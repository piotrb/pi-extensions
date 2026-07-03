import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { genericPatternToRegex } from "@piotrb/pi-extension-utils"

import { matchAspect, matchAspectEach } from "./aspects.ts"
import type { AnyVerdict, Config, PolicyDecision, ResolvedToolMetadata, RuleResult, Verdict } from "./types.ts"
import { fieldName, isArrayBinding } from "./types.ts"

/** Strictness ranking: deny > ask > allow. */
const STRICTNESS: Record<Verdict, number> = { deny: 3, ask: 2, allow: 1 }

function normalizeVerdict(v: AnyVerdict): { verdict: Verdict; reason?: string } {
  return typeof v === "string" ? { verdict: v } : v
}

/**
 * Coerce a value to a single string for pattern matching.
 *   - string  → the string itself
 *   - string[] → joined with " " (per the v2 design: any string[] is joined, the
 *     aspect's mode (e.g. "bash") then handles word-boundary semantics)
 *   - null / undefined → undefined
 *   - anything else → throw (schema guarantees primitives; a tool supplying a
 *     non-primitive is a tool bug).
 *
 * Coercion is type-driven — the v2 design has no aspectName/format params.
 */
export function coerceForMatch(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    // Per-element string check: any non-string element would have come from
    // a malformed tool input. We throw rather than silently coerce numbers
    // to strings (which would mask schema violations).
    return value
      .map((v) => {
        if (typeof v !== "string") {
          throw new Error(`coerceForMatch: array element is not a string: ${typeof v}`)
        }
        return v
      })
      .join(" ")
  }
  throw new Error(`coerceForMatch: value is not a string or string[]: ${typeof value}`)
}

/**
 * Layer priority. Lower index = more specific = wins ties among layers.
 * The default layer is least specific. The order is fixed; aspect > tool
 * > tag > default reflects the design intent: an explicit per-pattern
 * aspect rule (`bash_cmd "ls *" = allow`) should beat a broad tag rule
 * (`tag:mutating = ask`), because the aspect rule encodes a more
 * specific user intent. See the per-layer combine in `evaluate()`.
 */
const LAYER_PRIORITY: readonly RuleResult["layer"][] = ["aspect", "tool", "tag", "default"] as const

/**
 * Evaluate a single tool_call event against the active mode's rules.
 *
 * **Per-layer most-specific-wins combine.** The matcher first collects
 * rules into four layer buckets (aspect / tool / tag / default), then
 * picks the global winner from the layer winners in priority order
 * (aspect > tool > tag > default). `deny` is sticky across layers: if
 * ANY layer produces `deny`, the global verdict is `deny`.
 *
 * Why not the old "flat most-restrictive wins" combine? An aspect rule
 * like `bash_cmd "ls *" = allow` is a more specific user intent than
 * `tag:mutating = ask`, and the user reasonably expects the explicit
 * per-pattern allow to win. Under the old flat combine, the tag's
 * blanket `ask` would suppress the aspect's `allow` because `ask` is
 * more restrictive at the per-rule level — even though the user wrote
 * the aspect rule specifically to override the tag.
 *
 * The two-direction property (the one that makes this rule correct and
 * is easy to "fix" by accident in a future refactor):
 *
 *   - more-specific `allow` beats less-specific `ask`
 *     (the bug-report case: aspect `allow` over tag `ask`).
 *   - more-specific `ask`  beats less-specific `allow`
 *     (a deliberate `aspect: ask` for a narrow pattern should
 *     still ask, even when the tag says `allow`).
 *
 * `deny` is sticky to preserve the safety invariant: a `deny` from
 * ANY layer is the final answer, regardless of layer priority. A
 * `tag:mutating = deny` must not be overridable by an aspect `allow`.
 *
 * **Undecided layers defer.** When a layer has no rules (e.g. no
 * aspect pattern matched the call, no tool rule was defined), the
 * layer has no opinion and the combine defers to the next-most-
 * specific layer that DOES have a verdict. The default layer always
 * has a verdict (it is the baseline), so a call with no matching
 * rules at all lands on the default.
 *
 * The rule trail records each rule's per-rule status:
 *   - applied:  this rule is the layer winner AND the layer is the
 *               global winner. At most one rule per call has this
 *               status.
 *   - shadowed: this rule's verdict is less restrictive than the
 *               layer winner (or, if this rule IS the layer winner,
 *               the layer winner was beaten by a more-specific
 *               layer — e.g. the tag layer's `ask` is shadowed by
 *               the aspect layer's `allow`).
 *   - noop:     this rule's verdict matches the layer winner exactly
 *               (e.g. two `tag:readonly: ask` rules where the
 *               second is noop relative to the first).
 */
