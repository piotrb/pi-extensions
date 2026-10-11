---
title: streaming widget for streaming calls (setWidget above the editor with auto-clear)
category: architecture
severity: medium
tags:
  - setWidget
  - streaming
  - llm-gate
  - ux
  - pi-do-it-right
  - pi-extension
applies_when:
  - an extension's tool_call handler streams LLM output (text/thinking deltas)
  - the single-line setStatus progress is too thin to convey the verdict reasoning
  - the user needs to see what the model actually said before the call resumes
  - designing an LLM-aware gate or evaluator that takes >1s in the common case
---

# Problem

`ctx.ui.setStatus(key, text)` is the right surface for coarse-grained
"the gate is querying model X…" progress. But the status bar is a
single line. When the LLM's _verdict reasoning_ is the high-signal
information (e.g. "rule 3: bash_cmd `rm -rf` violates the no-destroy
rule"), a single-line status string can carry at most the first line
of the reason — and even then only at the cost of crowding out the
model indicator during the flash window.

`ctx.ui.setWidget(key, lines)` is a richer surface: a list of text
lines that pi renders above or below the editor. It survives across
tool calls until cleared with `undefined`. This is the right home for
"live stream of LLM output, then verdict, then clear."

The status-bar and widget surfaces are complementary, not exclusive.
The widget shows the reasoning; the status bar keeps the indicator in
the user's peripheral vision (so they know the system is still
working even when the widget is many lines deep).

# Context

`pi-do-it-right`'s Test Evaluation subcommand
(`/do-it-right` → Test Evaluation) showed a streaming widget for
years. The Test Evaluation path is a user-initiated probe — the user
typed a command and asked "would this be allowed?" — so the widget is
the _primary_ observation surface and stays on screen until the user
dismisses it.

The live `tool_call` gate, by contrast, only updated the status bar
with coarse phases (`querying…` / `thinking…` / `responding…`). When
a bash call took a few seconds to evaluate, the user saw a status bar
flicker but no reasoning — they had no way to see why the model
chose its verdict. This was a real UX gap that contradicted the
documented "streaming events are the strongest signal" principle in
the status-bar solution (see Related).

The fix was to promote the streaming widget to the live gate path,
sharing the same buffer/render logic via a single helper that both
call sites use. The widget auto-clears on the live path because a
blocked-or-allowed bash call is a moment, not a state — the model
indicator is the resting state.

# Solution

## The two feedback surfaces, side by side

| Surface     | Where                    | Best for                           |
| ----------- | ------------------------ | ---------------------------------- |
| `setStatus` | status bar (single line) | "the system is doing X right now"  |
| `setWidget` | block above the editor   | "the system has a panel showing Y" |
| `notify`    | transient popup          | "this just happened"               |

The widget is the right home for streaming reasoning. `setStatus`
remains the right home for the persistent indicator. They are not
mutually exclusive; the live gate runs both.

## The helper contract

A streaming-widget helper should expose three operations to the
caller:

```ts
const streaming = startStreamingWidget(command, ctx)

result = await evaluateStream(rules, command, model, opts, (event) => {
  streaming.onEvent(event) // buffers / renders per event
  // …status-bar coarse-grained updates run alongside the widget renders
})

if (result.ok) {
  streaming.finish("allow", result.reason, 1500) // auto-clears after 1.5s
} else {
  streaming.finish("block", result.reason, 4000) // block stays longer
}
```

The `onEvent` callback owns event-type → render mapping
(`thinking_start` clears the buffer; `thinking_delta` appends;
`thinking_end` folds into "completed thinking"; `text_delta`
appends). The `finish(verdict, reason, clearAfterMs)` appends the
verdict marker + reason on its own line(s), then schedules a
`setWidget(key, undefined)` after `clearAfterMs`. `clear()` is a
no-timeout drop for the fail-open path.

## Where the widget goes: above vs below

`setWidget` accepts an `aboveEditor` (default) or `belowEditor`
placement. Above is right for tool-call progress: the user's eyes are
on the prompt at the bottom of the screen, and a panel sitting above
the prompt is in their natural reading flow. Below is right for
content the agent reads (the per-call log the agent can scroll back
into), not user-facing progress.

## Auto-clear timings

