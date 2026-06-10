import { describe, expect, it } from "vitest"

import { checkRules, type Rule } from "./permissions.ts"

// ─── checkRules ───────────────────────────────────────────────────────────────

describe("checkRules", () => {
  describe("basic level verdicts", () => {
    const rules: Rule[] = [
      { pattern: "pnpm run *", level: "allow", scope: "project" },
      { pattern: "rm *", level: "deny", scope: "project" },
      { pattern: "*", level: "ask", scope: "global" },
    ]

    it("returns allow for a matching allow rule", () => {
      expect(checkRules(["pnpm", "run", "build"], rules)).toBe("allow")
    })
    it("returns deny for a matching deny rule", () => {
      expect(checkRules(["rm", "-rf", "."], rules)).toBe("deny")
    })
    it("returns ask when only the catch-all matches", () => {
      expect(checkRules(["node", "index.js"], rules)).toBe("ask")
    })
    it("returns undecided when no rules are present", () => {
      expect(checkRules(["anything"], [])).toBe("undecided")
    })
  })

  describe("specificity resolution", () => {
    const rules: Rule[] = [
      { pattern: "*", level: "ask", scope: "global" },
      { pattern: "bun *", level: "ask", scope: "global" },
      { pattern: "bun run *", level: "allow", scope: "project" },
    ]

    it("most specific rule wins regardless of order in the array", () => {
      expect(checkRules(["bun", "run", "build"], rules)).toBe("allow")
    })
    it("medium-specificity rule wins over catch-all", () => {
      expect(checkRules(["bun", "add", "react"], rules)).toBe("ask")
    })
    it("catch-all fires when nothing more specific matches", () => {
      expect(checkRules(["node", "--version"], rules)).toBe("ask")
    })
  })

  describe("scope tiebreaking", () => {
    it("project beats global at equal specificity", () => {
      const rules: Rule[] = [
        { pattern: "bun run *", level: "deny", scope: "global" },
        { pattern: "bun run *", level: "allow", scope: "project" },
      ]
      expect(checkRules(["bun", "run", "build"], rules)).toBe("allow")
    })
    it("project beats user at equal specificity", () => {
      const rules: Rule[] = [
        { pattern: "bun run *", level: "ask", scope: "user" },
        { pattern: "bun run *", level: "allow", scope: "project" },
      ]
      expect(checkRules(["bun", "run", "build"], rules)).toBe("allow")
    })
    it("user beats global at equal specificity", () => {
      const rules: Rule[] = [
        { pattern: "bun run *", level: "deny", scope: "global" },
        { pattern: "bun run *", level: "allow", scope: "user" },
      ]
      expect(checkRules(["bun", "run", "build"], rules)).toBe("allow")
    })
  })

  describe("undecided fallback", () => {
    it("returns undecided when no pattern matches", () => {
      const rules: Rule[] = [{ pattern: "pnpm run *", level: "allow", scope: "project" }]
      expect(checkRules(["bun", "run", "build"], rules)).toBe("undecided")
    })
  })
})
