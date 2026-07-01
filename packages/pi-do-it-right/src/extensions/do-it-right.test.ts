/**
 * tests for src/extensions/do-it-right.ts
 *
 * Mirrors the `makeFakePi` / `makeFakeCtx` pattern from
 * pi-tool-policy/src/extensions/tool-policy.test.ts. Mocks the lib
 * modules so the integration test exercises the wiring (cache, fail-open,
 * block-reason format, slash command) without touching the loader or
 * fetcher internals.
 */

import type { Api, Model } from "@earendil-works/pi-ai"
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

const loadRulesMock = vi.fn<(...args: unknown[]) => Promise<string>>()
const loadRuleSourcesMock = vi.fn<(...args: unknown[]) => Promise<unknown[]>>()
const loadSettingsMock = vi.fn<() => Promise<{ model: { provider: string; id: string } }>>()
const saveSettingsMock = vi.fn<() => Promise<void>>()
const evaluateMock =
  vi.fn<
    (
      rules: string,
      command: string,
      model: unknown,
      options?: unknown,
      deps?: unknown,
    ) => Promise<{ ok: boolean; reason: string }>
  >()

const FAKE_MODEL: Model<Api> = {
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
}

vi.mock(import("../lib/rules.ts"), async (importOriginal) => {
  // Spread the real module so unimocked exports (buildRulesList,
  // SOURCE_LABELS, the path helpers) keep working. Only the IO and
  // shape-mutating entry points are stubbed.
  const actual = await importOriginal()
  return {
    ...actual,
    loadRules: loadRulesMock as (typeof actual)["loadRules"],
    loadRuleSources: loadRuleSourcesMock as (typeof actual)["loadRuleSources"],
  }
})
vi.mock("../lib/evaluate.ts", () => ({
  // Both `evaluate` and `evaluateStream` route through `evaluateMock` so
  // a single mock setup covers every code path. `evaluate` is no longer
  // called by the entry point (it switched to `evaluateStream` for live
  // status feedback) but we keep the shim for safety / future use.
  evaluate: (...args: unknown[]): unknown => (evaluateMock as unknown as (...args: unknown[]) => unknown)(...args),
  evaluateStream: (...args: unknown[]): unknown =>
    (evaluateMock as unknown as (...args: unknown[]) => unknown)(...args),
  EvaluationError: class EvaluationError extends Error {
    constructor(
      message: string,
      public readonly cause?: unknown,
    ) {
      super(message)
      this.name = "EvaluationError"
    }
  },
}))
vi.mock("../lib/settings.ts", () => ({
  loadSettings: (...args: unknown[]): unknown =>
    (loadSettingsMock as unknown as (...args: unknown[]) => unknown)(...args),
  saveSettings: (...args: unknown[]): unknown =>
    (saveSettingsMock as unknown as (...args: unknown[]) => unknown)(...args),
  DEFAULT_SETTINGS: { model: { provider: "anthropic", id: "claude-haiku-4-5" } },
  settingsPath: (home: string): string => `${home}/.pi/agent/auto-reject-rules.json`,
}))

// Import after the mocks are registered.
const { default: doItRight } = await import("./do-it-right.ts")

type FakeCommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>

interface StatusCall {
  key: string
  text: string | undefined
}

interface UiStub {
  /** Queue of canned select() responses, consumed in order. */
  selectQueue: (string | undefined)[]
  /** Queue of canned input() responses, consumed in order. */
  inputQueue: (string | undefined)[]
  /** All setStatus calls made through this UI, in order. */
  statusCalls: StatusCall[]
  /** All notify calls made through this UI. */
  notifications: { message: string; type?: "info" | "warning" | "error" }[]
  /** All setWidget calls, keyed by widget id. Last write wins per key. */
  widgets: Record<string, string[] | undefined>
  /** When non-null, `ctx.ui.custom` resolves with this value. Counts
   *  invocations so a test can assert the modal was entered. */
  customResult: { value: unknown; calls: number } | null
}