export function evaluate(
  event: ToolCallEvent,
  config: Config,
  currentModeName: string,
  effectiveTags: string[],
  toolMetadata: Map<string, ResolvedToolMetadata>,
  ctx: ExtensionContext,
): PolicyDecision {
  const mode = config.modes[currentModeName]
  if (!mode) {
    return {
      action: "deny",
      reason: `Rejected: unknown mode ${currentModeName}`,
      ruleTrail: [],
      effectiveTags,
      directoryGuardrailFired: false,
    }
  }

  const ruleTrail: RuleResult[] = []
  // Per-layer accumulators. Each layer collects its rules verbatim;
  // the per-layer winner and the global winner are decided in a
  // second pass after all rules are collected. This separation is
  // what makes "deny sticky" and "more-specific-layer wins" compose
  // correctly — the matcher's contribution order within a layer
  // doesn't matter, and a deny from any layer is observable to
  // every other layer.
  const layerRules: Record<RuleResult["layer"], RuleResult[]> = {
    aspect: [],
    tool: [],
    tag: [],
    default: [],
  }

  /** Contribute a rule's verdict to its layer's bucket. */
  function contribute(
    layer: RuleResult["layer"],
    key: string,
    v: AnyVerdict,
    extras: { aspect?: string; pattern?: string } = {},
  ): void {
    const { verdict, reason } = normalizeVerdict(v)
    const entry: RuleResult = {
      layer,
      key,
      aspect: extras.aspect,
      pattern: extras.pattern,
      verdict,
      reason,
      status: "noop",
    }
    layerRules[layer].push(entry)
    ruleTrail.push(entry)
  }

  // 1. tagRules: for each tag in effectiveTags, look up tagRules[tag]
  for (const tag of effectiveTags) {
    const v = mode.tagRules[tag]
    if (v !== undefined) {
      contribute("tag", tag, v)
    }
  }

  // 2. aspectRules: for each declared aspect binding on the tool, run the aspect matcher
  const meta = toolMetadata.get(event.toolName)
  if (meta) {
    const args = event.input as Record<string, unknown>
    for (const [aspectName, decl] of Object.entries(meta.fields)) {
      const aspectRule = mode.aspectRules[aspectName]
      if (!aspectRule) continue

      for (const binding of decl.fields) {
        const field = fieldName(binding)
        const value = args[field]
        if (value === undefined || value === null) continue

        if (isArrayBinding(binding)) {
          // Array-mode binding: iterate per element and combine.
          if (!Array.isArray(value)) continue
          // Dispatch on `decl.mode` (one of the 5 base modes), not the
          // user-defined `aspectName`. The user-defined name (e.g. "source"
          // for git_mv's `source` aspect) may not be one of the base modes;
          // the base mode (e.g. "path") identifies the matcher semantics
          // (picomatch vs url-host vs basename-glob vs regex vs bash-word).
          const result = matchAspectEach(decl.mode, value as string[], aspectRule, ctx.cwd)
          if (result === "undecided") continue
          contribute("aspect", field, result.verdict, { aspect: aspectName, pattern: result.pattern })
          continue
        }

        const s = coerceForMatch(value)
        if (!s) continue
        // See comment above — dispatch on the base mode, not the
        // user-defined aspect name. This is the dispatch-key fix.
        const result = matchAspect(decl.mode, s, aspectRule, ctx.cwd)
        if (result === "undecided") continue
        contribute("aspect", field, result.verdict, { aspect: aspectName, pattern: result.pattern })
      }
    }
  }

  // 3. toolRules: for each entry in toolRules[tool]
  const toolEntries = mode.toolRules[event.toolName]
  if (toolEntries) {
    const args = event.input as Record<string, unknown>
    for (const entry of toolEntries) {
      if (!entry.fields) {
        // No fields clause: always matches.
        contribute("tool", event.toolName, entry.verdict)
        continue
      }
      let allFieldsMatch = true
      for (const [field, patterns] of Object.entries(entry.fields)) {
        const value = args[field]
        if (value === undefined || value === null) {
          allFieldsMatch = false
          break
        }
        const s = coerceForMatch(value)
        if (!s) {
          allFieldsMatch = false
          break
        }
        const fieldMatched = patterns.some((p) => genericPatternToRegex(p).test(s))
        if (!fieldMatched) {
          allFieldsMatch = false
          break
        }
      }
      if (allFieldsMatch) {
        contribute("tool", event.toolName, entry.verdict)
      }
    }
  }

  // 4. defaultDecision: the baseline. Always contributed as a rule in
  // its own layer, so the per-layer combine can fall through to it
  // when no other layer has a verdict. The default's per-rule status
  // is decided in the second pass below (it's `applied` when no
  // other layer has rules; otherwise it's `shadowed` or `noop`
  // relative to the more-specific layer winner).
  contribute("default", "<default>", mode.defaultDecision)

  // ─── second pass: assign per-rule statuses ──────────────────────────────
  //
  // For each layer, the layer winner is the most-restrictive verdict
  // among the layer's rules (most-restrictive of deny > ask > allow).
  // A layer with no rules has no winner and the combine defers to the
  // next-most-specific layer (see "undecided layers defer" in the
  // function docstring).
  //
  // The global winner is the most-specific layer's layer winner,
  // subject to deny-sticky: if ANY layer produced `deny`, the global
  // winner is `deny` (the deny-sticky layer is the global winner for
  // status purposes, even if a more-specific layer had a non-deny
  // verdict — the safety invariant is "any deny anywhere wins").
  //
  // Per-rule status (mutates `entry.status` in place):
  //   - applied:  this rule is the layer winner AND the layer is the
  //               global winner.
  //   - noop:     this rule's verdict matches the layer winner
  //               exactly.
  //   - shadowed: this rule's verdict is less restrictive than the
  //               layer winner, OR the rule IS the layer winner but
  //               the layer was beaten by a more-specific layer.

  /** The most-restrictive verdict among the rules in a layer. Undefined
   *  when the layer has no rules. */
  function layerWinner(layer: RuleResult["layer"]): Verdict | undefined {
    const rules = layerRules[layer]
    if (rules.length === 0) return undefined
    let winner: Verdict = rules[0]!.verdict
    for (const r of rules) {
      if (STRICTNESS[r.verdict] > STRICTNESS[winner]) {
        winner = r.verdict
      }
    }
    return winner
  }

  const winners: Partial<Record<RuleResult["layer"], Verdict>> = {}
  for (const layer of LAYER_PRIORITY) {
    const w = layerWinner(layer)
    if (w !== undefined) winners[layer] = w
  }

  // Global winner: deny-sticky first (any layer's `deny` wins), then
  // most-specific layer's winner. Implementation: we walk layers
  // from most-specific to least-specific (LAYER_PRIORITY order) and
  // track two slots:
  //   - firstSeen: the first layer with any verdict (the "no-deny"
  //     candidate; will be the global winner IF no layer has a
  //     deny verdict).
  //   - mostSpecificDeny: the most-specific layer with a `deny`
  //     verdict, if any (overrides firstSeen if set).
  // The global winner is mostSpecificDeny ?? firstSeen. This gives
  // us: (a) deny-sticky (any layer's deny wins), and (b) the
  // most-specific layer with that deny is reported.
  let firstSeen: { layer: RuleResult["layer"]; verdict: Verdict } | undefined
  let mostSpecificDeny: { layer: RuleResult["layer"]; verdict: Verdict } | undefined
  for (const layer of LAYER_PRIORITY) {
    const w = winners[layer]
    if (w === undefined) continue
    firstSeen ??= { layer, verdict: w }
    if (w === "deny") mostSpecificDeny ??= { layer, verdict: w }
  }

  // The combine always has a winner — at minimum the default layer
  // is always populated, so firstSeen is always set. The assertion
  // is a type guard for the rest of the function.
  const globalWinner = mostSpecificDeny ?? firstSeen
  if (globalWinner === undefined) {
    // Defensive: should be unreachable because the default layer is
    // always contributed above. If it ever triggers, fall back to
    // a sane PolicyDecision.
    return {
      action: "ask",
      reason: "Policy evaluation produced no verdict (internal error)",
      ruleTrail,
      effectiveTags,
      directoryGuardrailFired: false,
    }
  }

  // Assign per-rule statuses. Walk the layers in priority order so
  // we can determine "is this layer the global winner?" without
  // re-checking.
  for (const layer of LAYER_PRIORITY) {
    const rules = layerRules[layer]
    if (rules.length === 0) continue
    const layerVerdict = winners[layer]!
    const isGlobalWinnerLayer = layer === globalWinner.layer
    // Find the first rule in the layer with the layer winner's
    // verdict; that's the rule that gets `applied` (if the layer
    // is the global winner). Subsequent rules with the same verdict
    // are `noop`; rules with a less-restrictive verdict are
    // `shadowed`.
    let winnerAssigned = false
    for (const r of rules) {
      if (r.verdict === layerVerdict && !winnerAssigned) {
        r.status = isGlobalWinnerLayer ? "applied" : "shadowed"
        winnerAssigned = true
      } else if (r.verdict === layerVerdict) {
        r.status = "noop"
      } else {
        r.status = "shadowed"
      }
    }
  }

  // Format the final reason. The framing depends on the verdict:
  //   - "allow" doesn't reach here.
  //   - "deny"  → tool-implicating rejection with the rule's reason
  //               (or matched rule id) surfaced as steering context.
  //               See `formatDenyReason` for the full layout.
  //   - "ask"   → "Permission requested: ..." (a rule fired; the user
  //               will see an interactive modal — this reason is what the
  //               modal displays as context, not a rejection message).
  const finalVerdict: Verdict = globalWinner.verdict
  const appliedRules = ruleTrail.filter((r) => r.status === "applied")
  const reasonParts = appliedRules.map((r) => r.reason ?? "").filter((r) => r.length > 0)
  const reason =
    finalVerdict === "deny"
      ? buildDenyReason({
          toolName: event.toolName,
          modeName: currentModeName,
          appliedRules,
          reasonParts,
          // The new model considers a default-only deny (no other
          // layer's rules) to still be an "explicit rule fired" from
          // the deny-reason formatter's perspective — the default
          // rule is a real rule with a real verdict. The "no rule
          // matched" middle block now only triggers when the default
          // itself has no verdict, which is impossible by
          // construction. Kept as `applied.length > 0` for safety.
          explicitRuleFired: appliedRules.length > 0,
        })
      : formatAskReason(ruleTrail)

  return {
    action: finalVerdict,
    reason,
    ruleTrail,
    effectiveTags,
    directoryGuardrailFired: false,
  }
}

