import { describe, expect, it } from "vitest"

import { buildCoverageReport } from "./coverage.ts"
import type { Mode, ResolvedToolMetadata } from "./types.ts"

function modeWith(rules: Partial<Mode> = {}): Mode {
  return {
    description: "test",
    defaultDecision: "ask",
    tagRules: {},
    toolRules: {},
    aspectRules: {},
    ...rules,
  }
}

const runMeta: ResolvedToolMetadata = {
  tags: ["execution"],
  fields: { command: { mode: "bash", fields: ["cmd"] } },
}

const readMeta: ResolvedToolMetadata = {
  tags: ["readonly"],
  fields: { path: { mode: "path", fields: ["path"] } },
}

describe("buildCoverageReport", () => {
  describe("aspect coverage", () => {
    it("returns false when the mode has no aspect rules", () => {
      const mode = modeWith()
      const report = buildCoverageReport("run", { cmd: ["ls"] }, runMeta, mode, "/")
      expect(report.aspectCovered).toBe(false)
    })

    it("returns false when an aspect rule exists but doesn't match the call's value", () => {
      const mode = modeWith({
        aspectRules: { command: { patterns: { "pnpm *": "allow" } } },
      })
      const report = buildCoverageReport("run", { cmd: ["ls"] }, runMeta, mode, "/")
      expect(report.aspectCovered).toBe(false)
    })

    it("returns true when an aspect rule allows the call's value", () => {
      const mode = modeWith({
        aspectRules: { command: { patterns: { ls: "allow" } } },
      })
      const report = buildCoverageReport("run", { cmd: ["ls"] }, runMeta, mode, "/")
      expect(report.aspectCovered).toBe(true)
    })

    it("uses per-element matching for `[]` mode aspects", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["mutating"],
        fields: { path: { mode: "path[]", fields: ["paths"] } },
      }
      const mode = modeWith({
        aspectRules: { path: { patterns: { "**/*.env": "deny", "**": "allow" } } },
      })
      // Both elements are allowed; aspect is covered.
      const report = buildCoverageReport("git_add", { paths: ["src/a.ts", "src/b.ts"] }, meta, mode, "/")
      expect(report.aspectCovered).toBe(true)
    })

    it("returns false for `[]` mode when ANY element hits a deny (most-restrictive across elements)", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["mutating"],
        fields: { path: { mode: "path[]", fields: ["paths"] } },
      }
      // Last-match-wins inside a single aspect rule; the deny pattern
      // is declared LAST so it shadows the more permissive fallback
      // for matching paths.
      const mode = modeWith({
        aspectRules: { path: { patterns: { "**": "allow", "**/*.env": "deny" } } },
      })
      // a.ts matches `**` → allow. .env matches both, last is `**/*.env` → deny.
      // matchAspectEach combines deny > ask > allow across elements → deny.
      const report = buildCoverageReport("git_add", { paths: ["src/a.ts", ".env"] }, meta, mode, "/")
      expect(report.aspectCovered).toBe(false)
    })
  })

  describe("tool-rule coverage", () => {
    it("returns false when no toolRule exists for the tool", () => {
      const mode = modeWith()
      const report = buildCoverageReport("run", { cmd: ["ls"] }, runMeta, mode, "/")
      expect(report.toolCovered).toBe(false)
    })

    it("returns true when a no-fields toolRule exists (matches any call)", () => {
      const mode = modeWith({
        toolRules: { run: [{ verdict: "allow" }] },
      })
      const report = buildCoverageReport("run", { cmd: ["ls"] }, runMeta, mode, "/")
      expect(report.toolCovered).toBe(true)
    })

    it("returns true when a toolRule's fields clause matches the call", () => {
      const mode = modeWith({
        toolRules: { run: [{ fields: { cmd: ["ls"] }, verdict: "allow" }] },
      })
      const report = buildCoverageReport("run", { cmd: ["ls"] }, runMeta, mode, "/")
      expect(report.toolCovered).toBe(true)
    })

    it("returns false when a toolRule's fields clause doesn't match", () => {
      const mode = modeWith({
        toolRules: { run: [{ fields: { cmd: ["pnpm *"] }, verdict: "allow" }] },
      })
      const report = buildCoverageReport("run", { cmd: ["ls"] }, runMeta, mode, "/")
      expect(report.toolCovered).toBe(false)
    })

    it("returns false when the matching toolRule is a deny (not an allow)", () => {
      const mode = modeWith({
        toolRules: { run: [{ fields: { cmd: ["ls"] }, verdict: "deny" }] },
      })
      const report = buildCoverageReport("run", { cmd: ["ls"] }, runMeta, mode, "/")
      expect(report.toolCovered).toBe(false)
    })

    it("returns true when a toolRule's array-field pattern matches the joined value", () => {
      const mode = modeWith({
        toolRules: {
          run: [{ fields: { cmd: ["pnpm run test"] }, verdict: "allow" }],
        },
      })
      const report = buildCoverageReport("run", { cmd: ["pnpm", "run", "test"] }, runMeta, mode, "/")
      expect(report.toolCovered).toBe(true)
    })
  })

  describe("no aspects / no metadata", () => {
    it("returns false for both when the tool has no aspect metadata", () => {
      const mode = modeWith()
      const report = buildCoverageReport("pfs_unlink", { path: "/etc/hosts" }, undefined, mode, "/")
      expect(report.aspectCovered).toBe(false)
      expect(report.toolCovered).toBe(false)
    })

    it("readMeta without any aspect rules returns false for aspect coverage", () => {
      const mode = modeWith()
      const report = buildCoverageReport("read", { path: "/etc/hosts" }, readMeta, mode, "/")
      expect(report.aspectCovered).toBe(false)
    })
  })
})
