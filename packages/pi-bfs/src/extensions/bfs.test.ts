import { describe, expect, it } from "vitest"

import defaultExport from "./bfs.ts"

describe("bfs", () => {
  it("is a function", () => {
    expect(typeof defaultExport).toBe("function")
  })

  it("has length 1 (takes pi: ExtensionAPI parameter)", () => {
    expect(defaultExport.length).toBe(1)
  })

  it("registers a tool whose parameters include a `cwd` field", () => {
    let registered: { parameters?: { properties?: Record<string, unknown> } } | undefined
    const pi = {
      registerTool: (tool: { parameters?: { properties?: Record<string, unknown> } }) => {
        registered = tool
      },
    } as unknown as Parameters<typeof defaultExport>[0]
    defaultExport(pi)
    expect(registered).toBeDefined()
    const properties = registered?.parameters?.properties
    expect(properties).toBeDefined()
    expect(properties).toHaveProperty("cwd")
  })
})