interface FakePi {
  pi: ExtensionAPI
  handlers: {
    session_start?: (e: unknown, ctx: ExtensionContext) => Promise<void> | void
    tool_call?: (e: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined>
    do_it_right?: FakeCommandHandler
  }
}

function makeFakeUi(): UiStub {
  return {
    selectQueue: [],
    inputQueue: [],
    statusCalls: [],
    notifications: [],
    widgets: {},
    customResult: { value: null, calls: 0 },
  }
}

function makeUiBindings(ui: UiStub): ExtensionContext["ui"] {
  return {
    notify: (message: string, type?: "info" | "warning" | "error"): void => {
      ui.notifications.push({ message, type })
    },
    select: (_title: string, _options: string[]): Promise<string | undefined> => {
      const next = ui.selectQueue.shift()
      return Promise.resolve(next)
    },
    input: (_title: string, _placeholder?: string): Promise<string | undefined> => {
      const next = ui.inputQueue.shift()
      return Promise.resolve(next)
    },
    setStatus: (key: string, text: string | undefined): void => {
      ui.statusCalls.push({ key, text })
    },
    setWidget: (key: string, content: string[] | undefined): void => {
      ui.widgets[key] = content
    },
    custom: <T>(): Promise<T> => {
      // Increment the call counter; the test's `customResult.value` is
      // what the modal promise resolves to. We never invoke the factory
      // — modal interaction is exercised by lower-level unit tests.
      if (ui.customResult) ui.customResult.calls += 1
      return Promise.resolve(ui.customResult?.value as T)
    },
  } as never
}

function makeFakePi(): FakePi {
  const handlers: FakePi["handlers"] = {}
  const pi = {
    on: (event: string, handler: unknown): void => {
      if (event === "session_start") handlers.session_start = handler as FakePi["handlers"]["session_start"]
      else if (event === "tool_call") handlers.tool_call = handler as FakePi["handlers"]["tool_call"]
    },
    registerCommand: (_name: string, options: { handler: FakeCommandHandler }): void => {
      handlers.do_it_right = options.handler
    },
  } as unknown as ExtensionAPI
  return { pi, handlers }
}

function makeFakeModelRegistry(
  overrides: {
    modelFound?: boolean
    available?: Model<Api>[]
  } = {},
): ExtensionContext["modelRegistry"] {
  const modelFound = overrides.modelFound ?? true
  const available = overrides.available ?? [FAKE_MODEL]
  return {
    find: (): Model<Api> | undefined => (modelFound ? FAKE_MODEL : undefined),
    hasConfiguredAuth: (): boolean => true,
    getApiKeyAndHeaders: (): Promise<{ ok: true; apiKey: string }> =>
      Promise.resolve({ ok: true as const, apiKey: "test-key" }),
    getAvailable: (): Model<Api>[] => available,
  } as unknown as ExtensionContext["modelRegistry"]
}

interface FakeCtxOptions {
  modelFound?: boolean
  signal?: AbortSignal
  hasUI?: boolean
  available?: Model<Api>[]
  ui?: UiStub
  /** The agent's currently-active model — used as the recovery
   *  fallback when the configured model isn't in the registry. */
  activeModel?: Model<Api> | null
}

function makeFakeCtx(cwd: string, opts: FakeCtxOptions = {}): ExtensionContext {
  const ui = opts.ui ?? makeFakeUi()
  const ctx: Record<string, unknown> = {
    cwd,
    ui: makeUiBindings(ui),
    hasUI: opts.hasUI ?? true,
    signal: opts.signal,
    modelRegistry: makeFakeModelRegistry({
      modelFound: opts.modelFound,
      available: opts.available,
    }),
    _ui: ui,
  }
  // activeModel defaults to FAKE_MODEL (anthropic). Pass `null` to
  // simulate "pi has no active model".
  if (opts.activeModel !== null) {
    ctx.model = opts.activeModel ?? FAKE_MODEL
  }
  return ctx as unknown as ExtensionContext
}

beforeEach(() => {
  loadRulesMock.mockReset()
  loadRuleSourcesMock.mockReset()
  evaluateMock.mockReset()
  loadSettingsMock.mockReset()
  saveSettingsMock.mockReset()
  loadRulesMock.mockResolvedValue("rules")
  // Default: four empty sources, none present, none suppressed. Tests
  // that need a specific rules shape override this in their own setup.
  loadRuleSourcesMock.mockResolvedValue([
    { id: "bundled", path: "/bundled.md", content: "", lineCount: 0, suppressed: false, present: false },
    { id: "globalOverride", path: "/override.md", content: "", lineCount: 0, suppressed: false, present: false },
    { id: "global", path: "/user.md", content: "", lineCount: 0, suppressed: false, present: false },
    { id: "project", path: "/proj.md", content: "", lineCount: 0, suppressed: false, present: false },
  ])
  evaluateMock.mockResolvedValue({ ok: true, reason: "ok" })
  loadSettingsMock.mockResolvedValue({
    model: { provider: "anthropic", id: "claude-haiku-4-5" },
  })
  saveSettingsMock.mockResolvedValue()
})

function makeBashEvent(command: string): ToolCallEvent {
  return {
    type: "tool_call",
    toolCallId: "id-1",
    toolName: "bash",
    input: { command },
  } as ToolCallEvent
}

/** Drive `session_start`. Since the handler awaits `initializeSettings`,
 *  the cache is fully populated when this returns — no drainage needed. */
async function startSession(
  handlers: FakePi["handlers"],
  cwd: string,
  ctxOpts: FakeCtxOptions = {},
): Promise<ExtensionContext> {
  const ctx = makeFakeCtx(cwd, ctxOpts)
  await handlers.session_start?.({}, ctx)
  return ctx
}

describe("do-it-right extension", () => {
  it("default export is a function of arity 1", () => {
    expect(typeof doItRight).toBe("function")
    expect(doItRight.length).toBe(1)
  })

  it("session_start does NOT pre-load rules (rules are read on every tool_call)", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    await startSession(handlers, "/work/a")
    expect(loadRulesMock).not.toHaveBeenCalled()
  })

  it("every bash tool_call re-reads the rules (no cache)", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    await startSession(handlers, "/work/a")
    loadRulesMock.mockClear()
    evaluateMock.mockResolvedValue({ ok: true, reason: "ok" })
    await handlers.tool_call?.(makeBashEvent("ls"), makeFakeCtx("/work/a"))
    await handlers.tool_call?.(makeBashEvent("pwd"), makeFakeCtx("/work/a"))
    await handlers.tool_call?.(makeBashEvent("echo hi"), makeFakeCtx("/work/a"))
    // One call per bash event, no caching.
    expect(loadRulesMock).toHaveBeenCalledTimes(3)
  })

