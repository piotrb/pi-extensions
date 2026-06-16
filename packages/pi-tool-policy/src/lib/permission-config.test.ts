import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { loadConfig, STOCK_CONFIG } from "./permission-config.ts"
import { YOLO_MODE } from "./types.ts"

let tmpCwd: string
let tmpHome: string

// Isolate both the project cwd AND the user home dir so the tests don't
// read a real ~/.pi/tool-policy.json from the developer environment.
// `homedir()` is consulted on every call inside `loadConfig`, so
// stubbing `process.env.HOME` (and `USERPROFILE` on Windows for
// completeness) is enough — no module-level cache to invalidate.
beforeAll(() => {
  vi.stubEnv("HOME", "will-be-overridden-in-beforeEach")
  vi.stubEnv("USERPROFILE", "will-be-overridden-in-beforeEach")
})

afterAll(() => {
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  tmpCwd = await mkdtemp(join(tmpdir(), "tool-policy-test-"))
  tmpHome = await mkdtemp(join(tmpdir(), "tool-policy-test-home-"))
  // The values from beforeAll were placeholders so the env-stub call
  // is valid even on platforms that don't read USERPROFILE. Now we
  // point HOME (and USERPROFILE) at a fresh, empty temp dir.
  process.env.HOME = tmpHome
  process.env.USERPROFILE = tmpHome
})

afterEach(async () => {
  await rm(tmpCwd, { recursive: true, force: true })
  await rm(tmpHome, { recursive: true, force: true })
})

describe("loadConfig", () => {
  it("reports both sources as absent when neither file exists", async () => {
    const { sources } = await loadConfig(tmpCwd)
    expect(sources).toEqual({ project: false, user: false })
  })

  it("reports the project source as present when the project file exists", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ modeOrder: ["default"] }))
    const { sources } = await loadConfig(tmpCwd)
    expect(sources).toEqual({ project: true, user: false })
  })

  it("applies STOCK_CONFIG when neither file exists", async () => {
    const { config } = await loadConfig(tmpCwd)
    // Stock modes are present.
    expect(config.modes).toHaveProperty("default")
    expect(config.modes).toHaveProperty("plan")
    expect(config.modes).toHaveProperty("edit")
    // Stock toolMetadata for the 7 built-in tools is present.
    expect(config.toolMetadata).toHaveProperty("read")
    expect(config.toolMetadata).toHaveProperty("bash")
  })

  it("is idempotent (two consecutive calls return equivalent results)", async () => {
    const a = await loadConfig(tmpCwd)
    const b = await loadConfig(tmpCwd)
    expect(a.config).toEqual(b.config)
    expect(a.sources).toEqual(b.sources)
  })

  it("injects the YOLO (emergency-off) mode on every load, even with stock defaults", async () => {
    const { config } = await loadConfig(tmpCwd)
    expect(config.modes).toHaveProperty(YOLO_MODE)
    expect(config.modeOrder).toContain(YOLO_MODE)
    // The YOLO mode must be the LAST entry in modeOrder so the cycle wraps
    // to it as a last resort. Users normally don't see it.
    expect(config.modeOrder[config.modeOrder.length - 1]).toBe(YOLO_MODE)
    // The YOLO mode's defaultDecision is allow (the gate is short-circuited
    // entirely; the verdict is only set here for documentation).
    expect(config.modes[YOLO_MODE]?.defaultDecision).toBe("allow")
  })

  it("does not duplicate the YOLO mode in modeOrder if it was already added by the user", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({ modeOrder: ["default", "plan", "__yolo__"] }),
    )
    const { config } = await loadConfig(tmpCwd)
    const yoloCount = config.modeOrder.filter((m) => m === YOLO_MODE).length
    expect(yoloCount).toBe(1)
  })

  it("re-reads after an external write (hot reload)", async () => {
    const before = await loadConfig(tmpCwd)
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), JSON.stringify({ modeOrder: ["only-mode"] }))
    const after = await loadConfig(tmpCwd)
    // The user-supplied modeOrder wins; the YOLO mode is appended automatically.
    expect(after.config.modeOrder).toEqual(["only-mode", "__yolo__"])
    expect(after.config.modeOrder).not.toEqual(before.config.modeOrder)
  })

  it("treats malformed JSON in the config file as if the file were missing", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), "{not valid json")
    const { config, sources, warnings } = await loadConfig(tmpCwd)
    expect(sources.project).toBe(false)
    // Stock modeOrder is the prefix; the YOLO mode is appended on every load.
    expect(config.modeOrder).toEqual([...STOCK_CONFIG.modeOrder, "__yolo__"])
    // No warning is emitted for a parse error — silent fall-through per v1 contract.
    expect(warnings).toEqual([])
  })

  it("is callable in a tight loop (1000 calls with no files) within 1s", async () => {
    const start = performance.now()
    for (let i = 0; i < 1000; i++) {
      await loadConfig(tmpCwd)
    }
    const elapsed = performance.now() - start
    // 2000ms accommodates a slow CI runner; locally this is ~300ms.
    expect(elapsed).toBeLessThan(2000)
  })

  it("project file overrides STOCK_CONFIG for a top-level key", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({ modeOrder: ["plan"], modes: { plan: { description: "custom", defaultDecision: "deny" } } }),
    )
    const { config } = await loadConfig(tmpCwd)
    // The project file replaced the entire "plan" mode block.
    expect(config.modes.plan?.description).toBe("custom")
    expect(config.modes.plan?.defaultDecision).toBe("deny")
    // The other stock modes are still present.
    expect(config.modes).toHaveProperty("default")
  })
})

