import { describe, expect, it } from "vitest"

import { composeConfig } from "./compose-config.ts"
import type { Config, Mode } from "./types.ts"

/** Build a minimal valid `Config` for tests. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    modeOrder: [],
    modes: {},
    allowedPaths: [],
    taggingRules: [],
    toolMetadata: {},
    ...overrides,
  }
}

/** A pre-canned `Mode` template; tests override the fields they care about. */
function makeMode(overrides: Partial<Mode> = {}): Mode {
  return {
    description: "test mode",
    defaultDecision: "ask",
    tagRules: {},
    toolRules: {},
    aspectRules: {},
    ...overrides,
  }
}

describe("composeConfig", () => {
  describe("N-layer merge (later wins)", () => {
    it("folds three stock/user/project layers into a single Config with later-wins semantics", () => {
      // Stock: permissive base.
      const stock = makeConfig({
        modeOrder: ["default", "readonly", "edit", "plan", "__yolo__"],
        modes: {
          default: makeMode({
            defaultDecision: "ask",
            tagRules: { mutating: "ask", execution: "ask" },
          }),
        },
        allowedPaths: [],
        taggingRules: [],
      })
      // User: tightens one tag rule (deny vs ask).
      const user = makeConfig({
        modes: {
          default: makeMode({
            tagRules: { mutating: "deny" },
          }),
        },
      })
      // Project: also tightens; later layer wins.
      const project = makeConfig({
        modes: {
          default: makeMode({
            description: "project-default",
          }),
        },
      })

      const { config, warnings } = composeConfig(stock, user, project)

      // modeOrder: concat-dedup → no change here, all stock modes already unique.
      expect(config.modeOrder).toEqual(stock.modeOrder)
      // modes: per-mode deep-merge. Project's description wins; user's
      // tagRules merge into stock's; user's deny for `mutating` wins.
      const mergedDefault = config.modes.default
      expect(mergedDefault?.description).toBe("project-default")
      expect(mergedDefault?.tagRules.mutating).toBe("deny")
      expect(mergedDefault?.tagRules.execution).toBe("ask")
      // No warnings of its own from composeConfig.
      expect(warnings).toEqual([])
    })

    it("concatenates allowedPaths across layers (no replace)", () => {
      const a = makeConfig({
        allowedPaths: [{ tags: ["mutating"], path: "/repo" }],
      })
      const b = makeConfig({
        allowedPaths: [
          { tags: ["readonly"], path: "/repo" },
          { tags: ["mutating"], path: "/repo/src" },
        ],
      })
      const { config } = composeConfig(a, b)
      // Both layers' entries accumulate.
      expect(config.allowedPaths).toEqual([
        { tags: ["mutating"], path: "/repo" },
        { tags: ["readonly"], path: "/repo" },
        { tags: ["mutating"], path: "/repo/src" },
      ])
    })

    it("concatenates taggingRules across layers (no replace)", () => {
      const a = makeConfig({
        taggingRules: [{ tool: "bash", fields: { command: ["ls"] }, action: { type: "addTags", tags: ["readonly"] } }],
      })
      const b = makeConfig({
        taggingRules: [
          { tool: "bash", fields: { command: ["echo *"] }, action: { type: "addTags", tags: ["readonly"] } },
        ],
      })
      const { config } = composeConfig(a, b)
      expect(config.taggingRules).toEqual([
        { tool: "bash", fields: { command: ["ls"] }, action: { type: "addTags", tags: ["readonly"] } },
        { tool: "bash", fields: { command: ["echo *"] }, action: { type: "addTags", tags: ["readonly"] } },
      ])
    })

    it("merges toolMetadata per tool name (union-deduped tags; shallow-merged aspects)", () => {
      const a = makeConfig({
        toolMetadata: {
          bash: {
            tags: ["execution"],
            aspects: { bash_cmd: { mode: "bash", fields: ["command"] } },
          },
        },
      })
      const b = makeConfig({
        toolMetadata: {
          bash: {
            tags: ["execution"], // dedup with layer a
            aspects: {
              bash_cmd: { mode: "bash", fields: ["command"] }, // dedup
              env: { mode: "glob", fields: ["PATH"] },
            },
          },
        },
      })
      const { config } = composeConfig(a, b)
      expect(config.toolMetadata.bash?.tags).toEqual(["execution"])
      expect(config.toolMetadata.bash?.aspects.bash_cmd).toEqual({
        mode: "bash",
        fields: ["command"],
      })
      expect(config.toolMetadata.bash?.aspects.env).toEqual({
        mode: "glob",
        fields: ["PATH"],
      })
    })
  })

  describe("modeOrder", () => {
    it("concatenates modeOrder across layers (later adds, not replaces)", () => {
      // Stock sets the canonical cycle; the user's layer appends a
      // custom mode at the end.
      const stock = makeConfig({ modeOrder: ["default", "readonly", "edit", "plan"] })
      const user = makeConfig({ modeOrder: ["default", "readonly", "edit", "plan", "custom-user-mode"] })
      const { config } = composeConfig(stock, user)
      // Pure concat; dedup preserves first occurrence (later layer's
      // "custom-user-mode" is preserved because first appearance is
      // in the user layer — since stock didn't have it).
      expect(config.modeOrder).toEqual(["default", "readonly", "edit", "plan", "custom-user-mode"])
    })

    it("dedup preserves first occurrence (a reversed-order layer does not override stock order)", () => {
      // The user layer lists the stock modes in a different order
      // and adds a new one at the head. The merged order should
      // match the stock layer's order, with the user's new entry
      // appended at the end (because ts-deepmerge's first-occurrence
      // dedup preserves the stock-listed entries' positions; the
      // user-introduced entry has its first occurrence in the user
      // layer, so it lands after the stock entries).
      const stock = makeConfig({ modeOrder: ["default", "readonly", "edit", "plan"] })
      const user = makeConfig({ modeOrder: ["custom-user-mode", "default", "readonly", "edit", "plan"] })
      const { config } = composeConfig(stock, user)
      expect(config.modeOrder).toEqual(["default", "readonly", "edit", "plan", "custom-user-mode"])
    })
  })

  describe("edge cases", () => {
    it("throws on zero layers", () => {
      expect(() => composeConfig()).toThrow(/at least one layer/)
    })

    it("returns the single layer untouched when one layer is supplied", () => {
      const only = makeConfig({
        modeOrder: ["default"],
        modes: { default: makeMode({ description: "only" }) },
      })
      const { config } = composeConfig(only)
      expect(config.modeOrder).toEqual(["default"])
      expect(config.modes.default?.description).toBe("only")
    })

    it("returns {} (empty Config) when every layer is the empty Config", () => {
      const empty = makeConfig()
      const { config } = composeConfig(empty, empty, empty)
      expect(config).toEqual({
        modeOrder: [],
        modes: {},
        allowedPaths: [],
        taggingRules: [],
        toolMetadata: {},
      })
    })

    it("returns an empty warnings array (composeConfig emits no warnings; inventory runs separately)", () => {
      // The warnings contract is preserved as part of the return
      // shape for symmetry with `loadConfig`. `composeConfig`
      // itself emits no warnings; cycle / unknown-`extends`
      // detection is the consumer's job (via `inventoryWarnings`).
      const { warnings } = composeConfig(makeConfig(), makeConfig())
      expect(warnings).toEqual([])
    })
  })
})