// ─── deny-reason formatting ──────────────────────────────────────────────────

/**
 * Inputs to the deny-reason formatter. Split out as a named struct so
 * the call site is readable and tests can construct cases without
 * going through the full `evaluate()` pipeline.
 */
interface DenyReasonArgs {
  toolName: string
  modeName: string
  /**
   * The applied rules from the matcher trail, in evaluation order.
   * Used to synthesize the "no reason" middle block from the first
   * applied rule's id (or the rule's pattern for aspect-layer rules).
   */
  appliedRules: readonly RuleResult[]
  /**
   * The reasons from the applied rules, in evaluation order. Empty
   * for the "no reason" case (rule has no `reason` field, or the
   * deny came from `defaultDecision` with no explicit rule).
   */
  reasonParts: readonly string[]
  /**
   * `false` when the deny came from `defaultDecision` with no
   * explicit rule (the "default-deny" sub-case). The middle block
   * is formatted differently to surface that.
   */
  explicitRuleFired: boolean
  /**
   * The user-typed reason from the interactive prompt (the "one-off"
   * case). When present, this takes precedence over the configured
   * reasons from `reasonParts` for the middle block — the user just
   * told the agent why *now*; that's more timely than whatever the
   * on-disk rule says.
   */
  userReason?: string
}

