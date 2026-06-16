import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { addAspectRule, addBroadAllow, addToolRule } from "./permission-writer.ts"

let tmpCwd: string

beforeEach(async () => {
  tmpCwd = await mkdtemp(join(tmpdir(), "tool-policy-writer-test-"))
})

afterEach(async () => {
  await rm(tmpCwd, { recursive: true, force: true })
})

describe("addToolRule (project scope)", () => {
  it("creates the file and adds the rule to an existing mode", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ modeOrder: ["default"] }))
    await addToolRule("project", tmpCwd, "default", "bash", { verdict: "allow" })
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    const config = JSON.parse(raw) as { modes?: { default?: { toolRules?: { bash?: unknown[] } } } }
    expect(config.modes?.default?.toolRules?.bash).toEqual([{ verdict: "allow" }])
  })

  it("appends to existing entries (does not replace)", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({ modes: { default: { toolRules: { bash: [{ verdict: "deny" }] } } } }),
    )
    await addToolRule("project", tmpCwd, "default", "bash", { verdict: "allow" })
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    const config = JSON.parse(raw) as { modes?: { default?: { toolRules?: { bash?: unknown[] } } } }
    expect(config.modes?.default?.toolRules?.bash).toEqual([{ verdict: "deny" }, { verdict: "allow" }])
  })

  it("creates the .pi directory if it doesn't exist", async () => {
    // No prior file, no prior directory.
    await addToolRule("project", tmpCwd, "default", "read", { verdict: "allow" })
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    const config = JSON.parse(raw) as { modes?: { default?: { toolRules?: { read?: unknown[] } } } }
    expect(config.modes?.default?.toolRules?.read).toEqual([{ verdict: "allow" }])
  })

  it("preserves other top-level keys when adding a rule", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({ modeOrder: ["default", "plan"], allowedPaths: [{ tags: [], path: "/x" }] }),
    )
    await addToolRule("project", tmpCwd, "default", "read", { verdict: "allow" })
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    const config = JSON.parse(raw) as {
      modeOrder?: string[]
      allowedPaths?: unknown[]
      modes?: { default?: { toolRules?: { read?: unknown[] } } }
    }
    expect(config.modeOrder).toEqual(["default", "plan"])
    expect(config.allowedPaths).toEqual([{ tags: [], path: "/x" }])
    expect(config.modes?.default?.toolRules?.read).toEqual([{ verdict: "allow" }])
  })

  it("writes a new mode if it doesn't exist", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ modeOrder: ["plan"] }))
    await addToolRule("project", tmpCwd, "plan", "read", { verdict: "allow" })
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    const config = JSON.parse(raw) as { modes?: { plan?: { toolRules?: { read?: unknown[] } } } }
    expect(config.modes?.plan?.toolRules?.read).toEqual([{ verdict: "allow" }])
  })
})

describe("addBroadAllow", () => {
  it("is a thin wrapper around addToolRule with verdict: 'allow'", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ modeOrder: ["default"] }))
    await addBroadAllow("project", tmpCwd, "default", "bash")
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    const config = JSON.parse(raw) as { modes?: { default?: { toolRules?: { bash?: unknown[] } } } }
    expect(config.modes?.default?.toolRules?.bash).toEqual([{ verdict: "allow" }])
  })
})

describe("addAspectRule", () => {
  it("creates a new aspectRules block with the pattern", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ modeOrder: ["default"] }))
    await addAspectRule("project", tmpCwd, "default", "command", "ls")
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    const config = JSON.parse(raw) as {
      modes?: { default?: { aspectRules?: { command?: { patterns?: Record<string, unknown> } } } }
    }
    expect(config.modes?.default?.aspectRules?.command?.patterns?.ls).toBe("allow")
  })

  it("preserves existing aspect patterns and appends the new one", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({ modes: { default: { aspectRules: { command: { patterns: { "pnpm *": "allow" } } } } } }),
    )
    await addAspectRule("project", tmpCwd, "default", "command", "ls")
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    const config = JSON.parse(raw) as {
      modes?: { default?: { aspectRules?: { command?: { patterns?: Record<string, unknown> } } } }
    }
    expect(config.modes?.default?.aspectRules?.command?.patterns).toEqual({
      "pnpm *": "allow",
      ls: "allow",
    })
  })

  it("preserves existing other-aspect rules when adding to a different aspect", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({ modes: { default: { aspectRules: { path: { patterns: { "**": "allow" } } } } } }),
    )
    await addAspectRule("project", tmpCwd, "default", "command", "ls")
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    const config = JSON.parse(raw) as {
      modes?: {
        default?: {
          aspectRules?: {
            path?: { patterns?: Record<string, unknown> }
            command?: { patterns?: Record<string, unknown> }
          }
        }
      }
    }
    expect(config.modes?.default?.aspectRules?.path?.patterns).toEqual({ "**": "allow" })
    expect(config.modes?.default?.aspectRules?.command?.patterns).toEqual({ ls: "allow" })
  })

  it("rejects an empty pattern", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ modeOrder: ["default"] }))
    await expect(addAspectRule("project", tmpCwd, "default", "command", "")).rejects.toThrow(/non-empty/)
  })
})
