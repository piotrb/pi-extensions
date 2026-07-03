import { describe, expect, it, vi } from "vitest"

import { RUNTIME_CUSTOM_TYPE, RuntimeState, type SessionEventTimeline, sessionToConfigLayer } from "./runtime-state.ts"
import type { Config } from "./types.ts"

/** Minimal valid stock-shaped config for tests. Modes carry `extends`
 * to mirror the post-Unit-3b JIT shape. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    modeOrder: ["default", "readonly", "edit", "plan"],
    modes: {
      readonly: {
        description: "readonly",
        defaultDecision: "ask",
        tagRules: { readonly: "allow", metadata: "allow" },
        toolRules: {},
        aspectRules: {},
      },
      default: {
        description: "default",
        extends: ["readonly"],
        defaultDecision: "ask",
        tagRules: { mutating: "ask", network: "ask" },
        toolRules: {},
        aspectRules: {},
      },
      edit: {
        description: "edit",
        extends: ["default"],
        defaultDecision: "ask",
        tagRules: { mutating: "allow" },
        toolRules: {},
        aspectRules: {},
      },
      plan: {
        description: "plan",
        extends: ["readonly"],
        defaultDecision: "deny",
        tagRules: {
          mutating: "deny",
          network: "deny",
        },
        toolRules: {},
        aspectRules: {},
      },
    },
    allowedPaths: [],
    taggingRules: [],
    toolMetadata: {},
    ...overrides,
  }
}

describe("RuntimeState", () => {
  describe("fromTimeline rebuilds in-memory state from session events", () => {
    it("rebuilds the active mode name from a single setMode event", () => {
      const config = makeConfig()
      const timeline: SessionEventTimeline = [{ type: "setMode", modeName: "edit", timestamp: "2026-07-01T00:00:00Z" }]
      const state = RuntimeState.fromTimeline(timeline, config, "/repo")
      expect(state.currentModeName()).toBe("edit")
    })

    it("uses config.modeOrder[0] when the timeline is empty", () => {
      const config = makeConfig({ modeOrder: ["plan", "default", "readonly"] })
      const state = RuntimeState.fromTimeline([], config, "/repo")
      expect(state.currentModeName()).toBe("plan")
    })

    it("rebuilds the granted session paths from addSessionAllowedPath events", () => {
      const config = makeConfig()
      const timeline: SessionEventTimeline = [
        {
          type: "addSessionAllowedPath",
          entry: { tags: ["mutating"], path: "/repo/src" },
          timestamp: "2026-07-01T00:00:00Z",
        },
      ]
      const state = RuntimeState.fromTimeline(timeline, config, "/repo")
      const paths = state.sessionAllowedPaths()
      expect(paths).toEqual([{ tags: ["mutating"], path: "/repo/src" }])
      // The granted entry's tags augment `effectiveTags`.
      expect(state.effectiveTags()).toEqual(["mutating"])
    })

    it("rebuilds the runtime grants from addRuntimeGrant events", () => {
      const config = makeConfig()
      const timeline: SessionEventTimeline = [
        {
          type: "addRuntimeGrant",
          grant: {
            modeName: "default",
            toolName: "bash",
            fields: { command: "ls" },
          },
          timestamp: "2026-07-01T00:00:00Z",
        },
      ]
      const state = RuntimeState.fromTimeline(timeline, config, "/repo")
      const grants = state.runtimeGrants()
      expect(grants).toHaveLength(1)
      expect(grants[0]?.toolName).toBe("bash")
    })
  })

  describe("writes update in-memory state AND append to the timeline", () => {
    it("setMode updates the active mode name AND appends a setMode event", () => {
      const appendEntry = vi.fn()
      const config = makeConfig()
      const state = RuntimeState.fromTimeline([], config, "/repo", appendEntry)

      state.setMode("edit")
      // In-memory state updated.
      expect(state.currentModeName()).toBe("edit")
      // Timeline got a custom entry with the right type.
      expect(appendEntry).toHaveBeenCalledWith(
        RUNTIME_CUSTOM_TYPE,
        expect.objectContaining({ type: "setMode", modeName: "edit" }),
      )
    })

    it("addSessionAllowedPath updates the session-paths store AND appends an event", () => {
      const appendEntry = vi.fn()
      const config = makeConfig()
      const state = RuntimeState.fromTimeline([], config, "/repo", appendEntry)

      state.addSessionAllowedPath({ tags: ["readonly"], path: "/repo" })
      expect(state.sessionAllowedPaths()).toEqual([{ tags: ["readonly"], path: "/repo" }])
      expect(appendEntry).toHaveBeenCalledWith(
        RUNTIME_CUSTOM_TYPE,
        expect.objectContaining({
          type: "addSessionAllowedPath",
          entry: { tags: ["readonly"], path: "/repo" },
        }),
      )
    })

    it("addRuntimeGrant updates the grants store AND appends an event", () => {
      const appendEntry = vi.fn()
      const config = makeConfig()
      const state = RuntimeState.fromTimeline([], config, "/repo", appendEntry)

      state.addRuntimeGrant({ modeName: "default", toolName: "read" })
      expect(state.runtimeGrants()).toEqual([{ modeName: "default", toolName: "read" }])
      expect(appendEntry).toHaveBeenCalledWith(
        RUNTIME_CUSTOM_TYPE,
        expect.objectContaining({
          type: "addRuntimeGrant",
          grant: { modeName: "default", toolName: "read" },
        }),
      )
    })

    it("setMode is a no-op when the mode is not in the config (no spurious timeline event)", () => {
      const appendEntry = vi.fn()
      const config = makeConfig()
      const state = RuntimeState.fromTimeline([], config, "/repo", appendEntry)

      state.setMode("ghost")
      // Active mode stays where it was.
      expect(state.currentModeName()).toBe(config.modeOrder[0])
      // No timeline entry was added.
      expect(appendEntry).not.toHaveBeenCalled()
    })
  })

  describe("runtime behavior", () => {
    it("does not read the timeline at runtime — the in-memory state is the source of truth within a session", () => {
      // Build a state whose initial mode is "edit" (via the timeline).
      // Then write a separate `setMode` event into "the timeline"; the
      // factory does not see it (because reading the timeline happened
      // at `fromTimeline`). The in-memory state still reports "edit",
      // and `RuntimeState`'s read methods do NOT consult the timeline.
      const appendEntry = vi.fn()
      const config = makeConfig()
      const initialTimeline: SessionEventTimeline = [
        { type: "setMode", modeName: "edit", timestamp: "2026-07-01T00:00:00Z" },
      ]
      const state = RuntimeState.fromTimeline(initialTimeline, config, "/repo", appendEntry)
      expect(state.currentModeName()).toBe("edit")

      // Subsequent writes use only the appendEntry callback and the
      // in-memory store — the timeline is a write-side append only.
      state.setMode("readonly")
      expect(state.currentModeName()).toBe("readonly")
      expect(appendEntry).toHaveBeenCalledTimes(1)
    })

    it("applyGrantsFor overlays runtime grants on a mode's toolRules for the matcher", () => {
      const config = makeConfig()
      const timeline: SessionEventTimeline = [
        {
          type: "addRuntimeGrant",
          grant: { modeName: "default", toolName: "bash" },
          timestamp: "2026-07-01T00:00:00Z",
        },
      ]
      const state = RuntimeState.fromTimeline(timeline, config, "/repo")
      const baseMode = config.modes.default!
      const result = state.applyGrantsFor("default", baseMode)
      // The grant broad-allow creates a new entry on `toolRules.bash`.
      expect(result.toolRules.bash).toEqual([{ verdict: "allow" }])
      // The mode is a new object (no in-place mutation).
      expect(result).not.toBe(baseMode)
    })

    it("applyGrantsFor with no grants returns the input mode unchanged", () => {
      const config = makeConfig()
      const state = RuntimeState.fromTimeline([], config, "/repo")
      const baseMode = config.modes.default!
      // No grants for the "readonly" mode.
      expect(state.applyGrantsFor("readonly", baseMode)).toBe(baseMode)
    })
  })
})

describe("sessionToConfigLayer", () => {
  it("translates each event type into the right Partial<Config> slice", () => {
    const config = makeConfig()
    const timeline: SessionEventTimeline = [
      {
        type: "addSessionAllowedPath",
        entry: { tags: ["mutating"], path: "/repo/src" },
        timestamp: "2026-07-01T00:00:00Z",
      },
      {
        type: "addRuntimeGrant",
        grant: { modeName: "default", toolName: "bash" },
        timestamp: "2026-07-01T00:00:01Z",
      },
      { type: "setMode", modeName: "readonly", timestamp: "2026-07-01T00:00:02Z" },
    ]
    const layer = sessionToConfigLayer(timeline, config, "/repo")
    // The session-paths entry was projected.
    expect(layer.allowedPaths).toEqual([{ tags: ["mutating"], path: "/repo/src" }])
    // The most-recent setMode was projected as the new modeOrder head.
    expect(layer.modeOrder).toEqual(["readonly"])
    // Per-mode runtime grants are applied at consumer time
    // (applyGrantsFor), not via the partial-config projection.
  })

  it("returns an empty partial when the timeline is empty", () => {
    const layer = sessionToConfigLayer([], makeConfig(), "/repo")
    expect(layer).toEqual({})
  })
})
