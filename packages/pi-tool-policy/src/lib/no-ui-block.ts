import type { ToolCallEvent } from "@earendil-works/pi-coding-agent"

import type { PolicyDecision } from "./types.ts"

/**
 * Build the `block` reason returned by the policy when an `ask`
 * verdict fires in a context where no UI is available
 * (`ctx.hasUI === false`, e.g. a subagent, `--mode json`,
 * `--mode print`, or any RPC client that doesn't handle
 * `extension_ui_request`).
 *
 * The matcher would normally open an interactive modal for the
 * user to choose allow/deny. Without a UI, the modal is a no-op
 * and would either hang (RPC client that ignores the request) or
 * resolve immediately with `undefined` (print/json mode), which
 * the policy treats as a dismissal and blocks anyway. The user
 * gets a generic "Denied by user" reason that doesn't tell them
 * what actually happened or what to do.
 *
 * This helper produces an actionable reason instead. It names the
 * tool, names the matched rule (so the user knows which rule
 * would have prompted), explains the no-UI situation, and gives
 * the user the two real ways out: pre-approve the rule in their
 * config, or re-run the call from a top-level session where the
 * prompt can be shown.
 *
 * The reason is rendered as a single block of text — the agent
 * (or the user reading the tool result) sees the whole story in
 * one place, with no need to click through to a sub-modal.
 *
 * Exported for unit tests.
 */
export function buildNoUIBlockReason(
  event: Pick<ToolCallEvent, "toolName">,
  decision: PolicyDecision,
  currentMode: string,
): string {
  const tool = event.toolName
  const ruleHint = decision.reason ?? "no rule (default behavior)"
  return [
    `The \`${tool}\` tool call needs user approval, but this is running in a non-interactive context (subagent, print mode, or a client without UI).`,
    `Matched rule in \`${currentMode}\` mode: ${ruleHint}.`,
    "",
    "Two ways to unblock:",
    `  1. Pre-approve the call in your config — e.g. add \`toolRules.${tool}\` or relax the relevant \`tagRules\` / \`aspectRules\` for the \`${currentMode}\` mode.`,
    "  2. Re-run this call from a top-level session, where the prompt can be shown and you can allow/deny directly.",
  ].join("\n")
}
