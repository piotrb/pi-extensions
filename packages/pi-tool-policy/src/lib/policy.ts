import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { genericPatternToRegex } from "@piotrb/pi-extension-utils"

import { matchAspect, matchAspectEach } from "./aspects.ts"
import type { AnyVerdict, Config, PolicyDecision, ResolvedToolMetadata, RuleResult, Verdict } from "./types.ts"
import { baseMode, isArrayMode } from "./types.ts"

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
 * Evaluate a single tool_call event against the active mode's rules.
 *
 * Single-pass fold: tagRules + aspectRules + toolRules contribute verdicts;
 * defaultDecision is the fall-through. Most-restrictive wins. The rule trail
 * captures applied/suppressed/noop for the UI:
 *   - applied: rule's verdict was the running winner at the time it was added
 *   - suppressed: rule's verdict was less restrictive than the running winner
 *   - noop: rule's verdict matched the running winner at the time it was added
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
  // No decision yet — the defaultDecision is the *baseline*, not a rule
  // that always wins. We seed winningVerdict from the default only if
  // no explicit rule (tagRules / aspectRules / toolRules) fires. This
  // way `tagRules.readonly: "allow"` properly allows readonly tools
  // even when `defaultDecision` is `"ask"`, matching the standard
  // precedence: explicit rules > default.
  let winningVerdict: Verdict | undefined = undefined
  const reasonParts: string[] = []

  /** True after at least one explicit rule (tag/aspect/tool) fired. */
  let explicitRuleFired = false

  /** Contribute a rule's verdict to the running combine. */
  function contribute(
    layer: RuleResult["layer"],
    key: string,
    v: AnyVerdict,
    extras: { aspect?: string; pattern?: string } = {},
  ): void {
    const { verdict, reason } = normalizeVerdict(v)
    const strictness = STRICTNESS[verdict]
    const winningStrictness = winningVerdict === undefined ? -1 : STRICTNESS[winningVerdict]

    let status: RuleResult["status"]
    if (winningVerdict === undefined) {
      // First rule to fire: always applied.
      status = "applied"
      winningVerdict = verdict
    } else if (strictness > winningStrictness) {
      status = "applied"
      winningVerdict = verdict
    } else if (strictness < winningStrictness) {
      status = "suppressed"
    } else {
      status = "noop" // same value as the running winner
    }

    ruleTrail.push({ layer, key, aspect: extras.aspect, pattern: extras.pattern, verdict, reason, status })
    if (status === "applied" && reason) {
      reasonParts.push(reason)
    }
  }

  // 1. tagRules: for each tag in effectiveTags, look up tagRules[tag]
  for (const tag of effectiveTags) {
    const v = mode.tagRules[tag]
    if (v !== undefined) {
      contribute("tag", tag, v)
      explicitRuleFired = true
    }
  }

  // 2. aspectRules: for each declared aspect binding on the tool, run the aspect matcher
  const meta = toolMetadata.get(event.toolName)
  if (meta) {
    const args = event.input as Record<string, unknown>
    for (const [aspectName, decl] of Object.entries(meta.fields)) {
      const aspectRule = mode.aspectRules[aspectName]
      if (!aspectRule) continue

      // Array mode (`mode: "X[]"`) — iterate per element and combine
      // deny > ask > allow. Scalar mode — coerce and match as one.
      const baseName = isArrayMode(decl.mode) ? baseMode(decl.mode) : aspectName

      for (const field of decl.fields) {
        // AspectDeclaration.fields is `string[]` — the field name is the string.
        const value = args[field]
        if (value === undefined || value === null) continue

        if (isArrayMode(decl.mode)) {
          // Array mode requires the value to be a string[]; anything else
          // is a schema violation — skip and let the default verdict win.
          if (!Array.isArray(value)) continue
          const result = matchAspectEach(baseName, value as string[], aspectRule, ctx.cwd)
          if (result === "undecided") continue
          contribute("aspect", field, result.verdict, { aspect: aspectName, pattern: result.pattern })
          explicitRuleFired = true
          continue
        }

        const s = coerceForMatch(value)
        if (!s) continue
        const result = matchAspect(aspectName, s, aspectRule, ctx.cwd)
        if (result === "undecided") continue
        contribute("aspect", field, result.verdict, { aspect: aspectName, pattern: result.pattern })
        explicitRuleFired = true
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
        explicitRuleFired = true
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
        explicitRuleFired = true
      }
    }
  }

  // 4. defaultDecision: the baseline. Contributed as a rule only if no
  // explicit rule (tag/aspect/tool) fired, so an explicit `allow` on
  // tagRules / aspectRules / toolRules is not overridden by the default.
  if (!explicitRuleFired) {
    contribute("default", "<default>", mode.defaultDecision)
  } else {
    // Record the default in the trail as a "noop" (it didn't apply, but
    // it's still useful debug context for the user to see what the
    // baseline would have been).
    const { verdict, reason } = normalizeVerdict(mode.defaultDecision)
    ruleTrail.push({
      layer: "default",
      key: "<default>",
      verdict,
      reason,
      status: "noop",
    })
  }

  // Format the final reason. The framing depends on the verdict:
  //   - "allow" doesn't reach here.
  //   - "deny"  → tool-implicating rejection with the rule's reason
  //               (or matched rule id) surfaced as steering context.
  //               See `formatDenyReason` for the full layout.
  //   - "ask"   → "Permission requested: ..." (a rule fired; the user
  //               will see an interactive modal — this reason is what the
  //               modal displays as context, not a rejection message).
  const normalizedDefault: Verdict =
    typeof mode.defaultDecision === "string" ? mode.defaultDecision : mode.defaultDecision.verdict
  // Use the explicit `explicitRuleFired` boolean as the source of
  // truth (TS narrows `winningVerdict` to `Verdict` after closure
  // analysis, defeating any direct undefined check).
  const finalVerdict: Verdict = explicitRuleFired ? (winningVerdict as unknown as Verdict) : normalizedDefault
  const reason =
    finalVerdict === "deny"
      ? buildDenyReason({
          toolName: event.toolName,
          modeName: currentModeName,
          appliedRules: ruleTrail.filter((r) => r.status === "applied"),
          reasonParts,
          explicitRuleFired,
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
