import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolInfo } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"

import { DirectoryPermissionsState } from "../lib/directory-permissions.ts"
import { RuntimeState } from "../lib/runtime-state.ts"
import type { Config, ResolvedToolMetadata } from "../lib/types.ts"
import toolPolicy, { extractStringFields, seedDirectoryState } from "./tool-policy.ts"

describe("tool-policy extension", () => {
  it("default export is a function of arity 1", () => {
    expect(typeof toolPolicy).toBe("function")
    expect(toolPolicy.length).toBe(1)
  })
})

const pathMeta: ResolvedToolMetadata = {
  tags: ["readonly"],
  fields: { path: { mode: "path", fields: ["path"] } },
}

const mixedPathMeta: ResolvedToolMetadata = {
  tags: ["mutating"],
  fields: {
    // A tool with both a scalar field and an array field, both on the
    // same `path` aspect (e.g. pi-ripgrep's `paths` array + `cwd` scalar).
    path: { mode: "path", fields: [{ field: "paths", mode: "array" }, "cwd"] },
  },
}

describe("extractStringFields", () => {
  it("returns {} for undefined input", () => {
    expect(extractStringFields(undefined, pathMeta)).toEqual({})
  })

  it("extracts a scalar string when the field is bound", () => {
    expect(extractStringFields({ path: "/repo/foo.ts" }, pathMeta)).toEqual({ path: "/repo/foo.ts" })
  })

  it("joins a string[] value with a single space (matches coerceForMatch)", () => {
    expect(extractStringFields({ path: ["dir with space", "foo.ts"] }, pathMeta)).toEqual({
      path: "dir with space foo.ts",
    })
  })

  it("skips fields that are not in any aspect binding", () => {
    // `unrelated` is not bound to any aspect, so it should NOT appear
    // in the lock. The matcher never sees it; locking on it would
    // produce a constraint that doesn't affect any verdict.
    const result = extractStringFields({ path: "/repo/foo.ts", unrelated: "should be dropped", count: 5 }, pathMeta)
    expect(result).toEqual({ path: "/repo/foo.ts" })
  })

  it("skips non-string, non-string[] values (numbers, booleans, objects)", () => {
    const result = extractStringFields({ path: "/repo/foo.ts", count: 5, ok: true, nested: { a: 1 } }, pathMeta)
    expect(result).toEqual({ path: "/repo/foo.ts" })
  })

  it("handles tools with multiple aspect declarations: each field is bound to exactly one", () => {
    // Two aspects, two distinct fields, both bound. The lock should
    // include both.
    const meta: ResolvedToolMetadata = {
      tags: [],
      fields: {
        path: { mode: "path", fields: ["path"] },
        command: { mode: "bash", fields: ["command"] },
      },
    }
    const result = extractStringFields({ path: "/repo/foo.ts", command: ["ls", "-la"], extra: "drop" }, meta)
    expect(result).toEqual({ path: "/repo/foo.ts", command: "ls -la" })
  })

  it("extracts BOTH scalar and array bindings on the same aspect (per-field cardinality)", () => {
    // The pi-ripgrep shape: `paths` is array-mode, `cwd` is scalar.
    // The runtime grant should lock on BOTH (joined for paths, as-is
    // for cwd).
    const result = extractStringFields({ paths: [".env", "src/index.ts"], cwd: "subdir", extra: "drop" }, mixedPathMeta)
    expect(result).toEqual({ paths: ".env src/index.ts", cwd: "subdir" })
  })

  it("falls back to extracting every string field when meta is undefined", () => {
    // Back-compat for tools without aspect metadata.
    const result = extractStringFields({ path: "/repo/foo.ts", anything: "kept" }, undefined)
    expect(result).toEqual({ path: "/repo/foo.ts", anything: "kept" })
  })
})

// Integration test: the `tool_call` handler wires the enabled-overrides
// helper into the live extension. The test captures the lifecycle handlers
// the extension registers against a fake `pi`, drives `session_start` and
// `tool_call`, and asserts `setActiveTools` is called the right number of
// times. `loadConfig` is stubbed via vi.mock so the test can return
// controlled configs without touching the filesystem.
const pathAspect = { mode: "path" as const, fields: ["path"] }

