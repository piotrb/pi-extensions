import { coerceForMatch } from "../policy.ts"
import type { ResolvedToolMetadata, ToolRuleEntry } from "../types.ts"
import { fieldName, isArrayBinding } from "../types.ts"
import { formatValue } from "./ask-display.ts"
import { formatPathForDisplay } from "./path-display.ts"

/**
 * What the "Allow for this user / project" option in the policy-ask
 * prompt actually grants. The `entry` is the `ToolRuleEntry` we'd
 * persist to the config file; the `label` is a single-line human
 * summary that goes into the select option text.
 *
 * The entry constrains on EXACT joined values per captured field
 * (string[] inputs are joined with " " to match `coerceForMatch`'s
 * array coercion), so a subsequent call with different argv / paths
 * will ask again. That's the whole point of the suggestion: lock
 * THIS particular call, no more, no less.
 */
export interface SuggestedAllow {
  entry: ToolRuleEntry
  /** Single-line summary, e.g. `command: ls -la /tmp` or `path: .env, src/index.ts`. */
  label: string
}

/**
 * Build the suggested allow-rule for a tool call. For tools with
 * `pi.toolMetadata` aspect declarations, we use the aspect names as
 * label keys (e.g. `command`, `path`) — these are what the user sees
 * in the ask title, so the option label matches what they just read.
 *
 * For tools WITHOUT aspect metadata, we fall back to the input field
 * names themselves (`cmd`, `path`, etc.). The semantics are the same:
 * one line per captured field, with values formatted via `formatValue`.
 *
 * `cwd` is optional. When provided AND the aspect's mode is `"path"`,
 * the LABEL is converted to cwd-relative form for display. The
 * persisted `entry.fields` clause is ALWAYS the original (typically
 * absolute) value — the tool-rule fields clause is matched against
 * the raw input via `genericPatternToRegex` full-string equality, so
 * a relative value here would never match a future absolute call.
 */
export function buildSuggestedAllow(
  toolName: string,
  input: Record<string, unknown>,
  toolMeta: ResolvedToolMetadata | undefined,
  cwd?: string,
): SuggestedAllow {
  void toolName
  const entry: ToolRuleEntry = { verdict: "allow" }
  const labelParts: string[] = []

  if (toolMeta) {
    const fields: Record<string, string[]> = {}
    for (const [aspectName, decl] of Object.entries(toolMeta.fields)) {
      const isPathMode = cwd !== undefined && decl.mode === "path"
      for (const binding of decl.fields) {
        const field = fieldName(binding)
        const raw = input[field]
        if (raw === undefined || raw === null) continue

        if (isArrayBinding(binding)) {
          // Array-mode binding: the persisted `fields` clause uses the
          // joined value (matching `coerceForMatch`'s coercion) so the
          // full-string matcher locks on the same string. The LABEL
          // shows each element individually, relativized for path mode.
          if (!Array.isArray(raw)) continue
          const elements = raw.filter((v): v is string => typeof v === "string" && v.length > 0)
          if (elements.length === 0) continue
          fields[field] = [elements.join(" ")]
          const rendered = elements.map((e) => (isPathMode ? formatPathForDisplay(e, cwd) : formatValue(e))).join(", ")
          labelParts.push(`${aspectName}[]: ${rendered}`)
        } else {
          // Scalar-mode binding: coerce to a single string. The
          // persisted rule stores the coerced form (kept absolute for
          // path mode — the tool-rule matcher compares it via
          // genericPatternToRegex against the raw input). The label
          // shows the same coerced form, relativized for path mode.
          let coerced: string | undefined
          try {
            coerced = coerceForMatch(raw)
          } catch {
            // Non-string / non-string[] value — the rule's
            // `fields` clause can't constrain on it. Skip.
            continue
          }
          if (!coerced || coerced.length === 0) continue
          fields[field] = [coerced]
          const labelValue = isPathMode ? formatPathForDisplay(coerced, cwd) : formatValue(coerced)
          labelParts.push(`${aspectName}: ${labelValue}`)
        }
      }
    }
    if (Object.keys(fields).length > 0) {
      entry.fields = fields
    }
    return { entry, label: labelParts.join("  ") }
  }

  // Fallback: no aspect metadata. Capture string / string[] fields
  // with their raw input keys. The label is `key: value` per field.
  const fields: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      if (value.length === 0) continue
      fields[key] = [value]
      labelParts.push(`${key}: ${formatValue(value)}`)
    } else if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) {
      const elements = value.filter((v) => v.length > 0)
      if (elements.length === 0) continue
      fields[key] = [elements.join(" ")]
      labelParts.push(`${key}: ${elements.map((e) => formatValue(e)).join(", ")}`)
    }
  }
  if (Object.keys(fields).length > 0) {
    entry.fields = fields
  }
  return { entry, label: labelParts.join("  ") }
}
