/* eslint-disable @typescript-eslint/no-unnecessary-condition --
 * The MenuAction discriminated union over a switch is correctly typed but
 * the linter's no-unnecessary-condition rule over-narrows after the
 * first case label (a known TS-ESLint interaction). The runtime logic
 * is correct; the linter is wrong. The rule is disabled for this file.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

import type { CoverageReport } from "../coverage.ts"
import { coerceForMatch } from "../policy.ts"
import type { AspectDeclaration, ResolvedToolMetadata, RuleResult, ToolRuleEntry, Verdict } from "../types.ts"
import { fieldName, isArrayBinding } from "../types.ts"
import { buildAskDisplay, formatValue } from "./ask-display.ts"
import { formatPathForDisplay } from "./path-display.ts"
import { openPolicyInputModal } from "./policy-input-modal.ts"
import { buildSuggestedAllow } from "./suggested-allow.ts"

/**
 * The top-level decisions the user can make. `allow_save` and
 * `deny_save` are sub-decisions that carry scope + rule-type + entry;
 * `deny` carries an optional reason. `deny_save` additionally
 * carries the reason so the persisted rule can be annotated.
 */
export type PolicyAskDecision = "allow_once" | "allow_session" | "allow_save" | "deny" | "deny_save"

export interface PolicyAskArgs {
  toolName: string
  effectiveTags: string[]
  reason?: string
  currentMode: string
  input: Record<string, unknown>
  toolMeta: ResolvedToolMetadata | undefined
  /**
   * Project root. Used by display-side helpers to convert absolute
   * path-mode aspect values to cwd-relative form (see
   * `formatPathForDisplay`). The matcher does its own relativization,
   * so this only affects what the user SEES — never what gets
   * persisted.
   */
  cwd: string
  /**
   * The rule trail from the matcher. Each entry is one rule's contribution
   * (layer, key, verdict, reason, status). The policy ask prompt surfaces
   * these as a "Rules that fired" block so the user can see exactly which
   * rule triggered the ask (and which rules were suppressed). The default
   * baseline is included as a noop entry when other rules fired.
   */
  ruleTrail?: readonly RuleResult[]
}

/** The persistence scope for a saved rule. */
export type PolicyAskScope = "user" | "project"

/**
 * The kind of rule to persist. Aspect rules attach the pattern to a
 * named aspect (broad — applies to every tool that has the aspect);
 * tool rules attach the constraint to this specific tool (narrow).
 */
export type PolicyAskRuleType = "aspect" | "tool"

export interface PolicyAskResult {
  decision: PolicyAskDecision
  /**
   * For `allow_save` and `deny_save` only: the scope, rule type, and the
   * rule entry to persist. The caller is responsible for routing this
   * to the right writer (aspect vs tool).
   */
  save?: {
    scope: PolicyAskScope
    ruleType: PolicyAskRuleType
    /** The aspect name (for `aspect` ruleType) — needed by the writer. */
    aspectName?: string
    /** The aspect pattern the user typed (for `aspect` ruleType). */
    aspectPattern?: string
    /** The ToolRuleEntry (for `tool` ruleType). */
    entry: ToolRuleEntry
  }
  /** For `deny` and `deny_save` only: the optional reason the user typed. */
  denyReason?: string
}

/**
 * The top-level options in the policy-ask prompt. These are the
 * first thing the user sees; picking 'Allow & Save', 'Deny', or
 * 'Deny & Save' leads to a follow-up prompt.
 */
const TOP_LEVEL: readonly { value: PolicyAskDecision; label: string }[] = [
  { value: "allow_once", label: "Allow once" },
  { value: "allow_session", label: "Allow for this session" },
  { value: "allow_save", label: "Allow & Save" },
  { value: "deny", label: "Deny" },
  { value: "deny_save", label: "Deny & Save" },
] as const

const SCOPE_LABELS: readonly { value: PolicyAskScope; label: string }[] = [
  { value: "project", label: "Save for this project (writes to <cwd>/.pi/tool-policy.json)" },
  { value: "user", label: "Save for this user (writes to ~/.pi/tool-policy.json)" },
] as const

