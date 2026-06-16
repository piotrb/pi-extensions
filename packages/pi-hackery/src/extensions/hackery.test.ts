import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"

import hackery from "./hackery.ts"

type Registerable = "registerTool" | "registerCommand" | "on" | "sendMessage"
type Api = Pick<ExtensionAPI, Registerable>

function makeFakeApi(): { api: Api; calls: { tool: string; command: string } } {
  const calls = { tool: "", command: "" }
  const api: Api = {
    registerTool: (tool) => {
      calls.tool = tool.name
    },
    registerCommand: (name) => {
      calls.command = name
    },
    on: () => {
      // No-op: this test only asserts that no tool or command is registered.
    },
    sendMessage: () => {
      // No-op: this test only asserts that no tool or command is registered.
    },
  }
  // Suppress unused-param warnings on the closures.
  void vi
  return { api, calls }
}

describe("@piotrb/pi-hackery placeholder extension", () => {
  it("loads and is callable as a default export", () => {
    expect(typeof hackery).toBe("function")
  })

  it("registers no tools and no commands (sandbox is intentionally empty)", () => {
    const { api, calls } = makeFakeApi()
    hackery(api as unknown as ExtensionAPI)
    expect(calls.tool).toBe("")
    expect(calls.command).toBe("")
  })
})
