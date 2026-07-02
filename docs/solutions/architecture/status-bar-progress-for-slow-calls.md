---
title: status-bar progress for slow tool calls (setStatus with auto-revert + streaming integration)
category: architecture
severity: medium
tags:
  - status-bar
  - setStatus
  - progress
  - streaming
  - trust
  - ux
  - tool-call
  - ctx.ui
  - pi-tui
applies_when:
  - a tool_call handler is going to call out to a slow API (LLM, network, file system, subprocess)
  - an LLM-based gate or evaluator takes more than 1s in the common case
  - a long-running command needs visible feedback to distinguish running from hung
  - streaming events are available (text deltas, thinking deltas, progress updates)
  - designing a tool, gate, or extension that should not read as "frozen"
---

# Problem

A `tool_call` handler that takes more than ~1 second without showing the user any progress reads as a hung agent. The user does not know whether the tool is slow, the LLM is slow, or the session is broken. Surface progress through `ctx.ui.setStatus(key, text)` so the user has a live signal.

This is not optional UX polish — it's a trust mechanism. A status indicator that says "gate: querying claude-haiku-4-5…" tells the user "the system is doing what I asked." A frozen screen tells the user nothing.

# Context

The status bar in `pi-tui` is a non-blocking, persistent display surface. Each `setStatus(key, text)` call updates a single slot; multiple updates per second are fine. The status bar does **not** clear automatically — if you set a status, you must set it again to clear or change it. Use `setStatus(key, undefined)` to remove the indicator entirely.

The three pi-tui feedback surfaces are:

- **`ctx.ui.setStatus(key, text)`** — for **ongoing** state. The user sees the indicator persist; updates replace the previous text.
- **`ctx.ui.setWidget(key, component)`** — for richer content (the rules viewer, the modal body). Survives across tool calls.
- **`ctx.ui.notify(message, level)`** — for **transient** one-off popups. Auto-dismiss after a few seconds.

Use `setStatus` for "the system is doing X right now." Use `setWidget` for "the system has a panel showing Y." Use `notify` for "this just happened."

# Solution

## When to use

Lead with the symptom: "The user reported the agent was frozen, but the tool was actually running." Use this solution when:

- An extension's `tool_call` handler is going to call a slow API (LLM, network, file system, subprocess).
- An LLM-based gate or evaluator takes more than 1s in the common case.
- A long-running command needs visible feedback to distinguish "running" from "hung."
- Streaming events are available (text deltas, thinking deltas, progress updates).

**Do not surface progress for fast operations.** If the handler finishes in 100ms, no status update is needed — the user never sees "frozen" because they don't perceive a gap.

## The pattern

The key/text/auto-revert pattern:

1. **The key is the slot, the text is the content.** A stable key (e.g. `do-it-right-model`) means updates to the same indicator. A transient state ("querying…", "thinking…", "responding…") followed by a final state ("allow", "block: rule 3") is the right shape.
2. **The status text should be specific.** "Running..." is unhelpful. "Gate: querying claude-haiku-4-5 (thinking)…" tells the user exactly what is happening. Reserve the generic text for genuinely opaque cases.
3. **Auto-revert after a beat.** After a successful pass, the verdict ("allow") should appear briefly, then revert to the long-running indicator. After a block, the verdict should stay long enough to read. After an error, restore the model indicator immediately.
4. **Streaming is the strongest signal.** If the LLM API supports streaming (text deltas, thinking deltas), drive the status updates from the events. The user sees the LLM work in real time, which is much more reassuring than a static "thinking…" placeholder.
5. **The status bar is cheap.** `ctx.ui.setStatus(key, text)` is non-blocking. Frequent updates (multiple per second) are fine. Throttling is unnecessary at human-readable update rates.

## Steps

1. **Pick a stable key.** One per extension. e.g. `do-it-right-model`. Reuse across status changes.
2. **Set the initial state immediately.** Before the slow call, `setStatus(key, "gate: querying <model>…")`. The user sees the request start.
3. **Wire streaming events to status updates.** If the API streams (e.g. `stream()` from pi-ai), pass an `onEvent` callback that updates the status:
   - `text_start` / `text_delta` → "responding…"
   - `thinking_start` / `thinking_delta` → "thinking…"
4. **Set the final state on completion.** The verdict text (e.g. "block: rule 3 — rm -rf"). Schedule a revert after 1.5s (allow) or 4s (block) so the user can read it, then restore the long-running indicator.
5. **On error, restore immediately.** Don't leave "evaluating..." on screen if the call failed. Replace with a brief error state and revert.

## Reference implementation: `pi-do-it-right`

`pi-do-it-right` is the canonical example. Its `tool_call` handler:

