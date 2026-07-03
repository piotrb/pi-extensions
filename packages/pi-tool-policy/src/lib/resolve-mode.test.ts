import { describe, expect, it } from "vitest"

import { resolveMode } from "./resolve-mode.ts"
import type { Config, Mode } from "./types.ts"

function makeMode(overrides: Partial<Mode> = {}): Mode {
  return {
    description: "test mode",
    defaultDecision: "allow",
    tagRules: {},
    toolRules: {},
    aspectRules: {},
    ...overrides,
  }
}

function makeConfig(modes: Record<string, Mode>): Config {
  return {
    modeOrder: Object.keys(modes),
    modes,
    allowedPaths: [],
    taggingRules: [],
    toolMetadata: {},
  }
}

describe("resolveMode", () => {
  describe("standalone mode (no extends)", () => {
    it("returns the mode's own fields with no extends key in the result", () => {
      const child = makeMode({ description: "child-only", defaultDecision: "deny" })
      const config = makeConfig({ custom: child })

      const { mode, warnings } = resolveMode("custom", config)

      expect(warnings).toEqual([])
      expect(mode.description).toBe("child-only")
      expect(mode.defaultDecision).toBe("deny")
      // The extends field must NOT survive resolution — it was either
      // absent or applied (and applied means the field is gone).
      expect("extends" in mode).toBe(false)
    })

    it("does not consult any parent mode for standalone modes", () => {
      const child = makeMode({ defaultDecision: "deny", tagRules: { mutating: "ask" } })
      const parent = makeMode({ defaultDecision: "allow", tagRules: { readonly: "allow" } })
      const config = makeConfig({ custom: child, parent })

      const { mode, warnings } = resolveMode("custom", config)

      expect(warnings).toEqual([])
      // Child's tagRules are untouched; parent's tagRules are NOT leaked in.
      expect(mode.tagRules).toEqual({ mutating: "ask" })
    })
  })

  describe("child extends parent", () => {
    it("child's overrides win for the same key; parent's other rules survive", () => {
      const parent = makeMode({
        defaultDecision: "allow",
        tagRules: { readonly: "allow", metadata: "allow" },
        description: "parent",
      })
      const child = makeMode({
        extends: ["parent"],
        defaultDecision: "deny",
        tagRules: { mutating: "allow" },
        description: "child",
      })
      const config = makeConfig({ parent, child })

      const { mode, warnings } = resolveMode("child", config)

      expect(warnings).toEqual([])
      // Child wins on shared keys (defaultDecision, description).
      expect(mode.defaultDecision).toBe("deny")
      expect(mode.description).toBe("child")
      // Parent's tagRules survive into the merge; child's tagRules merge in.
      expect(mode.tagRules).toEqual({
        readonly: "allow",
        metadata: "allow",
        mutating: "allow",
      })
      // No extends field on the resolved mode.
      expect("extends" in mode).toBe(false)
    })

    it("multi-step chain applies parents in extends-chain order", () => {
      const grandparent = makeMode({
        defaultDecision: "allow",
        tagRules: { readonly: "allow" },
        description: "grandparent",
      })
      const parent = makeMode({
        extends: ["grandparent"],
        defaultDecision: "ask",
        tagRules: { network: "ask" },
        description: "parent",
      })
      const child = makeMode({
        extends: ["parent"],
        defaultDecision: "deny",
        tagRules: { mutating: "allow" },
        description: "child",
      })
      const config = makeConfig({ grandparent, parent, child })

      const { mode, warnings } = resolveMode("child", config)

      expect(warnings).toEqual([])
      expect(mode.description).toBe("child")
      expect(mode.defaultDecision).toBe("deny")
      // All three levels of tagRules merge in.
      expect(mode.tagRules).toEqual({
        readonly: "allow",
        network: "ask",
        mutating: "allow",
      })
    })
  })

  describe("cycle (A extends B extends A)", () => {
    it("degrades gracefully: returns a Mode (no throw) AND emits a warning naming the cycle", () => {
      const a: Mode = makeMode({ extends: ["b"], defaultDecision: "deny", description: "a" })
      const b: Mode = makeMode({ extends: ["a"], defaultDecision: "ask", description: "b" })
      const config = makeConfig({ a, b })

      const { mode, warnings } = resolveMode("a", config)

      // Behavior assertion: the function returned a Mode (no crash on cycle).
      expect(mode).toBeDefined()
      expect(mode.description).toBeDefined()
      // Behavior assertion: at least one warning, and it names the cycle / one of the modes.
      expect(warnings.length).toBeGreaterThan(0)
      const cycleWarning = warnings.find((w) => /cycle|circular|cycle detected/i.test(w))
      expect(cycleWarning, `expected a cycle warning, got: ${JSON.stringify(warnings)}`).toBeDefined()
    })
  })

  describe("unknown extends target", () => {
    it("emits a warning and still resolves the child with its own fields", () => {
      const child = makeMode({
        extends: ["ghost-mode-not-in-config"],
        defaultDecision: "deny",
        description: "child with missing parent",
        tagRules: { mutating: "ask" },
      })
      const config = makeConfig({ child })

      const { mode, warnings } = resolveMode("child", config)

      // No crash; child mode returned.
      expect(mode.description).toBe("child with missing parent")
      expect(mode.defaultDecision).toBe("deny")
      expect(mode.tagRules).toEqual({ mutating: "ask" })
      // Warning naming the missing parent.
      const unknownWarning = warnings.find(
        (w) => w.includes("ghost-mode-not-in-config") && /unknown|missing|not found|extends/i.test(w),
      )
      expect(unknownWarning, `expected an unknown-extends warning, got: ${JSON.stringify(warnings)}`).toBeDefined()
    })
  })

  describe("mode not in config (stale currentModeName)", () => {
    it("returns a safe-default mode and pushes a warning rather than crashing", () => {
      const config = makeConfig({})

      const { mode, warnings } = resolveMode("phantom", config)

      // No throw; safe-default mode returned (the matcher can still run with it).
      expect(mode).toBeDefined()
      expect(typeof mode.defaultDecision).toBe("string")
      expect(typeof mode.description).toBe("string")
      expect(mode.tagRules).toEqual({})
      expect(mode.toolRules).toEqual({})
      expect(mode.aspectRules).toEqual({})
      // Warning names the missing mode.
      const missingWarning = warnings.find((w) => w.includes("phantom") && /unknown|missing|not found/i.test(w))
      expect(missingWarning, `expected a missing-mode warning, got: ${JSON.stringify(warnings)}`).toBeDefined()
    })
  })
})
