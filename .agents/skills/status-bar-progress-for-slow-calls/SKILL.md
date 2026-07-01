---
name: status-bar-progress-for-slow-calls
description: When a tool call, gate, or extension takes more than ~1 second, surface progress to the user via the status bar (ctx.ui.setStatus). A frozen screen reads as "the agent is hung" and erodes trust. Use whenever an extension is going to call out to a slow API.
---

# Status-bar progress for slow tool calls

A `tool_call` handler that takes more than ~1 second without showing the user any progress reads as a hung agent. The user does not know whether the tool is slow, the LLM is slow, or the session is broken. Surface progress through `ctx.ui.setStatus(key, text)` so the user has a live signal.

This is not optional UX polish — it's a trust mechanism. A status indicator that says "gate: querying claude-haiku-4-5…" tells the user "the system is doing what I asked." A frozen screen tells the user nothing.

## When to Use

Lead with the symptom: "The user reported the agent was frozen, but the tool was actually running." Use this skill when:

- An extension's `tool_call` handler is going to call a slow API (LLM, network, file system, subprocess).
- An LLM-based gate or evaluator takes more than 1s in the common case.
- A long-running command needs visible feedback to distinguish "running" from "hung."
- Streaming events are available (text deltas, thinking deltas, progress updates).

## Key Facts

- **The status bar is cheap.** `ctx.ui.setStatus(key, text)` is non-blocking. Frequent updates (multiple per second) are fine. Throttling is unnecessary at human-readable update rates.
- **The key is the slot, the text is the content.** A stable key (e.g. `do-it-right-model`) means updates to the same indicator. A transient state ("querying…", "thinking…", "responding…") followed by a final state ("allow", "block: rule 3") is the right shape.
- **Auto-revert after a beat.** After a successful pass, the verdict ("allow") should appear briefly, then revert to the long-running indicator. After a block, the verdict should stay long enough to read. After an error, restore the model indicator immediately.
- **Streaming is the strongest signal.** If the LLM API supports streaming (text deltas, thinking deltas), drive the status updates from the events. The user sees the LLM work in real time, which is much more reassuring than a static "thinking…" placeholder.
- **Don't surface this for fast operations.** If the handler finishes in 100ms, no status update is needed — the user never sees "frozen" because they don't perceive a gap.
- **The status text should be specific.** "Running..." is unhelpful. "Gate: querying claude-haiku-4-5 (thinking)…" tells the user exactly what is happening. Reserve the generic text for genuinely opaque cases.

## Steps

1. **Pick a stable key.** One per extension. e.g. `do-it-right-model`. Reuse across status changes.
2. **Set the initial state immediately.** Before the slow call, `setStatus(key, "gate: querying <model>…")`. The user sees the request start.
3. **Wire streaming events to status updates.** If the API streams (e.g. `stream()` from pi-ai), pass an `onEvent` callback that updates the status:
   - `text_start` / `text_delta` → "responding…"
   - `thinking_start` / `thinking_delta` → "thinking…"
4. **Set the final state on completion.** The verdict text (e.g. "block: rule 3 — rm -rf"). Schedule a revert after 1.5s (allow) or 4s (block) so the user can read it, then restore the long-running indicator.
5. **On error, restore immediately.** Don't leave "evaluating..." on screen if the call failed. Replace with a brief error state and revert.

## Notes

- The model indicator (e.g. "gate: anthropic/claude-haiku-4-5") is the resting state. It tells the user "the system is configured and ready" without further detail.
- This is related to but distinct from `ctx.ui.setWidget` (the rules viewer) and `ctx.ui.notify` (transient popups). The status bar is for _ongoing_ state, not one-off events.
- pi-tui's `setStatus` does not clear automatically. If you set a status, you must set it again to clear or change it. Use `setStatus(key, undefined)` to remove the indicator entirely.
- Surfaced in the implementation of `pi-do-it-right` — see the `tool_call` handler's status bar updates and the streaming integration in `evaluateStream`.
- The "auto-revert after a beat" pattern uses `setTimeout`. The 1.5s/4s timings are user-tested defaults; if a particular gate's verdicts are long, raise the revert time.
