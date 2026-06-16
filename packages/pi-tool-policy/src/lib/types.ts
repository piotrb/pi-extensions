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

/** A tool's aspect declaration: which fields are bound to which matcher mode. */
export interface AspectDeclaration {
  /**
   * The aspect's pattern-matching mode. A `[]` suffix (e.g. `"path[]"`)
   * marks the aspect as array-mode: the matcher iterates each element
   * of the input value as its own match unit and combines the results
   * deny > ask > allow. Without the suffix, the matcher treats the
   * value (after coercion) as a single string to match.
   */
  mode: "path" | "path[]" | "url" | "url[]" | "bash" | "bash[]" | "glob" | "glob[]" | "regex" | "regex[]"
  /**
   * Root keys on the tool's input that are matched against this aspect.
   * The matcher coerces values via `coerceForMatch`: strings pass through
   * unchanged, `string[]` is joined with " " (for scalar-mode aspects)
   * or iterated per element (for `[]`-mode aspects).
   */
  fields: string[]
}

/** True if the mode suffix is `[]` (array mode). */
export function isArrayMode(mode: AspectDeclaration["mode"]): boolean {
  return mode.endsWith("[]")
}

/** Strip the `[]` suffix to get the base mode. */
export function baseMode(mode: AspectDeclaration["mode"]): "path" | "url" | "bash" | "glob" | "regex" {
  return mode.slice(0, -2) as "path" | "url" | "bash" | "glob" | "regex"
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

/** Status of a single rule in the per-mode matcher trail. */
export type RuleStatus = "applied" | "suppressed" | "noop"

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
  /** applied = winner (or contributed to the winner), suppressed = less restrictive, noop = same value. */
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
