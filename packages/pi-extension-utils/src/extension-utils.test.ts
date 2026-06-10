import type { ChildProcess } from "node:child_process"

import { describe, expect, it } from "vitest"

import {
  bashPatternToRegex,
  genericPatternToRegex,
  lastMatch,
  progressiveKill,
  scheduleProcessTimeout,
  spawnStreaming,
  specificity,
} from "./extension-utils.ts"

// Minimal ChildProcess-compatible mock for unit tests
function makeMockChild(): ChildProcess {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const noop = (): void => {}
  return {
    kill: noop,
    once: noop,
    removeListener: noop,
  } as unknown as ChildProcess
}

describe("extension-utils", () => {
  describe("spawnStreaming", () => {
    it("is a function", () => {
      expect(typeof spawnStreaming).toBe("function")
    })

    it("resolves with exit code 0 for a successful command", async () => {
      const result = await spawnStreaming("node", ["-e", "process.exit(0)"], { cwd: process.cwd() })
      expect(result.exitCode).toBe(0)
      expect(result.lines).toEqual([])
    })

    it("captures stdout lines", async () => {
      const result = await spawnStreaming("node", ["-e", "console.log('hello\\nworld')"], { cwd: process.cwd() })
      expect(result.lines).toEqual(["hello", "world"])
      expect(result.exitCode).toBe(0)
    })

    it("captures stderr lines", async () => {
      const result = await spawnStreaming("node", ["-e", "console.error('error line')"], { cwd: process.cwd() })
      expect(result.lines).toEqual(["error line"])
      expect(result.exitCode).toBe(0)
    })

    it("sets spawnError for non-existent binary", async () => {
      const result = await spawnStreaming("nonexistent-binary-xyz", [], { cwd: process.cwd() })
      expect(result.spawnError).toBeDefined()
      expect(result.spawnError).toContain("command not found")
    })

    it("uses notFoundHint in spawnError when provided", async () => {
      const hint = "Try running: brew install foo"
      const result = await spawnStreaming("nonexistent-binary-xyz", [], { cwd: process.cwd(), notFoundHint: hint })
      expect(result.spawnError).toContain(hint)
    })
  })

  describe("progressiveKill", () => {
    it("is a function", () => {
      expect(typeof progressiveKill).toBe("function")
    })

    it("returns a cleanup function", () => {
      const mockChild = makeMockChild()
      const cleanup = progressiveKill(mockChild)
      cleanup() // cancel pending timers
      expect(typeof cleanup).toBe("function")
    })
  })

  describe("scheduleProcessTimeout", () => {
    it("is a function", () => {
      expect(typeof scheduleProcessTimeout).toBe("function")
    })

    it("returns a cancel function", () => {
      const mockChild = makeMockChild()
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      const cancel = scheduleProcessTimeout(Infinity, mockChild, () => {})
      expect(typeof cancel).toBe("function")
    })

    it("no-op cancel when ms is Infinity", () => {
      const mockChild = makeMockChild()
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      const cancel = scheduleProcessTimeout(Infinity, mockChild, () => {})
      expect(() => {
        cancel()
      }).not.toThrow()
    })
  })

  describe("bashPatternToRegex", () => {
    it("lifts the runner's behavior byte-equivalently", () => {
      expect(bashPatternToRegex("git *").test("git status")).toBe(true)
      expect(bashPatternToRegex("git *").test("git")).toBe(true) // word-boundary
      expect(bashPatternToRegex("git:*").test("git status")).toBe(true) // :* → ' *'
      expect(bashPatternToRegex("pnpm run *").test("pnpm run test")).toBe(true)
      expect(bashPatternToRegex("rm -rf *").test("rm -rf /")).toBe(true)
      expect(bashPatternToRegex("*").test("anything goes")).toBe(true)
      expect(bashPatternToRegex("git").test("git status")).toBe(false) // exact match
    })
  })

  describe("genericPatternToRegex", () => {
    it("drops the bash word-boundary", () => {
      expect(genericPatternToRegex("git *").test("git status")).toBe(true)
      expect(genericPatternToRegex("git *").test("git")).toBe(false) // NO word-boundary
      expect(genericPatternToRegex("git").test("git")).toBe(true)
      expect(genericPatternToRegex("git").test("git status")).toBe(false)
      expect(genericPatternToRegex("*.env").test(".env")).toBe(true)
      expect(genericPatternToRegex("*").test("anything goes")).toBe(true)
      expect(genericPatternToRegex("foo*bar").test("foo and bar")).toBe(true)
    })
  })

  describe("specificity", () => {
    it("counts non-wildcard characters", () => {
      expect(specificity("git")).toBe(3)
      expect(specificity("git *")).toBe(4) // 'g','i','t',' ' = 4 non-wildcards (space is a char)
      expect(specificity("*")).toBe(0)
      expect(specificity("*.env")).toBe(4) // '.','e','n','v' = 4 non-wildcards
      expect(specificity("pnpm run test")).toBe(13) // 'p','n','p','m',' ','r','u','n',' ','t','e','s','t'
    })
  })

  describe("lastMatch", () => {
    it("returns the last matching entry's value", () => {
      // With the more-specific pattern declared first, the more-general
      // pattern declared second wins (last-match-wins).
      const entries = { "*.env": "deny", "*": "allow" }
      expect(lastMatch(entries, ".env", genericPatternToRegex)).toEqual({ pattern: "*", value: "allow" })
      expect(lastMatch(entries, "foo.txt", genericPatternToRegex)).toEqual({ pattern: "*", value: "allow" })
    })

    it("returns the more specific pattern when it is declared last", () => {
      // Reverse the order: the more-specific pattern now wins for .env.
      const entries = { "*": "allow", "*.env": "deny" }
      expect(lastMatch(entries, ".env", genericPatternToRegex)).toEqual({ pattern: "*.env", value: "deny" })
      expect(lastMatch(entries, "foo.txt", genericPatternToRegex)).toEqual({ pattern: "*", value: "allow" })
    })

    it("returns undefined when no pattern matches and no '*' fallback", () => {
      const entries = { "*.env": "deny" }
      expect(lastMatch(entries, "foo.txt", genericPatternToRegex)).toBeUndefined()
    })
  })
})
