import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

import { matchAspect } from "./aspects.ts"
import { buildDenyReason, evaluate } from "./policy.ts"
import { resolveMode } from "./resolve-mode.ts"
import type { AspectRule, Config, ResolvedToolMetadata, Verdict } from "./types.ts"

// Minimal mock — we only read event.toolName and event.input
function makeEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: "tool_call", toolCallId: "test", toolName, input } as unknown as ToolCallEvent
}

// Minimal ExtensionContext stub: only `cwd` is read by the policy engine.
const ctx = { cwd: "/repo" } as unknown as ExtensionContext
const emptyMeta = new Map<string, ResolvedToolMetadata>()

/** Helper: build a synthetic Config with one default mode, then run evaluate. */
function runInMode(
  toolName: string,
  input: Record<string, unknown>,
  mode: Config["modes"][string],
  effectiveTags: string[] = [],
  toolMetadata: Map<string, ResolvedToolMetadata> = emptyMeta,
) {
  const config: Config = {
    modeOrder: ["default"],
    modes: { default: mode },
    allowedPaths: [],
    taggingRules: [],
    toolMetadata: {},
  }
  return evaluate(makeEvent(toolName, input), config, "default", effectiveTags, toolMetadata, ctx)
}

/** Build a single-mode tool-metadata entry for a path-aspect tool. */
function pathTool(_name: string, tags: string[] = ["readonly"]): ResolvedToolMetadata {
  return {
    tags,
    fields: { path: { mode: "path", fields: ["path"] } },
  }
}

