import { genericPatternToRegex } from "@piotrb/pi-extension-utils"

import { matchAspect, matchAspectEach } from "./aspects.ts"
import { coerceForMatch } from "./policy.ts"
import type { AnyVerdict, Mode, ResolvedToolMetadata, Verdict } from "./types.ts"
import { fieldName, isArrayBinding } from "./types.ts"

/**
 * What existing rules would already allow this call. The 'Allow & Save'
 * submenu hides options that would be redundant — if the existing
 * aspect rule already allows the call, don't ask the user to write
 * the same aspect rule again.
 *
 * `aspectCovered` is true if the tool has at least one aspect declared
 * AND at least one aspect rule (for one of those aspects) produces an
 * `allow` verdict for the call's value.
 *
 * `toolCovered` is true if any existing toolRule entry for this tool
 * matches the call and produces an `allow` verdict.
 */
export interface CoverageReport {
  aspectCovered: boolean
  toolCovered: boolean
}

/**
 * Compute the coverage report for a single tool call against the
 * active mode's rules. Pure function — no I/O, no UI. Callers can
 * use it to filter the 'Save →' submenu before showing it.
 */
export function buildCoverageReport(
  toolName: string,
  input: Record<string, unknown>,
  toolMeta: ResolvedToolMetadata | undefined,
  mode: Mode,
  cwd: string,
): CoverageReport {
  return {
    aspectCovered: isAspectCovered(toolName, input, toolMeta, mode, cwd),
    toolCovered: isToolRuleCovered(toolName, input, toolMeta, mode),
  }
}

/**
 * True if any existing aspect rule for this tool's declared aspects
 * would produce an `allow` verdict for the call's value. Tools with
 * no aspect metadata return false (nothing to check).
 */
function isAspectCovered(
  toolName: string,
  input: Record<string, unknown>,
  toolMeta: ResolvedToolMetadata | undefined,
  mode: Mode,
  cwd: string,
): boolean {
  if (!toolMeta) return false
  for (const [aspectName, decl] of Object.entries(toolMeta.fields)) {
    const aspectRule = mode.aspectRules[aspectName]
    if (!aspectRule) continue
    for (const binding of decl.fields) {
      const field = fieldName(binding)
      const value = input[field]
      if (value === undefined || value === null) continue
      if (isArrayBinding(binding)) {
        if (!Array.isArray(value)) continue
        const result = matchAspectEach(aspectName, value as string[], aspectRule, cwd)
        if (result !== "undecided" && result.verdict === "allow") return true
        continue
      }
      const s = coerceForMatch(value)
      if (!s) continue
      const result = matchAspect(aspectName, s, aspectRule, cwd)
      if (result !== "undecided" && result.verdict === "allow") return true
    }
  }
  void toolName
  return false
}

/**
 * True if any existing toolRule entry for this tool matches the call
 * AND produces an `allow` verdict. Mirrors the `evaluate()` logic
 * for layer 3 (toolRules) but returns the coverage boolean instead
 * of contributing to a running fold.
 */
function isToolRuleCovered(
  toolName: string,
  input: Record<string, unknown>,
  toolMeta: ResolvedToolMetadata | undefined,
  mode: Mode,
): boolean {
  const toolEntries = mode.toolRules[toolName]
  if (!toolEntries) {
    void toolMeta
    return false
  }
  for (const entry of toolEntries) {
    if (normalizeVerdict(entry.verdict).verdict !== "allow") continue
    if (!entry.fields) {
      // No fields clause: always matches.
      return true
    }
    let allFieldsMatch = true
    for (const [field, patterns] of Object.entries(entry.fields)) {
      const value = input[field]
      if (value === undefined || value === null) {
        allFieldsMatch = false
        break
      }
      const s = coerceForMatch(value)
      if (!s) {
        allFieldsMatch = false
        break
      }
      const fieldMatched = patterns.some((p) => genericPatternToRegex(p).test(s))
      if (!fieldMatched) {
        allFieldsMatch = false
        break
      }
    }
    if (allFieldsMatch) return true
  }
  return false
}

function normalizeVerdict(v: AnyVerdict): { verdict: Verdict } {
  return typeof v === "string" ? { verdict: v } : v
}
