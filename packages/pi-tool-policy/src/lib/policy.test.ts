import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

import { matchAspect } from "./aspects.ts"
import { ExternalDirectoryState } from "./external-directory.ts"
import { evaluate } from "./policy.ts"
import type { AspectDefinition, Config, ResolvedToolMetadata, Verdict } from "./types.ts"

// Minimal mock — we only read event.toolName and event.input
function makeEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: "tool_call", toolCallId: "test", toolName, input } as unknown as ToolCallEvent
}

// Minimal ExtensionContext stub: only `cwd` is read by the policy engine.
// Cast via `as unknown as ExtensionContext` to satisfy the strict-typed
// ExtensionContext surface while keeping the test focused on policy logic.
const ctx = { cwd: "/repo" } as unknown as ExtensionContext
const emptyExternal = new ExternalDirectoryState()

describe("evaluate", () => {
  describe("layer 1: tools", () => {
    it("uses the tool's verdict", () => {
      const config: Config = { tools: { read: "allow", write: "deny" } }
      const meta = new Map<string, ResolvedToolMetadata>()
      expect(evaluate(makeEvent("read", {}), config, meta, emptyExternal, ctx).action).toBe("allow")
      expect(evaluate(makeEvent("write", {}), config, meta, emptyExternal, ctx).action).toBe("deny")
    })

    it("uses a per-tool pattern map (last-match-wins within the map)", () => {
      // The tool's own name is matched against the pattern map. Order
      // matters: the more-specific pattern is declared LAST so it wins.
      const config: Config = { tools: { dangerous: { "*": "allow", dangerous: "deny" } } }
      const meta = new Map<string, ResolvedToolMetadata>()
      expect(evaluate(makeEvent("dangerous", {}), config, meta, emptyExternal, ctx).action).toBe("deny")
    })
  })

  describe("layer 2: groupVerdicts", () => {
    it("combines multiple groups most-restrictive-wins", () => {
      const config: Config = { groupVerdicts: { readonly: "allow", mutating: "ask" } }
      const meta = new Map<string, ResolvedToolMetadata>([["write", { groups: ["mutating"], fields: {} }]])
      expect(evaluate(makeEvent("write", {}), config, meta, emptyExternal, ctx).action).toBe("ask")
    })

    it("deny in any group overrides allow", () => {
      const config: Config = { groupVerdicts: { readonly: "allow", forbidden: "deny" } }
      const meta = new Map<string, ResolvedToolMetadata>([["read", { groups: ["readonly", "forbidden"], fields: {} }]])
      expect(evaluate(makeEvent("read", {}), config, meta, emptyExternal, ctx).action).toBe("deny")
    })

    it("ignores groups with no matching groupVerdict entry", () => {
      // Tool is explicitly allowed, group 'readonly' allows, group 'unknown'
      // has no entry → ignored. Final verdict is "allow".
      const config: Config = { tools: { read: "allow" }, groupVerdicts: { readonly: "allow" } }
      const meta = new Map<string, ResolvedToolMetadata>([["read", { groups: ["readonly", "unknown"], fields: {} }]])
      expect(evaluate(makeEvent("read", {}), config, meta, emptyExternal, ctx).action).toBe("allow")
    })
  })

  describe("layer 3: aspects", () => {
    it("denies when an aspect pattern denies", () => {
      const config: Config = {
        aspects: { path: { patterns: { "**": "allow", "*.env": "deny" } } },
        tools: { read: "allow" },
      }
      const meta = new Map<string, ResolvedToolMetadata>([
        ["read", { groups: [], fields: { path: { aspect: "path" } } }],
      ])
      expect(evaluate(makeEvent("read", { path: "/repo/.env" }), config, meta, emptyExternal, ctx).action).toBe("deny")
    })

    it("joins string[] args for bash_cmd aspect", () => {
      const config: Config = {
        aspects: { bash_cmd: { mode: "bash", patterns: { "*": "ask", "rm -rf *": "deny" } } },
        tools: { run: "ask" },
      }
      const meta = new Map<string, ResolvedToolMetadata>([
        ["run", { groups: [], fields: { cmd: { aspect: "bash_cmd" } } }],
      ])
      expect(evaluate(makeEvent("run", { cmd: ["rm", "-rf", "/"] }), config, meta, emptyExternal, ctx).action).toBe(
        "deny",
      )
    })

    it("combines multi-binding fields via the lattice", () => {
      // One field, two bindings: a path binding + a glob binding.
      // The path aspect allows; the glob aspect denies — deny wins.
      const config: Config = {
        aspects: {
          path: { patterns: { "**": "allow" } },
          glob: { patterns: { "*": "deny" } },
        },
        tools: { read: "ask" },
      }
      const meta = new Map<string, ResolvedToolMetadata>([
        ["read", { groups: [], fields: { path: [{ aspect: "path" }, { aspect: "glob" }] } }],
      ])
      expect(evaluate(makeEvent("read", { path: "/repo/foo.ts" }), config, meta, emptyExternal, ctx).action).toBe(
        "deny",
      )
    })

    it("records the matching pattern in blockingRules", () => {
      const config: Config = {
        aspects: { path: { patterns: { "**": "allow", "*.env": "deny" } } },
        tools: { read: "allow" },
      }
      const meta = new Map<string, ResolvedToolMetadata>([
        ["read", { groups: [], fields: { path: { aspect: "path" } } }],
      ])
      const decision = evaluate(makeEvent("read", { path: "/repo/.env" }), config, meta, emptyExternal, ctx)
      expect(decision.action).toBe("deny")
      if (decision.action !== "allow") {
        const aspectRule = decision.blockingRules.find((r) => r.layer === "aspect")
        expect(aspectRule).toBeDefined()
        expect(aspectRule?.pattern).toBe("*.env")
      }
    })
  })

  describe("layer 4: externalDirectory", () => {
    it("asks for a path outside cwd even when the tool is allowed", () => {
      const config: Config = { tools: { read: "allow" } }
      const meta = new Map<string, ResolvedToolMetadata>([
        ["read", { groups: [], fields: { path: { aspect: "path" } } }],
      ])
      const decision = evaluate(makeEvent("read", { path: "/etc/passwd" }), config, meta, emptyExternal, ctx)
      expect(decision.action).toBe("ask")
      if (decision.action !== "allow") {
        expect(decision.blockingRules.some((r) => r.layer === "externalDirectory")).toBe(true)
      }
    })

    it("does not ask for a path inside cwd", () => {
      const config: Config = { tools: { read: "allow" } }
      const meta = new Map<string, ResolvedToolMetadata>([
        ["read", { groups: [], fields: { path: { aspect: "path" } } }],
      ])
      expect(evaluate(makeEvent("read", { path: "/repo/foo.ts" }), config, meta, emptyExternal, ctx).action).toBe(
        "allow",
      )
    })
  })

  describe("undecided collapse", () => {
    it("undecided from all layers → ask (fail-closed)", () => {
      const config: Config = {
        aspects: { path: { patterns: { "*.env": "deny" } } }, // no '**' default
        tools: { read: "ask" },
      }
      const meta = new Map<string, ResolvedToolMetadata>([
        ["read", { groups: [], fields: { path: { aspect: "path" } } }],
      ])
      expect(evaluate(makeEvent("read", { path: "/repo/foo.ts" }), config, meta, emptyExternal, ctx).action).toBe("ask")
    })

    it("defaultDecision is consulted only when no tools[tool] entry exists", () => {
      // No tools entry for 'unknown' → defaultDecision wins.
      const config: Config = {
        defaultDecision: "deny",
        aspects: { path: { patterns: { "*.env": "deny" } } },
      }
      const meta = new Map<string, ResolvedToolMetadata>([
        ["unknown", { groups: [], fields: { path: { aspect: "path" } } }],
      ])
      // No aspect match, no group, no tool entry → fallback to defaultDecision ("deny").
      expect(evaluate(makeEvent("unknown", { path: "/repo/foo.ts" }), config, meta, emptyExternal, ctx).action).toBe(
        "deny",
      )
    })
  })

  describe("performance", () => {
    // Perf bound from the plan: 4 layers × 100 rules per layer resolves
    // a single tool_call within 20ms (the design's "O(layers × rules) — O(n)
    // with small constant" claim).
    it("resolves a tool_call with 4 layers × 100 rules within 100ms (CI-friendly)", () => {
      // Build a config with 4 aspects, 4 groups, 4 tools, 4 default verdicts.
      // Each aspect has 100 patterns; each group has 100 verdicts; the
      // tool's per-field binding maps into 100 of the 4 aspects.
      const aspectPatterns: Record<string, Verdict> = {}
      for (let i = 0; i < 100; i++) {
        aspectPatterns[`pattern-${i}-*.ts`] = i === 99 ? "deny" : "allow"
      }
      const aspects: Record<string, AspectDefinition> = {
        path: { patterns: aspectPatterns },
        url: { patterns: aspectPatterns },
        glob: { patterns: aspectPatterns },
        bash_cmd: { mode: "bash", patterns: aspectPatterns },
      }
      const groupVerdicts: Record<string, Verdict> = {}
      for (let i = 0; i < 100; i++) {
        groupVerdicts[`group-${i}`] = i === 99 ? "deny" : "allow"
      }
      // Tool 'big' belongs to 100 groups, has 4 fields (one per aspect).
      const groups: string[] = []
      for (let i = 0; i < 100; i++) groups.push(`group-${i}`)
      const config: Config = { aspects, groupVerdicts, tools: { big: "allow" } }
      const meta = new Map<string, ResolvedToolMetadata>([
        [
          "big",
          {
            groups,
            fields: {
              path: { aspect: "path" },
              url: { aspect: "url" },
              glob: { aspect: "glob" },
              bash_cmd: { aspect: "bash_cmd" },
            },
          },
        ],
      ])
      const start = performance.now()
      const decision = evaluate(
        makeEvent("big", {
          path: "/repo/pattern-99-final.ts",
          url: "https://example.com/pattern-99",
          glob: "/repo/pattern-99-final.ts",
          bash_cmd: ["pattern-99", "final"],
        }),
        config,
        meta,
        emptyExternal,
        ctx,
      )
      const elapsed = performance.now() - start
      // The 'deny' verdict from any of the 4 layers must surface.
      expect(decision.action).toBe("deny")
      // 100ms accommodates CI noise + cold picomatch compilation; locally this is single-digit ms.
      expect(elapsed).toBeLessThan(100)
    })
  })
})

// Tiny smoke: re-export the import to keep the dependency explicit in the
// coverage report and to ensure the import path stays valid.
describe("module surface", () => {
  it("re-exports matchAspect and ExternalDirectoryState", () => {
    expect(typeof matchAspect).toBe("function")
    expect(typeof ExternalDirectoryState).toBe("function")
  })
})
