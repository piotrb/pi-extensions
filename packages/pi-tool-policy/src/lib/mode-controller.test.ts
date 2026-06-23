import { describe, expect, it } from "vitest"

import { ModeController } from "./mode-controller.ts"
import { computeExtendsChain } from "./mode-controller.ts"
import type { Config } from "./types.ts"

function makeConfig(modeOrder: string[]): Config {
  const modes: Config["modes"] = {}
  for (const name of modeOrder) {
    modes[name] = { description: name, defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} }
  }
  return { modeOrder, modes, allowedPaths: [], taggingRules: [], toolMetadata: {} }
}

describe("ModeController", () => {
  describe("cycleMode", () => {
    it("cycles to the next mode in modeOrder", () => {
      const c = new ModeController()
      c.reset(makeConfig(["default", "plan", "edit"]))
      expect(c.getMode()).toBe("default")
      expect(c.cycleMode(makeConfig(["default", "plan", "edit"]))).toBe("plan")
      expect(c.getMode()).toBe("plan")
      expect(c.cycleMode(makeConfig(["default", "plan", "edit"]))).toBe("edit")
      expect(c.getMode()).toBe("edit")
    })

    it("wraps around at the end of modeOrder", () => {
      const c = new ModeController()
      c.reset(makeConfig(["default", "plan"]))
      c.cycleMode(makeConfig(["default", "plan"])) // plan
      expect(c.cycleMode(makeConfig(["default", "plan"]))).toBe("default") // wraps
    })

    it("returns the current mode when modeOrder is empty", () => {
      const c = new ModeController()
      c.reset(makeConfig([]))
      expect(c.cycleMode(makeConfig([]))).toBe("default")
    })
  })

  describe("setMode", () => {
    it("sets the current mode", () => {
      const c = new ModeController()
      c.reset(makeConfig(["default", "plan"]))
      c.setMode("plan", makeConfig(["default", "plan"]))
      expect(c.getMode()).toBe("plan")
    })

    it("throws on unknown mode", () => {
      const c = new ModeController()
      c.reset(makeConfig(["default"]))
      expect(() => {
        c.setMode("missing", makeConfig(["default"]))
      }).toThrow("Unknown mode")
    })
  })

  describe("buildAdditionalInstructions", () => {
    it("returns empty string when the mode has no additionalInstructions", () => {
      const c = new ModeController()
      c.reset(makeConfig(["default"]))
      const out = c.buildAdditionalInstructions(makeConfig(["default"]))
      expect(out).toBe("")
    })

    it("returns the section wrapped in markers when the mode has prose", () => {
      const c = new ModeController()
      const config: Config = {
        modeOrder: ["plan"],
        modes: {
          plan: {
            description: "plan",
            defaultDecision: "deny",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
            additionalInstructions: { mode: "replace", text: "You are in plan mode." },
          },
        },
        allowedPaths: [],
        taggingRules: [],
        toolMetadata: {},
      }
      c.reset(config)
      const out = c.buildAdditionalInstructions(config)
      expect(out).toContain("[Tool policy mode: plan]")
      expect(out).toContain("You are in plan mode.")
      expect(out).toContain("[/Tool policy mode]")
    })

    it("joins string[] text with newlines", () => {
      const c = new ModeController()
      const config: Config = {
        modeOrder: ["plan"],
        modes: {
          plan: {
            description: "plan",
            defaultDecision: "deny",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
            additionalInstructions: { mode: "append", text: ["line 1", "line 2", "line 3"] },
          },
        },
        allowedPaths: [],
        taggingRules: [],
        toolMetadata: {},
      }
      c.reset(config)
      const out = c.buildAdditionalInstructions(config)
      expect(out).toContain("line 1\nline 2\nline 3")
    })
  })

  describe("refreshStatusBar", () => {
    it("sets the status key to 'mode: <name> (Alt+M)'", () => {
      const c = new ModeController()
      c.reset(makeConfig(["default", "plan"]))
      let capturedKey: string | undefined
      let capturedVal: string | undefined
      const capturingCtx = {
        ui: {
          setStatus: (key: string, val: string | undefined) => {
            capturedKey = key
            capturedVal = val
          },
        },
      }
      c.refreshStatusBar(capturingCtx)
      expect(capturedKey).toBe("tool-policy-mode")
      expect(capturedVal).toBe("mode: default (Alt+M)")
    })

    it("renders the EMERGENCY OFF status text when the YOLO mode is active", () => {
      const c = new ModeController()
      c.reset(makeConfig(["default", "plan", "__yolo__"]))
      c.setMode("__yolo__", makeConfig(["default", "plan", "__yolo__"]))
      let capturedVal: string | undefined
      const capturingCtx = {
        ui: {
          setStatus: (_key: string, val: string | undefined) => {
            capturedVal = val
          },
        },
      }
      c.refreshStatusBar(capturingCtx)
      expect(capturedVal).toContain("EMERGENCY OFF")
      expect(capturedVal).toContain("__yolo__")
    })
  })

  describe("isYolo", () => {
    it("is true when the current mode is __yolo__", () => {
      const c = new ModeController()
      c.reset(makeConfig(["default", "plan", "__yolo__"]))
      c.setMode("__yolo__", makeConfig(["default", "plan", "__yolo__"]))
      expect(c.isYolo()).toBe(true)
    })

    it("is false for normal modes", () => {
      const c = new ModeController()
      c.reset(makeConfig(["default", "plan"]))
      expect(c.isYolo()).toBe(false)
    })
  })

  describe("warnings", () => {
    it("stores and returns warnings", () => {
      const c = new ModeController()
      expect(c.getWarnings()).toEqual([])
      c.setWarnings(["w1", "w2"])
      expect(c.getWarnings()).toEqual(["w1", "w2"])
    })
  })

  describe("getExtendsChain", () => {
    it("returns just the current mode for a standalone mode (no extends)", () => {
      const c = new ModeController()
      c.reset(makeConfig(["solo"]))
      const config: Config = {
        modeOrder: ["solo"],
        modes: {
          solo: { description: "solo", defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
        },
        allowedPaths: [],
        taggingRules: [],
        toolMetadata: {},
      }
      expect(c.getExtendsChain(config)).toEqual(["solo"])
    })

    it("returns [child, parent] for a two-mode chain", () => {
      const c = new ModeController()
      c.reset(makeConfig(["child"]))
      const config: Config = {
        modeOrder: ["child", "parent"],
        modes: {
          child: {
            description: "child",
            extends: ["parent"],
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
          },
          parent: { description: "parent", defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
        },
        allowedPaths: [],
        taggingRules: [],
        toolMetadata: {},
      }
      expect(c.getExtendsChain(config)).toEqual(["child", "parent"])
    })

    it("walks the full chain for a three-mode inheritance (edit → default → readonly)", () => {
      const c = new ModeController()
      c.reset(makeConfig(["edit"]))
      const config: Config = {
        modeOrder: ["edit", "default", "readonly"],
        modes: {
          edit: {
            description: "edit",
            extends: ["default"],
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
          },
          default: {
            description: "default",
            extends: ["readonly"],
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
          },
          readonly: { description: "readonly", defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
        },
        allowedPaths: [],
        taggingRules: [],
        toolMetadata: {},
      }
      expect(c.getExtendsChain(config)).toEqual(["edit", "default", "readonly"])
    })

    it("stops at the first unknown link in the chain (returns what we collected)", () => {
      const c = new ModeController()
      c.reset(makeConfig(["child"]))
      const config: Config = {
        modeOrder: ["child"],
        modes: {
          child: {
            description: "child",
            extends: ["ghost"], // ghost is not defined
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
          },
        },
        allowedPaths: [],
        taggingRules: [],
        toolMetadata: {},
      }
      expect(c.getExtendsChain(config)).toEqual(["child"])
    })

    it("short-circuits a cycle (a → b → a) instead of infinite-looping", () => {
      const c = new ModeController()
      c.reset(makeConfig(["a"]))
      const config: Config = {
        modeOrder: ["a", "b"],
        modes: {
          a: {
            description: "a",
            extends: ["b"],
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
          },
          b: {
            description: "b",
            extends: ["a"],
            defaultDecision: "ask",
            tagRules: {},
            toolRules: {},
            aspectRules: {},
          },
        },
        allowedPaths: [],
        taggingRules: [],
        toolMetadata: {},
      }
      const chain = c.getExtendsChain(config)
      // Must terminate (no infinite loop). Must contain each mode
      // at most once.
      expect(new Set(chain).size).toBe(chain.length)
      expect(chain[0]).toBe("a")
    })

    it("returns [] for an unknown current mode (the mode is not in the config)", () => {
      // The pure helper computes the chain from a config that doesn't
      // contain the requested mode — returns []. The ModeController's
      // `setMode` rejects unknown modes (covered in a separate test
      // above), so this case can only be reached via the pure helper
      // with a manually-constructed config.
      const config: Config = {
        modeOrder: ["default"],
        modes: {
          default: { description: "d", defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} },
        },
        allowedPaths: [],
        taggingRules: [],
        toolMetadata: {},
      }
      expect(computeExtendsChain(config, "missing")).toEqual([])
    })
  })
})
