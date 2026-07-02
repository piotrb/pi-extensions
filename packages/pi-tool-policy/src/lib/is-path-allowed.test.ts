import { describe, expect, it } from "vitest"

import { isPathAllowed } from "./is-path-allowed.ts"
import type { AllowedPath } from "./types.ts"

describe("isPathAllowed", () => {
  describe("path inside an allowed directory is allowed", () => {
    it("covers a descendant path when the allowed entry has empty tags", () => {
      const allowedPaths: AllowedPath[] = [{ tags: [], path: "/repo" }]
      expect(isPathAllowed("/repo/foo.ts", ["readonly"], allowedPaths)).toBe(true)
    })
  })

  describe("path outside the allowed directory is denied", () => {
    it("denies a path that is not contained in any allowed entry", () => {
      const allowedPaths: AllowedPath[] = [{ tags: [], path: "/repo" }]
      expect(isPathAllowed("/etc/passwd", ["readonly"], allowedPaths)).toBe(false)
    })
  })

  describe("required tags must all be present", () => {
    const allowedPaths: AllowedPath[] = [{ tags: ["readonly", "metadata"], path: "/repo" }]

    it("allows when effectiveTags contain every required tag", () => {
      expect(isPathAllowed("/repo/foo", ["readonly", "metadata"], allowedPaths)).toBe(true)
    })

    it("denies when effectiveTags are missing a required tag", () => {
      expect(isPathAllowed("/repo/foo", ["readonly"], allowedPaths)).toBe(false)
    })

    it("denies when effectiveTags are empty", () => {
      expect(isPathAllowed("/repo/foo", [], allowedPaths)).toBe(false)
    })
  })

  describe("empty allowedPaths denies everything", () => {
    it("denies any path when the allowed list is empty", () => {
      expect(isPathAllowed("/repo", ["readonly"], [])).toBe(false)
      expect(isPathAllowed("/", [], [])).toBe(false)
    })
  })
})