  it("re-reading the rules picks up edits without a session restart", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    await startSession(handlers, "/work/a")
    loadRulesMock.mockClear()
    evaluateMock.mockResolvedValue({ ok: true, reason: "ok" })
    // First call: empty rules, evaluate never runs.
    loadRulesMock.mockResolvedValueOnce("")
    await handlers.tool_call?.(makeBashEvent("ls"), makeFakeCtx("/work/a"))
    // Second call: user edited the file mid-session; gate runs.
    loadRulesMock.mockResolvedValueOnce("rules-after-edit")
    await handlers.tool_call?.(makeBashEvent("ls"), makeFakeCtx("/work/a"))
    expect(evaluateMock).toHaveBeenCalledTimes(1)
  })

  it("non-bash tool_name passes through", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    // session_start pre-loads the rules cache and model — loadRules
    // is called once during init. We assert that the read-event call
    // itself does not run loadRules or evaluate.
    await handlers.session_start?.({}, makeFakeCtx("/work/a"))
    loadRulesMock.mockClear()
    evaluateMock.mockClear()
    const event = {
      type: "tool_call",
      toolCallId: "id-1",
      toolName: "read",
      input: { path: "/foo" },
    } as unknown as ToolCallEvent
    const result = await handlers.tool_call?.(event, makeFakeCtx("/work/a"))
    expect(result).toBeUndefined()
    expect(loadRulesMock).not.toHaveBeenCalled()
    expect(evaluateMock).not.toHaveBeenCalled()
  })

  it("bash with empty rules short-circuits", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    loadRulesMock.mockResolvedValue("")
    await startSession(handlers, "/work/a")
    expect(evaluateMock).not.toHaveBeenCalled()
  })

  it("bash with ok:true returns undefined (no block)", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    evaluateMock.mockResolvedValue({ ok: true, reason: "ok" })
    await startSession(handlers, "/work/a")
    const result = await handlers.tool_call?.(makeBashEvent("ls"), makeFakeCtx("/work/a"))
    expect(result).toBeUndefined()
  })

  it("bash with ok:false returns { block: true, reason: <reason> + suffix }", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    evaluateMock.mockResolvedValue({ ok: false, reason: "rule 3: rm -rf" })
    await startSession(handlers, "/work/a")
    const result = await handlers.tool_call?.(makeBashEvent("rm -rf /"), makeFakeCtx("/work/a"))
    expect(result?.block).toBe(true)
    // The reason is the LLM's own verdict — we don't add a suffix to
    // it. The agent reads this verbatim, and the user sees the same
    // text in the block message.
    expect(result?.reason).toBe("rule 3: rm -rf")
  })

  it("evaluate throws → handler returns undefined (fail-open)", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    evaluateMock.mockRejectedValue(new Error("network error"))
    await startSession(handlers, "/work/a")
    const result = await handlers.tool_call?.(makeBashEvent("ls"), makeFakeCtx("/work/a"))
    expect(result).toBeUndefined()
  })

  it("bash with non-string `command` field returns undefined", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    await startSession(handlers, "/work/a")
    const event = {
      type: "tool_call",
      toolCallId: "id-1",
      toolName: "bash",
      input: { command: 123 },
    } as unknown as ToolCallEvent
    const result = await handlers.tool_call?.(event, makeFakeCtx("/work/a"))
    expect(result).toBeUndefined()
    expect(evaluateMock).not.toHaveBeenCalled()
  })

  it("concurrent tool_calls each trigger their own loadRules invocation (no shared cache)", async () => {
    // With the cache dropped, every tool_call re-reads. The race we
    // used to test (single shared promise) is now a non-issue because
    // there is no shared promise to race on. Each tool_call's loadRules
    // is its own promise.
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    let callCount = 0
    loadRulesMock.mockImplementation(() => {
      callCount += 1
      return Promise.resolve("rules")
    })
    const cwd = "/work/race"
    // session_start must run first so the model + settings are
    // initialized; otherwise the handler fails open before reaching
    // loadRules.
    const ctx = await startSession(handlers, cwd)
    loadRulesMock.mockClear()
    callCount = 0
    const p1 = handlers.tool_call?.(makeBashEvent("ls"), ctx)
    const p2 = handlers.tool_call?.(makeBashEvent("pwd"), ctx)
    await Promise.all([p1, p2])
    expect(callCount).toBe(2)
  })

  it("model not in registry AND no active fallback → tool_call returns undefined (fail-open)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    // activeModel: null means pi has no model to fall back to — the
    // extension is fully disabled at session_start.
    await handlers.session_start?.({}, makeFakeCtx("/work/a", { modelFound: false, activeModel: null }))
    await new Promise((r) => setTimeout(r, 10))
    const result = await handlers.tool_call?.(
      makeBashEvent("ls"),
      makeFakeCtx("/work/a", { modelFound: false, activeModel: null }),
    )
    expect(result).toBeUndefined()
    expect(evaluateMock).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not found in registry"))
    warn.mockRestore()
  })

  it("configured model not in registry → recovers to pi's active model + notifies", async () => {
    const { pi, handlers } = makeFakePi()
    const ui = makeFakeUi()
    doItRight(pi)
    // The configured model in loadSettingsMock is something that doesn't
    // exist; recovery falls back to pi's active model (default FAKE_MODEL).
    loadSettingsMock.mockReset()
    loadSettingsMock.mockResolvedValue({
      model: { provider: "openai", id: "gpt-5-nonexistent" },
    })
    await handlers.session_start?.({}, makeFakeCtx("/work/a", { ui, modelFound: false }))
    // session_start awaits initializeSettings; recovery is complete.
    expect(saveSettingsMock).toHaveBeenCalledTimes(1)
    expect(saveSettingsMock).toHaveBeenCalledWith({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
    })
    // Two notifications: a warning at recovery time, an info after persist.
    expect(
      ui.notifications.some(
        (n) => n.type === "warning" && n.message.includes("falling back to anthropic/claude-haiku-4-5"),
      ),
    ).toBe(true)
    expect(
      ui.notifications.some(
        (n) => n.type === "info" && n.message.includes("saved anthropic/claude-haiku-4-5 as new default"),
      ),
    ).toBe(true)
    // Status bar reflects the recovered model.
    expect(ui.statusCalls).toContainEqual({
      key: "do-it-right-model",
      text: "gate: anthropic/claude-haiku-4-5",
    })
  })

  it("configured model has auth that fails to resolve at evaluate time → tool_call fails open", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    loadSettingsMock.mockReset()
    loadSettingsMock.mockResolvedValue({
      model: { provider: "anthropic", id: "claude-haiku-4-5" },
    })
    // Registry finds the model but getApiKeyAndHeaders fails (e.g. auth
    // was revoked between session_start and the first bash call). The
    // entry point must not block in this case — auth failures are
    // expected to be transient and the gate is fail-open.
    const registry = {
      find: (): Model<Api> => FAKE_MODEL,
      hasConfiguredAuth: (): boolean => true,
      getApiKeyAndHeaders: (): Promise<{ ok: false; error: string }> =>
        Promise.resolve({ ok: false as const, error: "token revoked" }),
      getAvailable: (): Model<Api>[] => [],
    } as unknown as ExtensionContext["modelRegistry"]
    const ctx = {
      ...makeFakeCtx("/work/a"),
      modelRegistry: registry,
    } as ExtensionContext
    await handlers.session_start?.({}, ctx)
    // evaluateStream is called without auth (resolveAuth returned null).
    // The mock resolves to a benign allow verdict; the gate must NOT
    // block under any auth-failure condition.
    evaluateMock.mockReset()
    evaluateMock.mockResolvedValue({ ok: true, reason: "ok" })
    const result = await handlers.tool_call?.(makeBashEvent("ls"), ctx)
    expect(result).toBeUndefined()
  })

  it("session_start publishes the model to the status bar", async () => {
    const { pi, handlers } = makeFakePi()
    const ui = makeFakeUi()
    doItRight(pi)
    await handlers.session_start?.({}, makeFakeCtx("/work/a", { ui }))
    expect(ui.statusCalls).toContainEqual({
      key: "do-it-right-model",
      text: "gate: anthropic/claude-haiku-4-5",
    })
  })
})