describe("evaluate", () => {
  describe("tag rules", () => {
    it("applies a tag rule when the tag is in the effective set", () => {
      const decision = runInMode(
        "read",
        { path: "/repo/foo.ts" },
        {
          description: "test",
          defaultDecision: "allow",
          tagRules: { readonly: "allow" },
          toolRules: {},
          aspectRules: {},
        },
        ["readonly"],
      )
      expect(decision.action).toBe("allow")
    })

    it("ignores a tag rule when the tag is NOT in the effective set", () => {
      const decision = runInMode(
        "write",
        { path: "/repo/foo.ts" },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { readonly: "allow" },
          toolRules: {},
          aspectRules: {},
        },
        ["mutating"],
      )
      // No rule fires for "mutating"; defaultDecision ("ask") wins as noop (same as runner).
      expect(decision.action).toBe("ask")
    })

    it("deny in any tag wins over allow in another", () => {
      const decision = runInMode(
        "bash",
        { command: ["echo", "hi"] },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { readonly: "allow", destructive: "deny" },
          toolRules: {},
          aspectRules: {},
        },
        ["readonly", "destructive"],
      )
      expect(decision.action).toBe("deny")
    })
  })

  describe("aspect rules", () => {
    it("denies when an aspect pattern denies", () => {
      const path: AspectRule = { patterns: { "**": "allow", "*.env": "deny" } }
      const decision = runInMode(
        "read",
        { path: "/repo/.env" },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: {},
          toolRules: {},
          aspectRules: { path },
        },
        [],
        new Map([["read", pathTool("read")]]),
      )
      expect(decision.action).toBe("deny")
    })

    it("joins string[] args for the bash aspect", () => {
      const bash: AspectRule = { mode: "bash", patterns: { "*": "ask", "rm -rf *": "deny" } }
      const decision = runInMode(
        "bash",
        { command: ["rm", "-rf", "/"] },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: {},
          toolRules: {},
          aspectRules: { bash_cmd: bash },
        },
        [],
        new Map([["bash", { tags: ["execution"], fields: { bash_cmd: { mode: "bash", fields: ["command"] } } }]]),
      )
      expect(decision.action).toBe("deny")
    })

    it("records the matching pattern in ruleTrail", () => {
      const path: AspectRule = { patterns: { "**": "allow", "*.env": "deny" } }
      const decision = runInMode(
        "read",
        { path: "/repo/.env" },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: {},
          toolRules: {},
          aspectRules: { path },
        },
        [],
        new Map([["read", pathTool("read")]]),
      )
      expect(decision.action).toBe("deny")
      const aspectRule = decision.ruleTrail.find((r) => r.layer === "aspect")
      expect(aspectRule).toBeDefined()
      expect(aspectRule?.pattern).toBe("*.env")
    })
  })

  describe("tool rules", () => {
    it("matches a tool with no fields clause (always matches)", () => {
      const decision = runInMode(
        "bash",
        { command: ["echo", "hi"] },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: {},
          toolRules: { bash: [{ verdict: "deny" }] },
          aspectRules: {},
        },
      )
      expect(decision.action).toBe("deny")
    })

    it("matches a tool when the fields clause matches", () => {
      const decision = runInMode(
        "bash",
        { command: ["echo", "hi"] },
        {
          description: "test",
          defaultDecision: "allow",
          tagRules: {},
          toolRules: { bash: [{ fields: { command: ["echo *"] }, verdict: "allow" }] },
          aspectRules: {},
        },
      )
      expect(decision.action).toBe("allow")
    })

    it("does NOT match when the fields clause fails", () => {
      const decision = runInMode(
        "bash",
        { command: ["rm", "-rf", "/"] },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: {},
          toolRules: { bash: [{ fields: { command: ["echo *"] }, verdict: "allow" }] },
          aspectRules: {},
        },
      )
      // No rule fires; defaultDecision ("ask") is the winner.
      expect(decision.action).toBe("ask")
    })
  })

  describe("defaultDecision fall-through", () => {
    it("defaultDecision wins when no rules fire", () => {
      const decision = runInMode(
        "unknown",
        {},
        {
          description: "test",
          defaultDecision: "deny",
          tagRules: {},
          toolRules: {},
          aspectRules: {},
        },
      )
      expect(decision.action).toBe("deny")
    })

    it("the defaultDecision status is 'shadowed' when a more-specific layer wins", () => {
      const decision = runInMode(
        "read",
        { path: "/repo/foo.ts" },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { readonly: "ask" },
          toolRules: {},
          aspectRules: {},
        },
        ["readonly"],
      )
      // The tag rule produced "ask"; the default also says "ask" but
      // the tag layer is more specific than the default layer, so
      // the tag layer wins. The default's status is therefore
      // `shadowed` (its layer was beaten by a more-specific layer),
      // NOT `noop` (which is reserved for "same verdict as the
      // layer winner within the same layer").
      const defaultRule = decision.ruleTrail.find((r) => r.layer === "default")
      expect(defaultRule?.status).toBe("shadowed")
    })

    it("the defaultDecision status is 'applied' when no rules fired", () => {
      const decision = runInMode(
        "unknown",
        {},
        {
          description: "test",
          defaultDecision: "deny",
          tagRules: {},
          toolRules: {},
          aspectRules: {},
        },
      )
      const defaultRule = decision.ruleTrail.find((r) => r.layer === "default")
      expect(defaultRule?.status).toBe("applied")
    })
  })

  describe("status trail", () => {
    it("'applied' status is the most-restrictive rule in the winning layer; the loser in the same layer is 'shadowed'", () => {
      const decision = runInMode(
        "write",
        { path: "/repo/foo.ts" },
        {
          description: "test",
          defaultDecision: "allow",
          tagRules: { readonly: "allow", mutating: "deny" },
          toolRules: {},
          aspectRules: {},
        },
        ["readonly", "mutating"],
      )
      expect(decision.action).toBe("deny")
      // Per-layer combine: both rules are in the tag layer. The
      // layer's most-restrictive winner is `deny` (mutating). The
      // mutating rule is `applied`; the readonly rule is `shadowed`
      // (less restrictive than the layer winner). Exactly one rule
      // per call is `applied` — the global winner.
      const denyRule = decision.ruleTrail.find((r) => r.layer === "tag" && r.key === "mutating")
      expect(denyRule?.status).toBe("applied")
      const allowRule = decision.ruleTrail.find((r) => r.layer === "tag" && r.key === "readonly")
      expect(allowRule?.status).toBe("shadowed")
    })

    it("'noop' status when the rule's verdict matches the running decision", () => {
      const decision = runInMode(
        "read",
        { path: "/repo/foo.ts" },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { readonly: "ask", metadata: "ask" },
          toolRules: {},
          aspectRules: {},
        },
        ["readonly", "metadata"],
      )
      // Both tag rules produce "ask"; the second is noop relative to the first.
      const readonlyRule = decision.ruleTrail.find((r) => r.layer === "tag" && r.key === "readonly")
      const metadataRule = decision.ruleTrail.find((r) => r.layer === "tag" && r.key === "metadata")
      // Order in ruleTrail: readonly (applied) then metadata (noop).
      expect(readonlyRule?.status).toBe("applied")
      expect(metadataRule?.status).toBe("noop")
    })
  })

  describe("per-layer combine (most-specific layer wins; deny is sticky)", () => {
    it("REGRESSION: aspect 'allow' beats tag 'ask' (the bug-report case)", () => {
      // From the bug report: a `bash` call with command `["ls", "*"]`
      // and effective tag `execution`. The user wrote an aspect rule
      // `bash_cmd "ls *" = allow` to allow `ls` calls without
      // prompting. The tag rule `tag:execution = ask` is a blanket
      // ask for everything tagged execution. Under the old
      // flat-most-restrictive combine, the tag's `ask` won. Under
      // the new per-layer combine, the more-specific aspect layer
      // wins, so the call is allowed.
      const bash: AspectRule = { mode: "bash", patterns: { "ls *": "allow" } }
      const decision = runInMode(
        "bash",
        { command: ["ls", "*"] },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { execution: "ask" },
          toolRules: {},
          aspectRules: { bash_cmd: bash },
        },
        ["execution"],
        new Map([["bash", { tags: ["execution"], fields: { bash_cmd: { mode: "bash", fields: ["command"] } } }]]),
      )
      expect(decision.action).toBe("allow")
      const aspectRule = decision.ruleTrail.find((r) => r.layer === "aspect")
      const tagRule = decision.ruleTrail.find((r) => r.layer === "tag")
      expect(aspectRule?.status).toBe("applied")
      expect(tagRule?.status).toBe("shadowed")
    })

    it("more-specific 'ask' beats less-specific 'allow' (the other direction)", () => {
      // A user deliberately wrote an aspect rule that ASKS for a
      // narrow pattern. The tag rule allows broadly. The more-
      // specific aspect `ask` should still apply — the user wrote
      // the rule specifically to ask about this pattern. This is
      // the two-direction property of the combine.
      const path: AspectRule = { patterns: { "*.env": "ask" } }
      const decision = runInMode(
        "read",
        { path: "/repo/.env" },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { readonly: "allow" },
          toolRules: {},
          aspectRules: { path },
        },
        ["readonly"],
        new Map([["read", pathTool("read")]]),
      )
      expect(decision.action).toBe("ask")
      const aspectRule = decision.ruleTrail.find((r) => r.layer === "aspect")
      const tagRule = decision.ruleTrail.find((r) => r.layer === "tag")
      expect(aspectRule?.status).toBe("applied")
      expect(tagRule?.status).toBe("shadowed")
    })

    it("REGRESSION: deny at any layer beats all other rules regardless of specificity", () => {
      // Safety invariant: a `deny` from ANY layer is the final
      // answer, regardless of layer priority. A more-specific
      // aspect `allow` must NOT override a tag `deny`. This is
      // what `deny`-sticky means.
      const path: AspectRule = { patterns: { "**": "allow" } }
      const decision = runInMode(
        "read",
        { path: "/repo/foo.ts" },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { readonly: "deny" },
          toolRules: {},
          aspectRules: { path },
        },
        ["readonly"],
        new Map([["read", pathTool("read")]]),
      )
      expect(decision.action).toBe("deny")
      const tagRule = decision.ruleTrail.find((r) => r.layer === "tag")
      const aspectRule = decision.ruleTrail.find((r) => r.layer === "aspect")
      expect(tagRule?.status).toBe("applied")
      expect(aspectRule?.status).toBe("shadowed")
    })

    it("undecided aspect layer defers to the next-most-specific layer (tag wins)", () => {
      // No aspect pattern matches the call (the `*.env` aspect
      // pattern does not match `/repo/foo.ts`). The aspect layer
      // therefore has no opinion and the combine defers to the
      // tag layer, which says `ask`. The default is shadowed.
      const path: AspectRule = { patterns: { "*.env": "deny" } }
      const decision = runInMode(
        "read",
        { path: "/repo/foo.ts" },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { readonly: "ask" },
          toolRules: {},
          aspectRules: { path },
        },
        ["readonly"],
        new Map([["read", pathTool("read")]]),
      )
      expect(decision.action).toBe("ask")
      const tagRule = decision.ruleTrail.find((r) => r.layer === "tag")
      const defaultRule = decision.ruleTrail.find((r) => r.layer === "default")
      // No aspect rule in the trail (the matcher returns `undecided`
      // and doesn't contribute).
      expect(decision.ruleTrail.find((r) => r.layer === "aspect")).toBeUndefined()
      expect(tagRule?.status).toBe("applied")
      expect(defaultRule?.status).toBe("shadowed")
    })

    it("tool layer beats tag layer when both have matching rules", () => {
      // Tool rule is more specific than tag rule. The tool rule's
      // verdict wins regardless of which is more restrictive.
      const decision = runInMode(
        "bash",
        { command: ["echo", "hi"] },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { execution: "ask" },
          toolRules: { bash: [{ fields: { command: ["echo *"] }, verdict: "allow" }] },
          aspectRules: {},
        },
        ["execution"],
      )
      expect(decision.action).toBe("allow")
      const toolRule = decision.ruleTrail.find((r) => r.layer === "tool")
      const tagRule = decision.ruleTrail.find((r) => r.layer === "tag")
      expect(toolRule?.status).toBe("applied")
      expect(tagRule?.status).toBe("shadowed")
    })

    it("two denies across layers: the most-specific layer's deny is the global winner", () => {
      // Both the tag and the tool layer have `deny`. The more-
      // specific (tool) layer's `deny` is the global winner.
      const decision = runInMode(
        "bash",
        { command: ["echo", "hi"] },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { execution: "deny" },
          toolRules: { bash: [{ verdict: "deny" }] },
          aspectRules: {},
        },
        ["execution"],
      )
      expect(decision.action).toBe("deny")
      const toolRule = decision.ruleTrail.find((r) => r.layer === "tool")
      const tagRule = decision.ruleTrail.find((r) => r.layer === "tag")
      expect(toolRule?.status).toBe("applied")
      expect(tagRule?.status).toBe("shadowed")
    })

    it("noop means 'same verdict as the layer winner' (not 'same as global winner')", () => {
      // Two tag rules in the same layer with the same verdict.
      // The first is the layer winner (and global winner); the
      // second is noop relative to the layer winner.
      const decision = runInMode(
        "read",
        { path: "/repo/foo.ts" },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { readonly: "ask", metadata: "ask" },
          toolRules: {},
          aspectRules: {},
        },
        ["readonly", "metadata"],
      )
      const readonlyRule = decision.ruleTrail.find((r) => r.layer === "tag" && r.key === "readonly")
      const metadataRule = decision.ruleTrail.find((r) => r.layer === "tag" && r.key === "metadata")
      expect(readonlyRule?.status).toBe("applied")
      expect(metadataRule?.status).toBe("noop")
    })
  })

  describe("AnyVerdict reasons", () => {
    it("concatenates applied rules' reasons with '; '", () => {
      const decision = runInMode(
        "bash",
        { command: ["echo", "hi"] },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { execution: { verdict: "deny", reason: "no execution in plan mode" } },
          toolRules: { bash: [{ verdict: { verdict: "ask", reason: "always ask for bash" } }] },
          aspectRules: {},
        },
        ["execution"],
      )
      expect(decision.action).toBe("deny")
      // For deny verdicts, the reason is a 3-part layout: headline
      // (tool + mode), middle block (rule reason or matched-rule id),
      // suffix (steering instruction). The single applied rule's reason
      // wins (the toolRules 'ask' is suppressed by the more-restrictive
      // 'deny').
      expect(decision.reason).toBe(
        "The agent was not permitted to call the `bash` tool in `default` mode.\n\n" +
          'Reason from the rule: "no execution in plan mode"\n\n' +
          "Analyze why this call was blocked and adjust your approach accordingly.",
      )
    })

    it("synthesizes a reason when no applied rule has one", () => {
      const decision = runInMode(
        "read",
        { path: "/repo/.env" },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: {},
          toolRules: {},
          aspectRules: { path: { patterns: { "**": "allow", "*.env": "deny" } } },
        },
        [],
        new Map([["read", pathTool("read")]]),
      )
      expect(decision.action).toBe("deny")
      // The aspect rule has no reason; the middle block shows the
      // matched rule's pattern instead. The 3-part layout is the
      // standard deny-reason template.
      expect(decision.reason).toBe(
        "The agent was not permitted to call the `read` tool in `default` mode.\n\n" +
          "Matched rule: *.env\n\n" +
          "Analyze why this call was blocked and adjust your approach accordingly.",
      )
    })

    it("uses 'Permission requested' framing for ask verdicts (not 'Rejected')", () => {
      const decision = runInMode(
        "read",
        { path: "/repo/.env" },
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: {},
          toolRules: {},
          aspectRules: { path: { patterns: { "*.env": { verdict: "ask", reason: "sensitive" } } } },
        },
        [],
        new Map([["read", pathTool("read")]]),
      )
      expect(decision.action).toBe("ask")
      // The reason is framed as a request, not a rejection.
      // The aspect rule has no reason, so the synthesizer falls back to
      // the pattern; the framing prefix distinguishes 'ask' from 'deny'.
      expect(decision.reason).toBe("Permission requested: *.env")
    })
  })

  describe("v1 backward-compat (under a synthetic default mode)", () => {
    it("reproduces the v1 'tools' verdict via toolRules", () => {
      // v1 had: tools: { read: "allow", write: "deny" }
      // v2 equivalent: toolRules: { read: [{ verdict: "allow" }], write: [{ verdict: "deny" }] }
      const allowDecision = runInMode(
        "read",
        {},
        {
          description: "test",
          defaultDecision: "allow",
          tagRules: {},
          toolRules: { read: [{ verdict: "allow" }] },
          aspectRules: {},
        },
      )
      const denyDecision = runInMode(
        "write",
        {},
        {
          description: "test",
          defaultDecision: "allow",
          tagRules: {},
          toolRules: { write: [{ verdict: "deny" }] },
          aspectRules: {},
        },
      )
      expect(allowDecision.action).toBe("allow")
      expect(denyDecision.action).toBe("deny")
    })

    it("reproduces the v1 groupVerdicts via tagRules + tool-metadata tags", () => {
      // v1: groupVerdicts: { readonly: "allow", mutating: "ask" } + tool metadata with groups
      // v2: tagRules: { readonly: "allow", mutating: "ask" } + tool metadata with tags
      const decision = runInMode(
        "write",
        {},
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: { readonly: "allow", mutating: "ask" },
          toolRules: {},
          aspectRules: {},
        },
        ["mutating"],
      )
      expect(decision.action).toBe("ask")
    })

    it("reproduces the v1 per-tool pattern map via a single fields-clause entry", () => {
      // v1: tools: { dangerous: { "*": "allow", dangerous: "deny" } }
      // v2: toolRules: { dangerous: [{ fields: { _tool: ["dangerous"] }, verdict: "deny" }] }
      // (The v1 "tool name pattern" is gone in v2 — the user's config now uses
      // an exact tool name in toolRules. To match a v1-style "per-tool pattern",
      // the user would just add multiple toolRules entries. The semantic
      // equivalent here is the explicit entry.)
      const decision = runInMode(
        "dangerous",
        {},
        {
          description: "test",
          defaultDecision: "ask",
          tagRules: {},
          toolRules: { dangerous: [{ verdict: "deny" }] },
          aspectRules: {},
        },
      )
      expect(decision.action).toBe("deny")
    })
  })

  describe("unknown mode", () => {
    it("denies on unknown mode", () => {
      const config: Config = {
        modeOrder: ["default"],
        modes: { default: { description: "", defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} } },
        allowedPaths: [],
        taggingRules: [],
        toolMetadata: {},
      }
      const decision = evaluate(makeEvent("read", {}), config, "missing", [], emptyMeta, ctx)
      expect(decision.action).toBe("deny")
      expect(decision.reason).toContain("unknown mode")
    })
  })

  describe("performance", () => {
    it("resolves a tool_call with 4 layers × 100 rules within 100ms (CI-friendly)", () => {
      // Build a mode with 100 tagRules, 100 aspectRules patterns, 100 toolRules entries.
      const tagRules: Record<string, Verdict> = {}
      for (let i = 0; i < 100; i++) {
        tagRules[`tag-${i}`] = i === 99 ? "deny" : "allow"
      }
      const aspectPatterns: Record<string, Verdict> = {}
      for (let i = 0; i < 100; i++) {
        aspectPatterns[`pattern-${i}-*.ts`] = i === 99 ? "deny" : "allow"
      }
      const toolEntries = []
      for (let i = 0; i < 100; i++) {
        toolEntries.push({ fields: { path: [`pattern-${i}-*`] }, verdict: (i === 99 ? "deny" : "allow") as Verdict })
      }
      const effectiveTags: string[] = []
      for (let i = 0; i < 100; i++) effectiveTags.push(`tag-${i}`)

      const meta = new Map<string, ResolvedToolMetadata>([["big", pathTool("big", effectiveTags)]])

      const decision = runInMode(
        "big",
        { path: "/repo/pattern-99-final.ts" },
        {
          description: "stress",
          defaultDecision: "ask",
          tagRules,
          toolRules: { big: toolEntries },
          aspectRules: { path: { patterns: aspectPatterns } },
        },
        effectiveTags,
        meta,
      )
      const start = performance.now()
      evaluate(
        makeEvent("big", { path: "/repo/pattern-99-final.ts" }),
        {
          modeOrder: ["default"],
          modes: {
            default: {
              description: "stress",
              defaultDecision: "ask",
              tagRules,
              toolRules: { big: toolEntries },
              aspectRules: { path: { patterns: aspectPatterns } },
            },
          },
          allowedPaths: [],
          taggingRules: [],
          toolMetadata: {},
        },
        "default",
        effectiveTags,
        meta,
        ctx,
      )
      const elapsed = performance.now() - start

      expect(decision.action).toBe("deny")
      expect(elapsed).toBeLessThan(100)
    })
  })
})

