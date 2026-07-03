/**
 * tests for src/lib/evaluate.ts
 *
 * Stubs `completeSimple` from `@earendil-works/pi-ai` via the `deps`
 * injection seam. The model is a structural placeholder — `evaluate`
 * passes it through to `completeSimple` unchanged.
 */

import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { evaluate, type EvaluateDeps, type EvaluateOptions, evaluateStream, EvaluationError } from "./evaluate.ts"

const MODEL: Model<"anthropic-messages"> = {
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function makeAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

function stubComplete(text: string): { deps: EvaluateDeps; calls: SimpleStreamOptions[] } {
  const calls: SimpleStreamOptions[] = []
  const stub = vi.fn(
    (_m: Model<"anthropic-messages">, _c: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> => {
      calls.push(options ?? {})
      return Promise.resolve(makeAssistantMessage(text))
    },
  )
  return { deps: { completeSimple: stub as unknown as EvaluateDeps["completeSimple"] }, calls }
}

function stubCompleteThrow(err: unknown): EvaluateDeps {
  const error = err instanceof Error ? err : new Error(String(err))
  const stub = vi.fn((): Promise<AssistantMessage> => Promise.reject(error))
  return { completeSimple: stub as unknown as EvaluateDeps["completeSimple"] }
}

function stubCompleteResponse(response: AssistantMessage): EvaluateDeps {
  const stub = vi.fn((): Promise<AssistantMessage> => Promise.resolve(response))
  return { completeSimple: stub as unknown as EvaluateDeps["completeSimple"] }
}

const defaultOptions: EvaluateOptions = { signal: undefined }

describe("evaluate", () => {
  it("parses a happy-path response (ok: true)", async () => {
    const { deps } = stubComplete('{"ok":true,"reason":"no rule violated"}')
    const result = await evaluate("rules", "ls", MODEL, defaultOptions, deps)
    expect(result).toEqual({ ok: true, reason: "no rule violated" })
  })

  it("parses a happy-path response (ok: false)", async () => {
    const { deps } = stubComplete('{"ok":false,"reason":"rule 4: cat to read files"}')
    const result = await evaluate("rules", "cat README.md", MODEL, defaultOptions, deps)
    expect(result).toEqual({ ok: false, reason: "rule 4: cat to read files" })
  })

  it("strips ```json fences around the text block", async () => {
    const { deps } = stubComplete('```json\n{"ok":true,"reason":"ok"}\n```')
    const result = await evaluate("rules", "ls", MODEL, defaultOptions, deps)
    expect(result).toEqual({ ok: true, reason: "ok" })
  })

  it("strips plain ``` fences around the text block", async () => {
    const { deps } = stubComplete('```\n{"ok":false,"reason":"rule X"}\n```')
    const result = await evaluate("rules", "rm -rf /", MODEL, defaultOptions, deps)
    expect(result).toEqual({ ok: false, reason: "rule X" })
  })

  it("throws EvaluationError when completeSimple rejects (network error)", async () => {
    const deps = stubCompleteThrow(new Error("network"))
    await expect(evaluate("rules", "ls", MODEL, defaultOptions, deps)).rejects.toBeInstanceOf(EvaluationError)
  })

  it("throws EvaluationError when response has no text block", async () => {
    const deps = stubCompleteResponse({
      ...makeAssistantMessage("placeholder"),
      content: [],
    })
    await expect(evaluate("rules", "ls", MODEL, defaultOptions, deps)).rejects.toBeInstanceOf(EvaluationError)
  })

  it("surfaces stopReason=error via the errorMessage field", async () => {
    const deps = stubCompleteResponse({
      ...makeAssistantMessage(""),
      content: [],
      stopReason: "error",
      errorMessage: "rate limit exceeded",
    })
    await expect(evaluate("rules", "ls", MODEL, defaultOptions, deps)).rejects.toThrow(
      /stopReason=error.*rate limit exceeded/,
    )
  })

  it("surfaces stopReason=aborted", async () => {
    const deps = stubCompleteResponse({
      ...makeAssistantMessage(""),
      content: [{ type: "thinking", thinking: "..." }],
      stopReason: "aborted",
    })
    await expect(evaluate("rules", "ls", MODEL, defaultOptions, deps)).rejects.toThrow(/stopReason=aborted/)
  })

  it("includes content-types in the missing-text-block message", async () => {
    const deps = stubCompleteResponse({
      ...makeAssistantMessage(""),
      content: [{ type: "thinking", thinking: "..." } as never],
    })
    await expect(evaluate("rules", "ls", MODEL, defaultOptions, deps)).rejects.toThrow(/thinking/)
  })

  it("throws EvaluationError on JSON parse error", async () => {
    const { deps } = stubComplete("not json")
    await expect(evaluate("rules", "ls", MODEL, defaultOptions, deps)).rejects.toBeInstanceOf(EvaluationError)
  })

  it("throws EvaluationError on missing fields (ok but no reason)", async () => {
    const { deps } = stubComplete('{"ok":true}')
    await expect(evaluate("rules", "ls", MODEL, defaultOptions, deps)).rejects.toBeInstanceOf(EvaluationError)
  })

  it("throws EvaluationError on parsed payload that is not an object", async () => {
    const { deps } = stubComplete('"just a string"')
    await expect(evaluate("rules", "ls", MODEL, defaultOptions, deps)).rejects.toBeInstanceOf(EvaluationError)
  })

  it("propagates the caller's signal to completeSimple", async () => {
    const controller = new AbortController()
    const { deps, calls } = stubComplete('{"ok":true,"reason":"ok"}')
    await evaluate("rules", "ls", MODEL, { ...defaultOptions, signal: controller.signal }, deps)
    expect(calls[0]?.signal).toBe(controller.signal)
  })

  it("does not forward a default maxTokens (lets the model pick its ceiling)", async () => {
    const { deps, calls } = stubComplete('{"ok":true,"reason":"ok"}')
    await evaluate("rules", "ls", MODEL, {}, deps)
    expect(calls[0]?.maxTokens).toBeUndefined()
  })

  it("honors explicit maxTokens override", async () => {
    const { deps, calls } = stubComplete('{"ok":true,"reason":"ok"}')
    await evaluate("rules", "ls", MODEL, { maxTokens: 1024 }, deps)
    expect(calls[0]?.maxTokens).toBe(1024)
  })

  it("includes rules + command in fenced blocks in the user message", async () => {
    let capturedContext: Context | undefined
    const stub = vi.fn((_m: Model<"anthropic-messages">, ctx: Context): Promise<AssistantMessage> => {
      capturedContext = ctx
      return Promise.resolve(makeAssistantMessage('{"ok":true,"reason":"ok"}'))
    })
    const deps = { completeSimple: stub as unknown as EvaluateDeps["completeSimple"] }
    await evaluate("rule X", "ls -la", MODEL, defaultOptions, deps)
    const text = capturedContext?.messages[0]?.content
    expect(typeof text).toBe("string")
    expect(text).toContain("rule X")
    expect(text).toContain("ls -la")
    expect(text).toContain("```")
  })
})

/** Stub stream fixture for `evaluateStream` tests.
 *
 *  Mirrors the surface area `evaluateStream` exercises: it must be an
 *  `AsyncIterable<AssistantMessageEvent>` (consumed via the helper's
 *  event loop) AND expose `.result(): Promise<AssistantMessage>` (which
 *  `runEvaluation` awaits concurrently). The real pi-ai class
 *  `AssistantMessageEventStream` does both; the stub reproduces the
 *  shape with a hand-crafted sequence so tests don't need a live
 *  provider.
 *
 *  `.result()` resolves only after the iterator is fully drained —
 *  this matches the real provider contract and is what makes the
 *  helper's `await finalResultPromise` reliably see all events before
 *  it returns. */
function stubStream(
  events: readonly AssistantMessageEvent[],
  finalResponse: AssistantMessage,
): EvaluateDeps["streamSimple"] {
  return (() => {
    // `.result()` resolves only after the consumer has drained every
    // event from the iterable. This mirrors the real provider's
    // contract — the helper's `runEvaluation` awaits `result()` and
    // `consumeEvents` runs in parallel; we want the test to see the
    // onEvent callback fire for every event before evaluateStream
    // resolves.
    //
    // We resolve `.result()` via a microtask scheduled when the
    // iterator's `return()` is called by the consumer's `for await`
    // (which happens after the last yielded value). Putting `return()`
    // in a `try { ... } finally { ... }` block is the standard way to
    // detect end-of-iteration from inside the generator — the next
    // call after the last `yield event` is implicitly `return()`.
    //
    // Returning a regular sync generator's `.return()` resolves with
    // `undefined`. The `for await` in `consumeEvents` then yields
    // undefined and the outer loop ends. Our `done` listener on the
    // iterator signals `result()` to resolve.
    let resolveResult: ((msg: AssistantMessage) => void) | undefined
    const resultPromise = new Promise<AssistantMessage>((resolve) => {
      resolveResult = resolve
    })

    // eslint-disable-next-line @typescript-eslint/require-await
    const iterable = (async function* (): AsyncGenerator<AssistantMessageEvent> {
      // The `try/finally` runs once the consumer calls `.return()`
      // (after the last yield). We schedule the resolve via
      // `queueMicrotask` so it lands on a fresh microtask queue
      // AFTER the helper has had a chance to deliver the last
      // event's `onEvent` callback. The `require-await` lint rule
      // would otherwise flag this generator because the only async
      // work happens in `finally`, not at a `yield` boundary.
      try {
        for (const event of events) {
          yield event
        }
      } finally {
        queueMicrotask(() => {
          resolveResult?.(finalResponse)
        })
      }
    })()
    return Object.assign(iterable, {
      result: (): Promise<AssistantMessage> => resultPromise,
    })
  }) as unknown as EvaluateDeps["streamSimple"]
}

/** Build a minimal partial `AssistantMessage` to satisfy the
 *  `partial` field every streaming event carries. The streaming
 *  helper doesn't read the partial — `parseResponse` reads the
 *  final `.result()` instead — so any structurally valid
 *  AssistantMessage is fine. */
function minimalPartial(): AssistantMessage {
  return makeAssistantMessage("")
}

describe("evaluateStream", () => {
  it("forwards each non-terminal event to the onEvent callback", async () => {
    const seen: AssistantMessageEvent[] = []
    const finalMessage = makeAssistantMessage('{"ok":true,"reason":"ok"}')
    const partial = minimalPartial()
    const streamSimple = stubStream(
      [
        { type: "thinking_start", contentIndex: 0, partial },
        { type: "thinking_delta", contentIndex: 0, delta: "is it safe? ", partial },
        { type: "thinking_end", contentIndex: 0, content: "is it safe? ", partial },
        { type: "text_start", contentIndex: 1, partial },
        { type: "text_delta", contentIndex: 1, delta: '{ "ok": ', partial },
        { type: "text_delta", contentIndex: 1, delta: 'true, "reason": "ok" }', partial },
      ],
      finalMessage,
    )
    const deps: EvaluateDeps = { streamSimple }
    const result = await evaluateStream(
      "rules",
      "ls",
      MODEL,
      defaultOptions,
      (event) => {
        seen.push(event)
      },
      deps,
    )
    // Verdict: the stream's `text_delta` events don't matter for the
    // JSON parse — the final `AssistantMessage` from `.result()` is
    // what `parseResponse` reads. Including text deltas in the
    // events array ensures we don't accidentally test that they ARE
    // read instead of `.result()`.
    expect(result).toEqual({ ok: true, reason: "ok" })
    // Each non-terminal event made it to the callback. The terminal
    // `done`/`error` would also be filtered (consumed by the event
    // iterator, not surfaced) — we don't emit one here.
    expect(seen.map((e) => e.type)).toEqual([
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_delta",
    ])
    // Deltas are concatenated by the consumer (the streaming widget
    // appends them to its own text buffer). We just verify the
    // payload is passed through unchanged.
    const textDeltas = seen.filter((e) => e.type === "text_delta")
    expect(textDeltas.map((e) => (e as { delta: string }).delta)).toEqual(['{ "ok": ', 'true, "reason": "ok" }'])
  })
})