/**
 * Public entry point. Builds the full deny reason the agent sees
 * when a call is blocked. Three-part layout, separated by blank lines:
 *
 *   1. Headline — tool + mode, in the form
 *      `The agent was not permitted to call the `<tool>` tool in `<mode>` mode.`
 *      The mode is part of the headline so the agent can see *which*
 *      mode's policy fired; rules are modal, so the same rule id in
 *      different modes can mean different things.
 *
 *   2. Middle block — varies by reason availability:
 *      - One-off reason (user typed it at the prompt this session):
 *          `User's reason for denying: "..."` — takes precedence over
 *          configured reasons; the user just told the agent *why now*.
 *      - Configured reason (rule has a `reason` field):
 *          `Reason from the rule: "..."` (one quoted reason; if
 *          multiple rules with reasons fired, the strings are joined
 *          with `; ` inside the single quoted span).
 *      - No reason: `Matched rule: <id>` where `<id>` is the most
 *        useful identifier for the layer (`tool:<name>` for tool-layer,
 *        `<pattern>` for aspect-layer, `tag:<name>` for tag-layer).
 *      - Default-deny (no rule matched, mode defaults to deny):
 *          `Default mode decision: deny (no rule matched)`.
 *
 *   3. Suffix — the steering instruction. Identical across all states:
 *      `Analyze why this call was blocked and adjust your approach accordingly.`
 *      The agent decides whether "different tool", "different
 *      parameters", or "ask the user to adjust" is the right
 *      response; the suffix doesn't prescribe.
 *
 * All states share the headline and suffix. The middle block is
 * the only piece that varies.
 *
 * Exported for tests.
 */
