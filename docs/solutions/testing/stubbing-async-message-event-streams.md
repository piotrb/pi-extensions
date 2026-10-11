---
title: stubbing async-iterable message event streams (defer .result() until the iterator drains)
category: testing
severity: medium
tags:
  - async-iterator
  - event-stream
  - test-stub
  - pi-ai
  - streaming
  - helper
applies_when:
  - testing a helper that consumes an async iterable AND awaits a sibling `.result()` promise
  - the production API contract is "events flow first, then result resolves" (real-time streaming)
  - tests need to see every event delivered to the callback before the helper returns
---

# Problem

`@earendil-works/pi-ai`'s `AssistantMessageEventStream` combines two
APIs on one object:

1. `[Symbol.asyncIterator]()` — yields `AssistantMessageEvent` objects as the model streams
2. `.result()` — returns a `Promise<AssistantMessage>` that resolves with the final message

`evaluateStream` consumes both: it awaits `.result()` for the final
message (used for verdict parsing), and a parallel `for await` loop
calls the user's `onEvent` callback for each event (used for streaming
UI updates).

A naive test stub that resolves `.result()` immediately creates a
flaky assertion: the helper returns when `.result()` resolves, but the
iterator may still be drained asynchronously — `onEvent` may not have
seen all events by the time the test inspects the callback's recorded
events. Symptom: the test passes for the first event but fails for the
rest.

# Context

Working on `pi-do-it-right`'s streaming widget promotion (commit
`c00cfb7`). `streaming-widget.ts` consumes the streaming events via
`evaluateStream(..., onEvent, deps)`. The test seam is
`deps.streamSimple`, which the helper's `runEvaluation` calls via
`streamSimple(model, context, simpleOptions)`. The test needs to
verify that `onEvent` receives every event with the expected payload.

The naive stub:

```ts
function stubStream(events, final) {
  return (() => {
    const iterable = (async function* () {
      for (const event of events) yield event
    })()
    return Object.assign(iterable, {
      result: () => Promise.resolve(final), // BUG: resolves immediately
    })
  })()
}
```

When the helper's `for await (const event of events)` runs in parallel
with `await finalResultPromise`, the test sees:

```ts
expect(seen.map((e) => e.type)).toEqual([
  "thinking_start",
  // ... 'thinking_delta', 'thinking_end', 'text_start', 'text_delta', 'text_delta' all missing
])
```

because `finalResultPromise` resolves on the first microtask, long
before the consumer has a chance to deliver the iterator's remaining
events.

# Solution

Defer `.result()` until the iterator's `try/finally` block runs. The
consumer's `for await` calls the iterator's implicit `return()` after
the last `yield`. Use that to schedule `resolve()` via
`queueMicrotask` so the resolve lands AFTER the last `onEvent` call:

```ts
function stubStream(events, final) {
  return (() => {
    let resolveResult
    const resultPromise = new Promise<AssistantMessage>((resolve) => {
      resolveResult = resolve
    })

    const iterable = (async function* () {
      // eslint-disable-next-line @typescript-eslint/require-await
      try {
        for (const event of events) yield event
      } finally {
        // After the consumer drains the last event, schedule the
        // resolve on a fresh microtask. This guarantees the last
        // `onEvent` callback fires before `.result()` resolves.
        queueMicrotask(() => resolveResult?.(final))
      }
    })()
    return Object.assign(iterable, {
      result: () => resultPromise,
    })
  })()
}
```

The test can then safely `await evaluateStream(..., onEvent)` and
inspect `seen` — every event has been delivered by the time the helper
returns.

## Why `queueMicrotask` instead of synchronous resolve

Calling `resolveResult?.(final)` inside `finally` resolves synchronously
on the same microtask as the last `yield`. The order of microtasks
becomes ambiguous between "the last `yield`'s deliver step" and "the
explicit resolve". `queueMicrotask` defers the resolve to the next
microtask, ensuring the resolve always lands AFTER the last event has
been delivered through `onEvent`.

