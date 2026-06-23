import type { ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

import { buildNoUIBlockReason } from "./no-ui-block.ts"
import type { PolicyDecision } from "./types.ts"

function makeEvent(toolName: string): Pick<ToolCallEvent, "toolName"> {
  return { toolName }
}

function makeDecision(reason: string | undefined): PolicyDecision {
  return {
    action: "ask",
    reason,
    ruleTrail: [],
    effectiveTags: [],
    directoryGuardrailFired: false,
  }
}

describe("buildNoUIBlockReason", () => {
  it("names the tool, the matched rule, and the no-UI situation in one block", () => {
    const reason = buildNoUIBlockReason(
      makeEvent("bash"),
      makeDecision("Permission requested: tag:execution"),
      "default",
    )
    expect(reason).toContain("`bash` tool call")
    expect(reason).toContain("non-interactive context")
    expect(reason).toContain("Permission requested: tag:execution")
    expect(reason).toContain("`default` mode")
  })

  it("gives the user two concrete ways to unblock", () => {
    const reason = buildNoUIBlockReason(makeEvent("bash"), makeDecision("x"), "default")
    // The first action: pre-approve in config. Must mention toolRules
    // as the most direct option, and the mode name so the user knows
    // which block to edit.
    expect(reason).toMatch(/toolRules\.bash|Pre-approve.*config/i)
    expect(reason).toContain("`default` mode")
    // The second action: re-run from a top-level session. Must say
    // "top-level" so the user understands this is about the session
    // context, not the file location.
    expect(reason).toMatch(/top-level session/i)
  })

  it("falls back to 'no rule (default behavior)' when the decision has no reason", () => {
    const reason = buildNoUIBlockReason(makeEvent("bash"), makeDecision(undefined), "default")
    // The fallback must be present (NOT the empty string) so the
    // user always sees what triggered the block.
    expect(reason).toContain("no rule (default behavior)")
  })

  it("includes the mode name in both the rule hint and the config-action suggestion", () => {
    const reason = buildNoUIBlockReason(makeEvent("read"), makeDecision("x"), "plan")
    // The user needs to see the mode in BOTH places — once in the
    // rule hint ("Matched rule in `plan` mode") and once in the
    // config suggestion (the `plan` mode is the one to edit).
    const planOccurrences = (reason.match(/`plan`/g) ?? []).length
    expect(planOccurrences).toBeGreaterThanOrEqual(2)
  })

  it("renders as multi-line prose with a blank line separating the explanation from the action list", () => {
    const reason = buildNoUIBlockReason(makeEvent("bash"), makeDecision("x"), "default")
    // Multi-line: the helper produces line breaks (one per prose
    // element) and a single blank line between the explanation
    // and the action list. The blank line is intentional — it
    // gives the user a visual break to scan the prose and then
    // the actions.
    expect(reason).toContain("\n")
    // The blank line must be a SINGLE blank line, not multiple
    // (which would split the block into confusing paragraphs).
    expect(reason).not.toContain("\n\n\n")
    // The action list starts with a 2-space indent on each item.
    expect(reason).toMatch(/\n  1\./)
  })
})
