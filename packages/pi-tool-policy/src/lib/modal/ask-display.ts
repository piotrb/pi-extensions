import { coerceForMatch } from "../policy.ts"
import type { AspectDeclaration, ResolvedToolMetadata } from "../types.ts"
import { fieldName, isArrayBinding } from "../types.ts"

/**
 * What the ask UI shows about a single tool call. A flat list of
 * `key: value` lines — no "primary target" callout, because every
 * aspect-decorated field (and every input field, when no aspects
 * are declared) is equally relevant to the user's decision.
 */
export interface AskDisplay {
  /** One line per field. Order: aspect-decorated first, then fallback scalars. */
  fieldLines: string[]
}

/** A field that, when present, is always listed in the display. */
interface DisplayField {
  /** The key to show (`aspectName` for decorated fields, `inputKey` for fallback). */
  key: string
  /** Pre-formatted display value. */
  value: string
}

/**
 * Build the per-call display data for the policy-ask UI. No "primary"
 * — all relevant fields are listed. For tools with `pi.toolMetadata`
 * aspects, we list each aspect with a non-empty value. For tools
 * WITHOUT aspects (or with empty aspects), we fall back to dumping
 * every scalar string-typed field in the input.
 *
 * Per-element vs joined semantics for `[]`-mode aspects:
 *   - `mode: "X"` (scalar): coerce to one string (`string[]` is
 *     joined with " "), emit one line.
 *   - `mode: "X[]"` (array): emit one line per element. Matches the
 *     matcher's per-element cardinality.
 */
export function buildAskDisplay(
  toolName: string,
  input: Record<string, unknown>,
  toolMeta: ResolvedToolMetadata | undefined,
): AskDisplay {
  void toolName
  const fields: DisplayField[] = []

  // 1. Aspect-decorated fields (in declaration order).
  if (toolMeta) {
    for (const [aspectName, decl] of Object.entries(toolMeta.fields)) {
      for (const value of readAspectValues(decl, input)) {
        fields.push({ key: aspectName, value: formatValue(value) })
      }
    }
  }

  // 2. Fallback: if no aspect fields produced any lines, dump scalar
  //    string-typed input fields. This handles custom tools with no
  //    `pi.toolMetadata` block — the user still sees the arguments.
  if (fields.length === 0) {
    for (const [key, value] of Object.entries(input)) {
      for (const v of scalarValues(value)) {
        fields.push({ key, value: formatValue(v) })
      }
    }
  }

  return { fieldLines: fields.map((f) => `${f.key}: ${f.value}`) }
}

/**
 * Read the values of an aspect's bound fields as an array of strings.
 * One string per non-empty element. For scalar-mode bindings the
 * returned array has length 0 or 1 (the coerced value, if any).
 * For array-mode bindings it has one entry per input element.
 */
function readAspectValues(decl: AspectDeclaration, input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const binding of decl.fields) {
    const field = fieldName(binding)
    const raw = input[field]
    if (raw === undefined || raw === null) continue

    if (isArrayBinding(binding)) {
      // Array-mode binding: the value MUST be a string[]; anything else
      // is a schema violation, skip.
      if (!Array.isArray(raw)) continue
      for (const element of raw) {
        if (typeof element !== "string") continue
        if (element.length === 0) continue
        out.push(element)
      }
      continue
    }

    // Scalar-mode binding: coerce (joins string[] with " ").
    const coerced = coerceForMatch(raw)
    if (coerced && coerced.length > 0) out.push(coerced)
  }
  return out
}

/**
 * Extract scalar string values from an input field for the fallback
 * case (no aspects declared). Mirrors `readAspectValues` for the
 * no-aspect path: string passes through, string[] is iterated as
 * one value per element, anything else is skipped.
 */
function scalarValues(value: unknown): string[] {
  if (typeof value === "string") return value.length > 0 ? [value] : []
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.length > 0)
  }
  return []
}

/**
 * Format a scalar value for human-readable display — a hybrid of JSON,
 * YAML, and TOML (per the project's "humanized JSON" convention).
 *
 *   - Keys are NOT quoted (the caller already adds the `key:` prefix).
 *   - Values are NOT quoted when they're simple (no whitespace, no
 *     quotes, no control characters).
 *   - Values with spaces/tabs/newlines/quote chars ARE quoted, with
 *     embedded quotes backslash-escaped and control chars escaped
 *     as `\n` / `\t` etc.
 *   - Long values are truncated with `…` to keep the title readable.
 */
export function formatValue(value: string): string {
  if (value.length > 80) {
    return formatValue(`${value.slice(0, 77)}…`)
  }
  if (needsQuoting(value)) {
    return `"${escapeQuoted(value)}"`
  }
  return value
}

function needsQuoting(value: string): boolean {
  if (value.length === 0) return true
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x20) return true // control chars (newlines, tabs, etc.)
    if (c === 0x22 /* " */ || c === 0x5c /* \ */) return true
  }
  return /\s/.test(value)
}

function escapeQuoted(value: string): string {
  let out = ""
  // C-style for — `for-of` iterates code POINTS, we want code UNITS to
  // escape each UTF-16 chunk independently. The non-null assertion is
  // the lint-preferred style for "indexed access is in bounds".
  // eslint-disable-next-line @typescript-eslint/prefer-for-of
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!
    if (c === "\\") out += "\\\\"
    else if (c === '"') out += '\\"'
    else if (c === "\n") out += "\\n"
    else if (c === "\r") out += "\\r"
    else if (c === "\t") out += "\\t"
    else if (c.charCodeAt(0) < 0x20) out += `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
    else out += c
  }
  return out
}
