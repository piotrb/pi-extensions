/**
 * permissions — pattern-based rule matching with three verdict levels.
 *
 * Pattern syntax mirrors Claude Code's Bash permission syntax:
 *   No wildcard     — exact match against the command string
 *   Trailing ' *'   — prefix match with word boundary (space or end-of-string)
 *   Trailing ':*'  — identical to trailing ' *'
 *   '*' elsewhere  — glob-style: * matches any sequence including spaces
 *   Standalone '*'  — matches everything
 *
 * Resolution — when multiple rules match a command, the most specific wins.
 * Specificity is the number of non-wildcard characters in the pattern.
 * Ties are broken by scope: project > user > global.
 */

import { bashPatternToRegex, specificity } from "@piotrb/pi-extension-utils"

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
    if (!bashPatternToRegex(rule.pattern).test(cmdStr)) continue

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
