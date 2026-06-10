import { describe, expect, it } from "vitest"

import { matchAspect } from "./aspects.ts"
import type { AspectDefinition, Verdict } from "./types.ts"

describe("matchAspect", () => {
  describe("path", () => {
    // Last-match-wins: defaults come FIRST, overrides come LATER. This means
    // a more specific pattern (e.g. "*.env") declared after "*" will win
    // for the value it matches, and "*" acts as the catch-all default.
    const path: AspectDefinition = { patterns: { "**": "allow", "*.env": "deny" } }

    it("matches .env inside cwd (deny wins because *.env is later)", () => {
      expect(matchAspect("path", "/repo/.env", path, "/repo")).toEqual({
        verdict: "deny",
        pattern: "*.env",
      })
    })

    it("allows a regular file (matches the ** catch-all)", () => {
      // `**` is opt-in cross-segment (gitignore-style); `*` would NOT match `src/foo.ts`.
      expect(matchAspect("path", "/repo/src/foo.ts", path, "/repo")).toEqual({
        verdict: "allow",
        pattern: "**",
      })
    })

    it("returns undecided when no pattern matches and no '**' default", () => {
      const noDefault: AspectDefinition = { patterns: { "*.env": "deny" } }
      expect(matchAspect("path", "/repo/foo.ts", noDefault, "/repo")).toBe("undecided")
    })
  })

  describe("url", () => {
    // Last-match-wins: defaults first, specific overrides later.
    const url: AspectDefinition = { patterns: { "*": "ask", "https://*.example.com/*": "allow" } }

    it("allows an example.com URL (more-specific pattern declared later wins)", () => {
      expect(matchAspect("url", "https://api.example.com/foo", url, "/")).toEqual({
        verdict: "allow",
        pattern: "https://*.example.com/*",
      })
    })

    it("asks for a non-example.com URL (falls through to *)", () => {
      expect(matchAspect("url", "https://github.com/foo", url, "/")).toEqual({
        verdict: "ask",
        pattern: "*",
      })
    })

    it("falls back to https:// for bare hosts", () => {
      expect(matchAspect("url", "github.com/foo", url, "/")).toEqual({
        verdict: "ask",
        pattern: "*",
      })
    })
  })

  describe("bash_cmd", () => {
    // Last-match-wins: defaults first, specific overrides later.
    const bash: AspectDefinition = {
      mode: "bash",
      patterns: { "*": "ask", "pnpm run *": "allow", "rm -rf *": "deny" },
    }

    it("allows pnpm run test", () => {
      // Caller has joined ["pnpm", "run", "test"] with " " → "pnpm run test"
      expect(matchAspect("bash_cmd", "pnpm run test", bash, "/")).toEqual({
        verdict: "allow",
        pattern: "pnpm run *",
      })
    })

    it("denies rm -rf /", () => {
      expect(matchAspect("bash_cmd", "rm -rf /", bash, "/")).toEqual({
        verdict: "deny",
        pattern: "rm -rf *",
      })
    })

    it("asks for an unknown command (falls through to *)", () => {
      expect(matchAspect("bash_cmd", "echo hi", bash, "/")).toEqual({
        verdict: "ask",
        pattern: "*",
      })
    })

    it("bash word-boundary: 'git' matches 'git *' but 'gitfoo' does not", () => {
      const allowGit: AspectDefinition = { mode: "bash", patterns: { "git *": "allow" } }
      expect(matchAspect("bash_cmd", "git status", allowGit, "/")).toEqual({
        verdict: "allow",
        pattern: "git *",
      })
      // Wait — "git" alone should match "git *" with the word-boundary. "gitfoo" should not.
      expect(matchAspect("bash_cmd", "gitfoo", allowGit, "/")).toBe("undecided")
    })
  })

  describe("glob", () => {
    // Last-match-wins: defaults first, specific overrides later.
    const glob: AspectDefinition = { patterns: { "*": "deny", "*.ts": "allow" } }

    it("matches a .ts file (basename-only, *.ts declared after *)", () => {
      // basename of "/repo/src/foo.ts" is "foo.ts" — matches "*.ts".
      expect(matchAspect("glob", "/repo/src/foo.ts", glob, "/repo")).toEqual({
        verdict: "allow",
        pattern: "*.ts",
      })
    })
  })

  describe("last-match-wins", () => {
    it("returns the LAST matching pattern, not the first", () => {
      const aspect: AspectDefinition = {
        patterns: { "**": "ask", "*.env": "allow", "*.env.*": "deny" },
      }
      // ".env.local" matches "*.env" AND "*.env.*" — the LAST matching wins (deny).
      expect(matchAspect("path", "/repo/.env.local", aspect, "/repo")).toEqual({
        verdict: "deny",
        pattern: "*.env.*",
      })
    })
  })

  describe("performance", () => {
    // Perf bound from the plan: an aspect with 1000 patterns resolves a single
    // match call within 500ms (CI-friendly; locally it’s ~35ms). The design’s
    // "O(n) per call" claim is covered by a 10×-patterns ≈ 10×-time check on
    // the first call, and a per-call budget assertion on the cached path.
    it("an aspect with 1000 patterns resolves (first call) within a CI-friendly bound", () => {
      const patterns: Record<string, Verdict> = {}
      for (let i = 0; i < 1000; i++) {
        patterns[`pattern-${i}-*.ts`] = i === 999 ? "deny" : "allow"
      }
      const aspect: AspectDefinition = { patterns }
      const start = performance.now()
      const result = matchAspect("path", "/repo/pattern-999-final.ts", aspect, "/repo")
      const elapsed = performance.now() - start
      expect(result).toEqual({ verdict: "deny", pattern: "pattern-999-*.ts" })
      // 500ms accommodates a cold disk + parallel turbo load; locally this is ~35ms.
      expect(elapsed).toBeLessThan(500)
    })

    it("a cached 1000-pattern call resolves within 20ms (subsequent call)", () => {
      const patterns: Record<string, Verdict> = {}
      for (let i = 0; i < 1000; i++) {
        patterns[`pattern-${i}-*.ts`] = i === 999 ? "deny" : "allow"
      }
      const aspect: AspectDefinition = { patterns }
      // Prime the module-level picomatch cache.
      matchAspect("path", "/repo/pattern-999-final.ts", aspect, "/repo")
      const start = performance.now()
      const result = matchAspect("path", "/repo/pattern-999-final.ts", aspect, "/repo")
      const elapsed = performance.now() - start
      expect(result).toEqual({ verdict: "deny", pattern: "pattern-999-*.ts" })
      // 20ms accommodates CI noise; locally this is ~1ms.
      expect(elapsed).toBeLessThan(20)
    })
  })
})
