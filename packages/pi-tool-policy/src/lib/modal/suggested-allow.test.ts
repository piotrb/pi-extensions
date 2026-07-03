import { describe, expect, it } from "vitest"

import type { ResolvedToolMetadata } from "../types.ts"
import { buildSuggestedAllow } from "./suggested-allow.ts"

describe("buildSuggestedAllow", () => {
  describe("aspect-decorated scalar-mode tools", () => {
    it("locks run with cmd: ['ls'] to the joined command 'ls'", () => {
      const meta: ResolvedToolMetadata = {
        tags: [],
        fields: { command: { mode: "bash", fields: ["cmd"] } },
      }
      const out = buildSuggestedAllow("run", { cmd: ["ls"] }, meta)
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { cmd: ["ls"] },
      })
      expect(out.label).toBe("command: ls")
    })

    it("joins string[] args with ' ' so the matcher can full-string match", () => {
      const meta: ResolvedToolMetadata = {
        tags: [],
        fields: { command: { mode: "bash", fields: ["cmd"] } },
      }
      const out = buildSuggestedAllow("run", { cmd: ["ls", "-la", "/tmp"] }, meta)
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { cmd: ["ls -la /tmp"] },
      })
      expect(out.label).toBe('command: "ls -la /tmp"')
    })

    it("locks read with path: '/etc/hosts'", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["readonly"],
        fields: { path: { mode: "path", fields: ["path"] } },
      }
      const out = buildSuggestedAllow("read", { path: "/etc/hosts" }, meta, "/etc")
      // The entry keeps the absolute form (the tool-rule matcher
      // compares it via genericPatternToRegex full-string equality
      // against the raw input).
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { path: ["/etc/hosts"] },
      })
      // The label is shown cwd-relative.
      expect(out.label).toBe("path: hosts")
    })
  })

  describe("aspect-decorated array-mode tools", () => {
    it("locks git_add with paths: ['.env', 'src/index.ts'] using the joined value", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["mutating"],
        fields: { path: { mode: "path", fields: [{ field: "paths", mode: "array" }] } },
      }
      const out = buildSuggestedAllow("git_add", { paths: [".env", "src/index.ts"] }, meta)
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { paths: [".env src/index.ts"] },
      })
      // Label shows the array cardinality (path[]) with comma-separated
      // elements so the user can see this locks both values.
      expect(out.label).toBe("path[]: .env, src/index.ts")
    })
  })

  describe("multi-aspect tools", () => {
    it("captures both source and destination for pfs_mv", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["mutating"],
        fields: {
          source: { mode: "path", fields: ["source"] },
          destination: { mode: "path", fields: ["destination"] },
        },
      }
      const out = buildSuggestedAllow("pfs_mv", { source: "/a/b", destination: "/c/d" }, meta, "/a")
      // Both entries stay absolute.
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { source: ["/a/b"], destination: ["/c/d"] },
      })
      // Both labels are cwd-relative; destination escapes cwd so it
      // shows both forms per `formatPathForDisplay`.
      expect(out.label).toBe("source: b  destination: `../c/d` (`/c/d`)")
    })
  })

  describe("tools without aspect metadata", () => {
    it("falls back to capturing string fields by their input key (cwd is a no-op without aspects)", () => {
      // Without aspect metadata we don't know which fields are paths,
      // so the fallback never applies path-relative conversion — even
      // with a cwd. The user's bug report is about path-mode aspects.
      const out = buildSuggestedAllow("pfs_unlink", { path: "/etc/hosts" }, undefined, "/etc")
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { path: ["/etc/hosts"] },
      })
      expect(out.label).toBe("path: /etc/hosts")
    })

    it("joins string[] fallback fields the same way as aspect-decorated ones", () => {
      const out = buildSuggestedAllow("custom_tool", { targets: ["./a", "./b"] }, undefined)
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { targets: ["./a ./b"] },
      })
      expect(out.label).toBe("targets: ./a, ./b")
    })
  })

  describe("empty / skip cases", () => {
    it("returns a broad allow entry with no fields when the input has no string fields", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["readonly"],
        fields: { path: { mode: "path", fields: ["path"] } },
      }
      const out = buildSuggestedAllow("read", { path: 42 }, meta)
      expect(out.entry).toEqual({ verdict: "allow" })
      expect(out.label).toBe("")
    })

    it("skips empty string values", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["readonly"],
        fields: { path: { mode: "path", fields: ["path"] } },
      }
      const out = buildSuggestedAllow("read", { path: "" }, meta)
      expect(out.entry).toEqual({ verdict: "allow" })
      expect(out.label).toBe("")
    })
  })

  describe("path-mode behavior with cwd", () => {
    it("keeps the entry absolute and shows the label cwd-relative (scalar)", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["readonly"],
        fields: { path: { mode: "path", fields: ["path"] } },
      }
      const out = buildSuggestedAllow("read", { path: "/repo/src/foo.ts" }, meta, "/repo")
      // Entry stays absolute — the tool-rule matcher compares it
      // against the raw input via full-string regex.
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { path: ["/repo/src/foo.ts"] },
      })
      expect(out.label).toBe("path: src/foo.ts")
    })

    it("keeps the entry absolute and shows the label cwd-relative per element (array)", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["mutating"],
        fields: { path: { mode: "path", fields: [{ field: "paths", mode: "array" }] } },
      }
      const out = buildSuggestedAllow("git_add", { paths: ["/repo/a", "/repo/b"] }, meta, "/repo")
      // Entry uses the joined absolute form.
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { paths: ["/repo/a /repo/b"] },
      })
      // Label shows each element relativized.
      expect(out.label).toBe("path[]: a, b")
    })

    it("shows both forms in the label when a path escapes cwd", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["readonly"],
        fields: { path: { mode: "path", fields: ["path"] } },
      }
      const out = buildSuggestedAllow("read", { path: "/parent/foo" }, meta, "/repo")
      expect(out.entry.fields).toEqual({ path: ["/parent/foo"] })
      // path.relative("/repo", "/parent/foo") = "../parent/foo".
      expect(out.label).toBe("path: `../parent/foo` (`/parent/foo`)")
    })

    it("passes already-relative input through the label unchanged", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["readonly"],
        fields: { path: { mode: "path", fields: ["path"] } },
      }
      const out = buildSuggestedAllow("custom", { path: "src/foo.ts" }, meta, "/repo")
      // Entry uses the raw (relative) value — the matcher will compare
      // it against future raw inputs, which the tool may also pass
      // relatively.
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { path: ["src/foo.ts"] },
      })
      expect(out.label).toBe("path: src/foo.ts")
    })

    it("does NOT relativize non-path-mode aspects even when cwd is given", () => {
      const meta: ResolvedToolMetadata = {
        tags: [],
        fields: { command: { mode: "bash", fields: ["cmd"] } },
      }
      const out = buildSuggestedAllow("run", { cmd: ["ls", "-la", "/tmp"] }, meta, "/repo")
      // bash mode joins with " " — no path-relative conversion applies.
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { cmd: ["ls -la /tmp"] },
      })
      expect(out.label).toBe('command: "ls -la /tmp"')
    })
  })
})
