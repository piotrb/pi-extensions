import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import { describe, expect, it } from "vitest"
import * as yaml from "yaml"

const SOLUTIONS_DIR = "docs/solutions"
const CATEGORIES = ["workflow", "testing", "architecture", "integration", "tooling"] as const
const SEVERITIES = ["critical", "high", "medium", "low"] as const
const REQUIRED_FIELDS = ["title", "category", "severity", "tags", "applies_when"] as const

interface SolutionFrontmatter {
  title?: string
  category?: string
  severity?: string
  tags?: unknown
  applies_when?: unknown
  [key: string]: unknown
}

function findSolutionFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...findSolutionFiles(full))
    } else if (entry.endsWith(".md")) {
      out.push(full)
    }
  }
  return out
}

function extractFrontmatter(raw: string): { frontmatter: string; body: string } | null {
  if (!raw.startsWith("---")) return null
  const end = raw.indexOf("\n---", 3)
  if (end === -1) return null
  const frontmatter = raw.slice(3, end)
  const body = raw.slice(end + 4)
  return { frontmatter, body }
}

describe("docs/solutions frontmatter", () => {
  const files = findSolutionFiles(SOLUTIONS_DIR)

  if (files.length === 0) {
    it.skip("no solutions found (skipped)", () => {
      // intentional: when there are no solutions, the test is skipped
    })
    return
  }

  const slugs = new Map<string, string>()

  for (const file of files) {
    const slug = file.replace(/^.*\//, "").replace(/\.md$/, "")
    slugs.set(slug, file)

    describe(relative(process.cwd(), file), () => {
      let raw: string
      let parsed: SolutionFrontmatter | null
      let parseError: Error | null

      try {
        raw = readFileSync(file, "utf-8")
        const extracted = extractFrontmatter(raw)
        if (!extracted) {
          throw new Error("no frontmatter found (file must start with --- and have a closing ---)")
        }
        parsed = yaml.parse(extracted.frontmatter) as SolutionFrontmatter | null
        if (!parsed || typeof parsed !== "object") {
          throw new Error("frontmatter is not a YAML mapping")
        }
      } catch (e) {
        parseError = e as Error
        parsed = null
      }

      it("parses as valid YAML", () => {
        if (parseError) throw parseError
        expect(parsed).not.toBeNull()
      })

      it("has all required fields", () => {
        if (parseError) throw parseError
        for (const field of REQUIRED_FIELDS) {
          expect(parsed, `missing field: ${field}`).toHaveProperty(field)
        }
      })

      it("title is a non-empty string", () => {
        if (parseError) throw parseError
        expect(typeof parsed!.title).toBe("string")
        expect(parsed!.title!.length).toBeGreaterThan(0)
      })

      it("category is one of the 5 valid values", () => {
        if (parseError) throw parseError
        expect(CATEGORIES).toContain(parsed!.category)
      })

      it("severity is one of the 4 valid values", () => {
        if (parseError) throw parseError
        expect(SEVERITIES).toContain(parsed!.severity)
      })

      it("tags is a non-empty array of strings", () => {
        if (parseError) throw parseError
        expect(Array.isArray(parsed!.tags)).toBe(true)
        expect((parsed!.tags as unknown[]).length).toBeGreaterThan(0)
        for (const tag of parsed!.tags as unknown[]) {
          expect(typeof tag).toBe("string")
          expect((tag as string).length).toBeGreaterThan(0)
        }
      })

      it("applies_when is a non-empty array of strings", () => {
        if (parseError) throw parseError
        expect(Array.isArray(parsed!.applies_when)).toBe(true)
        expect((parsed!.applies_when as unknown[]).length).toBeGreaterThan(0)
        for (const cond of parsed!.applies_when as unknown[]) {
          expect(typeof cond).toBe("string")
          expect((cond as string).length).toBeGreaterThan(0)
        }
      })

      it("has no unquoted colons in any scalar field", () => {
        if (parseError) throw parseError
        // Walk the frontmatter text line by line. Any line matching
        // `field: value:` where value doesn't start with a quote/pipe/dash
        // indicates an unquoted colon. (yaml.parse would have failed earlier
        // if this caused an actual parse error; this catches the silent
        // cases where the parser tolerates the colon but the convention
        // forbids it.)
        const extracted = extractFrontmatter(readFileSync(file, "utf-8"))!
        const lines = extracted.frontmatter.split("\n")
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!
          // Match `key: value` where value is unquoted and contains a colon.
          // The regex anchors on the start of the line (not in a list item)
          // because tags/applies_when values are on indented child lines.
          const m = /^([a-zA-Z_][a-zA-Z0-9_-]*):\s+(.+)$/.exec(line)
          if (!m) continue
          const [, , value] = m
          if (!value) {
            throw new Error("value was falsey when it shouldn't have been able to be")
          }
          // Quoted values, block scalars, and empty values are fine.
          if (
            value === "" ||
            value.startsWith('"') ||
            value.startsWith("'") ||
            value.startsWith("|") ||
            value.startsWith(">") ||
            value.startsWith("[") ||
            value.startsWith("{")
          ) {
            continue
          }
          // Anything else: if there's a `:` in the value (not as part of a URL or path),
          // flag it. This is the conservative check; the YAML safety rule says
          // "no colons in unquoted scalars."
          if (value.includes(":")) {
            throw new Error(`line ${i + 1}: unquoted scalar contains a colon — wrap the value in quotes\n  ${line}`)
          }
        }
      })
    })
  }

  describe("cross-cutting", () => {
    it("has no duplicate slugs", () => {
      const seen: Record<string, string> = {}
      for (const [slug, file] of Object.entries(slugs)) {
        if (slug in seen) {
          const previous = seen[slug]!
          throw new Error("duplicate slug " + slug + " at " + previous + " and " + file)
        }
        seen[slug] = file
      }
    })
  })
})
