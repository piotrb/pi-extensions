import { describe, expect, it } from "vitest"

import { checkRules, patternToRegex, type Rule, specificity } from "./permissions.ts"

// ─── patternToRegex ───────────────────────────────────────────────────────────

describe("patternToRegex", () => {
  describe("exact patterns", () => {
    it("matches the exact string", () => {
      expect(patternToRegex("npm run build").test("npm run build")).toBe(true)
    })
    it("does not match with extra suffix", () => {
      expect(patternToRegex("npm run build").test("npm run build --watch")).toBe(false)
    })
    it("does not match a prefix", () => {
      expect(patternToRegex("npm run build").test("npm run")).toBe(false)
    })
  })

  describe("trailing ' *' patterns (prefix + word boundary)", () => {
    it("matches the prefix alone", () => {
      expect(patternToRegex("pnpm run *").test("pnpm run")).toBe(true)
    })
    it("matches prefix followed by a space and more", () => {
      expect(patternToRegex("pnpm run *").test("pnpm run build")).toBe(true)
    })
    it("matches prefix followed by multiple words", () => {
      expect(patternToRegex("pnpm run *").test("pnpm run test --watch")).toBe(true)
    })
    it("does not match when prefix runs into the next word without a space", () => {
      expect(patternToRegex("pnpm run *").test("pnpm runaway")).toBe(false)
    })
    it("does not match a different command", () => {
      expect(patternToRegex("pnpm run *").test("npm run build")).toBe(false)
    })
  })

  describe("trailing ':*' patterns (shorthand for trailing ' *')", () => {
    it("matches any subcommand", () => {
      expect(patternToRegex("pnpm:*").test("pnpm install")).toBe(true)
    })
    it("matches the bare command", () => {
      expect(patternToRegex("pnpm:*").test("pnpm")).toBe(true)
    })
    it("does not match a different command with shared prefix chars", () => {
      expect(patternToRegex("pnpm:*").test("pnpmx something")).toBe(false)
    })
  })

  describe("standalone '*'", () => {
    it("matches everything", () => {
      expect(patternToRegex("*").test("anything at all")).toBe(true)
    })
    it("matches the empty string", () => {
      expect(patternToRegex("*").test("")).toBe(true)
    })
  })

  describe("'*' in the middle", () => {
    it("matches with anything between prefix and suffix", () => {
      expect(patternToRegex("git * main").test("git checkout main")).toBe(true)
    })
    it("matches when * spans multiple words", () => {
      expect(patternToRegex("git * main").test("git push origin main")).toBe(true)
    })
    it("does not match when suffix is absent", () => {
      expect(patternToRegex("git * main").test("git status")).toBe(false)
    })
  })

  describe("'*' at the start", () => {
    it("matches any command ending with the suffix", () => {
      expect(patternToRegex("* --version").test("node --version")).toBe(true)
    })
    it("does not match when suffix is followed by more content", () => {
      expect(patternToRegex("* --version").test("node --version --extra")).toBe(false)
    })
  })
})

// ─── specificity ──────────────────────────────────────────────────────────────

describe("specificity", () => {
  it("standalone * has zero specificity", () => {
    expect(specificity("*")).toBe(0)
  })
  it("counts all non-wildcard characters", () => {
    expect(specificity("bun run *")).toBe(8) // 'b','u','n',' ','r','u','n',' '
  })
  it("exact pattern has the highest specificity", () => {
    expect(specificity("npm run build")).toBeGreaterThan(specificity("npm run *"))
  })
  it("longer prefix beats shorter prefix", () => {
    expect(specificity("bun run *")).toBeGreaterThan(specificity("bun *"))
  })
})

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
