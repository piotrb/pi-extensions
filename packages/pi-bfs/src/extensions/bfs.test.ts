import { resolve as resolvePath } from "node:path"

import { describe, expect, it, vi } from "vitest"

// Stub @piotrb/pi-extension-utils BEFORE importing the extension so the
// module's top-level binding for `spawnStreaming` is replaced with a spy.
const spawnStreamingMock = vi.fn(
  (..._args: unknown[]): Promise<{ lines: string[]; exitCode: number; spawnError?: string }> =>
    Promise.resolve({ lines: [], exitCode: 0, spawnError: undefined }),
)
vi.mock("@piotrb/pi-extension-utils", () => ({
  spawnStreaming: (...args: unknown[]) => (spawnStreamingMock as unknown as (...a: unknown[]) => unknown)(...args),
}))

const { default: defaultExport } = await import("./bfs.ts")

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
  if (!registered) throw new Error("bfs did not register a tool")
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

describe("bfs", () => {
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

describe("bfs cwd resolution", () => {
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