describe("per-field aspect cardinality (FieldBinding)", () => {
  // The v2 refactor moved cardinality from `mode: "path[]"` (whole-aspect)
  // to a per-field `FieldBinding` shape. The same `path` aspect can
  // bind a scalar `cwd` field and an array-mode `paths` field. The
  // matcher dispatches per binding, not per aspect. This is the
  // load-bearing test for the refactor.

  it("ripgrep: scalar cwd is matched as a single path; array paths are matched per element", () => {
    // .env in cwd → deny; everything else allowed. cwd is matched as
    // a single path (relative to ctx.cwd /repo), so /repo/.env
    // becomes .env — which the *.env pattern matches.
    const path: AspectRule = { patterns: { "**": "allow", "*.env": "deny" } }
    const meta: ResolvedToolMetadata = {
      tags: ["readonly"],
      fields: {
        path: {
          mode: "path",
          fields: [{ field: "paths", mode: "array" }, "cwd"],
        },
      },
    }
    const decision = runInMode(
      "ripgrep",
      { paths: ["/repo/src/a.ts", "/repo/src/b.ts"], cwd: "/repo/.env" },
      {
        description: "test",
        defaultDecision: "ask",
        tagRules: {},
        toolRules: {},
        aspectRules: { path },
      },
      [],
      new Map([["ripgrep", meta]]),
    )
    // cwd is a single path that matches the deny pattern. The scalar
    // match fires; per-element paths are both allowed but the scalar
    // cwd deny is more restrictive → final verdict is deny.
    expect(decision.action).toBe("deny")
  })

  it("git: array paths on the path aspect, scalar source on git_mv", () => {
    // Simulate git_add (single `path` aspect with array-mode `paths`)
    // and git_mv (separate `source` and `destination` aspects).
    const path: AspectRule = { patterns: { "**": "allow", "*.env": "deny" } }
    const source: AspectRule = { patterns: { "**": "allow", "*.env": "deny" } }
    const destination: AspectRule = { patterns: { "**": "allow" } }

    const gitAddMeta: ResolvedToolMetadata = {
      tags: ["mutating"],
      fields: { path: { mode: "path", fields: [{ field: "paths", mode: "array" }] } },
    }
    const gitMvMeta: ResolvedToolMetadata = {
      tags: ["mutating"],
      fields: {
        source: { mode: "path", fields: [{ field: "source", mode: "array" }] },
        destination: { mode: "path", fields: ["destination"] },
      },
    }
    const meta = new Map<string, ResolvedToolMetadata>([
      ["git_add", gitAddMeta],
      ["git_mv", gitMvMeta],
    ])

    // git_add with one .env among the array → deny (per-element combine).
    const gitAdd = runInMode(
      "git_add",
      { paths: ["/repo/src/a.ts", "/repo/.env"] },
      {
        description: "test",
        defaultDecision: "ask",
        tagRules: {},
        toolRules: {},
        aspectRules: { path },
      },
      [],
      meta,
    )
    expect(gitAdd.action).toBe("deny")

    // git_mv with a .env source → deny (array-mode source match).
    const gitMv = runInMode(
      "git_mv",
      { source: ["/repo/.env"], destination: "/repo/public" },
      {
        description: "test",
        defaultDecision: "ask",
        tagRules: {},
        toolRules: {},
        aspectRules: { source, destination },
      },
      [],
      meta,
    )
    expect(gitMv.action).toBe("deny")
  })

  it("dispatches aspect rules to picomatch when aspectName !== 'path' (regression for the dispatch-key gotcha)", () => {
    // git_mv-shaped tool: custom aspect name "source" bound to mode: "path".
    // The bug would dispatch on the user-defined name ("source"), not the
    // declared mode ("path"), so the generic-regex fallback would fire.
    // The brace-expansion pattern `**/{node_modules,.git}/**` distinguishes
    // the two branches: picomatch expands braces (matches), generic-regex
    // does not (does not match).
    const source: AspectRule = { patterns: { "**/{node_modules,.git}/**": "deny" } }
    const meta: ResolvedToolMetadata = {
      tags: ["mutating"],
      fields: {
        source: { mode: "path", fields: [{ field: "source", mode: "array" }] },
      },
    }
    const decision = runInMode(
      "git_mv",
      { source: ["/repo/node_modules/foo"] },
      {
        description: "test",
        defaultDecision: "allow",
        tagRules: {},
        toolRules: {},
        aspectRules: { source },
      },
      [],
      new Map([["git_mv", meta]]),
    )
    // With the fix: picomatch expands the braces and matches
    // /repo/node_modules/foo (relative to /repo → node_modules/foo,
    // which the brace pattern covers) → rule fires → deny.
    // Without the fix: the fallback can't expand braces, the rule
    // doesn't fire, defaultDecision ("allow") wins → action would
    // be "allow" and this test would fail.
    expect(decision.action).toBe("deny")
    const aspectRules = decision.ruleTrail.filter((r) => r.layer === "aspect")
    expect(aspectRules).toEqual([expect.objectContaining({ verdict: "deny", pattern: "**/{node_modules,.git}/**" })])
  })

  it("mixed scalar + array on the same aspect: both bindings contribute, most-restrictive wins", () => {
    // Both fields bind to the same `path` aspect. `cwd` is scalar
    // (matched as one), `paths` is array (matched per element). The
    // matcher contributes both to the running fold.
    const path: AspectRule = { patterns: { "**": "allow", "*.env": "deny" } }
    const meta: ResolvedToolMetadata = {
      tags: ["readonly"],
      fields: {
        path: {
          mode: "path",
          fields: [{ field: "paths", mode: "array" }, "cwd"],
        },
      },
    }
    const decision = runInMode(
      "ripgrep",
      // paths are all allow; cwd matches deny → final deny
      { paths: ["/repo/src/a.ts", "/repo/src/b.ts"], cwd: "/repo/.env" },
      {
        description: "test",
        defaultDecision: "ask",
        tagRules: {},
        toolRules: {},
        aspectRules: { path },
      },
      [],
      new Map([["ripgrep", meta]]),
    )
    expect(decision.action).toBe("deny")
    const aspectRules = decision.ruleTrail.filter((r) => r.layer === "aspect")
    // Two aspect-layer rules contributed: one for the array-mode paths
    // (allow, applied) and one for the scalar cwd (deny, applied —
    // strictly more restrictive, takes over from allow).
    expect(aspectRules.length).toBe(2)
    const fields = aspectRules.map((r) => r.key).sort()
    expect(fields).toEqual(["cwd", "paths"])
  })
})

