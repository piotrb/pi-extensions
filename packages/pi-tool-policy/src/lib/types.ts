// ─── core enums ───────────────────────────────────────────────────────────────

export type Verdict = "allow" | "ask" | "deny"

// ─── verdict shapes ───────────────────────────────────────────────────────────

/** A bare verdict (sugar) or a RuleEntry with optional reason. */
export type AnyVerdict = Verdict | RuleEntry

export interface RuleEntry {
  verdict: Verdict
  reason?: string
}

// ─── aspect definitions ───────────────────────────────────────────────────────

export type AspectMode = "generic" | "bash"

/** A named pattern space (e.g. "path", "url", "bash_cmd"). */
export interface AspectRule {
  /** Pattern syntax mode. Default: "generic". Bash mode has trailing-` *` word-boundary. */
  mode?: AspectMode
  /** Pattern → verdict map. LAST MATCH WINS. Values are AnyVerdict. */
  patterns: Record<string, AnyVerdict>
}

// ─── mode definitions ─────────────────────────────────────────────────────────

/** System-prompt prose injection configuration. */
export interface AdditionalInstructions {
  /** append concatenates after the existing systemPrompt; replace uses only the user's text. */
  mode: "append" | "replace"
  /** Prose, may be a string or a list of lines. */
  text: string | string[]
}

/** The reserved name for the emergency-off "YOLO" mode. The extension
 * injects this mode into every loaded Config; it is not a user-configurable
 * mode. When active, the policy match is skipped entirely (the extension
 * becomes a no-op on tool_call), so the user can recover from a bug
 * (or a malformed config) without reloading the session. */
export const YOLO_MODE = "__yolo__"

/**
 * The mode-cycle hotkey in three forms. All three are derived from one
 * binding (`Key.alt("m")`) so a change here propagates to:
 *   - the runtime registration in `extensions/tool-policy.ts`
 *   - the status bar text in `mode-controller.ts`
 *   - the default-config user-facing comment in `permission-config.ts`
 *   - the tests that assert the status bar format
 *
 * `HOTKEY_CYCLE_MODE_KEY` is the `KeyId` string for `registerShortcut`.
 * `HOTKEY_CYCLE_MODE_LABEL` is the human-readable form shown to the user.
 */
export const HOTKEY_CYCLE_MODE_KEY = "alt+m" as const
export const HOTKEY_CYCLE_MODE_LABEL = "Alt+M" as const

/** A single per-tool rule entry. */
export interface ToolRuleEntry {
  /** Optional. If absent, the entry always matches. Patterns are OR-ed within a key. */
  fields?: Record<string, string[]>
  /** The verdict (with optional reason). */
  verdict: AnyVerdict
}

export interface Mode {
  /** Human description; shown in /tool_policy modal. */
  description: string
  /** Parent modes to deep-merge from. Cycles rejected at config-load. */
  extends?: string[]
  /** Final fall-through verdict when no rule in this mode matches. */
  defaultDecision: AnyVerdict
  /** Per-tag verdicts — evaluated in the same pass as aspectRules and toolRules. */
  tagRules: Record<string, AnyVerdict>
  /** Per-tool rule entries (each entry has an optional fields clause and a verdict). */
  toolRules: Record<string, ToolRuleEntry[]>
  /** Aspect rules. Each aspect's patterns use that aspect's matcher mode. */
  aspectRules: Record<string, AspectRule>
  /** Optional system-prompt prose injected when this mode is active. */
  additionalInstructions?: AdditionalInstructions
}

// ─── top-level config ─────────────────────────────────────────────────────────

/** A pre-approved path for the directory-permissions guardrail. */
export interface AllowedPath {
  /** Required tags. The tool's effective tag set must include ALL of these. */
  tags: string[]
  /** Absolute (user-level) or cwd-relative (project-level) path. */
  path: string
}

/** A tagger rule — augments the effective tag set at tool_call time. */
export interface TaggerRule {
  /** Tool-name pattern (glob, picomatch). e.g. "git_*". */
  tool: string
  /** Root key → patterns. AND-ed across keys. OR-ed within a key. */
  fields?: Record<string, string[]>
  /** Aspect name → patterns. AND-ed across aspects. OR-ed within an aspect. */
  aspects?: Record<string, string[]>
  /** Action block. addTags is the first/only action type. */
  action: TaggerAction
}

export type TaggerAction = AddTagsAction

export interface AddTagsAction {
  type: "addTags"
  tags: string[]
}

/**
 * A single field binding inside an `AspectDeclaration.fields` array.
 * A bare string is shorthand for `{ field: <name>, mode: "scalar" }` —
 * the most common case (most tool input fields are single strings).
 * The object form opts in to array-mode per-field iteration.
 */
export type FieldBinding = string | { field: string; mode?: "scalar" | "array" }

