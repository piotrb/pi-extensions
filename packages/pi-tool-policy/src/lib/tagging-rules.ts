import type { ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { genericPatternToRegex } from "@piotrb/pi-extension-utils"
import picomatch from "picomatch"

import { matchAspect } from "./aspects.ts"
import { coerceForMatch } from "./policy.ts"
import type { AspectRule, ResolvedToolMetadata, TaggerRule, Verdict } from "./types.ts"

/**
 * Apply tagger rules to a tool_call event. The output is the AUGMENTED tag
 * set (added on top of the tool's static tags from toolMetadata).
 *
 * Tagger rules NEVER produce verdicts directly. They augment the effective
 * tag set, which then drives `tagRules` verdicts in the matcher and the
 * directory-permissions guardrail.
 *
 * Matching semantics:
 *   - tool name: glob (picomatch)
 *   - fields:    AND across keys, OR within a key (generic pattern matcher)
 *   - aspects:   AND across aspects, OR within an aspect (aspect's mode)
 *   - action:    addTags (the only action type)
 */
export function applyTaggerRules(
  event: ToolCallEvent,
  rules: TaggerRule[],
  toolMetadata: Map<string, ResolvedToolMetadata>,
  cwd: string,
): string[] {
  const augmented = new Set<string>()
  const args = event.input as Record<string, unknown>

  for (const rule of rules) {
    // 1. Tool name matches (glob).
    if (!picomatch.isMatch(event.toolName, rule.tool, { dot: true })) continue

    // 2. fields clause (AND across keys, OR within a key).
    let fieldsOk = true
    if (rule.fields) {
      for (const [field, patterns] of Object.entries(rule.fields)) {
        const value = args[field]
        if (value === undefined || value === null) {
          fieldsOk = false
          break
        }
        const s = coerceForMatch(value)
        if (!s) {
          fieldsOk = false
          break
        }
        const matched = patterns.some((p) => genericPatternToRegex(p).test(s))
        if (!matched) {
          fieldsOk = false
          break
        }
      }
    }
    if (!fieldsOk) continue

    // 3. aspects clause (AND across aspects, OR within an aspect).
    let aspectsOk = true
    if (rule.aspects) {
      const meta = toolMetadata.get(event.toolName)
      if (!meta) {
        aspectsOk = false
      } else {
        for (const [aspectName, patterns] of Object.entries(rule.aspects)) {
          const decl = meta.fields[aspectName]
          if (!decl) {
            // Aspect not declared on the tool — can't match.
            aspectsOk = false
            break
          }
          // AspectDeclaration.fields is `string[]` — the root keys on the
          // tool's input that the aspect binds to.
          const fieldNames = decl.fields
          let aspectMatched = false
          for (const field of fieldNames) {
            const value = args[field]
            if (value === undefined || value === null) continue
            const s = coerceForMatch(value)
            if (!s) continue
            // The patterns are user-supplied. We need to check if ANY of them
            // match the value. The aspect matcher uses pattern KEYS, not
            // values, so we wrap each pattern as a key in a fake map.
            const fakePatterns: Record<string, Verdict> = Object.fromEntries(patterns.map((p) => [p, "allow"]))
            const fakeAspect: AspectRule = { mode: "generic", patterns: fakePatterns }
            const result = matchAspect(aspectName, s, fakeAspect, cwd)
            if (result !== "undecided") {
              aspectMatched = true
              break
            }
          }
          if (!aspectMatched) {
            aspectsOk = false
            break
          }
        }
      }
    }
    if (!aspectsOk) continue

    // 4. Apply the action (addTags is the only action type; the discriminated
    // union is reserved for future expansion).
    for (const tag of rule.action.tags) {
      augmented.add(tag)
    }
  }

  return [...augmented]
}
