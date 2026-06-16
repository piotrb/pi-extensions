import { describe, expect, it } from "vitest"

import type { ResolvedToolMetadata } from "../types.ts"
import { buildAskDisplay, formatValue } from "./ask-display.ts"

describe("formatValue", () => {
  it("returns a simple string as-is (no quotes)", () => {
    expect(formatValue("ls")).toBe("ls")
    expect(formatValue("/etc/hosts")).toBe("/etc/hosts")
  })

  it("quotes values containing spaces", () => {
    expect(formatValue("ls -la /tmp")).toBe('"ls -la /tmp"')
  })

  it("quotes values containing tabs", () => {
    expect(formatValue("a\tb")).toBe('"a\\tb"')
  })

  it("escapes newlines as \\n", () => {
    expect(formatValue("line1\nline2")).toBe('"line1\\nline2"')
  })

  it("escapes embedded double quotes with backslash", () => {
    expect(formatValue('say "hi"')).toBe('"say \\"hi\\""')
  })

  it("escapes backslashes", () => {
    expect(formatValue("a\\b")).toBe('"a\\\\b"')
  })

  it("quotes the empty string (zero-length values)", () => {
    expect(formatValue("")).toBe('""')
  })

  it("truncates values over 80 characters with an ellipsis", () => {
    const long = "x".repeat(120)
    const out = formatValue(long)
    expect(out.length).toBeLessThanOrEqual(82) // 80 + 2 for the quotes (we re-quote after truncation)
    expect(out).toContain("…")
  })
})

describe("buildAskDisplay", () => {
  describe("with aspects", () => {
    it("emits one line per aspect with a value (scalar mode)", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["readonly"],
        fields: { path: { mode: "path", fields: ["path"] } },
      }
      const out = buildAskDisplay("read", { path: "/etc/hosts" }, meta)
      expect(out.fieldLines).toEqual(["path: /etc/hosts"])
    })

    it("emits one line per element (array mode)", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["mutating"],
        fields: { path: { mode: "path", fields: [{ field: "paths", mode: "array" }] } },
      }
      const out = buildAskDisplay("git_add", { paths: [".env", "src/index.ts"] }, meta)
      expect(out.fieldLines).toEqual(["path: .env", "path: src/index.ts"])
    })

    it("quotes values that contain spaces (scalar mode)", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["execution"],
        // bash mode (scalar, joined). run's cmd: string[] joins with " ".
        fields: { command: { mode: "bash", fields: ["cmd"] } },
      }
      const out = buildAskDisplay("run", { cmd: ["ls", "-la", "/tmp"] }, meta)
      expect(out.fieldLines).toEqual(['command: "ls -la /tmp"'])
    })

    it("emits multiple aspects in declaration order", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["mutating"],
        fields: {
          source: { mode: "path", fields: [{ field: "source", mode: "array" }] },
          destination: { mode: "path", fields: ["destination"] },
        },
      }
      const out = buildAskDisplay("git_mv", { source: ["/src"], destination: "/dst" }, meta)
      // source[] is array mode (per-element), destination is scalar.
      expect(out.fieldLines).toEqual(["source: /src", "destination: /dst"])
    })

    it("skips aspects with no value in the input", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["readonly"],
        fields: { path: { mode: "path", fields: ["path"] } },
      }
      const out = buildAskDisplay("read", {}, meta)
      expect(out.fieldLines).toEqual([])
    })

    it("skips empty-string values in array mode", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["mutating"],
        fields: { path: { mode: "path", fields: [{ field: "paths", mode: "array" }] } },
      }
      const out = buildAskDisplay("git_add", { paths: [".env", "", "src"] }, meta)
      expect(out.fieldLines).toEqual(["path: .env", "path: src"])
    })
  })

  describe("fallback (no aspects)", () => {
    it("dumps scalar string-typed input fields when no aspect metadata is declared", () => {
      // A tool with no ResolvedToolMetadata — e.g. a custom tool with no
      // pi.toolMetadata block.
      const out = buildAskDisplay("pfs_unlink", { path: "/etc/hosts" }, undefined)
      expect(out.fieldLines).toEqual(["path: /etc/hosts"])
    })

    it("emits one line per element when the input field is a string array", () => {
      const out = buildAskDisplay("custom", { tags: ["a", "b", "c"] }, undefined)
      expect(out.fieldLines).toEqual(["tags: a", "tags: b", "tags: c"])
    })

    it("skips non-string scalar fields (numbers, booleans, null)", () => {
      const out = buildAskDisplay("custom", { count: 42, ok: true, n: null }, undefined)
      expect(out.fieldLines).toEqual([])
    })
  })

  describe("fallback precedence over empty aspects", () => {
    it("uses the fallback when aspects are declared but all yield empty values", () => {
      // A tool with aspects declared but no values provided. The user
      // still needs to see the inputs (some may not be aspect-bound),
      // so the fallback kicks in.
      const meta: ResolvedToolMetadata = {
        tags: ["readonly"],
        fields: { path: { mode: "path", fields: ["path"] } },
      }
      const out = buildAskDisplay("read", { url: "https://example.com" }, meta)
      // path aspect has no value, fallback kicks in and shows url.
      expect(out.fieldLines).toEqual(["url: https://example.com"])
    })
  })
})
