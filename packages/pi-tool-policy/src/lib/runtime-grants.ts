import type { Mode, ToolRuleEntry } from "./types.ts"

/**
 * A runtime grant keyed by `(modeName, toolName, fields)`. The `fields`
 * clause is the OPTIONAL fields clause the user saw on the ask modal. If
 * present, the grant only matches tool calls whose `event.input` contains
 * the same key=value pairs (string equality). If absent, the grant matches
 * every call to that tool (the "broad" allow).
 */
export interface RuntimeGrant {
  modeName: string
  toolName: string
  /** Optional fields clause. When present, the input must match all entries. */
  fields?: Record<string, string>
}

/**
 * In-memory runtime grants per active mode. Mutated by the "allow for session"
 * option in the policy-ask modal. Cleared on `session_start` via `clear()`.
 *
 * The config-on-disk grants ("allow for this user/project") are written via
 * the permission-config writer; this class only tracks the in-memory layer.
 */
export class RuntimeGrants {
  private grants: RuntimeGrant[] = []

  clear(): void {
    this.grants = []
  }

  /** Record a runtime grant. */
  grant(grant: RuntimeGrant): void {
    this.grants.push(grant)
  }

  /**
   * Check if a tool call is granted by any runtime grant for the active mode.
   * `args` is the raw `event.input`. Returns true if a matching grant exists.
   */
  isGranted(modeName: string, toolName: string, args: Record<string, unknown> | undefined): boolean {
    for (const g of this.grants) {
      if (g.modeName !== modeName) continue
      if (g.toolName !== toolName) continue
      if (!g.fields) return true // broad grant
      if (!args) continue
      // All fields must match (string equality).
      let ok = true
      for (const [k, v] of Object.entries(g.fields)) {
        const actual = args[k]
        if (typeof actual !== "string" || actual !== v) {
          ok = false
          break
        }
      }
      if (ok) return true
    }
    return false
  }

  /**
   * Apply the grants to a mode's `toolRules` for the matcher. Each grant
   * becomes a `ToolRuleEntry` with the appropriate `fields` clause. The
   * result is a NEW mode object (does not mutate the input or the grant
   * state).
   */
  applyFor(modeName: string, mode: Mode): Mode {
    const matching = this.grants.filter((g) => g.modeName === modeName)
    if (matching.length === 0) return mode
    const newToolRules: Record<string, ToolRuleEntry[]> = { ...mode.toolRules }
    for (const g of matching) {
      // Wrap each value in a single-element array (the matcher OR-s within
      // a key). For a single-value session grant, that's [v].
      const fields = g.fields
        ? (Object.fromEntries(Object.entries(g.fields).map(([k, v]) => [k, [v]])) as Record<string, string[]>)
        : undefined
      const entry: ToolRuleEntry = fields ? { fields, verdict: "allow" } : { verdict: "allow" }
      newToolRules[g.toolName] = [...(newToolRules[g.toolName] ?? []), entry]
    }
    return { ...mode, toolRules: newToolRules }
  }
}