export function buildDenyReason(args: DenyReasonArgs): string {
  const headline = `The agent was not permitted to call the \`${args.toolName}\` tool in \`${args.modeName}\` mode.`
  const middle = formatDenyMiddleBlock(args)
  const suffix = "Analyze why this call was blocked and adjust your approach accordingly."
  return [headline, middle, suffix].join("\n\n")
}

function formatDenyMiddleBlock(args: DenyReasonArgs): string {
  // 1. One-off reason from the user at the prompt. Wins over the
  //    configured reasons: the user just told us *now*, which is
  //    more timely than whatever the on-disk rule says.
  if (args.userReason && args.userReason.length > 0) {
    return `User's reason for denying: "${args.userReason}"`
  }

  // 2. Configured reason: at least one applied rule has a non-empty
  //    reason. Quoted; multiple reasons joined with "; " inside the
  //    same quoted span.
  const nonEmptyReasons = args.reasonParts.filter((r) => r.length > 0)
  if (nonEmptyReasons.length > 0) {
    return `Reason from the rule: "${nonEmptyReasons.join('"; "')}"`
  }

  // 3. Default-deny sub-case: no rule matched, mode defaults to deny.
  //    Surface this explicitly so the agent knows adjusting a rule
  //    won't help — the mode itself is deny-by-default.
  if (!args.explicitRuleFired) {
    return "Default mode decision: deny (no rule matched)"
  }

  // 4. No reason: show the matched rule's id. Pick the most useful
  //    identifier per layer: aspect-layer uses the pattern (the rule
  //    shape), tool-layer uses `tool:<name>`, tag-layer uses
  //    `tag:<name>`, default uses `<default>`.
  const firstApplied = args.appliedRules[0]
  if (!firstApplied) {
    // Defensive: explicitRuleFired was true but no applied rules in
    // the trail. Shouldn't happen in practice, but fall back to a
    // generic "deny" line rather than producing a malformed message.
    return "Matched rule: (unknown)"
  }
  let id: string
  if (firstApplied.layer === "aspect" && firstApplied.pattern) {
    id = firstApplied.pattern
  } else if (firstApplied.layer === "tool") {
    id = `tool:${firstApplied.key}`
  } else if (firstApplied.layer === "tag") {
    id = `tag:${firstApplied.key}`
  } else {
    id = `${firstApplied.layer}:${firstApplied.key}`
  }
  return `Matched rule: ${id}`
}

/**
 * Format the reason shown to the user when a tool call lands in the
 * `ask` state. The interactive modal displays this as context (it's
 * not a rejection — the user is the one deciding). We keep the
 * existing prefix-and-id format for now; the steering-layout work is
 * for the deny path.
 */
function formatAskReason(ruleTrail: readonly RuleResult[]): string {
  const firstApplied = ruleTrail.find((r) => r.status === "applied")
  if (firstApplied) {
    let src: string
    if (firstApplied.layer === "aspect" && firstApplied.pattern) {
      src = firstApplied.pattern
    } else {
      src = `${firstApplied.layer}:${firstApplied.key}`
    }
    return `Permission requested: ${src}`
  }
  return "Permission requested"
}