/**
 * One row in the rule-type submenu. For multi-aspect tools there can
 * be several aspect-rule rows (one per declared aspect with a value).
 */
interface RuleTypeRow {
  value: string
  label: string
  ruleType: PolicyAskRuleType
  /** For aspect rules: the aspect name. */
  aspectName?: string
  /** For aspect rules: the prefill pattern (joined value). */
  aspectPattern?: string
}

/**
 * Build the rule-type submenu. Filters out:
 *   - aspect rules for tools with no aspects
 *   - aspect rules for aspects that are already covered by an existing rule
 *   - tool rules if the tool is already covered
 *
 * `cwd` is the project root. When provided AND an aspect's mode is
 * `"path"`, both the aspect prefill and the tool-rule label are
 * converted to cwd-relative form for display.
 *
 * Exported for data-shaping tests.
 */
export function buildRuleTypeOptions(
  toolName: string,
  input: Record<string, unknown>,
  toolMeta: ResolvedToolMetadata | undefined,
  coverage: CoverageReport,
  cwd?: string,
): RuleTypeRow[] {
  const rows: RuleTypeRow[] = []

  // 1. Aspect rules — one row per declared aspect with a non-empty value.
  if (toolMeta && !coverage.aspectCovered) {
    for (const [aspectName, decl] of Object.entries(toolMeta.fields)) {
      const prefill = computeAspectPrefill(decl, input, cwd)
      if (prefill === undefined) continue
      const displayValue =
        decl.mode === "path" && cwd !== undefined ? formatPathForDisplay(prefill, cwd) : formatValue(prefill)
      rows.push({
        value: `aspect:${aspectName}`,
        label: `Aspect rule: ${aspectName} = ${displayValue}`,
        ruleType: "aspect",
        aspectName,
        aspectPattern: prefill,
      })
    }
  }

  // 2. Tool rule — single row, always offered unless already covered.
  if (!coverage.toolCovered) {
    const suggested = buildSuggestedAllow(toolName, input, toolMeta, cwd)
    const summary = suggested.label ? ` (${suggested.label})` : ""
    rows.push({
      value: "tool",
      label: `Tool rule: ${toolName}${summary}`,
      ruleType: "tool",
    })
  }

  return rows
}

/**
 * Compute the prefill value for an aspect rule. For scalar-mode
 * bindings it's the coerced single string; for array-mode bindings
 * the joined elements with a space (matching how `coerceForMatch`
 * joins arrays). Returns undefined if there's no string-coercible value.
 *
 * When `cwd` is provided AND the aspect's `mode` is `"path"`, the
 * returned prefill is in cwd-relative form. This matters because the
 * prefill is what the user sees in the text-input prompt and (if
 * accepted) what gets persisted as the aspect pattern; the matcher's
 * `path` branch (`aspects.ts`) picomatches the pattern against
 * `relative(cwd, value)`, so a relative pattern is the natural form
 * for the user to write and edit.
 */
