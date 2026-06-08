import { type ChildProcess } from "node:child_process"

import { describe, expect, it } from "vitest"

import { progressiveKill, scheduleProcessTimeout, spawnStreaming } from "./extension-utils.ts"

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
})