describe("do-it-right slash command", () => {
  it("registers a handler", () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    expect(handlers.do_it_right).toBeTypeOf("function")
  })

  it("warns (no menu) when hasUI is false", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    const ui = makeFakeUi()
    await handlers.do_it_right?.("", makeFakeCtx("/work/a", { hasUI: false, ui }) as ExtensionCommandContext)
    expect(ui.notifications.length).toBe(1)
    expect(ui.notifications[0]?.message).toMatch(/interactive session/)
  })

  it("exits silently when the user cancels the outer menu", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    const ui = makeFakeUi()
    // User presses Esc on the outer menu — select returns undefined.
    ui.selectQueue.push(undefined)
    await handlers.do_it_right?.("", makeFakeCtx("/work/a", { ui }) as ExtensionCommandContext)
    expect(ui.selectQueue.length).toBe(0) // inner menu was never shown
    expect(ui.notifications.length).toBe(0)
  })

  it("warns when no models are available", async () => {
    const { pi, handlers } = makeFakePi()
    doItRight(pi)
    const ui = makeFakeUi()
    // Outer menu → Settings; inner menu → Evaluation Model row.
    ui.selectQueue.push("Settings", "Evaluation Model: anthropic/claude-haiku-4-5")
    await handlers.do_it_right?.("", makeFakeCtx("/work/a", { ui, available: [] }) as ExtensionCommandContext)
    expect(ui.selectQueue.length).toBe(0) // model picker was never shown
    expect(ui.notifications.some((n) => /no models/i.test(n.message))).toBe(true)
  })

  it("saves the picked model + updates the closure cache + refreshes the status bar", async () => {
    const { pi, handlers } = makeFakePi()
    const ui = makeFakeUi()
    doItRight(pi)
    await startSession(handlers, "/work/a", { ui })

    const picked: Model<Api> = {
      ...FAKE_MODEL,
      id: "gemini-3-flash",
      provider: "google",
      name: "Gemini 3 Flash",
    }

    // Three selects: outer menu (Settings) → inner menu (Evaluation Model row)
    // → model picker (the model display string).
    ui.selectQueue.push("Settings", "Evaluation Model: anthropic/claude-haiku-4-5", "Gemini 3 Flash · google")

    await handlers.do_it_right?.(
      "",
      makeFakeCtx("/work/a", { ui, available: [FAKE_MODEL, picked] }) as ExtensionCommandContext,
    )

    // Queue drained — both menus answered.
    expect(ui.selectQueue.length).toBe(0)

    // saveSettings invoked with the new model — proves the wiring
    // picked and persisted. settings.test.ts verifies the on-disk
    // shape; this test verifies the wiring calls saveSettings.
    expect(saveSettingsMock).toHaveBeenCalledTimes(1)
    expect(saveSettingsMock).toHaveBeenCalledWith({
      model: { provider: "google", id: "gemini-3-flash" },
    })

    // Closure cache updated + status bar reflects the new model.
    const last = ui.statusCalls[ui.statusCalls.length - 1]
    expect(last).toEqual({ key: "do-it-right-model", text: "gate: google/gemini-3-flash" })

    // Success notify confirms the user-facing flow ran to completion.
    expect(ui.notifications.some((n) => n.message.includes("now using google/gemini-3-flash"))).toBe(true)
  })

  describe("Test Evaluation sub-menu", () => {
    async function driveTestEval(command: string, evaluateResult: { ok: boolean; reason: string }): Promise<UiStub> {
      const { pi, handlers } = makeFakePi()
      const ui = makeFakeUi()
      doItRight(pi)
      await startSession(handlers, "/work/a", { ui })
      // Outer menu: pick "Test Evaluation". Inner UI: input the command.
      ui.selectQueue.push("Test Evaluation")
      ui.inputQueue.push(command)
      // The mocked evaluateStream resolves to whatever the test specified.
      evaluateMock.mockReset()
      evaluateMock.mockResolvedValue(evaluateResult)
      await handlers.do_it_right?.("", makeFakeCtx("/work/a", { ui }) as ExtensionCommandContext)
      return ui
    }

    it("notifies 'would allow' when evaluate returns ok:true", async () => {
      const ui = await driveTestEval("ls -la", { ok: true, reason: "no rule violated" })
      expect(
        ui.notifications.some(
          (n) => n.type === "info" && n.message.includes("would allow") && n.message.includes("no rule violated"),
        ),
      ).toBe(true)
      // evaluateStream was called with the user's command.
      expect(evaluateMock).toHaveBeenCalledTimes(1)
      // The mock records positional args; the second positional arg is the command.
      const commandArg = evaluateMock.mock.calls[0]?.[1]
      expect(commandArg).toBe("ls -la")
      // Neither saveSettings nor the model picker fired.
      expect(saveSettingsMock).not.toHaveBeenCalled()
    })

    it("notifies 'would block' when evaluate returns ok:false", async () => {
      const ui = await driveTestEval("cat README.md", {
        ok: false,
        reason: "rule 4: do not use cat",
      })
      expect(
        ui.notifications.some(
          (n) =>
            n.type === "warning" && n.message.includes("would block") && n.message.includes("rule 4: do not use cat"),
        ),
      ).toBe(true)
    })

    it("cancelled input (Esc) yields no evaluate call and no verdict notify", async () => {
      const { pi, handlers } = makeFakePi()
      const ui = makeFakeUi()
      doItRight(pi)
      await startSession(handlers, "/work/a", { ui })
      ui.selectQueue.push("Test Evaluation")
      ui.inputQueue.push(undefined) // user pressed Esc
      evaluateMock.mockReset()
      await handlers.do_it_right?.("", makeFakeCtx("/work/a", { ui }) as ExtensionCommandContext)
      expect(evaluateMock).not.toHaveBeenCalled()
      expect(ui.notifications.some((n) => /would (allow|block)/.test(n.message))).toBe(false)
    })

    it("notifies 'evaluation failed' when evaluate throws", async () => {
      const { pi, handlers } = makeFakePi()
      const ui = makeFakeUi()
      doItRight(pi)
      await startSession(handlers, "/work/a", { ui })
      ui.selectQueue.push("Test Evaluation")
      ui.inputQueue.push("ls")
      evaluateMock.mockReset()
      evaluateMock.mockRejectedValue(new Error("network error"))
      await handlers.do_it_right?.("", makeFakeCtx("/work/a", { ui }) as ExtensionCommandContext)
      expect(
        ui.notifications.some(
          (n) => n.type === "error" && n.message.includes("evaluation failed") && n.message.includes("network error"),
        ),
      ).toBe(true)
    })

    it("notifies a warning and skips evaluate when no rules are configured", async () => {
      const { pi, handlers } = makeFakePi()
      const ui = makeFakeUi()
      doItRight(pi)
      // Override the rules mock BEFORE startSession so the cached promise
      // resolves to empty. We can't easily do that after startSession
      // without rerunning the entire session_start flow.
      loadRulesMock.mockReset()
      loadRulesMock.mockResolvedValue("")
      await startSession(handlers, "/work/a", { ui })
      ui.selectQueue.push("Test Evaluation")
      evaluateMock.mockReset()
      await handlers.do_it_right?.("", makeFakeCtx("/work/a", { ui }) as ExtensionCommandContext)
      // The input was never even shown — we short-circuit before prompting.
      expect(ui.notifications.some((n) => n.message.includes("no rules configured"))).toBe(true)
      expect(evaluateMock).not.toHaveBeenCalled()
    })
  })

  describe("Rules sub-menu", () => {
    it("opens the custom overlay when 'Rules' is picked from the main menu", async () => {
      const { pi, handlers } = makeFakePi()
      const ui = makeFakeUi()
      doItRight(pi)
      await startSession(handlers, "/work/a", { ui })
      ui.selectQueue.push("Rules")
      const initialCalls = ui.customResult?.calls ?? 0
      await handlers.do_it_right?.("", makeFakeCtx("/work/a", { ui }) as ExtensionCommandContext)
      // The Rules menu opens a custom overlay — assert it was invoked.
      expect(ui.customResult?.calls).toBe(initialCalls + 1)
    })

    it("does not open the Rules overlay when the user picks 'Test Evaluation' instead", async () => {
      const { pi, handlers } = makeFakePi()
      const ui = makeFakeUi()
      doItRight(pi)
      await startSession(handlers, "/work/a", { ui })
      ui.selectQueue.push("Test Evaluation")
      ui.inputQueue.push("ls")
      const initialCalls = ui.customResult?.calls ?? 0
      await handlers.do_it_right?.("", makeFakeCtx("/work/a", { ui }) as ExtensionCommandContext)
      expect(ui.customResult?.calls).toBe(initialCalls)
    })

    it("does not open the Rules overlay when the user picks 'Settings' instead", async () => {
      const { pi, handlers } = makeFakePi()
      const ui = makeFakeUi()
      doItRight(pi)
      await startSession(handlers, "/work/a", { ui })
      ui.selectQueue.push("Settings")
      const initialCalls = ui.customResult?.calls ?? 0
      await handlers.do_it_right?.("", makeFakeCtx("/work/a", { ui }) as ExtensionCommandContext)
      expect(ui.customResult?.calls).toBe(initialCalls)
    })
  })
})
