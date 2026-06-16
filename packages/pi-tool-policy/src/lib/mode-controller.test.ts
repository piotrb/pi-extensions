import { describe, expect, it } from "vitest"

import { ModeController } from "./mode-controller.ts"
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
})