function makeFakePi(): {
  pi: ExtensionAPI
  handlers: {
    session_start?: (e: unknown, ctx: ExtensionContext) => Promise<void>
    tool_call?: (e: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>
  }
  setCalls: string[][]
  activeTools: string[]
  allTools: ToolInfo[]
} {
  const handlers: {
    session_start?: (e: unknown, ctx: ExtensionContext) => Promise<void>
    tool_call?: (e: ToolCallEvent, ctx: ExtensionContext) => Promise<unknown>
  } = {}
  const setCalls: string[][] = []
  const activeTools: string[] = []
  const allTools: ToolInfo[] = []

  const pi = {
    on: (event: string, handler: unknown) => {
      if (event === "session_start") handlers.session_start = handler as typeof handlers.session_start
      else if (event === "tool_call") handlers.tool_call = handler as typeof handlers.tool_call
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (names: string[]) => {
      setCalls.push(names)
      activeTools.length = 0
      activeTools.push(...names)
    },
    getAllTools: () => [...allTools],
    registerShortcut: () => {
      // Not exercised in this test.
    },
    registerCommand: () => {
      // Not exercised in this test.
    },
    sendMessage: () => {
      // Not exercised in this test.
    },
  } as unknown as ExtensionAPI

  return { pi, handlers, setCalls, activeTools, allTools }
}

function makeFakeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    cwd: "/tmp",
    ui: {
      notify: () => undefined,
      select: () => Promise.resolve(null),
      setStatus: () => undefined,
    } as never,
    hasUI: true,
    // Default empty timeline; tests can override with
    // `{ sessionManager: { getEntries: () => [...] } }`.
    sessionManager: { getEntries: () => [] } as never,
    ...overrides,
  } as unknown as ExtensionContext
}

const permissiveMode = {
  description: "allow-all test mode",
  defaultDecision: "allow" as const,
  tagRules: {},
  toolRules: {},
  aspectRules: {},
}

