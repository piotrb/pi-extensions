/**
 * permissions — pattern-based allow/deny rule matching.
 *
 * Pattern syntax mirrors Claude Code's Bash permission syntax:
 *   No wildcard     — exact match against the command string
 *   Trailing ' *'   — prefix match with word boundary (space or end-of-string)
 *   Trailing ':*'   — identical to trailing ' *'
 *   '*' elsewhere   — glob-style: * matches any sequence including spaces
 *   Standalone '*'  — matches everything
 */

// ─── types ────────────────────────────────────────────────────────────────────

export interface PermissionSet {
  allow: string[]
  deny: string[]
}

// ─── patternToRegex ───────────────────────────────────────────────────────────

/**
 * Compile a permission pattern string to a RegExp.
 */
export function patternToRegex(pattern: string): RegExp {
  const escLit = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")

  // Normalise :* suffix → trailing ' *'
  const p = pattern.endsWith(":*") ? pattern.slice(0, -2) + " *" : pattern

  if (p === "*") return /^[\s\S]*$/

  const parts = p.split("*")

  if (parts.length === 1) {
    return new RegExp("^" + escLit(p) + "$")
  }

  const isTrailingSpaceStar = p.endsWith(" *")

  if (isTrailingSpaceStar && parts.length === 2) {
    // Simple prefix wildcard: enforce word boundary after prefix
    const prefix = p.slice(0, -2)
    return new RegExp("^" + escLit(prefix) + "( [\\s\\S]*)?$")
  }

  // General case: each * becomes [\s\S]* (spans spaces and words).
  // For a trailing ' *', apply the word-boundary treatment to the last wildcard.
  const segments = parts.map((seg, i) => {
    const escaped = escLit(seg)
    const isLast = i === parts.length - 1
    if (isLast) return escaped
    const isSemiLast = i === parts.length - 2
    if (isSemiLast && isTrailingSpaceStar) {
      return escaped.replace(/ $/, "") + "( [\\s\\S]*)?$"
    }
    return escaped + "[\\s\\S]*"
  })

  const regexStr = isTrailingSpaceStar ? "^" + segments.slice(0, -1).join("") : "^" + segments.join("") + "$"

  return new RegExp(regexStr)
}

// ─── check ────────────────────────────────────────────────────────────────────

/**
 * Test a command against a PermissionSet.
 *
 * Evaluation order: deny → allow → undecided.
 * Deny rules always win over allow rules.
 */
export function check(cmd: string[], set: PermissionSet): "allow" | "deny" | "undecided" {
  const cmdStr = cmd.join(" ")
  if (set.deny.some((p) => patternToRegex(p).test(cmdStr))) return "deny"
  if (set.allow.some((p) => patternToRegex(p).test(cmdStr))) return "allow"
  return "undecided"
}
