/**
 * tests for src/lib/evaluate.ts
 *
 * Stubs `completeSimple` from `@earendil-works/pi-ai` via the `deps`
 * injection seam. The model is a structural placeholder — `evaluate`
 * passes it through to `completeSimple` unchanged.
 */

import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { evaluate, type EvaluateDeps, type EvaluateOptions, EvaluationError } from "./evaluate.ts"

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