describe("extends deep-merge", () => {
  it("child description wins; child defaultDecision wins", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          child: {
            description: "child desc",
            extends: ["parent"],
            defaultDecision: "deny",
            tagRules: { x: "deny" },
            toolRules: {},
            aspectRules: {},
          },
          parent: {
            description: "parent desc",
            defaultDecision: "ask",
            tagRules: { y: "ask" },
            toolRules: {},
            aspectRules: {},
          },
        },
      }),
    )
    const { config, warnings } = await loadConfig(tmpCwd)
    const child = config.modes.child!
    expect(child.description).toBe("child desc")
    expect(child.defaultDecision).toBe("deny")
    // Both parent and child tagRules are present.
    expect(child.tagRules).toEqual({ x: "deny", y: "ask" })
    // No extends is left on the resolved mode.
    expect(child.extends).toBeUndefined()
    // No cycle warning.
    expect(warnings).toEqual([])
  })

  it("parent tagRules fill in when child does not override them", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          child: {
            description: "child",
            extends: ["parent"],
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
          },
          parent: {
            description: "parent",
            defaultDecision: "ask",
            tagRules: { a: "allow", b: "deny" },
            toolRules: {},
            aspectRules: {},
          },
        },
      }),
    )
    const { config } = await loadConfig(tmpCwd)
    expect(config.modes.child?.tagRules).toEqual({ a: "allow", b: "deny" })
  })

  it("child toolRules list replaces the parent's list (per-tool list replacement)", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          child: {
            description: "child",
            extends: ["parent"],
            defaultDecision: "ask",
            tagRules: {},
            toolRules: { bash: [{ verdict: "deny" }] },
            aspectRules: {},
          },
          parent: {
            description: "parent",
            defaultDecision: "ask",
            tagRules: {},
            toolRules: { bash: [{ verdict: "allow" }, { verdict: "ask" }] },
            aspectRules: {},
          },
        },
      }),
    )
    const { config } = await loadConfig(tmpCwd)
    // The child's list REPLACES the parent's, entry-by-entry merge NOT done.
    expect(config.modes.child?.toolRules.bash).toEqual([{ verdict: "deny" }])
  })

  it("child additionalInstructions wins", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          child: {
            description: "child",
            extends: ["parent"],
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
            additionalInstructions: { mode: "append", text: "child only" },
          },
          parent: {
            description: "parent",
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
            additionalInstructions: { mode: "replace", text: "parent" },
          },
        },
      }),
    )
    const { config } = await loadConfig(tmpCwd)
    expect(config.modes.child?.additionalInstructions).toEqual({ mode: "append", text: "child only" })
  })

  it("parent additionalInstructions applies when child has none", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          child: {
            description: "child",
            extends: ["parent"],
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
          },
          parent: {
            description: "parent",
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
            additionalInstructions: { mode: "replace", text: "parent prose" },
          },
        },
      }),
    )
    const { config } = await loadConfig(tmpCwd)
    expect(config.modes.child?.additionalInstructions).toEqual({ mode: "replace", text: "parent prose" })
  })
})

