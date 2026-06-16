import type { ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

import { applyTaggerRules } from "./tagging-rules.ts"
import type { ResolvedToolMetadata, TaggerRule } from "./types.ts"

function makeEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: "tool_call", toolCallId: "t", toolName, input } as unknown as ToolCallEvent
}

const cwd = "/repo"
const pathTool: ResolvedToolMetadata = {
  tags: ["readonly"],
  fields: { path: { mode: "path", fields: ["path"] } },
}

describe("applyTaggerRules", () => {
  describe("tool-name glob", () => {
    it("matches a single tool name", () => {
      const rules: TaggerRule[] = [{ tool: "read", action: { type: "addTags", tags: ["r"] } }]
      const meta = new Map<string, ResolvedToolMetadata>([["read", pathTool]])
      const out = applyTaggerRules(makeEvent("read", {}), rules, meta, cwd)
      expect(out).toEqual(["r"])
    })

    it("matches a tool-name glob", () => {
      const rules: TaggerRule[] = [{ tool: "git_*", action: { type: "addTags", tags: ["git-tool"] } }]
      const meta = new Map<string, ResolvedToolMetadata>([["git_status", { tags: [], fields: {} }]])
      const out = applyTaggerRules(makeEvent("git_status", {}), rules, meta, cwd)
      expect(out).toEqual(["git-tool"])
    })

    it("does NOT match when the tool name doesn't fit the glob", () => {
      const rules: TaggerRule[] = [{ tool: "git_*", action: { type: "addTags", tags: ["git-tool"] } }]
      const meta = new Map<string, ResolvedToolMetadata>([["read", pathTool]])
      const out = applyTaggerRules(makeEvent("read", {}), rules, meta, cwd)
      expect(out).toEqual([])
    })
  })

  describe("fields clause", () => {
    it("AND across keys: both must match", () => {
      const rules: TaggerRule[] = [
        {
          tool: "bash",
          fields: { command: ["rm *"], flag: ["--force"] },
          action: { type: "addTags", tags: ["destructive"] },
        },
      ]
      const meta = new Map<string, ResolvedToolMetadata>()
      const event = makeEvent("bash", { command: ["rm", "-rf", "/"], flag: "--force" })
      expect(applyTaggerRules(event, rules, meta, cwd)).toEqual(["destructive"])
    })

    it("AND across keys: one missing → no match", () => {
      const rules: TaggerRule[] = [
        {
          tool: "bash",
          fields: { command: ["rm *"], flag: ["--force"] },
          action: { type: "addTags", tags: ["destructive"] },
        },
      ]
      const meta = new Map<string, ResolvedToolMetadata>()
      const event = makeEvent("bash", { command: ["rm", "-rf", "/"], flag: "--safe" })
      expect(applyTaggerRules(event, rules, meta, cwd)).toEqual([])
    })

    it("OR within a key: any pattern matches", () => {
      const rules: TaggerRule[] = [
        {
          tool: "bash",
          fields: { command: ["rm *", "chmod *", "sudo *"] },
          action: { type: "addTags", tags: ["destructive"] },
        },
      ]
      const meta = new Map<string, ResolvedToolMetadata>()
      const event = makeEvent("bash", { command: ["chmod", "777", "/"] })
      expect(applyTaggerRules(event, rules, meta, cwd)).toEqual(["destructive"])
    })
  })

  describe("aspects clause", () => {
    it("matches when a path-aspect pattern matches", () => {
      const rules: TaggerRule[] = [
        {
          tool: "read",
          aspects: { path: [".env"] },
          action: { type: "addTags", tags: ["sensitive"] },
        },
      ]
      const meta = new Map<string, ResolvedToolMetadata>([["read", pathTool]])
      const event = makeEvent("read", { path: "/repo/.env" })
      expect(applyTaggerRules(event, rules, meta, cwd)).toEqual(["sensitive"])
    })

    it("does NOT match when no aspect pattern matches", () => {
      const rules: TaggerRule[] = [
        {
          tool: "read",
          aspects: { path: [".env"] },
          action: { type: "addTags", tags: ["sensitive"] },
        },
      ]
      const meta = new Map<string, ResolvedToolMetadata>([["read", pathTool]])
      const event = makeEvent("read", { path: "/repo/src/foo.ts" })
      expect(applyTaggerRules(event, rules, meta, cwd)).toEqual([])
    })

    it("AND across aspects: both must match", () => {
      const urlTool: ResolvedToolMetadata = {
        tags: [],
        fields: { path: { mode: "path", fields: ["path"] }, url: { mode: "url", fields: ["href"] } },
      }
      const rules: TaggerRule[] = [
        {
          tool: "fetch",
          aspects: { path: ["**"], url: ["https://example.com/*"] },
          action: { type: "addTags", tags: ["trusted"] },
        },
      ]
      const meta = new Map<string, ResolvedToolMetadata>([["fetch", urlTool]])
      const event = makeEvent("fetch", { path: "/repo/foo.ts", href: "https://example.com/bar" })
      expect(applyTaggerRules(event, rules, meta, cwd)).toEqual(["trusted"])
    })

    it("does NOT match when the tool has no metadata for the aspect", () => {
      const rules: TaggerRule[] = [
        {
          tool: "read",
          aspects: { path: ["**"] },
          action: { type: "addTags", tags: ["x"] },
        },
      ]
      // read is not in the metadata; the rule cannot match.
      const meta = new Map<string, ResolvedToolMetadata>()
      const event = makeEvent("read", { path: "/repo/.env" })
      expect(applyTaggerRules(event, rules, meta, cwd)).toEqual([])
    })
  })

  describe("fields + aspects are AND-ed", () => {
    it("both clauses must match", () => {
      const rules: TaggerRule[] = [
        {
          tool: "bash",
          fields: { command: ["curl *"] },
          aspects: { bash_cmd: ["*"] },
          action: { type: "addTags", tags: ["network-fetch"] },
        },
      ]
      const bashTool: ResolvedToolMetadata = {
        tags: [],
        fields: { bash_cmd: { mode: "bash", fields: ["command"] } },
      }
      const meta = new Map<string, ResolvedToolMetadata>([["bash", bashTool]])
      const event = makeEvent("bash", { command: ["curl", "https://example.com"] })
      expect(applyTaggerRules(event, rules, meta, cwd)).toEqual(["network-fetch"])
    })

    it("aspects mismatch → no match (even when fields match)", () => {
      const rules: TaggerRule[] = [
        {
          tool: "bash",
          fields: { command: ["curl *"] },
          aspects: { bash_cmd: ["ssh *"] },
          action: { type: "addTags", tags: ["network-fetch"] },
        },
      ]
      const bashTool: ResolvedToolMetadata = {
        tags: [],
        fields: { bash_cmd: { mode: "bash", fields: ["command"] } },
      }
      const meta = new Map<string, ResolvedToolMetadata>([["bash", bashTool]])
      const event = makeEvent("bash", { command: ["curl", "https://example.com"] })
      expect(applyTaggerRules(event, rules, meta, cwd)).toEqual([])
    })
  })

  describe("dedup", () => {
    it("adds each tag only once across all matching rules", () => {
      const rules: TaggerRule[] = [
        { tool: "read", action: { type: "addTags", tags: ["x", "y"] } },
        { tool: "read", action: { type: "addTags", tags: ["y", "z"] } },
      ]
      const meta = new Map<string, ResolvedToolMetadata>([["read", pathTool]])
      const out = applyTaggerRules(makeEvent("read", {}), rules, meta, cwd)
      expect(out.sort()).toEqual(["x", "y", "z"])
    })
  })

  describe("rule with neither fields nor aspects", () => {
    it("always fires for the matching tool", () => {
      const rules: TaggerRule[] = [{ tool: "read", action: { type: "addTags", tags: ["x"] } }]
      const meta = new Map<string, ResolvedToolMetadata>([["read", pathTool]])
      const out = applyTaggerRules(makeEvent("read", { path: "/repo/foo.ts" }), rules, meta, cwd)
      expect(out).toEqual(["x"])
    })
  })
})