function computeAspectPrefill(
  decl: AspectDeclaration,
  input: Record<string, unknown>,
  cwd: string | undefined,
): string | undefined {
  const isPathMode = cwd !== undefined && decl.mode === "path"
  for (const binding of decl.fields) {
    const field = fieldName(binding)
    const raw = input[field]
    if (raw === undefined || raw === null) continue
    if (isArrayBinding(binding)) {
      if (!Array.isArray(raw)) continue
      const elements = raw.filter((v): v is string => typeof v === "string" && v.length > 0)
      if (elements.length === 0) continue
      const joined = elements.join(" ")
      return isPathMode ? formatPathForDisplay(joined, cwd) : joined
    }
    try {
      const s = coerceForMatch(raw)
      if (s && s.length > 0) return isPathMode ? formatPathForDisplay(s, cwd) : s
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Build the title block shown above the option list. Multi-line — the
 * runtime renders each `\n` as a separate line in the selector.
 */
/** Render a short status icon for a rule's status, in plain ASCII so the
 *  multi-line title renders correctly in the selector. */
function statusIcon(status: RuleResult["status"]): string {
  if (status === "applied") return "[applied]"
  if (status === "suppressed") return "[suppressed]"
  return "[noop]"
}

/** Render a single rule trail entry as a compact one-liner. */
function renderRuleLine(rule: RuleResult): string {
  const parts: string[] = []
  if (rule.aspect && rule.pattern) {
    parts.push(`aspect ${rule.aspect} (${rule.pattern})`)
  } else if (rule.aspect) {
    parts.push(`aspect ${rule.aspect}`)
  } else {
    parts.push(`${rule.layer}:${rule.key}`)
  }
  parts.push(`= ${rule.verdict}`)
  parts.push(statusIcon(rule.status))
  if (rule.reason) parts.push(`"${rule.reason}"`)
  return parts.join(" ")
}

export function buildPolicyAskTitle(args: PolicyAskArgs): string {
  const lines: string[] = []
  lines.push(`Allow tool call: ${args.toolName}?`)
  const fieldDisplay = buildAskDisplay(args.toolName, args.input, args.toolMeta, args.cwd)
  for (const fl of fieldDisplay.fieldLines) {
    lines.push(fl)
  }
  const tagPart = args.effectiveTags.length > 0 ? args.effectiveTags.join(", ") : "(none)"
  lines.push(`Mode: ${args.currentMode} · Tags: ${tagPart}`)
  // Rule trail block — one line per rule. Helps the user understand
  // which rule triggered the ask (and why no rule allowed it). Skipped
  // when the matcher didn't expose a trail (legacy callers).
  if (args.ruleTrail && args.ruleTrail.length > 0) {
    lines.push("")
    lines.push("Rules that fired:")
    for (const rule of args.ruleTrail) {
      lines.push(`  ${renderRuleLine(rule)}`)
    }
  }
  lines.push("")
  lines.push("Pick an action:")
  return lines.join("\n")
}

/**
 * Open the policy-ask prompt. Multi-step:
 *
 *   1. Top-level select (Allow once / Session / Save / Deny).
 *   2. For "Save" → scope submenu → rule-type submenu → (for aspect
 *      rules) a text-input prompt for the user to confirm or edit the
 *      prefill pattern.
 *   3. For "Deny" → a text-input prompt for an optional reason.
 *
 * Returns `null` if the user dismisses any prompt with Esc.
 *
 * Uses `ctx.ui.select` for the menus and `ctx.ui.input` for the text
 * prompts. Both clear the prompt bar and handle their own keystrokes.
 */
/**
 * Internal sentinel for the menu loop. `BACK` means the user pressed
 * Esc at a sub-prompt and wants to return to the parent menu. Only
 * the outermost top-level menu can return `CANCEL` (= the user
 * dismissed the whole flow with no decision).
 */
interface MenuActionResult {
  kind: "result"
  result: PolicyAskResult
}
interface MenuActionRow {
  /** Internal: pickRuleType returns a chosen rule-type row (not yet
   *  a final PolicyAskResult). The caller dispatches on the row's
   *  ruleType. Never leaks to the top-level menu. */
  kind: "row"
  row: RuleTypeRow
}
interface MenuActionBack {
  kind: "back"
}
interface MenuActionCancel {
  kind: "cancel"
}
type MenuAction = MenuActionResult | MenuActionRow | MenuActionBack | MenuActionCancel

export async function openPolicyAskModal(
  ctx: ExtensionContext,
  args: PolicyAskArgs,
  coverage: CoverageReport,
): Promise<PolicyAskResult | null> {
  // The outermost loop only exits on a final RESULT or CANCEL. BACK
  // actions from sub-prompts bring us back to the top-level menu.
  // This lets the user change their mind at any sub-prompt without
  // losing all the work — they can navigate back up the menu stack.
  while (true) {
    const action: MenuAction = await runTopLevelMenu(ctx, args, coverage)
    // Dispatch through a switch — eslint's no-unnecessary-condition
    // rule has trouble with the if-chain over a discriminated union
    // here (it over-narrows the type after the first check). A switch
    // gives the linter the exhaustiveness hint it needs.
    switch (action.kind) {
      case "cancel":
        return null
      case "back":
        continue
      case "row":
        // Defensive: pickRuleType's `row` action is internal to
        // sub-flows and never reaches the top-level menu. If it
        // does, re-enter the loop (will re-show the top-level
        // prompt).
        continue
      case "result":
        return action.result
    }
  }
}

/**
 * Show the top-level menu and handle follow-up sub-prompts. Returns
 * `cancel` if the user Esc'd at the top level; `back` never returns
 * here (the top level has no parent). `result` returns a final
 * `PolicyAskResult`.
 */
async function runTopLevelMenu(
  ctx: ExtensionContext,
  args: PolicyAskArgs,
  coverage: CoverageReport,
): Promise<MenuAction> {
  // Step 1: top-level
  const topLabels = TOP_LEVEL.map((c) => c.label)
  const topChosen = await ctx.ui.select(buildPolicyAskTitle(args), topLabels)
  if (topChosen === undefined) return { kind: "cancel" }
  const top = TOP_LEVEL[topLabels.indexOf(topChosen)]
  if (!top) return { kind: "cancel" }
  if (top.value !== "allow_save" && top.value !== "deny" && top.value !== "deny_save") {
    return { kind: "result", result: { decision: top.value } }
  }

  if (top.value === "deny") {
    return runDenyFlow(ctx)
  }

  if (top.value === "deny_save") {
    return runDenySaveFlow(ctx, args, coverage)
  }

  // top.value === "allow_save"
  return runSaveFlow(ctx, args, coverage)
}

// ─── shared sub-flow helpers ─────────────────────────────────────────────────
// The "Allow & Save" and "Deny & Save" top-level choices walk the same
// sub-prompt tree: scope → rule-type → (aspect pattern) → [optional
// reason]. The differences live in three small spots:
//   - the scope prompt title ("Save where?" vs "Deny & Save where?")
//   - the entry's verdict ("allow" vs "deny") and the tool-rule's
//     fields clause (broad allow is suggested-by-args; broad deny
//     has no args to suggest)
//   - whether to ask for a reason afterwards (only deny-save does)
//
// Each helper takes the verdict and the prompt-title prefix as
// parameters so a single body serves both flows. The high-level
// orchestrators (`runSaveFlow`, `runDenySaveFlow`) become thin
// glue.

/** Show the scope submenu. Returns `back` on Esc. */
async function pickScope(
  ctx: ExtensionContext,
  args: PolicyAskArgs,
  promptPrefix: "Save" | "Deny & Save",
): Promise<{ kind: "scope"; scope: PolicyAskScope } | MenuActionBack | MenuActionCancel> {
  const scopeLabels = SCOPE_LABELS.map((c) => c.label)
  const scopeChosen = await ctx.ui.select(`${promptPrefix} where?\n\nTool: ${args.toolName}`, scopeLabels)
  if (scopeChosen === undefined) return { kind: "back" }
  const scope = SCOPE_LABELS[scopeLabels.indexOf(scopeChosen)]
  if (!scope) return { kind: "back" }
  return { kind: "scope", scope: scope.value }
}

/**
 * Options for `pickRuleType`. The two save flows differ in
 * (a) whether the rule-type submenu is filtered by coverage (only
 * allow-save does this — a deny rule is always additive because
 * most-restrictive-wins means a new `deny` overrides any less-
 * restrictive existing verdict), and (b) the prompt title prefix
 * and the tool-row label (a broad deny doesn't need a suggested-
 * args summary because the user said "deny this tool", not "deny
 * this specific call").
 */
interface PickRuleTypeOptions {
  /** Coverage filter — for allow-save pass the real coverage; for
   *  deny-save pass `{ aspectCovered: false, toolCovered: false }`. */
  coverage: CoverageReport
  /** The prompt-title prefix: "What kind of rule?" (allow-save) or
   *  "What kind of deny rule?" (deny-save). */
  promptPrefix: "What kind of rule?" | "What kind of deny rule?"
  /** Strip the "with-suggested-args" summary from the tool-row label.
   *  Deny-save sets this to true; the suggested-args summary is
   *  meaningless for a broad deny. */
  stripToolSummary: boolean
  /** The tool name to show in the prompt title and the tool-row label. */
  toolName: string
  /** The scope to show in the prompt title. */
  scope: PolicyAskScope
}

/**
 * Show the rule-type submenu. Loops internally on `back` (the user
 * can re-pick after bailing out of an aspect-pattern prompt). When
 * the (filtered) row set is empty AND coverage-filtering was on
 * (allow-save), falls back to a plain deny flow — the user picked
 * "Allow & Save" but everything is already covered, so we ask once
 * and forward any sub-flow result. When the row set is empty AND
 * coverage-filtering was off (deny-save), the only way to reach
 * here is a programming error (no aspects AND no tool row), so we
 * cancel.
 */
/**
 * Pure reducer for the rule-type submenu's edge cases. The full
 * `pickRuleType` function is an async loop because it has to await
 * `ctx.ui.select` / `ctx.ui.input`, but the dispatch logic is pure
 * data-in / data-out and worth testing in isolation.
 *
 * Three inputs:
 *   - `rowsAvailable` — the rule-type rows that `buildRuleTypeOptions`
 *     produced, possibly with the "strip tool summary" mutation applied
 *   - `coverage` — whether the allow-save / deny-save flow should
 *     fall back to a plain deny when no rows are available
 *   - `userChose` — `undefined` if the user pressed Esc, or a string
 *     (the selected label) if they picked a row
 *
 * Returns the next action: a chosen `row`, a `back` (Esc), a
 * `fallBackToDeny` (empty rows + coverage filtered), or a
 * `cancel` (empty rows + no coverage filter — a programming error).
 *
 * Exported for unit tests in `policy-ask-modal.test.ts`.
 */
export type RuleTypeSubmenuResult =
  | { kind: "row"; row: RuleTypeRow }
  | { kind: "back" }
  | { kind: "fallBackToDeny" }
  | { kind: "cancel" }

export function pickRuleTypeReducer(
  rowsAvailable: RuleTypeRow[],
  coverage: CoverageReport,
  userChose: string | undefined,
): RuleTypeSubmenuResult {
  if (rowsAvailable.length === 0) {
    // Two cases per the original logic:
    //   (a) coverage-filtered (allow-save): every layer is already
    //       covered. Fall back to a plain deny so the user has
    //       somewhere to go.
    //   (b) coverage-not-filtered (deny-save): we passed
    //       `toolCovered: false` so buildRuleTypeOptions must return
    //       at least the tool row. Empty set = programming error; cancel.
    if (coverage.aspectCovered || coverage.toolCovered) {
      return { kind: "fallBackToDeny" }
    }
    return { kind: "cancel" }
  }
  if (userChose === undefined) return { kind: "back" }
  const ruleRow = rowsAvailable.find((r) => r.label === userChose)
  if (!ruleRow) return { kind: "back" }
  return { kind: "row", row: ruleRow }
}

async function pickRuleType(
  ctx: ExtensionContext,
  args: PolicyAskArgs,
  opts: PickRuleTypeOptions,
): Promise<MenuAction> {
  while (true) {
    const allRows = buildRuleTypeOptions(args.toolName, args.input, args.toolMeta, opts.coverage, args.cwd)
    const rows = opts.stripToolSummary
      ? allRows.map((r) => (r.ruleType === "tool" ? { ...r, label: `Tool rule: ${opts.toolName}` } : r))
      : allRows
    if (rows.length === 0) {
      // No rule types available. Two cases:
      //   (a) allow-save: every layer is already covered. Fall back
      //       to a plain deny so the user has somewhere to go.
      //   (b) deny-save: we explicitly passed `toolCovered: false`,
      //       so buildRuleTypeOptions must return at least the tool
      //       row. Empty set = programming error; cancel.
      // The reducer classifies this case too, but the side-effect
      // (calling pickDenyReason) needs the ctx, so we keep the side
      // effect here and use the reducer for the data-only check.
      const emptyDecision = pickRuleTypeReducer([], opts.coverage, undefined)
      if (emptyDecision.kind === "fallBackToDeny") {
        const denyResult = await pickDenyReason(ctx, undefined)
        if (denyResult.kind === "back") continue
        return denyResult
      }
      return { kind: "cancel" }
    }
    const ruleTypeLabels = rows.map((r) => r.label)
    const ruleChosen = await ctx.ui.select(
      `${opts.promptPrefix}\n\nTool: ${opts.toolName}\nScope: ${opts.scope}`,
      ruleTypeLabels,
    )
    // Dispatch through the pure reducer so the edge cases (Esc, missing
    // row) are unit-testable without driving the TUI.
    const decision = pickRuleTypeReducer(rows, opts.coverage, ruleChosen)
    switch (decision.kind) {
      case "cancel":
      case "fallBackToDeny":
        // These branches are only reachable when rows is empty (the
        // pre-check above handles them); the non-empty path only
        // returns row or back.
        return { kind: "cancel" }
      case "back":
        return { kind: "back" }
      case "row":
        return { kind: "row", row: decision.row }
    }
  }
}

/**
 * Show the aspect-pattern input. Used for both allow-save and
 * deny-save; the verdict and decision are parameterized. Returns
 * `back` on Esc or empty input; otherwise a partial result with
 * the save metadata (no reason yet — that's picked up by
 * `pickDenyReason` only in the deny-save flow).
 */
async function pickAspectPattern(
  ctx: ExtensionContext,
  ruleRow: RuleTypeRow,
  scope: PolicyAskScope,
  decision: "allow_save" | "deny_save",
  verdict: Verdict,
): Promise<MenuAction> {
  const suggested = ruleRow.aspectPattern ?? ""
  const titlePrefix = verdict === "deny" ? "Deny aspect rule pattern" : "Aspect rule pattern"
  const submitted = await openPolicyInputModal(ctx, `${titlePrefix} for "${ruleRow.aspectName}":`, suggested)
  if (submitted === undefined) return { kind: "back" }
  const pattern = submitted.trim()
  if (pattern.length === 0) return { kind: "back" }
  return {
    kind: "result",
    result: {
      decision,
      save: {
        scope,
        ruleType: "aspect",
        aspectName: ruleRow.aspectName,
        aspectPattern: pattern,
        entry: { verdict },
      },
    },
  }
}

/**
 * Show the optional reason input. Used by plain "Deny" (no
 * attached save) and by "Deny & Save" (save attached, then
 * reason is appended to the result). Empty input = no reason.
 */
async function pickDenyReason(
  ctx: ExtensionContext,
  save: NonNullable<PolicyAskResult["save"]> | undefined,
): Promise<MenuAction> {
  const title = save
    ? "Optional reason for this deny rule (press Enter for no reason, Esc to back out):"
    : "Optional reason for denying (press Enter for no reason, Esc to back out):"
  const reason = await openPolicyInputModal(ctx, title, "")
  if (reason === undefined) return { kind: "back" }
  const trimmed = reason.trim()
  const hasReason = trimmed.length > 0
  // When saving a deny rule, the user-supplied reason is folded into
  // the persisted entry's verdict as a `RuleEntry` shape (`{ verdict,
  // reason }`). The bare-string verdict is kept when the user didn't
  // type a reason — keeps the config JSON clean for the common case.
  // The `denyReason` field on the result is still set so the extension
  // entry can use it for the block-reason of THIS call without
  // re-extracting it from the entry.
  const finalSave = save
    ? hasReason && typeof save.entry.verdict === "string"
      ? { ...save, entry: { ...save.entry, verdict: { verdict: save.entry.verdict, reason: trimmed } } }
      : save
    : undefined
  return {
    kind: "result",
    result: save
      ? { decision: "deny_save", save: finalSave ?? save, denyReason: hasReason ? trimmed : undefined }
      : { decision: "deny", denyReason: hasReason ? trimmed : undefined },
  }
}

// ─── high-level orchestrators ────────────────────────────────────────────────

/**
 * Plain "Deny" — show the optional reason input, return a `deny`
 * result. A thin wrapper over `pickDenyReason` kept for symmetry
 * with the other top-level handlers.
 */
function runDenyFlow(ctx: ExtensionContext): Promise<MenuAction> {
  return pickDenyReason(ctx, undefined)
}

/**
 * "Allow & Save". Walks scope → rule-type → (aspect pattern) with
 * coverage-filtered rule types. The user can Esc at the aspect
 * pattern to re-pick a rule type; Esc at the rule-type submenu
 * goes back to scope; Esc at scope goes back to the top level.
 */
async function runSaveFlow(ctx: ExtensionContext, args: PolicyAskArgs, coverage: CoverageReport): Promise<MenuAction> {
  const scopeResult = await pickScope(ctx, args, "Save")
  if (scopeResult.kind !== "scope") return scopeResult
  const scope = scopeResult.scope

  while (true) {
    const ruleResult = await pickRuleType(ctx, args, {
      coverage,
      promptPrefix: "What kind of rule?",
      stripToolSummary: false,
      toolName: args.toolName,
      scope,
    })
    if (ruleResult.kind !== "row") return ruleResult
    const ruleRow = ruleResult.row

    if (ruleRow.ruleType === "aspect") {
      const aspectResult = await pickAspectPattern(ctx, ruleRow, scope, "allow_save", "allow")
      if (aspectResult.kind === "back") continue
      return aspectResult
    }

    // tool rule — suggested entry from the actual call's args.
    const suggested = buildSuggestedAllow(args.toolName, args.input, args.toolMeta, args.cwd)
    return {
      kind: "result",
      result: {
        decision: "allow_save",
        save: {
          scope,
          ruleType: "tool",
          entry: suggested.entry,
        },
      },
    }
  }
}

/**
 * "Deny & Save". Walks scope → rule-type → (aspect pattern) →
 * optional reason. Coverage is ignored (a deny rule is always
 * additive); the tool-row label is stripped of its "suggested
 * args" summary (meaningless for a broad deny).
 */
async function runDenySaveFlow(
  ctx: ExtensionContext,
  args: PolicyAskArgs,
  coverage: CoverageReport,
): Promise<MenuAction> {
  const scopeResult = await pickScope(ctx, args, "Deny & Save")
  if (scopeResult.kind !== "scope") return scopeResult
  const scope = scopeResult.scope

  while (true) {
    const ruleResult = await pickRuleType(ctx, args, {
      coverage,
      promptPrefix: "What kind of deny rule?",
      stripToolSummary: true,
      toolName: args.toolName,
      scope,
    })
    if (ruleResult.kind !== "row") return ruleResult
    const ruleRow = ruleResult.row

    if (ruleRow.ruleType === "aspect") {
      const aspectResult = await pickAspectPattern(ctx, ruleRow, scope, "deny_save", "deny")
      if (aspectResult.kind === "back") continue
      if (aspectResult.kind === "cancel") return aspectResult
      if (aspectResult.kind === "row") return aspectResult // defensive: pickAspectPattern never returns row
      // aspectResult.kind === "result" with a partial save result
      // (no reason yet). Forward to the reason prompt.
      const result = aspectResult.result
      if (result.save) return pickDenyReason(ctx, result.save)
      return aspectResult
    }

    // tool rule — broad deny (no fields clause; matches every call).
    const save: NonNullable<PolicyAskResult["save"]> = {
      scope,
      ruleType: "tool",
      entry: { verdict: "deny" },
    }
    return pickDenyReason(ctx, save)
  }
}

/**
 * Helper to expose the top-level option list for tests. The live
 * UI uses `TOP_LEVEL` directly.
 */
export function buildTopLevelOptions(): string[] {
  return TOP_LEVEL.map((c) => c.label)
}