/** True if the field binding is array-mode (per-element combine). */
export function isArrayBinding(binding: FieldBinding): boolean {
  return typeof binding !== "string" && binding.mode === "array"
}

/** Extract the field name from a binding (string or object). */
export function fieldName(binding: FieldBinding): string {
  return typeof binding === "string" ? binding : binding.field
}

/** The base mode names available for `AspectDeclaration.mode`. */
export type BaseAspectMode = "path" | "url" | "bash" | "glob" | "regex"

/** A tool's aspect declaration: which fields are bound to which matcher mode. */
export interface AspectDeclaration {
  /**
   * The aspect's pattern-matching mode. Cardinality is per-field (see
   * `FieldBinding`); the aspect's `mode` only identifies the matcher
   * semantics (path-glob, URL-host, bash-word, basename-glob, regex).
   */
  mode: BaseAspectMode
  /**
   * The fields on the tool's input bound to this aspect. Each entry
   * is either a bare string (scalar cardinality) or an object opting
   * in to array cardinality for that field. Array-mode fields are
   * matched element-by-element and combined deny > ask > allow.
   */
  fields: FieldBinding[]
}

/** Tool metadata: structural layer (static tags + aspect declarations). */
export interface ToolMetadata {
  /** Static base tags. */
  tags?: string[]
  /** Aspect declarations for this tool. */
  aspects: Record<string, AspectDeclaration>
}

/** The top-level Config — the file is `tool-policy.json`. */
export interface Config {
  /** Ordered list of mode names; sets cycle order and modal display order. */
  modeOrder: string[]
  /** Mode blocks keyed by name. Built-in: default, plan, edit. */
  modes: Record<string, Mode>
  /** Top-level allowedPaths (the directory-permissions guardrail). NOT modal. */
  allowedPaths: AllowedPath[]
  /** Global tagger rules. Re-evaluated per tool_call. */
  taggingRules: TaggerRule[]
  /** Tool metadata overrides (cached for session, rebuilt on session_start). */
  toolMetadata: Record<string, ToolMetadata>
}

// ─── runtime state ────────────────────────────────────────────────────────────

/** The merged tool-metadata for a single tool (built-in + package.json + user overrides). */
export interface ResolvedToolMetadata {
  tags: string[]
  /** Aspect declarations keyed by aspect name. */
  fields: Record<string, AspectDeclaration>
}

/**
 * Status of a single rule in the per-mode matcher trail.
 *
 * Per-layer combine (see `src/lib/policy.ts`): the matcher first
 * computes the most-restrictive verdict within each layer
 * (aspect / tool / tag / default), then picks the most-specific
 * layer's verdict as the global winner. `deny` is sticky — if any
 * layer produces `deny`, the global verdict is `deny`.
 *
 * - `applied` — this rule's verdict is the layer winner AND the
 *   layer's verdict is the global winner. At most one rule per
 *   call has this status.
 * - `shadowed` — this rule's verdict was less restrictive than
 *   the layer winner (e.g. a `tag:execution: allow` shadowed by
 *   a `tag:execution: ask` from the same layer, or a `tag:execution:
 *   ask` shadowed by a more-specific `aspect: allow` from the
 *   aspect layer). The user sees this in the trail as debug
 *   context, not as a contributing rule.
 * - `noop` — this rule's verdict matched the layer winner exactly
 *   (e.g. two `tag:readonly: ask` rules where the second is noop
 *   relative to the first). The verdict is recorded for
 *   completeness; it does not change the winner.
 */
export type RuleStatus = "applied" | "shadowed" | "noop"

/** One rule's contribution to the per-mode fold. */
export interface RuleResult {
  /** Source layer. */
  layer: "tag" | "aspect" | "tool" | "default"
  /** The tag/aspect/tool key (or "<default>"). */
  key: string
  /** For aspect layer: which aspect fired. */
  aspect?: string
  /** The pattern that matched (for aspect layer). */
  pattern?: string
  /** The verdict this rule produced. */
  verdict: Verdict
  /** Optional reason carried by the rule. */
  reason?: string
  /**
   * applied = this rule's verdict is the layer winner AND the layer's
   * verdict is the global winner. shadowed = less restrictive than the
   * layer winner (a different rule in the same layer is more
   * restrictive, or a more-specific layer produced a verdict that
   * beats this one). noop = same value as the layer winner (recorded
   * for completeness; does not change the winner).
   */
  status: RuleStatus
}

/** The full policy decision for a single tool_call. */
export interface PolicyDecision {
  action: "allow" | "deny" | "ask"
  reason?: string
  ruleTrail: RuleResult[]
  /** Effective tag set at evaluation time (static + dynamic). */
  effectiveTags: string[]
  /** True if the decision was modified by the directory-permissions guardrail. */
  directoryGuardrailFired: boolean
}