| Path            | Clear timing | Why                                                 |
| --------------- | ------------ | --------------------------------------------------- |
| Live gate allow | 1500ms       | symmetric with status-bar flash timer               |
| Live gate block | 4000ms       | blocked calls deserve a beat to read why            |
| Test Evaluation | indefinite   | the user's observation surface, not transient state |

Allow and block times match the status-bar flash timers so the two
indicators fade together. Block stays longer because the user is
more likely to read the rule they just violated. Test Evaluation
leaves the widget until the user dismisses it (the notify carries
the short-form verdict).

## Future-toggle-ready

Wrap the gate logic in a single decision point so a future settings
toggle (e.g. `settings.showStreamingWidget = true`) can disable the
widget on both call sites in one change:

```ts
const useStreamingWidget = (): boolean => true // today

// caller:
const streaming = useStreamingWidget() ? startStreamingWidget(command, ctx) : null
// streaming?.onEvent, streaming?.finish, etc. — null-safe everywhere
```

When the toggle lands, only `useStreamingWidget` changes. The status-
bar path is unaffected (the user always gets the coarse indicator).

## Don't block the thread to render

`setWidget(key, lines)` is fire-and-forget. Updates from streaming
event callbacks are non-blocking. Don't `await` the widget update —
just call it and move on. The render and the next token emission
interleave at the microtask level.

# Why this works

- **Widget survives across tool calls** — the next gate's widget
  replaces it in place via the same key (`setWidget(key, …)` is a
  full replace), so the user never sees stacked widgets from
  overlapping gate calls.
- **Streaming events are the strongest signal** (same reasoning as
  the status-bar solution): a static placeholder is a UX tax. A
  streaming widget shows the LLM working in real time.
- **Auto-clear is the right shape for transient final states.** A
  verdict is a moment, not a state. The widget's purpose is to
  show the moment; the resting state is the model indicator on
  the status bar.

# Prevention

- **Do not skip the empty-state guard.** If the model has produced
  no events yet (zero-length buffer), `setWidget(key, [""])` would
  render a stray empty line. Render only when there's something
  to show — first render is a `[thinking] …` placeholder so the
  slot is occupied before the first delta arrives.
- **Do not block the tool_call handler awaiting widget renders.**
  The handler is async; the streaming event callback fires as
  events arrive. Awaiting renders introduces delays between events
  the user can't see (since `setWidget` is fire-and-forget anyway).
- **Do not leave the widget on screen on the failure path.** If
  `evaluateStream` throws and we fall back to fail-open, call
  `streaming.clear()` (or `setWidget(key, undefined)` directly)
  before returning `undefined`. Otherwise the user sees a
  half-rendered gate after the call has been let through
  unchanged.
- **Do not throttle widget renders at human-readable rates.** The
  widget is cheap to update. Throttling at 4Hz (or any rate below
  the streaming event rate) loses the real-time signal.
- **Do not use `setNotify` for streaming.** `notify` is a transient
  popup with auto-dismiss. It's wrong for streaming — the user
  would see one popup per event and lose the running thread of
  reasoning.
- **Do not couple the widget clear to the status-bar revert.** A
  refactor that ties the two timers together will cause one to
  fall out of sync on the next timing change. Treat them as
  independent indicators.

# Verification

- **Slow live path:** a bash call that takes 2-3s to evaluate shows
  thinking → responding → verdict (with reason text) → auto-clear
  over ~4s total.
- **Rapid live path:** two bash calls in quick succession replace the
  widget in place (same key) — the user never sees two widgets
  stacked.
- **Failure path:** a `evaluateStream` throw clears the widget
  before returning `undefined` (fail-open). The user sees no
  half-rendered gate.
- **Test Evaluation path:** the widget stays on screen with the
  verdict + reason until the user runs `/do-it-right` again or
  starts a new widget write. The notify carries the short-form
  verdict regardless.

# Related

- `architecture/status-bar-progress-for-slow-calls.md` — the
  status-bar surface for the same problem family. The two solutions
  describe complementary surfaces (status bar vs widget) for the
  same root concern: "LLM-gated tool calls need visible progress,
  not a frozen UI."
- `architecture/pi-lifecycle-hooks.md` — `ctx.ui` surface area,
  including the `setWidget` and `setStatus` references.
- `packages/pi-do-it-right/src/lib/streaming-widget.ts` — the
  reference implementation.
- `packages/pi-do-it-right/src/extensions/do-it-right.ts` — the
  live `tool_call` and `runTestEvaluation` paths that consume it.
