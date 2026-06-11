import type { ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent"

import { matchAspect } from "./aspects.ts"
import type { ExternalDirectoryState } from "./external-directory.ts"
import type {
  BlockingRule,
  Config,
  FieldBinding,
  FieldBindings,
  PolicyDecision,
  ResolvedToolMetadata,
  Verdict,
} from "./types.ts"

/** Strictness ranking: deny > ask > allow. undecided → ask (fail-closed). */
const STRICTNESS: Record<Verdict, number> = { deny: 3, ask: 2, allow: 1 }

function moreRestrictive(a: Verdict, b: Verdict): Verdict {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b
}

/** Coerce a value to a string (or string[]) for pattern matching, per the binding's format. */
function coerceForMatch(
  value: unknown,
  format: "scalar" | "array" | "string[]" | undefined,
  aspectName: string,
): string[] {
  if (value === undefined || value === null) return []
  // Explicit format always wins.
  if (format === "array" && Array.isArray(value)) {
    return value.map((v) => String(v))
  }
  if (format === "string[]" && Array.isArray(value)) {
    return [value.map((v) => String(v)).join(" ")]
  }
  // Auto-detect: string[] args + bash-mode aspect → join with " ".
  // Per the design's automatic-conversion rule, TArray<TString> + bash mode
  // produces a single joined string; the caller (the aspect matcher) then
  // applies bashPatternToRegex against that single string.
  if (format === undefined && Array.isArray(value) && aspectName === "bash_cmd") {
    return [value.map((v) => String(v)).join(" ")]
  }
  // Auto-detect: string[] args + generic aspect → per-element match.
  if (format === undefined && Array.isArray(value)) {
    return value.map((v) => String(v))
  }
  // scalar: coerce via String() (handles number, boolean, etc.).
  // Arrays/objects are rejected at this point — the union is now strictly
  // a primitive; cast to keep eslint happy with `no-base-to-string`.
  const scalar = value as string | number | boolean | bigint | symbol
  return [String(scalar)]
}

/** Walk the field bindings for a tool, producing a flat binding list. */
function flattenBindings(fields: FieldBindings | undefined): { field: string; binding: FieldBinding }[] {
  if (!fields) return []
  const out: { field: string; binding: FieldBinding }[] = []
  for (const [field, bindings] of Object.entries(fields)) {
    const list = Array.isArray(bindings) ? bindings : [bindings]
    for (const binding of list) {
      out.push({ field, binding })
    }
  }
  return out
}

/**
 * Evaluate a single tool_call event against the 4-layer policy.
 *
 * Layers (most-restrictive-wins across them, last-match-wins within each):
 *  1. tools              — `config.tools[toolName]` (scalar verdict or per-pattern map)
 *  2. groupVerdicts      — combined with the tool's group memberships
 *  3. aspects            — per-field, per-binding; produces per-field verdicts
 *  4. externalDirectory  — in-memory gate for paths that escape `ctx.cwd`
 *
 * The returned `PolicyDecision` carries the list of "blocking rules" that
 * contributed to the verdict — these are what the TUI modal renders.
 */
export function evaluate(
  event: ToolCallEvent,
  config: Config,
  toolMetadata: Map<string, ResolvedToolMetadata>,
  externalDir: ExternalDirectoryState,
  ctx: ExtensionContext,
): PolicyDecision {
  const tool = event.toolName
  const meta = toolMetadata.get(tool)
  const blockingRules: BlockingRule[] = []

  // ── Layer 1: tools ────────────────────────────────────────────────────────
  let verdict: Verdict = config.defaultDecision ?? "ask"
  const toolDef = config.tools?.[tool]
  if (typeof toolDef === "string") {
    verdict = toolDef
    blockingRules.push({ layer: "tool", key: tool })
  } else if (typeof toolDef === "object") {
    // Per-tool pattern map: e.g. { "*.env": "deny", "*": "allow" }
    // Match the tool's name as a synthetic value against the pattern map.
    const toolNameMatch = matchAspect("tool", tool, { patterns: toolDef }, ctx.cwd)
    if (toolNameMatch !== "undecided") {
      verdict = toolNameMatch.verdict
      blockingRules.push({ layer: "tool", key: tool, pattern: toolNameMatch.pattern })
    }
  }

  // ── Layer 2: groupVerdicts ───────────────────────────────────────────────
  if (meta?.groups) {
    for (const group of meta.groups) {
      const groupVerdict = config.groupVerdicts?.[group]
      if (groupVerdict) {
        const combined = moreRestrictive(verdict, groupVerdict)
        if (combined !== verdict) {
          verdict = combined
          blockingRules.push({ layer: "group", key: group })
        }
      }
    }
  }

  // ── Layer 3: aspects (per-field, per-binding) ─────────────────────────────
  if (meta?.fields && config.aspects) {
    const args = event.input as Record<string, unknown>
    for (const { field, binding } of flattenBindings(meta.fields)) {
      const aspect = config.aspects[binding.aspect]
      if (!aspect) continue
      const values = coerceForMatch(args[field], binding.format, binding.aspect)
      for (const value of values) {
        if (!value) continue
        const result = matchAspect(binding.aspect, value, aspect, ctx.cwd)
        if (result === "undecided") continue
        const combined = moreRestrictive(verdict, result.verdict)
        if (combined !== verdict) {
          verdict = combined
          blockingRules.push({
            layer: "aspect",
            key: field,
            aspect: binding.aspect,
            pattern: result.pattern,
          })
        }
      }
    }
  }

  // ── Layer 4: externalDirectory ────────────────────────────────────────────
  if (meta?.fields) {
    const args = event.input as Record<string, unknown>
    for (const { field, binding } of flattenBindings(meta.fields)) {
      if (binding.aspect !== "path") continue
      const value = args[field]
      if (typeof value !== "string") continue
      if (externalDir.shouldPrompt(value, ctx.cwd)) {
        const combined = moreRestrictive(verdict, "ask")
        if (combined !== verdict) {
          verdict = combined
          blockingRules.push({ layer: "externalDirectory", key: field })
        }
      }
    }
  }

  if (verdict === "allow") return { action: "allow" }
  const reason = formatReason(verdict, blockingRules)
  return { action: verdict, reason, blockingRules }
}

function formatReason(verdict: Verdict, rules: BlockingRule[]): string {
  if (rules.length === 0) return `Rejected by rule: default decision is ${verdict}`
  const first = rules[0]!
  if (first.layer === "aspect" && first.pattern) {
    return `Rejected by rule: ${first.pattern}`
  }
  return `Rejected by rule: ${first.layer}:${first.key}`
}
