import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { loadConfig, writeRuleToFile } from "./permission-config.ts"
import type { Config } from "./types.ts"

let tmpCwd: string

beforeEach(async () => {
  tmpCwd = await mkdtemp(join(tmpdir(), "tool-policy-test-"))
})

afterEach(async () => {
  await rm(tmpCwd, { recursive: true, force: true })
})

describe("loadConfig", () => {
  it("reports both sources as absent when neither file exists", async () => {
    const { sources } = await loadConfig(tmpCwd)
    expect(sources).toEqual({ project: false, user: false })
  })

  it("reports the project source as present when the project file exists", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ defaultDecision: "deny" }))
    const { sources } = await loadConfig(tmpCwd)
    expect(sources).toEqual({ project: true, user: false })
  })

  // Project-over-STOCK_CONFIG merge: a project file that sets a single
  // top-level key overrides the stock value for that key only. Other keys
  // (like `tools`) still come from STOCK_CONFIG.
  it("project file overrides STOCK_CONFIG for a matching top-level key", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ defaultDecision: "deny" }))
    const { config } = await loadConfig(tmpCwd)
    expect(config.defaultDecision).toBe("deny")
    // `tools` block still present from STOCK_CONFIG (built-in tools).
    expect(config.tools).toBeDefined()
  })

  // Per-key shallow merge: the project's value replaces the stock's
  // value for the same top-level key, but does not deep-merge into it.
  // The user asked: if STOCK_CONFIG.tools.write === "ask" and the user
  // config sets tools: { write: "allow" }, what wins?
  // Answer: "allow" — the tools block is replaced as a whole.
  it("user override of a top-level key replaces (not deep-merges into) STOCK_CONFIG", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ tools: { write: "allow" } }))
    const { config } = await loadConfig(tmpCwd)
    expect(config.tools?.write).toBe("allow")
    // STOCK_CONFIG ships no aspects; user's file also has no aspects.
    // The two should be merged into an empty object.
    expect(config.aspects).toEqual({})
  })

  it("is idempotent (two consecutive calls return equivalent results)", async () => {
    const a = await loadConfig(tmpCwd)
    const b = await loadConfig(tmpCwd)
    expect(a.config).toEqual(b.config)
    expect(a.sources).toEqual(b.sources)
  })

  // Hot-reload contract: an external write to the config file MUST be
  // visible on the very next loadConfig() call. This is what the
  // extension's tool_call handler relies on — no in-memory cache, no
  // mtime check, no file watcher.
  it("re-reads after an external write (hot reload)", async () => {
    const before = await loadConfig(tmpCwd)
    // External write: simulate the user editing the file directly.
    // The .pi/ parent dir does not pre-exist in this test — the
    // test must create it the same way the writer does for symmetry.
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ defaultDecision: "deny" }))
    // No cache invalidation — the next call re-reads.
    const after = await loadConfig(tmpCwd)
    expect(after.config.defaultDecision).toBe("deny")
    expect(after.config.defaultDecision).not.toBe(before.config.defaultDecision)
  })

  // Hot-reload contract #2: removing the file (so neither project nor user
  // exist) MUST fall back to STOCK_CONFIG. This is the "external delete"
  // case matching the "external write" case above.
  it("re-reads after file deletion (falls back to STOCK_CONFIG)", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ defaultDecision: "deny" }))
    const a = await loadConfig(tmpCwd)
    expect(a.config.defaultDecision).toBe("deny")
    await rm(join(tmpCwd, ".pi", "tool-policy.json"))
    const b = await loadConfig(tmpCwd)
    expect(b.sources.project).toBe(false)
  })

  it("treats malformed JSON in the config file as if the file were missing", async () => {
    // A parse error must not crash loadConfig — it should fall back to
    // the previous layer (STOCK_CONFIG) for that scope, the same as
    // ENOENT. The user gets a chance to fix the file on the next call.
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), "{not valid json")
    const { config, sources } = await loadConfig(tmpCwd)
    expect(sources.project).toBe(false)
    // defaultDecision still comes from STOCK_CONFIG, not from the file.
    expect(config.defaultDecision).toBeDefined()
  })

  // Perf bound: hot reload must be cheap enough to call on every
  // tool_call. 1000 sequential calls with neither file present (the
  // STOCK_CONFIG-only path, which is the cheapest case) should fit
  // well under 1s on any modern machine.
  it("is callable in a tight loop (1000 calls with no files) within 1s", async () => {
    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      await loadConfig(tmpCwd)
    }
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(1000)
  })
})

describe("writeRuleToFile", () => {
  beforeEach(async () => {
    // Ensure the parent .pi/ dir exists for the write to succeed.
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
  })

  it("writes a tool rule to the project file", async () => {
    await writeRuleToFile("project", "tool", "bash", "allow", tmpCwd)
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    expect(JSON.parse(raw)).toMatchObject({ tools: { bash: "allow" } })
  })

  it("writes a defaultDecision rule to a key named 'defaultDecision'", async () => {
    await writeRuleToFile("project", "defaultDecision", "", "deny", tmpCwd)
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    expect(JSON.parse(raw)).toMatchObject({ defaultDecision: "deny" })
  })

  it("writes a group verdict to the groupVerdicts block", async () => {
    await writeRuleToFile("project", "group", "execution", "deny", tmpCwd)
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    expect(JSON.parse(raw)).toMatchObject({ groupVerdicts: { execution: "deny" } })
  })

  it("preserves existing top-level keys when adding a new tool rule", async () => {
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ defaultDecision: "deny" }))
    await writeRuleToFile("project", "tool", "write", "allow", tmpCwd)
    const raw = await readFile(join(tmpCwd, ".pi", "tool-policy.json"), "utf-8")
    const written: Config = JSON.parse(raw) as Config
    // The pre-existing defaultDecision key is preserved, the new tool
    // rule is added on top.
    expect(written.defaultDecision).toBe("deny")
    expect(written.tools?.write).toBe("allow")
  })

  // Hot-reload contract #3: a write from the modal (writeRuleToFile) is
  // visible on the very next loadConfig() call. This is what makes
  // /permissions -> "save rule" -> next tool_call see the new rule work.
  it("writes are immediately visible on the next loadConfig (no cache)", async () => {
    await writeRuleToFile("project", "tool", "read", "deny", tmpCwd)
    const a = await loadConfig(tmpCwd)
    expect(a.config.tools?.read).toBe("deny")
    // Write again, immediately reload — must pick up the new value.
    await writeRuleToFile("project", "tool", "read", "allow", tmpCwd)
    const b = await loadConfig(tmpCwd)
    expect(b.config.tools?.read).toBe("allow")
  })
})

describe("tool-policy extension does NOT read the legacy config paths", () => {
  // Plan rule: the new system must not touch runner.json or
  // .pi/extensions/pi-permission-system/config.json. This is a static
  // check on the source — keeps the rule discoverable as a unit test.
  // The check scans `src/lib/*.ts` only (excluding the test file itself
  // — its own comment would otherwise be flagged).
  it("contains no string 'runner.json' in src/lib/*.ts (excluding tests)", async () => {
    const { readdir, stat } = await import("node:fs/promises")
    const { readFile } = await import("node:fs/promises")
    const dir = join(import.meta.dirname)
    const entries = await readdir(dir)
    const hits: string[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue
      const full = join(dir, entry)
      const s = await stat(full)
      if (!s.isFile()) continue
      const text = await readFile(full, "utf-8")
      if (text.includes("runner.json")) hits.push(entry)
    }
    expect(hits).toEqual([])
  })
})