// Tiny smoke: re-export the import to keep the dependency explicit in the
// coverage report and to ensure the import path stays valid.
describe("module surface", () => {
  it("re-exports matchAspect", () => {
    expect(typeof matchAspect).toBe("function")
  })
})

describe("buildDenyReason", () => {
  // Helper to keep the test cases readable. Each case constructs a
  // minimal applied-rule list; the formatter only cares about layer,
  // key, and pattern (and whether status is "applied").
  const head = (tool: string, mode: string) =>
    `The agent was not permitted to call the \`${tool}\` tool in \`${mode}\` mode.`
  const suffix = "Analyze why this call was blocked and adjust your approach accordingly."

  it("formats a deny with a configured reason (the most common case)", () => {
    const reason = buildDenyReason({
      toolName: "bash",
      modeName: "plan",
      appliedRules: [{ layer: "tag", key: "execution", verdict: "deny", status: "applied" }],
      reasonParts: ["no execution in plan mode"],
      explicitRuleFired: true,
    })
    expect(reason).toBe(
      `${head("bash", "plan")}\n\n` + `Reason from the rule: "no execution in plan mode"\n\n` + suffix,
    )
  })

  it("joins multiple configured reasons with '; ' inside the same quoted span", () => {
    const reason = buildDenyReason({
      toolName: "bash",
      modeName: "default",
      appliedRules: [
        { layer: "tag", key: "execution", verdict: "deny", status: "applied", reason: "no execution" },
        { layer: "tool", key: "bash", verdict: "deny", status: "applied", reason: "bash is banned" },
      ],
      reasonParts: ["no execution", "bash is banned"],
      explicitRuleFired: true,
    })
    expect(reason).toBe(
      `${head("bash", "default")}\n\n` + `Reason from the rule: "no execution"; "bash is banned"\n\n` + suffix,
    )
  })

  it("uses 'User's reason for denying' when a one-off reason is supplied", () => {
    const reason = buildDenyReason({
      toolName: "bash",
      modeName: "default",
      appliedRules: [{ layer: "tag", key: "execution", verdict: "deny", status: "applied", reason: "from config" }],
      // The configured reason is also present, but the one-off reason
      // wins — the user just told us why NOW.
      reasonParts: ["from config"],
      explicitRuleFired: true,
      userReason: "touches /etc — confirm before retrying",
    })
    expect(reason).toBe(
      `${head("bash", "default")}\n\n` +
        `User's reason for denying: "touches /etc — confirm before retrying"\n\n` +
        suffix,
    )
  })

  it("falls back to 'Matched rule: <id>' when no reason is present and a rule fired", () => {
    const reason = buildDenyReason({
      toolName: "read",
      modeName: "default",
      appliedRules: [
        { layer: "aspect", key: "path", aspect: "path", pattern: "*.env", verdict: "deny", status: "applied" },
      ],
      reasonParts: [],
      explicitRuleFired: true,
    })
    // For aspect-layer rules the most useful id is the pattern, not
    // the layer:key. So we get `Matched rule: *.env`.
    expect(reason).toBe(`${head("read", "default")}\n\n` + `Matched rule: *.env\n\n` + suffix)
  })

  it("uses 'tool:<name>' for tool-layer rules in the 'no reason' case", () => {
    const reason = buildDenyReason({
      toolName: "bash",
      modeName: "default",
      appliedRules: [{ layer: "tool", key: "bash", verdict: "deny", status: "applied" }],
      reasonParts: [],
      explicitRuleFired: true,
    })
    expect(reason).toBe(`${head("bash", "default")}\n\n` + `Matched rule: tool:bash\n\n` + suffix)
  })

  it("uses 'tag:<name>' for tag-layer rules in the 'no reason' case", () => {
    const reason = buildDenyReason({
      toolName: "bash",
      modeName: "default",
      appliedRules: [{ layer: "tag", key: "mutating", verdict: "deny", status: "applied" }],
      reasonParts: [],
      explicitRuleFired: true,
    })
    expect(reason).toBe(`${head("bash", "default")}\n\n` + `Matched rule: tag:mutating\n\n` + suffix)
  })

  it("uses the 'Default mode decision: deny (no rule matched)' line for default-deny", () => {
    const reason = buildDenyReason({
      toolName: "bash",
      modeName: "plan",
      appliedRules: [],
      reasonParts: [],
      explicitRuleFired: false,
    })
    expect(reason).toBe(`${head("bash", "plan")}\n\n` + `Default mode decision: deny (no rule matched)\n\n` + suffix)
  })

  it("ignores empty-string reason parts (treats them as no reason)", () => {
    const reason = buildDenyReason({
      toolName: "bash",
      modeName: "default",
      appliedRules: [{ layer: "tag", key: "execution", verdict: "deny", status: "applied" }],
      reasonParts: ["", ""],
      explicitRuleFired: true,
    })
    // Empty-string reasons fall through to the "Matched rule" path.
    expect(reason).toContain("Matched rule: tag:execution")
  })

  it("ignores empty user reason (falls through to configured reason)", () => {
    const reason = buildDenyReason({
      toolName: "bash",
      modeName: "default",
      appliedRules: [{ layer: "tag", key: "execution", verdict: "deny", status: "applied", reason: "configured" }],
      reasonParts: ["configured"],
      explicitRuleFired: true,
      userReason: "",
    })
    expect(reason).toContain('Reason from the rule: "configured"')
  })
})

