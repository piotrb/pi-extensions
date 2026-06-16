import { describe, expect, it } from "vitest"

import type { ResolvedToolMetadata } from "../types.ts"
import { buildSuggestedAllow } from "./suggested-allow.ts"

describe("buildSuggestedAllow", () => {
  describe("aspect-decorated scalar-mode tools", () => {
    it("locks run with cmd: ['ls'] to the joined command 'ls'", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["execution"],
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
        tags: ["execution"],
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
      const out = buildSuggestedAllow("read", { path: "/etc/hosts" }, meta)
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { path: ["/etc/hosts"] },
      })
      expect(out.label).toBe("path: /etc/hosts")
    })
  })

  describe("aspect-decorated array-mode tools", () => {
    it("locks git_add with paths: ['.env', 'src/index.ts'] using the joined value", () => {
      const meta: ResolvedToolMetadata = {
        tags: ["mutating"],
        fields: { path: { mode: "path[]", fields: ["paths"] } },
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
      const out = buildSuggestedAllow("pfs_mv", { source: "/a/b", destination: "/c/d" }, meta)
      expect(out.entry).toEqual({
        verdict: "allow",
        fields: { source: ["/a/b"], destination: ["/c/d"] },
      })
      // Two spaces between aspect labels so the visual separation is
      // clear in the option label.
      expect(out.label).toBe("source: /a/b  destination: /c/d")
    })
  })

  describe("tools without aspect metadata", () => {
    it("falls back to capturing string fields by their input key", () => {
      const out = buildSuggestedAllow("pfs_unlink", { path: "/etc/hosts" }, undefined)
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
})
