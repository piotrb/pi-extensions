import { describe, expect, it } from "vitest"

import { check, patternToRegex, type PermissionSet } from "./permissions.ts"

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

// ─── check ────────────────────────────────────────────────────────────────────

describe("check", () => {
  const set: PermissionSet = {
    allow: ["pnpm run *", "npm run *", "git status"],
    deny: ["pnpm run deploy *", "rm *"],
  }

  it("returns 'allow' when a command matches an allow rule", () => {
    expect(check(["pnpm", "run", "build"], set)).toBe("allow")
  })

  it("returns 'deny' when a command matches a deny rule", () => {
    expect(check(["pnpm", "run", "deploy", "prod"], set)).toBe("deny")
  })

  it("deny takes precedence over allow", () => {
    // "pnpm run deploy *" is denied even though "pnpm run *" is allowed
    expect(check(["pnpm", "run", "deploy", "anything"], set)).toBe("deny")
  })

  it("returns 'undecided' when no rule matches", () => {
    expect(check(["bun", "run", "build"], set)).toBe("undecided")
  })

  it("matches an exact allow rule", () => {
    expect(check(["git", "status"], set)).toBe("allow")
  })

  it("does not match the exact allow when extra args are present", () => {
    expect(check(["git", "status", "--short"], set)).toBe("undecided")
  })

  it("returns 'deny' for a denied command with no matching allow", () => {
    expect(check(["rm", "-rf", "."], set)).toBe("deny")
  })
})
