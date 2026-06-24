import type { ExtensionAPI, ExtensionContext, ToolCallEventResult, ToolInfo } from "@earendil-works/pi-coding-agent"

import { buildCoverageReport } from "../lib/coverage.ts"
import { checkAndPrompt, DirectoryPermissionsState } from "../lib/directory-permissions.ts"
import { applyEnabledOverrides } from "../lib/enabled-tools.ts"
import { openDirectoryPermissionsModal } from "../lib/modal/directory-permissions-modal.ts"
import { openPolicyAskModal } from "../lib/modal/policy-ask-modal.ts"
import { openToolPolicyModal } from "../lib/modal/tool-policy-modal.ts"
import { computeExtendsChain } from "../lib/mode-controller.ts"
import { ModeController } from "../lib/mode-controller.ts"
import { buildNoUIBlockReason } from "../lib/no-ui-block.ts"
import { loadConfig, STOCK_CONFIG } from "../lib/permission-config.ts"
import { addAspectRule, addToolRule } from "../lib/permission-writer.ts"
import { evaluate } from "../lib/policy.ts"
import { buildDenyReason } from "../lib/policy.ts"
import { RuntimeGrants } from "../lib/runtime-grants.ts"
import { applyTaggerRules } from "../lib/tagging-rules.ts"
import { type AggregateResult, aggregateToolMetadata } from "../lib/tool-metadata.ts"
import type { Config, PolicyDecision, ResolvedToolMetadata, Verdict } from "../lib/types.ts"
import { fieldName } from "../lib/types.ts"
import { HOTKEY_CYCLE_MODE_KEY, YOLO_MODE } from "../lib/types.ts"

const HOTKEY_CYCLE_MODE = HOTKEY_CYCLE_MODE_KEY

/**
 * Extract string-typed fields from a tool call's input, restricted to
 * the fields the tool's aspect metadata actually binds. Scalar strings
 * pass through unchanged; `string[]` is joined with " " (matching the
 * matcher's `coerceForMatch` joining) so the persisted rule constrains
 * on the same string the matcher compares against.
 *
 * Fields that are NOT in any aspect binding are skipped — the matcher
 * never sees them, so locking on them would either be a no-op (a
 * different argv wouldn't change the verdict) or worse, would
 * produce a lock that doesn't reflect the user's intent. Non-string-typed
 * values (numbers, booleans, objects) are also skipped — the rule's
 * `fields` clause is a string-match map and can't constrain them.
 *
 * When `meta` is undefined (tool without any aspect declarations),
 * falls back to extracting every string / string[] field, so the
 * runtime grant still works for tools that haven't opted into the
 * aspect metadata system.
 *
 * Exported for unit tests.
 */
export function extractStringFields(
  input: Record<string, unknown> | undefined,
  meta: ResolvedToolMetadata | undefined,
): Record<string, string> {
  if (!input) return {}
  // If the tool has aspect metadata, restrict to bound fields. Otherwise
  // extract every string / string[] field (back-compat with tools that
  // haven't migrated to the aspect model).
  const boundFields: Set<string> | null = meta
    ? new Set(Object.values(meta.fields).flatMap((decl) => decl.fields.map(fieldName)))
    : null
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(input)) {
    if (boundFields && !boundFields.has(k)) continue
    if (typeof v === "string") {
      out[k] = v
    } else if (Array.isArray(v) && v.every((x): x is string => typeof x === "string")) {
      // Join with " " to match coerceForMatch's array coercion. The
      // matcher compares the same joined form, so a full-string match
      // on the persisted value locks the call to the same argv.
      out[k] = v.join(" ")
    }
  }
  return out
}

