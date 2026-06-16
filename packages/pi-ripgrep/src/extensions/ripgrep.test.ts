import { resolve as resolvePath } from "node:path"

import { describe, expect, it, vi } from "vitest"

const spawnStreamingMock = vi.fn(
  (..._args: unknown[]): Promise<{ lines: string[]; exitCode: number; spawnError?: string }> =>
    Promise.resolve({ lines: [], exitCode: 0, spawnError: undefined }),
)
vi.mock("@piotrb/pi-extension-utils", () => ({
  spawnStreaming: (...args: unknown[]) => (spawnStreamingMock as unknown as (...a: unknown[]) => unknown)(...args),
}))

const { default: defaultExport, renderLine } = await import("./ripgrep.ts")

interface CapturedTool {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: unknown) => void) | undefined,
    ctx: { cwd: string },
  ) => Promise<unknown>
  parameters?: { properties?: Record<string, unknown> }
}

function captureTool(): CapturedTool {
  let registered: CapturedTool | undefined
  const pi = {
    registerTool: (tool: CapturedTool) => {
      registered = tool
    },
  } as unknown as Parameters<typeof defaultExport>[0]
  defaultExport(pi)
  if (!registered) throw new Error("ripgrep did not register a tool")
  return registered
}

async function callExecuteCwd(
  tool: CapturedTool,
  params: Record<string, unknown>,
  projectCwd: string,
): Promise<string> {
  spawnStreamingMock.mockClear()
  spawnStreamingMock.mockReturnValue(Promise.resolve({ lines: [], exitCode: 0, spawnError: undefined }))
  await tool.execute("test-id", params, undefined, undefined, { cwd: projectCwd })
  const call = spawnStreamingMock.mock.calls[0]
  if (!call) throw new Error("spawnStreaming was not called")
  const opts = call[2] as { cwd: string }
  return opts.cwd
}

describe("ripgrep", () => {
  it("is a function", () => {
    expect(typeof defaultExport).toBe("function")
  })

  it("has length 1 (takes pi: ExtensionAPI parameter)", () => {
    expect(defaultExport.length).toBe(1)
  })

  it("registers a tool whose parameters include a `cwd` field", () => {
    const tool = captureTool()
    const properties = tool.parameters?.properties
    expect(properties).toBeDefined()
    expect(properties).toHaveProperty("cwd")
  })
})

describe("ripgrep cwd resolution", () => {
  it("falls back to ctx.cwd when cwd is omitted", async () => {
    const tool = captureTool()
    const cwd = await callExecuteCwd(tool, {}, "/repo")
    expect(cwd).toBe("/repo")
  })

  it("passes an absolute cwd through unchanged", async () => {
    const tool = captureTool()
    const cwd = await callExecuteCwd(tool, { cwd: "/elsewhere" }, "/repo")
    expect(cwd).toBe("/elsewhere")
  })

  it("resolves a relative cwd against ctx.cwd", async () => {
    const tool = captureTool()
    const cwd = await callExecuteCwd(tool, { cwd: "subdir" }, "/repo")
    expect(cwd).toBe(resolvePath("/repo", "subdir"))
  })
})

describe("renderLine", () => {
  // The Theme type is large (see @earendil-works/pi-tui). renderLine only
  // touches `theme.fg(color, text)`, so a partial stub is enough — we
  // declare a minimal interface that satisfies Theme's required methods
  // and cast through `unknown` at the call site.
  type Theme = Parameters<typeof renderLine>[1]
  interface StubTheme {
    fg: (color: string, text: string) => string
    calls: { color: string; text: string }[]
  }
  function makeTheme(): StubTheme {
    const calls: { color: string; text: string }[] = []
    const fg = (color: string, text: string): string => {
      calls.push({ color, text })
      return text
    }
    return { fg, calls }
  }
  /** Cast the stub to Theme while preserving the stub's `calls` field. */
  function asTheme(stub: StubTheme): Theme {
    return stub as unknown as Theme
  }

  it("renders a match line (rg --line-number output) with the accent color on the line number", () => {
    const stub = makeTheme()
    renderLine("src/foo.ts:42:matched text", asTheme(stub))
    // The five colored segments: file(dim), sep1(muted), lineNo(accent), sep2(muted), content(dim)
    const colors = stub.calls.map((c) => c.color)
    expect(colors).toEqual(["dim", "muted", "accent", "muted", "dim"])
    expect(stub.calls[0]?.text).toBe("src/foo.ts")
    expect(stub.calls[1]?.text).toBe(":")
    expect(stub.calls[2]?.text).toBe("42")
    expect(stub.calls[3]?.text).toBe(":")
    expect(stub.calls[4]?.text).toBe("matched text")
  })

  it("renders a context line (rg --context separator) with the muted color on the line number", () => {
    const stub = makeTheme()
    renderLine("src/foo.ts-42-context text", asTheme(stub))
    // Context separator: - instead of :, so lineNo is muted (not accent).
    expect(stub.calls.map((c) => c.color)).toEqual(["dim", "muted", "muted", "muted", "muted"])
    expect(stub.calls[1]?.text).toBe("-")
  })

  it("accepts the Unicode MINUS SIGN (U+2212) as a separator — protects against the 'fix' of an obvious typo", () => {
    const stub = makeTheme()
    renderLine("src/foo.ts\u221242\u2212context text", asTheme(stub))
    // Both separators should be the MINUS SIGN; the line should still parse
    // as a context line (muted line number).
    expect(stub.calls[2]?.text).toBe("42")
    expect(stub.calls.map((c) => c.color)).toEqual(["dim", "muted", "muted", "muted", "muted"])
  })

  it("renders a `--` group separator with a Unicode box-drawing line", () => {
    const stub = makeTheme()
    const out = renderLine("--", asTheme(stub))
    expect(stub.calls[0]?.color).toBe("muted")
    expect(stub.calls[0]?.text).toBe("──")
    expect(out).toBe("──")
  })

  it("handles a path containing `:` (a real-world case: `weird:path/file.ts:10:foo`)", () => {
    const stub = makeTheme()
    // The regex uses `[^:\n]+` for the file group, so this would NOT match
    // (it stops at the first `:`). That means the function falls through to
    // the default `theme.fg("dim", line)` path. Lock that in: the function
    // does NOT correctly render colon-bearing paths, so the description
    // should warn the LLM to use simpler path shapes.
    renderLine("weird:path/file.ts:10:foo", asTheme(stub))
    // If a future change fixes this, the test will fail and the fix author
    // should update both the test and the `description` text in ripgrep.ts.
    expect(stub.calls).toEqual([{ color: "dim", text: "weird:path/file.ts:10:foo" }])
  })
})
