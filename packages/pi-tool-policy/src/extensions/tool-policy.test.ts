import { describe, expect, it } from "vitest"

import type { ResolvedToolMetadata } from "../lib/types.ts"
import toolPolicy, { extractStringFields } from "./tool-policy.ts"

describe("tool-policy extension", () => {
  it("default export is a function of arity 1", () => {
    expect(typeof toolPolicy).toBe("function")
    expect(toolPolicy.length).toBe(1)
  })
})

const pathMeta: ResolvedToolMetadata = {
  tags: ["readonly"],
  fields: { path: { mode: "path", fields: ["path"] } },
}

const mixedPathMeta: ResolvedToolMetadata = {
  tags: ["mutating"],
  fields: {
    // A tool with both a scalar field and an array field, both on the
    // same `path` aspect (e.g. pi-ripgrep's `paths` array + `cwd` scalar).
    path: { mode: "path", fields: [{ field: "paths", mode: "array" }, "cwd"] },
  },
}

describe("extractStringFields", () => {
  it("returns {} for undefined input", () => {
    expect(extractStringFields(undefined, pathMeta)).toEqual({})
  })

  it("extracts a scalar string when the field is bound", () => {
    expect(extractStringFields({ path: "/repo/foo.ts" }, pathMeta)).toEqual({ path: "/repo/foo.ts" })
  })

  it("joins a string[] value with a single space (matches coerceForMatch)", () => {
    expect(extractStringFields({ path: ["dir with space", "foo.ts"] }, pathMeta)).toEqual({
      path: "dir with space foo.ts",
    })
  })

  it("skips fields that are not in any aspect binding", () => {
    // `unrelated` is not bound to any aspect, so it should NOT appear
    // in the lock. The matcher never sees it; locking on it would
    // produce a constraint that doesn't affect any verdict.
    const result = extractStringFields({ path: "/repo/foo.ts", unrelated: "should be dropped", count: 5 }, pathMeta)
    expect(result).toEqual({ path: "/repo/foo.ts" })
  })

  it("skips non-string, non-string[] values (numbers, booleans, objects)", () => {
    const result = extractStringFields({ path: "/repo/foo.ts", count: 5, ok: true, nested: { a: 1 } }, pathMeta)
    expect(result).toEqual({ path: "/repo/foo.ts" })
  })

  it("handles tools with multiple aspect declarations: each field is bound to exactly one", () => {
    // Two aspects, two distinct fields, both bound. The lock should
    // include both.
    const meta: ResolvedToolMetadata = {
      tags: [],
      fields: {
        path: { mode: "path", fields: ["path"] },
        command: { mode: "bash", fields: ["command"] },
      },
    }
    const result = extractStringFields({ path: "/repo/foo.ts", command: ["ls", "-la"], extra: "drop" }, meta)
    expect(result).toEqual({ path: "/repo/foo.ts", command: "ls -la" })
  })

  it("extracts BOTH scalar and array bindings on the same aspect (per-field cardinality)", () => {
    // The pi-ripgrep shape: `paths` is array-mode, `cwd` is scalar.
    // The runtime grant should lock on BOTH (joined for paths, as-is
    // for cwd).
    const result = extractStringFields({ paths: [".env", "src/index.ts"], cwd: "subdir", extra: "drop" }, mixedPathMeta)
    expect(result).toEqual({ paths: ".env src/index.ts", cwd: "subdir" })
  })

  it("falls back to extracting every string field when meta is undefined", () => {
    // Back-compat for tools without aspect metadata.
    const result = extractStringFields({ path: "/repo/foo.ts", anything: "kept" }, undefined)
    expect(result).toEqual({ path: "/repo/foo.ts", anything: "kept" })
  })
})