export default function (pi: ExtensionAPI): void {
  // toolMetadata is structural: built once on session_start, cached for the session.
  let toolMetadata: AggregateResult | null = null
  // cachedConfig is the most recently loaded config. The before_agent_start handler
  // reads it (ExtensionContext has no `config` field — the cast `ctx.config` would
  // silently return undefined at runtime). Updated on every session_start and on
  // every tool_call (so external edits take effect on the very next call).
  let cachedConfig: Config | null = null
  // liveTools is the most recent snapshot of `pi.getAllTools()`. Captured on
  // session_start and on every tool_call (so freshly-registered tools show up
  // in the debug view). Used by the `/tool_policy → Debug → Tools` dump.
  let liveTools: ToolInfo[] = []
  // enabledCache tracks the last-applied enabled-set signature so a no-op
  // reload (same config) does not call `pi.setActiveTools(...)` redundantly
  // per tool_call. Initialized to null and seeded on the first `session_start`.
  let enabledCache: { signature: string; set: Set<string> } | null = null
  const directoryState = new DirectoryPermissionsState()
  const modeController = new ModeController()
  // runtimeGrants tracks "allow for this session" choices from the policy-ask
  // modal. Purely in-memory; wiped on session_start.
  const runtimeGrants = new RuntimeGrants()

  // ── session_start: build the structural layer, reset in-memory state ──
  pi.on("session_start", async (_e, ctx) => {
    const { config, warnings } = await loadConfig(ctx.cwd)
    cachedConfig = config
    liveTools = pi.getAllTools()
    toolMetadata = await aggregateToolMetadata(liveTools, config.toolMetadata)
    directoryState.reset(ctx.cwd)
    runtimeGrants.clear()
    modeController.reset(config)
    modeController.setWarnings(warnings)
    modeController.refreshStatusBar(ctx)
    // Apply any `toolMetadata[*].enabled` overrides to the runtime active-tools
    // set. Runs unconditionally on session_start — YOLO is a per-`tool_call`
    // gate, not a session-level concern; the helper itself is a no-op when no
    // overrides are declared.
    enabledCache = applyEnabledOverrides(config, pi, enabledCache ?? undefined)
  })

  // ── before_agent_start: inject additionalInstructions for the active mode ──
  // (BeforeAgentStartEventResult is `{ systemPrompt?: string }` — we return
  // the merged systemPrompt with the mode's prose appended. The runtime chains
  // multiple extension results.)
  pi.on("before_agent_start", (event) => {
    if (!cachedConfig) return undefined
    const section = modeController.buildAdditionalInstructions(cachedConfig)
    if (!section) return undefined
    const base = event.systemPrompt
    return { systemPrompt: base + section }
  })

  // ── Alt+M: cycle mode ──
  pi.registerShortcut(HOTKEY_CYCLE_MODE, {
    description: "Cycle tool-policy mode",
    handler: async (ctx: ExtensionContext) => {
      const { config } = await loadConfig(ctx.cwd)
      const next = modeController.cycleMode(config)
      modeController.refreshStatusBar(ctx)
      ctx.ui.notify(`mode: ${next}`, "info")
    },
  })

  // ── /tool_policy: mode switcher + warnings viewer ──
  pi.registerCommand("tool_policy", {
    description: "Switch tool-policy mode or view config-load warnings",
    handler: async (_args, ctx) => {
      const { config, warnings, layers } = await loadConfig(ctx.cwd)
      const next = await openToolPolicyModal(
        ctx,
        config,
        modeController.getMode(),
        warnings,
        STOCK_CONFIG,
        // toolMetadata is set on session_start and stays stable for the
        // session lifetime. A null guard handles the unlikely case of the
        // slash command being invoked before session_start.
        toolMetadata ?? { metadata: new Map(), discovered: {}, warnings: [] },
        liveTools,
        pi.getActiveTools(),
        directoryState.snapshot(),
        layers,
      )
      if (next && next !== modeController.getMode()) {
        modeController.setMode(next, config)
        modeController.refreshStatusBar(ctx)
        ctx.ui.notify(`mode: ${next}`, "info")
      }
    },
  })

  // ── tool_call: the gate ──
  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    if (!toolMetadata) return undefined
    // Emergency escape: when the active mode is the synthetic YOLO mode,
    // the extension is fully disabled. All tool calls pass through with
    // no policy check, no directory guard, no ask modal. Used to recover
    // from a bug or a malformed config without reloading the session.
    if (modeController.getMode() === YOLO_MODE) {
      return undefined
    }
    try {
      // Refresh the live tool snapshot so the debug view reflects any
      // tools that other extensions registered after session_start.
      liveTools = pi.getAllTools()
      const { config } = await loadConfig(ctx.cwd)

      // Reconcile the runtime active-tools set against any
      // `toolMetadata[*].enabled` declarations in the freshly-loaded config.
      // Skipped when YOLO mode is active (the early-return above handles the
      // gate; this gate is about the helper's own side-effect, not the policy
      // decision). The helper is a no-op when no overrides are declared, and
      // a signature-skip when the config hasn't changed.
      enabledCache = applyEnabledOverrides(config, pi, enabledCache ?? undefined)

      // 1. Tagger rules augment the effective tag set.
      const staticTags = toolMetadata.metadata.get(event.toolName)?.tags ?? []
      const augmentedTags = applyTaggerRules(event, config.taggingRules, toolMetadata.metadata, ctx.cwd)
      const effectiveTags = [...new Set([...staticTags, ...augmentedTags])]

      // 2. Directory-permissions guardrail (loops-internally).
      const guardrail = await checkAndPrompt(
        directoryState,
        event,
        toolMetadata.metadata,
        effectiveTags,
        config.allowedPaths,
        ctx,
        (args) => openDirectoryPermissionsModal(ctx, args),
      )
      if (!guardrail.allowed) {
        return { block: true, reason: guardrail.denialReason ?? "Rejected: directory not allowed" }
      }

      // 3. Per-mode single-pass matcher. Apply runtime grants to the active
      // mode so an "allow for session" choice in the ask modal takes effect.
      const currentMode = modeController.getMode()
      const baseMode = config.modes[currentMode]
      if (!baseMode) {
        return { block: true, reason: `Unknown mode: ${currentMode}` }
      }
      const activeMode = runtimeGrants.applyFor(currentMode, baseMode)
      const configForEval: Config = { ...config, modes: { ...config.modes, [currentMode]: activeMode } }
      const decision = evaluate(event, configForEval, currentMode, effectiveTags, toolMetadata.metadata, ctx)

      if (decision.action === "allow") return undefined

      // For "ask" verdicts, open an interactive modal. While the modal is
      // open, this handler is pending — the tool won't run. The modal
      // returns the user's choice; we then translate to block/allow.
      if (decision.action === "ask") {
        // No-UI guard: when the matcher needs to ask, but the calling
        // context has no UI (subagent, print mode, JSON mode, RPC
        // client that doesn't handle extension_ui_request), the
        // interactive modal can't reach the user. Calling
        // `ctx.ui.select(...)` would either hang (RPC client that
        // ignores the request) or resolve immediately with
        // `undefined` (print/json mode), which the policy treats as
        // a dismissal and blocks anyway — the user gets a generic
        // "Denied by user" reason that doesn't tell them what
        // happened or what to do. Block with an actionable reason
        // instead. The subagent (or whoever ran the call) gets a
        // reason that names the tool, the matched rule, and the two
        // ways to unblock (pre-approve the rule in config, or re-run
        // from a top-level session).
        if (!ctx.hasUI) {
          return { block: true, reason: buildNoUIBlockReason(event, decision, currentMode) }
        }
        const coverage = buildCoverageReport(
          event.toolName,
          event.input,
          toolMetadata.metadata.get(event.toolName),
          activeMode,
          ctx.cwd,
        )
        // The save-rule modal asks the user which mode in the current
        // mode's inheritance chain to write a new rule into. The
        // chain must be computed against the RAW (pre-resolve) config
        // because the loader's `resolveExtends` strips the `extends`
        // field from the resolved modes. Without the raw config, the
        // chain would always be a single entry (the current mode) and
        // the target-mode picker would never appear.
        const extendsChain = computeExtendsChain(config, currentMode)
        const askResult = await openPolicyAskModal(
          ctx,
          {
            toolName: event.toolName,
            effectiveTags,
            reason: decision.reason,
            currentMode,
            input: event.input,
            toolMeta: toolMetadata.metadata.get(event.toolName),
            cwd: ctx.cwd,
            ruleTrail: decision.ruleTrail,
            extendsChain,
          },
          coverage,
        )
        if (askResult === null) {
          // User dismissed (Esc). Block the call — fail-closed.
          return { block: true, reason: decision.reason ?? "Denied by user" }
        }
        const { decision: askDecision, save, denyReason } = askResult
        if (askDecision === "allow_once") {
          return undefined
        }
        if (askDecision === "allow_session") {
          // Narrow: only the same (tool, arg-values) tuple is allowed.
          // Captures string-typed fields from the original call. Different
          // args will ask again.
          runtimeGrants.grant({
            modeName: currentMode,
            toolName: event.toolName,
            fields: extractStringFields(event.input, toolMetadata.metadata.get(event.toolName)),
          })
          return undefined
        }
        if ((askDecision === "allow_save" || askDecision === "deny_save") && save) {
          // Persist the rule chosen via the nested submenu. Aspect rules
          // and tool rules route to different writers. The verdict is
          // taken from the save entry (allow for allow_save, deny for
          // deny_save). `save.entry.verdict` is `AnyVerdict` — a bare
          // string or a `RuleEntry` with an optional reason — so we
          // normalize before comparing for the block-vs-allow branch.
          const rawVerdict = save.entry.verdict
          const verdict: Verdict = typeof rawVerdict === "string" ? rawVerdict : rawVerdict.verdict
          try {
            // `save.targetMode` is the mode the user picked in the
            // target-mode picker (or the current mode when the picker
            // was skipped because the chain has length 1). Writing
            // to a parent mode makes the rule apply to every mode
            // that inherits from it.
            const targetMode = save.targetMode
            if (save.ruleType === "aspect" && save.aspectName && save.aspectPattern !== undefined) {
              await addAspectRule(save.scope, ctx.cwd, targetMode, save.aspectName, save.aspectPattern, rawVerdict)
              ctx.ui.notify(
                `${verdict === "allow" ? "Allowed" : "Denied"} ${event.toolName}: aspect ${save.aspectName} = "${save.aspectPattern}" in mode '${targetMode}' for ${save.scope}`,
                "info",
              )
            } else if (save.ruleType === "tool") {
              await addToolRule(save.scope, ctx.cwd, targetMode, event.toolName, save.entry)
              ctx.ui.notify(
                `${verdict === "allow" ? "Allowed" : "Denied"} ${event.toolName} (tool rule) in mode '${targetMode}' for ${save.scope}`,
                "info",
              )
            }
            if (verdict === "deny") {
              // For deny_save we still block this call (and any future
              // matching call). Rebuild the deny reason so the
              // user-supplied one-off reason (if any) appears in the
              // middle block of the standard 3-part layout. Note: the
              // reason is also persisted inside the rule's verdict (via
              // `save.entry.verdict` when it's a RuleEntry), so future
              // matching calls will surface the user's reason through
              // the matcher trail.
              const blockReason = denyReason
                ? rebuildDenyReasonWithUserReason(decision, currentMode, event.toolName, denyReason)
                : (decision.reason ?? "Denied by user")
              return { block: true, reason: blockReason }
            }
            return undefined
          } catch (err) {
            ctx.ui.notify(`Failed to write rule: ${String(err)}`, "error")
            return { block: true, reason: `Failed to write rule: ${String(err)}` }
          }
        }
        // "deny" → block. Rebuild the deny reason with the user's
        // one-off reason in the middle block (so the agent sees the
        // tool/mode headline AND the user's just-typed reason, not
        // just the user's bare reason). Fall back to the matcher's
        // pre-built reason (which already uses the same layout) if
        // the rebuild fails for any reason.
        const reason = denyReason
          ? rebuildDenyReasonWithUserReason(decision, currentMode, event.toolName, denyReason)
          : (decision.reason ?? "Denied by user")
        return { block: true, reason }
      }

      // "deny" → block.
      return { block: true, reason: decision.reason ?? "Rejected by rule" }
    } catch (err) {
      return { block: true, reason: `Extension error: ${String(err)}` }
    }
  })
}

/**
 * Rebuild the deny reason with a user-supplied one-off reason in the
 * middle block. The matcher's `decision.reason` was already formatted
 * using the standard 3-part layout, but with whatever the rule
 * config said (or no reason, or "default deny"). When the user
 * types a reason at the prompt, we want THAT to land in the middle
 * block, with the same headline (tool + mode) and suffix.
 *
 * We re-derive the inputs from the decision's `ruleTrail` rather
 * than re-running the matcher — the trail already records which
 * rules fired, their reasons, and their status. The matcher's
 * internal `reasonParts` array isn't exposed; re-deriving it from
 * the trail gives the same set of inputs to `buildDenyReason` that
 * the matcher used.
 */
function rebuildDenyReasonWithUserReason(
  decision: PolicyDecision,
  currentMode: string,
  toolName: string,
  userReason: string,
): string {
  const applied = decision.ruleTrail.filter((r) => r.status === "applied")
  const reasonParts = applied.map((r) => r.reason ?? "").filter((r) => r.length > 0)
  return buildDenyReason({
    toolName,
    modeName: currentMode,
    appliedRules: applied,
    reasonParts,
    explicitRuleFired: applied.length > 0,
    userReason,
  })
}