- Sets the initial state `setStatus("do-it-right-model", "gate: querying <model>…")` before the LLM call.
- Wires the LLM's streaming events to status updates (text/thinking deltas → "responding…" / "thinking…").
- Sets the final state with the verdict: `setStatus("do-it-right-model", "allow")` or `setStatus("do-it-right-model", "block: rule 3 — rm -rf")`.
- Schedules a revert: 1.5s after an allow, 4s after a block.
- On error: `setStatus("do-it-right-model", "error: <message>")` and revert immediately.

The pattern is in `packages/pi-do-it-right/src/extensions/do-it-right.ts` and `packages/pi-do-it-right/src/lib/evaluate.ts` (`evaluateStream`).

## Auto-revert timings

The "auto-revert after a beat" pattern uses `setTimeout`. The 1.5s/4s timings are user-tested defaults:

- **Allow verdict (1.5s)** — the user doesn't need to read an allow; it just confirms "I evaluated this, it's fine." Brief acknowledgment, then back to the model indicator.
- **Block verdict (4s)** — the user needs to read the block reason. "block: rule 3 — rm -rf" tells them what was blocked and why. Long enough to read, then revert.
- **Error (immediate revert)** — the user knows something failed from the error state; lingering on it erodes trust.

If a particular gate's verdicts are long, raise the revert time. If the user reports "I never see the allow flash," raise the allow time.

# Why this works

- **The status bar is cheap and non-blocking.** `setStatus` is fire-and-forget. Frequent updates are fine. The cost of a status update is negligible compared to the cost of the user thinking the agent is hung.
- **The user perceives "running" vs "hung" in <1 second.** Without progress, a 2-second wait looks the same as a 30-second wait. With progress, the user sees the system working and waits patiently. The 1-second threshold is a UX guideline, not a hard limit.
- **Stable keys preserve slot identity.** A `do-it-right-model` slot shows the same indicator across status changes; the user learns "this slot is the LLM gate's status." A transient key would flash different indicators and lose the visual association.
- **Auto-revert is the right shape for transient final states.** A verdict ("allow", "block: rule 3") is a moment, not a state. The model indicator is the resting state. The revert is the signal "evaluation is done; back to idle."
- **Streaming events are the strongest signal.** A static "thinking…" is a placeholder; a streaming "thinking…" reflects actual LLM progress. The user sees the LLM work in real time.

# Prevention

- **Do not surface progress for fast operations.** A 100ms handler with a status update is noise. The user sees the indicator flash and miss the actual completion.
- **Do not use a transient key for the indicator.** The key is the slot; the text is the content. A new key per update would scatter indicators across the status bar and lose visual association.
- **Do not leave a transient state on the screen forever.** "Evaluating..." with no revert is a UX anti-pattern. The user sees "evaluating" but never sees the verdict. Always revert (to the model indicator or a final verdict state).
- **Do not use generic text when specific text is possible.** "Running..." is unhelpful. "Gate: querying claude-haiku-4-5 (thinking)…" is specific. The user can debug "why is this slow" from a specific text.
- **Do not block the main thread to update the status.** `setStatus` is async; updates from streaming event callbacks are non-blocking. Don't `await` the status update.
- **Do not confuse the three feedback surfaces.** `setStatus` is for ongoing state; `setWidget` is for richer persistent content; `notify` is for transient popups. The wrong surface reads as bad UX.
- **Do not throttle updates at human-readable rates.** `setStatus` is cheap. Throttling at 4Hz (or any rate below the streaming event rate) loses the real-time signal. Throttling is only useful if updates are too fast to read (e.g. 100Hz sub-millisecond updates), which streaming events do not produce.

# Verification

- **Slow path:** a tool call that takes >1s with a `setStatus` call before it shows the indicator to the user. The user sees "gate: querying…" until the verdict appears, then the verdict (1.5s/4s), then revert to the model indicator.
- **Streaming path:** an LLM-based tool call wired to streaming events shows "thinking…" or "responding…" as the LLM produces tokens, then the final verdict.
- **Fast path:** a 100ms tool call with no `setStatus` does not show a status indicator. The user sees the result with no flash.
- **Error path:** a failed LLM call shows "error: <message>" briefly, then reverts to the model indicator. The user sees the error, not a stuck "evaluating…".
- **Slot identity:** a `do-it-right-model` slot is consistent across the extension's lifetime. Updates to the slot use the same key. Other extensions do not clobber the slot (use a different key).

# Related

- `no-cache-for-user-mutable-data` — a parallel "design discipline" solution for the caching decision. Both are about right-sizing behavior at the API surface.
- `pi-lifecycle-hooks` — the `ctx.ui.notify` example in the lifecycle solution. The notify is a transient popup; the status bar is the persistent slot.
- `pi-tool-policy-mode-controller` — `refreshStatusBar(ctx)` updates the mode indicator (`mode: <name> (Alt+M)`). The mode indicator is a different slot from the slow-call progress indicator; they coexist on the same bar with different keys.
- `pi-do-it-right` — the reference implementation. The `tool_call` handler and `evaluateStream` are the live example.