## Generator vs async generator

A regular function-generator approach (returning events synchronously)
skips the `for await` microtask and the consumer's `onEvent` may not
have run by the time `result()` resolves. The async generator with
`queueMicrotask` keeps the entire flow inside the JS microtask queue,
where the consumer's `for await` body executes between yields.

## `require-await` lint

The generator's body has no `await` — the only async work is in the
`finally` block via `queueMicrotask`. The `@typescript-eslint/require-await`
rule flags async generators without an `await`. Suppress with a
targeted `eslint-disable-next-line` comment, explaining why (so a
future reader doesn't add a spurious `await` to satisfy the rule).

# Why this works

- **Real pi-ai providers do the same thing.** The production
  `AssistantMessageEventStream` resolves `.result()` only after the
  consumer has finished iterating. The test stub mirrors that
  contract, which is why "test the real deal" guidance in
  `AGENTS.md` calls for matching the production shape in stubs.
- **`queueMicrotask` is the smallest possible delay.** It runs in
  the same task the consumer is in. A `setTimeout(..., 0)` would
  also work but adds a macrotask boundary for no reason. A bare
  `Promise.resolve().then(...)` would work too, but `queueMicrotask`
  is the explicit primitive for this purpose.
- **The `for await ... finally` pattern is standard.** Any
  `for await`-consumed iterator's `finally` block runs once per
  iteration end (including via implicit `return()` on completion).
  This is the canonical way to observe "stream ended" from inside
  a generator.

# Prevention

- **Do not resolve `.result()` synchronously from the stub.** Even
  if the test "seems to pass" today, the timing relationship is
  load-bearing — a test that works for one event may miss events
  once the iterator grows.
- **Do not use `setTimeout(..., 0)` instead of `queueMicrotask`.**
  The macrotask boundary introduces a delay the helper can't reason
  about; the consumer may have moved on before the resolve lands.
- **Do not add a real `await` inside the async generator body.** The
  `try/finally` block is the only place async work happens, on purpose.
  Adding a `yield await Promise.resolve()` "just to make lint happy"
  introduces an extra microtask that races with the consumer's
  next iteration step. The `eslint-disable-next-line` comment is the
  correct way to satisfy `require-await`.
- **Do not switch to a sync generator as a workaround.** A regular
  generator runs synchronously, with no microtask between yields. The
  consumer's `for await` body runs synchronously too, but the helper's
  parallel `await finalResultPromise` may resolve before the
  consumer finishes iterating. Same timing bug, different shape.
- **Do not skip `.result()` resolution in tests.** If you don't
  assert on the result, omit the `.result()` field from the stub —
  but the helper's `if (isAsyncIterable)` branch means it
  _requires_ `.result()` to be present. Omitting it triggers a
  different code path (the `complete()` branch) and silently
  breaks the test's coverage of the streaming path.

# Verification

- **Sanity check on event ordering:** `expect(seen.map(e => e.type)).toEqual([...])`
  matches the input array's order. The stub's `resolve()` deferral
  ensures every event has been delivered to the callback before
  `evaluateStream` returns.
- **Sanity check on payload:** `expect(textDeltas.map(e => e.delta)).toEqual([...])`
  confirms the `delta` field is forwarded unchanged through the
  callback (no truncation, no concatenation, no transformation).
- **No timing assertions:** the test does not use `vi.useFakeTimers()`,
  mock clocks, or `setTimeout`-based waits. The microtask deferral
  is deterministic under normal JS event-loop semantics.

# Related

- `packages/pi-do-it-right/src/lib/evaluate.test.ts` — the reference
  test exercising this pattern. The `evaluateStream` describe block
  uses `stubStream` from this solution.
- `architecture/streaming-widget-for-streaming-calls.md` — the
  consumer-side solution that drove this testing pattern into
  existence.
- `AGENTS.md` "Tests assert behavior, not data" — confirms the
  intent: test the consumer's _behavior_ (event delivery) rather
  than the data shape of the helper's internal buffer.