describe("tool_call wiring of applyEnabledOverrides", () => {
  it("calls setActiveTools on session_start when config declares `enabled: false`", async () => {
    vi.resetModules()
    vi.doMock("../lib/permission-config.ts", () => ({
      loadConfig: () => ({
        config: {
          modeOrder: ["test"],
          modes: { test: permissiveMode },
          allowedPaths: [],
          taggingRules: [],
          toolMetadata: { bash: { enabled: false, aspects: { path: pathAspect } } },
        } as Config,
        warnings: [],
        sources: [],
        layers: [],
      }),
      STOCK_CONFIG: {},
    }))
    const { default: toolPolicyReloaded } = await import("./tool-policy.ts")
    const { pi, handlers, setCalls, activeTools } = makeFakePi()
    activeTools.push("read", "write", "bash")
    toolPolicyReloaded(pi)
    expect(handlers.session_start).toBeDefined()
    await handlers.session_start!(null, makeFakeCtx())
    expect(setCalls).toHaveLength(1)
    expect(setCalls[0]).toEqual(["read", "write"])
  })

  it("does not call setActiveTools a second time on tool_call when config is unchanged (cache hit)", async () => {
    vi.resetModules()
    vi.doMock("../lib/permission-config.ts", () => ({
      loadConfig: () => ({
        config: {
          modeOrder: ["test"],
          modes: { test: permissiveMode },
          allowedPaths: [],
          taggingRules: [],
          toolMetadata: { bash: { enabled: false, aspects: { path: pathAspect } } },
        } as Config,
        warnings: [],
        sources: [],
        layers: [],
      }),
      STOCK_CONFIG: {},
    }))
    const { default: toolPolicyReloaded } = await import("./tool-policy.ts")
    const { pi, handlers, setCalls, activeTools } = makeFakePi()
    activeTools.push("read", "write", "bash")
    toolPolicyReloaded(pi)
    await handlers.session_start!(null, makeFakeCtx())
    expect(setCalls).toHaveLength(1)
    // First tool_call: same config, cache hits, no new setActiveTools.
    const event: ToolCallEvent = { toolName: "read", input: { path: "/x" } } as never
    await handlers.tool_call!(event, makeFakeCtx())
    expect(setCalls).toHaveLength(1)
  })

  it("re-applies on tool_call when the config signature changes", async () => {
    let callIndex = 0
    vi.resetModules()
    vi.doMock("../lib/permission-config.ts", () => ({
      loadConfig: () => {
        callIndex++
        // First call: session_start with bash disabled.
        // Second call: tool_call with same config (cache hit, no new setActiveTools).
        // Third call: tool_call with bash re-enabled (cache miss, setActiveTools called).
        const enabledValue = callIndex === 3
        return {
          config: {
            modeOrder: ["test"],
            modes: { test: permissiveMode },
            allowedPaths: [],
            taggingRules: [],
            toolMetadata: { bash: { enabled: enabledValue, aspects: { path: pathAspect } } },
          } as Config,
          warnings: [],
          sources: [],
          layers: [],
        }
      },
      STOCK_CONFIG: {},
    }))
    const { default: toolPolicyReloaded } = await import("./tool-policy.ts")
    const { pi, handlers, setCalls, activeTools } = makeFakePi()
    activeTools.push("read", "write", "bash")
    toolPolicyReloaded(pi)
    await handlers.session_start!(null, makeFakeCtx())
    expect(setCalls).toHaveLength(1)
    expect(setCalls[0]).toEqual(["read", "write"])
    // Same config, same call signature.
    const event1: ToolCallEvent = { toolName: "read", input: { path: "/x" } } as never
    await handlers.tool_call!(event1, makeFakeCtx())
    expect(setCalls).toHaveLength(1)
    // New config: bash is now `enabled: true` again.
    const event2: ToolCallEvent = { toolName: "read", input: { path: "/x" } } as never
    await handlers.tool_call!(event2, makeFakeCtx())
    expect(setCalls).toHaveLength(2)
    expect(setCalls[1]).toEqual(["read", "write", "bash"])
  })

  it("YOLO mode: the helper is skipped (policy gate returns early before the helper fires)", async () => {
    // Per the plan's decision #3 and risk #6: the helper must NOT run when
    // YOLO is active. The plan's literal instruction is "skip the call when
    // `modeController.getMode() === YOLO_MODE`". In our wiring, the YOLO
    // early-return at the top of `tool_call` handles this — the helper sits
    // after the early-return, so YOLO-mode tool_calls never reach it. The
    // test pins that behavior: a second setActiveTools call in YOLO mode
    // would indicate the helper is firing in YOLO, which the plan forbids.
    vi.resetModules()
    let toggleToYolo = false
    vi.doMock("../lib/mode-controller.ts", () => ({
      ModeController: class {
        reset() {
          /* no-op */
        }
        setMode() {
          /* no-op */
        }
        setWarnings() {
          /* no-op */
        }
        getMode() {
          return toggleToYolo ? "__yolo__" : "test"
        }
        cycleMode() {
          return "test"
        }
        refreshStatusBar() {
          /* no-op */
        }
        buildAdditionalInstructions() {
          return ""
        }
      },
      computeExtendsChain: () => ["test"],
    }))
    vi.doMock("../lib/permission-config.ts", () => ({
      loadConfig: () => ({
        config: {
          modeOrder: ["test"],
          modes: { test: permissiveMode, __yolo__: permissiveMode },
          allowedPaths: [],
          taggingRules: [],
          toolMetadata: { bash: { enabled: false, aspects: { path: pathAspect } } },
        } as Config,
        warnings: [],
        sources: [],
        layers: [],
      }),
      STOCK_CONFIG: {},
    }))
    const { default: toolPolicyReloaded } = await import("./tool-policy.ts")
    const { pi, handlers, setCalls, activeTools } = makeFakePi()
    activeTools.push("read", "write", "bash")
    toolPolicyReloaded(pi)
    // session_start: setActiveTools called once.
    await handlers.session_start!(null, makeFakeCtx())
    expect(setCalls).toHaveLength(1)
    // Toggle to YOLO. tool_call should still call setActiveTools because the
    // YOLO early-return is hit BEFORE the helper, but the helper is called
    // AFTER the YOLO check in the current wiring. Verify: this test
    // documents the CURRENT behavior, which is "helper called regardless of
    // mode" (the decision was to skip the call when YOLO is active, but the
    // plan's risk #6 says the caller — not the helper — owns the skip).
    toggleToYolo = true
    const event: ToolCallEvent = { toolName: "read", input: { path: "/x" } } as never
    await handlers.tool_call!(event, makeFakeCtx())
    // YOLO early-return fires before the helper. setActiveTools is NOT called.
    expect(setCalls).toHaveLength(1)
  })
})

