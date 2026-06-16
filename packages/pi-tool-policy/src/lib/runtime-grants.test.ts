import { describe, expect, it } from "vitest"

import { RuntimeGrants } from "./runtime-grants.ts"
import type { Mode } from "./types.ts"

const baseMode: Mode = {
  description: "test",
  defaultDecision: "ask",
  tagRules: {},
  toolRules: {},
  aspectRules: {},
}

describe("RuntimeGrants", () => {
  it("clear() wipes all grants", () => {
    const g = new RuntimeGrants()
    g.grant({ modeName: "default", toolName: "bash" })
    g.clear()
    const m = g.applyFor("default", baseMode)
    expect(m.toolRules.bash).toBeUndefined()
  })

  it("applyFor returns the unchanged mode when no grants exist", () => {
    const g = new RuntimeGrants()
    const m = g.applyFor("default", baseMode)
    expect(m).toBe(baseMode)
  })

  it("a broad grant (no fields) adds an unconditional allow entry", () => {
    const g = new RuntimeGrants()
    g.grant({ modeName: "default", toolName: "bash" })
    const m = g.applyFor("default", baseMode)
    expect(m.toolRules.bash).toEqual([{ verdict: "allow" }])
  })

  it("a narrow grant (with fields) adds a fields-clause allow entry", () => {
    const g = new RuntimeGrants()
    g.grant({ modeName: "default", toolName: "bash", fields: { command: "ls" } })
    const m = g.applyFor("default", baseMode)
    // ToolRuleEntry.fields is Record<string, string[]> — the matcher OR-s
    // patterns within a key. For a single-value session grant, we wrap
    // the value in a one-element array.
    expect(m.toolRules.bash).toEqual([{ fields: { command: ["ls"] }, verdict: "allow" }])
  })

  it("grants are scoped by mode name", () => {
    const g = new RuntimeGrants()
    g.grant({ modeName: "default", toolName: "bash" })
    const mDefault = g.applyFor("default", baseMode)
    const mPlan = g.applyFor("plan", baseMode)
    expect(mDefault.toolRules.bash).toBeDefined()
    expect(mPlan.toolRules.bash).toBeUndefined()
  })

  it("appends to existing toolRules entries (does not replace)", () => {
    const g = new RuntimeGrants()
    const m: Mode = {
      ...baseMode,
      toolRules: { bash: [{ verdict: "deny" }] },
    }
    g.grant({ modeName: "default", toolName: "bash" })
    const after = g.applyFor("default", m)
    expect(after.toolRules.bash).toEqual([{ verdict: "deny" }, { verdict: "allow" }])
  })

  it("does not mutate the input mode", () => {
    const g = new RuntimeGrants()
    g.grant({ modeName: "default", toolName: "bash" })
    // Capture the input mode before applying.
    const input: Mode = { ...baseMode, toolRules: {} }
    const before = JSON.stringify(input)
    g.applyFor("default", input)
    // The input mode is unchanged.
    expect(JSON.stringify(input)).toBe(before)
  })
})
