/**
 * permissions — pattern-based rule matching with three verdict levels.
 *
 * Pattern syntax mirrors Claude Code's Bash permission syntax:
 *   No wildcard     — exact match against the command string
 *   Trailing ' *'   — prefix match with word boundary (space or end-of-string)
 *   Trailing ':*'   — identical to trailing ' *'
 *   '*' elsewhere   — glob-style: * matches any sequence including spaces
 *   Standalone '*'  — matches everything
 *
 * Resolution — when multiple rules match a command, the most specific wins.
 * Specificity is the number of non-wildcard characters in the pattern.
 * Ties are broken by scope: project > user > global.
 */

// ─── types ────────────────────────────────────────────────────────────────────

export type RuleLevel = "allow" | "ask" | "deny"
export type RuleScope = "project" | "user" | "global"

export interface Rule {
  pattern: string
  level: RuleLevel
  scope: RuleScope
}

// ─── scope priority ───────────────────────────────────────────────────────────

const SCOPE_PRIORITY: Record<RuleScope, number> = {
  project: 2,
  user: 1,
  global: 0,
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

// ─── specificity ──────────────────────────────────────────────────────────────

/**
 * Count the non-wildcard characters in a pattern.
 * Higher = more specific.
 */
export function specificity(pattern: string): number {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread
  return [...pattern].filter((c) => c !== "*").length
}

// ─── checkRules ───────────────────────────────────────────────────────────────

/**
 * Test a command against an ordered set of rules.
 *
 * The most specific matching rule wins (highest non-wildcard character count).
 * Ties are broken by scope: project > user > global.
 * Returns "undecided" if no rule matches.
 */
export function checkRules(cmd: string[], rules: Rule[]): RuleLevel | "undecided" {
  const cmdStr = cmd.join(" ")
  let best: Rule | null = null
  let bestSpec = -1
  let bestScopePriority = -1

  for (const rule of rules) {
    if (!patternToRegex(rule.pattern).test(cmdStr)) continue

    const spec = specificity(rule.pattern)
    const scopePri = SCOPE_PRIORITY[rule.scope]

    if (spec > bestSpec || (spec === bestSpec && scopePri > bestScopePriority)) {
      best = rule
      bestSpec = spec
      bestScopePriority = scopePri
    }
  }

  return best ? best.level : "undecided"
}