/**
 * These tests pin the post-Unit-3b invariant: the loader returns the
 * merged config with `extends` intact on every mode. The matcher
 * (`evaluate`) operates on a `Mode` produced by the consumer calling
 * `resolveMode(name, config)` — NOT on the raw config-as-loaded.
 *
 * Without the resolve-on-consumer step, the matcher's
 * `mode.tagRules[tag]` lookup misses inherited rules (e.g. `edit`'s
 * own tagRules is just `{ mutating: "allow" }`; the `readonly`,
 * `metadata`, `execution`, `network` rules live on `default` /
 * `readonly` and are reached only via `resolveMode`).
 *
 * This is a regression test for Unit 7a's handler-side fix; if a
 * future change bypasses `resolveMode`, these tests fail with
 * "Expected: allow, Received: ask".
 */
describe("JIT consumer — resolveMode before evaluate", () => {
  // Minimal stock-shaped config: each mode carries its `extends` field.
  // The loader produces this shape; the matcher consumes the resolved
  // form via `resolveMode(name, config)`.
  const configWithExtends: Config = {
    modeOrder: ["readonly", "default", "edit", "plan"],
    modes: {
      readonly: {
        description: "permits readonly",
        defaultDecision: "ask",
        tagRules: { readonly: "allow", metadata: "allow" },
        toolRules: {},
        aspectRules: {},
      },
      default: {
        description: "asks for mutating/execution/network",
        extends: ["readonly"],
        defaultDecision: "ask",
        tagRules: { mutating: "ask", execution: "ask", network: "ask" },
        toolRules: {},
        aspectRules: {},
      },
      edit: {
        description: "permits mutating",
        extends: ["default"],
        defaultDecision: "ask",
        tagRules: { mutating: "allow" },
        toolRules: {},
        aspectRules: {},
      },
      plan: {
        description: "denies everything",
        extends: ["readonly"],
        defaultDecision: "deny",
        tagRules: {
          mutating: "deny",
          execution: "deny",
          network: "deny",
        },
        toolRules: {},
        aspectRules: {},
      },
    },
    allowedPaths: [],
    taggingRules: [],
    toolMetadata: {
      read: { tags: ["readonly"], aspects: { path: { mode: "path", fields: ["path"] } } },
    },
  }
  const readToolMeta = new Map<string, ResolvedToolMetadata>([
    ["read", { tags: ["readonly"], fields: { path: { mode: "path", fields: ["path"] } } }],
  ])

  // Helper: simulate the JIT-consumer pattern as Unit 7a's handler will.
  function evaluateAfterResolve(modeName: string, toolName: string, input: Record<string, unknown>, tags: string[]) {
    const { mode } = resolveMode(modeName, configWithExtends)
    const evalConfig: Config = {
      ...configWithExtends,
      modes: { ...configWithExtends.modes, [modeName]: mode },
    }
    return evaluate(makeEvent(toolName, input), evalConfig, modeName, tags, readToolMeta, ctx)
  }

  it("edit-mode read (readonly tag) is allowed (resolved edit inherits readonly:allow)", () => {
    // Pre-Unit-3b behavior: edit's tagRules for "readonly" = "allow"
    // (inherited from default → readonly). After Unit 3b without
    // resolve-on-consumer, the raw edit mode has tagRules =
    // { mutating: "allow" } only; tagRules[readonly] = undefined;
    // the verdict falls through to defaultDecision ("ask") —
    // which is exactly what the user is reporting on reload.
    const decision = evaluateAfterResolve("edit", "read", { path: "/repo/foo.ts" }, ["readonly"])
    expect(decision.action).toBe("allow")
  })

  it("default-mode bash (execution tag) asks (resolved default inherits execution:ask)", () => {
    const bashMeta = new Map<string, ResolvedToolMetadata>([
      ["bash", { tags: ["execution"], fields: { bash_cmd: { mode: "bash", fields: ["command"] } } }],
    ])
    const { mode } = resolveMode("default", configWithExtends)
    const evalConfig: Config = {
      ...configWithExtends,
      modes: { ...configWithExtends.modes, default: mode },
    }
    const decision = evaluate(
      makeEvent("bash", { command: ["ls"] }),
      evalConfig,
      "default",
      ["execution"],
      bashMeta,
      ctx,
    )
    expect(decision.action).toBe("ask")
  })

  it("plan-mode bash (execution tag) denies (resolved plan has execution:deny)", () => {
    const bashMeta = new Map<string, ResolvedToolMetadata>([
      ["bash", { tags: ["execution"], fields: { bash_cmd: { mode: "bash", fields: ["command"] } } }],
    ])
    const { mode } = resolveMode("plan", configWithExtends)
    const evalConfig: Config = {
      ...configWithExtends,
      modes: { ...configWithExtends.modes, plan: mode },
    }
    const decision = evaluate(makeEvent("bash", { command: ["ls"] }), evalConfig, "plan", ["execution"], bashMeta, ctx)
    expect(decision.action).toBe("deny")
  })

  // ─── regression pin: raw JIT-mode passed to evaluate without
  // resolveMode produces the wrong verdict. The handler at
  // `tool_call` (Unit 7a's recipe) must call `resolveMode(currentMode, config)`
  // before `evaluate`. If a future change bypasses that call, these
  // tests fail: the user observes `ask` prompts on `read` in
  // `default` mode even though `readonly: "allow"` is configured.
  it("REGRESSION: read in raw default mode (no resolveMode) → ask (the bug)", () => {
    // No resolveMode call. The matcher's tagRules["readonly"] lookup
    // misses because the raw `default` mode's tagRules is only
    // { mutating, execution, network }. The matcher falls through
    // to defaultDecision ("ask"). This is the bug.
    const decision = evaluate(
      makeEvent("read", { path: "/repo/foo.ts" }),
      configWithExtends,
      "default",
      ["readonly"],
      readToolMeta,
      ctx,
    )
    // Pre-fix the verdict is "ask". With the handler fix
    // (Unit 7a's `resolveMode(currentMode, config)` wrapper), the
    // resolved default's tagRules.readonly = "allow" and the
    // verdict becomes "allow". The pin documents the broken
    // shape: any caller that forgets to call resolveMode here
    // gets "ask" instead of "allow" for read in default mode.
    expect(decision.action).toBe("ask")
  })
})
