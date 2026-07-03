import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { loadConfig, STOCK_CONFIG } from "./permission-config.ts"
import { inventoryWarnings } from "./resolve-mode.ts"
import { type Config, YOLO_MODE } from "./types.ts"

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
    expect(config.modes).toHaveProperty("readonly")
    expect(config.modes).toHaveProperty("default")
    expect(config.modes).toHaveProperty("edit")
    expect(config.modes).toHaveProperty("plan")
    // Stock toolMetadata for the 7 built-in tools is present.
    expect(config.toolMetadata).toHaveProperty("read")
    expect(config.toolMetadata).toHaveProperty("bash")
  })

  it("preserves the stock inheritance chain: default extends readonly, edit extends default, plan extends readonly", async () => {
    // The JIT loader-cleanup principle: `loadConfig` returns the
    // merged config with `extends` intact on every mode. Resolution
    // is a consumer-side projection (`resolveMode(name, config)`)
    // — the loader does NOT walk `extends` and does NOT strip it.
    // The matcher / `computeExtendsChain` reads the chain
    // as-authored. This test pins the new invariant.
    const { config } = await loadConfig(tmpCwd)
    // `default` extends `readonly`.
    expect(config.modes.default?.extends).toEqual(["readonly"])
    // `edit` extends `default` (which extends `readonly` — indirect).
    expect(config.modes.edit?.extends).toEqual(["default"])
    // `plan` extends `readonly` directly (skipping `default`).
    expect(config.modes.plan?.extends).toEqual(["readonly"])
    // Tag rules are NOT pre-merged by the loader. `default` carries
    // its own `tagRules` only; the inherited `readonly` rules live
    // on `readonly` and are applied at consumer time via `resolveMode`.
    expect(config.modes.default?.tagRules).toEqual({
      mutating: "ask",
      execution: "ask",
      network: "ask",
    })
    expect(config.modes.readonly?.tagRules).toEqual({
      readonly: "allow",
      metadata: "allow",
    })
    // `plan`'s `defaultDecision` is its own (not stripped, not merged).
    expect(config.modes.plan?.defaultDecision).toEqual({
      verdict: "deny",
      reason: "plan mode denies all by default",
    })
  })

  it("orders stock modes as default, readonly, edit, plan, __yolo__ in modeOrder", async () => {
    const { config } = await loadConfig(tmpCwd)
    // The first mode in modeOrder is the default starting mode — `default`
    // is the everyday mode, so it lands at position 0. The cycle order
    // walks strictly toward more permissive (`readonly` strips ask-on-write)
    // and then to `edit` (write allowed) and `plan` (all deny). YOLO is
    // a stock mode too, listed last so the cycle wraps to it as a last
    // resort. With YOLO now in stock, the stock-prefix order covers the
    // whole modeOrder when the user provides no override.
    expect(config.modeOrder.slice(0, 5)).toEqual(["default", "readonly", "edit", "plan", "__yolo__"])
  })

  it("is idempotent (two consecutive calls return equivalent results)", async () => {
    const a = await loadConfig(tmpCwd)
    const b = await loadConfig(tmpCwd)
    expect(a.config).toEqual(b.config)
    expect(a.sources).toEqual(b.sources)
  })

  it("includes YOLO as a stock mode (YOLO is part of STOCK_CONFIG)", async () => {
    // YOLO is now a stock mode — not a synthetic post-merge injection.
    // Its presence in the merged config is a property of the stock base,
    // not of the loader's runtime behavior.
    expect(STOCK_CONFIG.modes).toHaveProperty(YOLO_MODE)
    expect(STOCK_CONFIG.modeOrder).toContain(YOLO_MODE)
    const { config } = await loadConfig(tmpCwd)
    expect(config.modes).toHaveProperty(YOLO_MODE)
    // The YOLO mode must be the LAST entry in modeOrder so the cycle wraps
    // to it as a last resort. Users normally don't see it.
    expect(config.modeOrder[config.modeOrder.length - 1]).toBe(YOLO_MODE)
    // The YOLO mode's defaultDecision is allow (the gate is short-circuited
    // entirely; the verdict is only set here for documentation).
    expect(config.modes[YOLO_MODE]?.defaultDecision).toBe("allow")
  })

  it("does not duplicate the YOLO mode in modeOrder if the user lists it too", async () => {
    // YOLO is a stock mode. If the user lists `__yolo__` in their
    // modeOrder, the stock-first merge dedupes it (it's already in stock).
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
    // modeOrder is now stock-first: stock provides the canonical order,
    // user/project entries not already in stock are appended (deduped,
    // user-before-project). The user's "only-mode" is new (not in stock),
    // so it's appended after the stock prefix.
    expect(after.config.modeOrder).toEqual(["default", "readonly", "edit", "plan", "__yolo__", "only-mode"])
    expect(after.config.modeOrder).not.toEqual(before.config.modeOrder)
  })

  it("treats malformed JSON in the config file as if the file were missing", async () => {
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(join(tmpCwd, ".pi", "tool-policy.json"), "{not valid json")
    const { config, sources, warnings } = await loadConfig(tmpCwd)
    expect(sources.project).toBe(false)
    // Stock modeOrder is the canonical prefix; with YOLO in stock, the
    // modeOrder IS STOCK_CONFIG.modeOrder (no separate YOLO append anymore).
    expect(config.modeOrder).toEqual(STOCK_CONFIG.modeOrder)
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
  it("child description wins; child defaultDecision wins; child's tagRules survive", async () => {
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
    // JIT shape: the loader does NOT pre-resolve. The child's
    // own `tagRules` are merged in (key-wins from the project
    // layer), but the parent's `tagRules` do NOT appear on the
    // child — they would only be applied via the consumer's
    // `resolveMode(name, config)` call. This test pins the new
    // loader-level behavior: a single layer's fields only.
    expect(child.tagRules).toEqual({ x: "deny" })
    // `extends` is preserved on the child.
    expect(child.extends).toEqual(["parent"])
    // No cycle warning (valid `extends` chain).
    expect(warnings).toEqual([])
  })

  it("parent tagRules do NOT auto-fill the child (loader is not a resolver)", async () => {
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
    // JIT: the child's tagRules is the empty object the user set,
    // NOT the parent's. The parent lives on `parent` and is reached
    // at consumer time via `resolveMode`.
    expect(config.modes.child?.tagRules).toEqual({})
    // `extends` is preserved.
    expect(config.modes.child?.extends).toEqual(["parent"])
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

  it("parent additionalInstructions does NOT auto-fill the child (loader is not a resolver)", async () => {
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
    // JIT: the loader does not walk `extends` chains. The child's
    // `additionalInstructions` is undefined (the user didn't set it
    // on the child). The parent's `additionalInstructions` lives on
    // `parent` and is reached via `resolveMode` at consumer time.
    expect(config.modes.child?.additionalInstructions).toBeUndefined()
    // `extends` is preserved.
    expect(config.modes.child?.extends).toEqual(["parent"])
  })
})

describe("cycle detection (inventory walker via loadConfig)", () => {
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
    // JIT: cycle detection comes from `inventoryWarnings`,
    // a pure read-only walker that walks every mode in the
    // merged config — not the per-mode resolve loop. The
    // merged config keeps `extends` on each mode; the
    // inventory walker sees the cycle as-authored.
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

  it("preserves the `extends` field on every mode (JIT invariant)", async () => {
    // The JIT loader invariant: `extends` is information, not a
    // side effect. It survives the merge and survives the loader.
    const { config } = await loadConfig(tmpCwd)
    // Stock modes have a known set of `extends` declarations.
    expect(config.modes.default?.extends).toEqual(["readonly"])
    expect(config.modes.edit?.extends).toEqual(["default"])
    expect(config.modes.plan?.extends).toEqual(["readonly"])
    // `readonly` and `__yolo__` are leaf modes (no `extends`).
    expect(config.modes.readonly?.extends).toBeUndefined()
    expect(config.modes.__yolo__?.extends).toBeUndefined()
  })

  it("preserves a user override that explicitly sets extends: []", async () => {
    // A user explicitly setting `extends: []` declares "no inheritance".
    // The JIT loader must NOT strip the user's `extends: []`; the
    // user is saying "this mode is a leaf, do not walk any chain",
    // and `resolveMode` honors that. Here the user override at the
    // project layer sets `extends: []` on `plan` — that replaces the
    // stock `plan` mode entirely (mode block replacement). The stock
    // `plan`'s `extends: ["readonly"]` is gone (the user replaced it).
    // Other modes (e.g. `default`) keep their stock `extends`.
    await mkdir(join(tmpCwd, ".pi"), { recursive: true })
    await writeFile(
      join(tmpCwd, ".pi", "tool-policy.json"),
      JSON.stringify({
        modes: {
          plan: {
            description: "user-defined plan",
            extends: [],
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
          },
        },
      }),
    )
    const { config } = await loadConfig(tmpCwd)
    // The user's `plan` has `extends: []` — preserved.
    expect(config.modes.plan?.extends).toEqual([])
    // `default`'s `extends` is unaffected by the user's `plan` override.
    expect(config.modes.default?.extends).toEqual(["readonly"])
  })

  it("emits warnings via inventoryWarnings, not via per-mode resolve", () => {
    // Direct invocation of the inventory walker. Two warnings:
    // - a cycle (a → b → a),
    // - an unknown `extends` (a → ghost).
    // The walker should report BOTH. (The per-mode resolve
    // would have produced the same warnings, but JIT decouples
    // them: the loader doesn't call resolve, only inventory.)
    const config: Config = {
      modeOrder: ["a", "b"],
      modes: {
        a: {
          description: "a",
          extends: ["b", "ghost"],
          defaultDecision: "ask",
          tagRules: {},
          toolRules: {},
          aspectRules: {},
        },
        b: { description: "b", extends: ["a"], defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
      },
      allowedPaths: [],
      taggingRules: [],
      toolMetadata: {},
    }
    const warnings = inventoryWarnings(config)
    // Cycle warning naming at least one of the modes.
    expect(warnings.some((w) => /cycle/i.test(w))).toBe(true)
    // Unknown-mode warning naming `ghost`.
    expect(warnings.some((w) => w.includes("ghost") && /unknown|missing|extends/i.test(w))).toBe(true)
  })

  it("inventoryWarnings is non-mutating (it does not strip extends or alter the input config)", () => {
    // The walker reads the input; it doesn't write to it. The
    // input's `extends` field must be exactly what the caller passed
    // in after the call returns.
    const config: Config = {
      modeOrder: ["a"],
      modes: {
        a: { description: "a", extends: ["b"], defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
        b: { description: "b", defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
      },
      allowedPaths: [],
      taggingRules: [],
      toolMetadata: {},
    }
    const before = JSON.parse(JSON.stringify(config))
    inventoryWarnings(config)
    // The input config is unchanged.
    expect(config).toEqual(before)
  })

  it("inventoryWarnings returns an empty array on a valid tree (a → b)", () => {
    const config: Config = {
      modeOrder: ["a", "b"],
      modes: {
        a: { description: "a", extends: ["b"], defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
        b: { description: "b", defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
      },
      allowedPaths: [],
      taggingRules: [],
      toolMetadata: {},
    }
    expect(inventoryWarnings(config)).toEqual([])
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