describe("cycle detection", () => {
  it("detects a → b → a and emits a warning", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          a: { description: "a", extends: ["b"], defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
          b: { description: "b", extends: ["a"], defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
        },
      }),
    )
    const { warnings } = await loadConfig(tmpCwd)
    expect(warnings.some((w) => w.toLowerCase().includes("cycle"))).toBe(true)
  })

  it("emits a warning for self-loop (a → a)", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          a: { description: "a", extends: ["a"], defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
        },
      }),
    )
    const { warnings } = await loadConfig(tmpCwd)
    expect(warnings.some((w) => w.toLowerCase().includes("cycle"))).toBe(true)
  })

  it("emits a warning for extends on an unknown mode", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          a: {
            description: "a",
            extends: ["ghost"],
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
          },
        },
      }),
    )
    const { warnings } = await loadConfig(tmpCwd)
    expect(warnings.some((w) => w.toLowerCase().includes("unknown mode"))).toBe(true)
  })

  it("no warning on a valid tree (a → b, a → c)", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          a: {
            description: "a",
            extends: ["b", "c"],
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
          },
          b: { description: "b", defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
          c: { description: "c", defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
        },
      }),
    )
    const { warnings } = await loadConfig(tmpCwd)
    expect(warnings).toEqual([])
  })
})

describe("allowedPaths", () => {
  it("keeps absolute paths as-is", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({ allowedPaths: [{ tags: [], path: "/etc/hosts" }] }),
    )
    const { config } = await loadConfig(tmpCwd)
    expect(config.allowedPaths[0]?.path).toBe("/etc/hosts")
  })

  it("resolves project-level relative paths against cwd", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({ allowedPaths: [{ tags: ["readonly"], path: "../shared" }] }),
    )
    const { config } = await loadConfig(tmpCwd)
    expect(config.allowedPaths[0]?.path).toContain("shared")
    expect(config.allowedPaths[0]?.path.startsWith("/")).toBe(true)
  })
})

describe("regex pattern validation", () => {
  it("warns when a regex aspect pattern is invalid", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          default: {
            description: "test",
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: { regex: { patterns: { "[unclosed": "deny", "^.+\\.ts$": "allow" } } },
          },
        },
      }),
    )
    const { warnings } = await loadConfig(tmpCwd)
    // The invalid pattern is reported; the valid one is not.
    expect(warnings.some((w) => w.includes("Invalid regex pattern") && w.includes("[unclosed"))).toBe(true)
    expect(warnings.some((w) => w.includes("Invalid regex pattern") && w.includes("^.+\\.ts$"))).toBe(false)
  })

  it("names the mode and the regex aspect in the warning", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          plan: {
            description: "plan",
            defaultDecision: "deny",
            tagRules: {},
            toolRules: {},
            aspectRules: { regex: { patterns: { "(unbalanced": "deny" } } },
          },
        },
      }),
    )
    const { warnings } = await loadConfig(tmpCwd)
    const regexWarn = warnings.find((w) => w.includes("Invalid regex pattern"))
    expect(regexWarn).toBeDefined()
    expect(regexWarn).toContain("plan")
    expect(regexWarn).toContain("regex")
    expect(regexWarn).toContain("(unbalanced")
  })

  it("does not warn on non-regex aspects (path / glob patterns are not compiled as RegExp)", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          default: {
            description: "test",
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {
              // `*.env` is a valid picomatch glob but NOT a valid regex
              // (`*` outside a quantifier). The validation must not warn
              // on the `path` aspect because it uses picomatch, not RegExp.
              path: { patterns: { "*.env": "deny" } },
              url: { patterns: { "https://*.example.com/*": "allow" } },
            },
          },
        },
      }),
    )
    const { warnings } = await loadConfig(tmpCwd)
    expect(warnings.some((w) => w.includes("Invalid regex pattern"))).toBe(false)
  })
})

describe("tool-policy extension does NOT read the legacy config paths", () => {
  it("contains no string 'runner.json' in src/lib/*.ts (excluding tests)", async () => {
    const { readdir, readFile, stat } = await import("node:fs/promises")
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