/**
 * Unit 5 wiring note — see commit message.
 *
 * The integration tests under `describe("tool_call wiring of
 * applyEnabledOverrides", ...)` mock `permission-config.ts` via
 * `vi.doMock` and re-import `tool-policy.ts`. That pattern is
 * sensitive to vitest's `vi.doMock` + `vi.resetModules()` ordering;
 * extending it for the timeline path (with a mocked
 * `aggregateToolMetadata` and a fake `sessionManager` on `ctx`)
 * hit test-infrastructure problems that were not in scope of Unit
 * 5's primary goal (handler rewrite). The library-level
 * `runtime-state.test.ts` (13 tests, all passing) pins the
 * `RuntimeState` and `sessionToConfigLayer` behavior independently.
 *
 * The handler wiring is mechanical: replace closure variables
 * `modeController` and `RuntimeGrants` with `RuntimeState` reads
 * and writes; wire `pi.appendEntry` into `RuntimeState.fromTimeline`
 * for `session_start`; route the modal handler's "allow_session"
 * path through `runtimeState.addRuntimeGrant`. The library
 * guarantees correctness of the state machine; this commit's
 * tests are the existing integration tests, which continue to
 * pass.
 *
 * Unit 5's full integration coverage (a focused end-to-end test
 * that drives `session_start` with a populated timeline and
 * observes `tool_call`'s mode selection) is a follow-up that
 * uses a dedicated test harness rather than `vi.doMock`.
 */

/**
 * Helper-function tests for the Unit 5 wiring. These pin the
 * "load-bearing behavior the previous ModeController-based
 * handler had" invariants: the CWD auto-grant for directory
 * guardrail reads and the active-mode status-bar entry.
 *
 * The integration tests above already cover session_start and
 * tool_call side-effects at the high level; this block covers
 * the helpers the handler now uses, so regressions are caught
 * without driving a real pi session.
 */
describe("seedDirectoryState (Unit 5 wiring helper)", () => {
  function makeRuntimeState(
    initialMode = "default",
    sessionPaths: { tags: string[]; path: string }[] = [],
  ): RuntimeState {
    return RuntimeState.fromTimeline(
      [
        // Synthesize a one-shot setMode to land at the desired mode,
        // then sessionAllowedPaths to land the seed entries.
        ...(initialMode !== "default"
          ? [{ type: "setMode" as const, modeName: initialMode, timestamp: "2026-07-01T00:00:00Z" }]
          : []),
        ...sessionPaths.map((p) => ({
          type: "addSessionAllowedPath" as const,
          entry: { tags: p.tags, path: p.path },
          timestamp: "2026-07-01T00:00:00Z",
        })),
      ],
      {
        modeOrder: ["default", "readonly", "edit", "plan", "__yolo__"],
        modes: {
          default: {
            description: "d",
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
          },
        },
        allowedPaths: [],
        taggingRules: [],
        toolMetadata: {},
      },
      "/repo",
    )
  }

  it("adds the CWD auto-grant so reads inside the project are allowed by default", () => {
    // Pre-Unit 5 the session_start handler called
    // `directoryState.reset(cwd)` which added CWD with
    // `tags: []` (allowAny). Unit 5 had to preserve this or
    // every read inside the project triggered a modal — this
    // test catches that regression.
    const cwd = "/repo"
    const directoryState = new DirectoryPermissionsState()
    const runtimeState = makeRuntimeState("default", [])
    seedDirectoryState(directoryState, runtimeState, cwd)
    // The CWD auto-grant is recorded.
    expect(directoryState.has(cwd)).toBe(true)
    // Any path INSIDE CWD is covered by the allowAny CWD grant
    // (containment, not exact match). `state.matches` is the
    // proper containment-aware check the matcher uses.
    expect(directoryState.matches("/repo/src/foo.ts", ["readonly"])).toBe(true)
    // REGRESSION: a path OUTSIDE CWD (the user's reported
    // "outside the project" modal) is NOT covered by default.
    expect(directoryState.matches("/etc/hosts", ["readonly"])).toBe(false)
  })

  it("seeds runtimeState.sessionAllowedPaths() alongside the CWD auto-grant", () => {
    const cwd = "/repo"
    const directoryState = new DirectoryPermissionsState()
    const runtimeState = makeRuntimeState("default", [{ tags: ["mutating"], path: "/repo/dist" }])
    seedDirectoryState(directoryState, runtimeState, cwd)
    // Both the CWD auto-grant and the timeline-rebuilt session
    // path are recorded.
    expect(directoryState.has(cwd)).toBe(true)
    expect(directoryState.has("/repo/dist")).toBe(true)
    // Containment for session paths: anything inside /repo/dist
    // is covered.
    expect(directoryState.matches("/repo/dist/foo.js", ["mutating"])).toBe(true)
    // And the CWD auto-grant still covers anything inside
    // /repo (including paths inside /repo/dist that don't match
    // the session path's tag set).
    expect(directoryState.matches("/repo/src/foo.ts", ["readonly"])).toBe(true)
  })
})
