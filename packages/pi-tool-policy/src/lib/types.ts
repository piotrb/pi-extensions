// ─── core enums ───────────────────────────────────────────────────────────────

export type Verdict = "allow" | "ask" | "deny"
export type Persistence = "once" | "session" | "project" | "user"
export type Scope = "project" | "user"

/** Aspect mode — determines how string[] args are handled. */
export type AspectMode = "generic" | "bash"

// ─── aspect definitions ───────────────────────────────────────────────────────

/** A named pattern space (e.g. "path", "url", "bash_cmd"). */
export interface AspectDefinition {
	/** Pattern syntax mode. Default: "generic". Bash mode has trailing-` *` word-boundary. */
	mode?: AspectMode
	/** Pattern → verdict map. LAST MATCH WINS. */
	patterns: Record<string, Verdict>
}

// ─── tool-level definitions ───────────────────────────────────────────────────

/** A tool's surface. Either a single verdict or a per-pattern map. */
export type ToolDefinition = Verdict | Record<string, Verdict>

/** Per-tool group verdicts (e.g. "readonly": "allow"). */
export type GroupVerdict = Verdict

/** Field binding: a tool's root key is matched against an aspect. */
export interface FieldBinding {
	/** The aspect name to match against. Required. */
	aspect: string
	/** How to coerce the value. Default: auto-detect from TypeBox schema. */
	format?: "scalar" | "array" | "string[]"
}

/** A root key can have one binding or many. Multiple bindings produce multiple per-field verdicts, combined via the lattice. */
export type FieldBindings = Record<string, FieldBinding | FieldBinding[]>

/** Per-tool metadata: group memberships + field bindings. */
export interface ToolMetadata {
	/** Groups this tool belongs to (open-ended taxonomy; user-defined). */
	groups?: string[]
	/** Field bindings: which root keys are matched against which aspects. A key can have one or many bindings. */
	fields?: FieldBindings
}

// ─── top-level config ─────────────────────────────────────────────────────────

/** The flat config shape — the file is `tool-policy.json`, no `permission` wrapper. */
export interface Config {
	/** Fall-through verdict when no tool/group/aspect matches. Default: "ask". */
	defaultDecision?: Verdict
	/** Aspect definitions: named pattern spaces applied to tool args. */
	aspects?: Record<string, AspectDefinition>
	/** Group verdicts: per-group verdicts (e.g. "readonly": "allow"). */
	groupVerdicts?: Record<string, GroupVerdict>
	/** Per-tool verdicts or per-tool pattern maps. */
	tools?: Record<string, ToolDefinition>
	/** Per-tool metadata (groups + field bindings). */
	metadata?: Record<string, ToolMetadata>
}

// ─── runtime state ────────────────────────────────────────────────────────────

/** What the matcher produces per field binding. */
export interface FieldVerdict {
	tool: string
	field: string
	aspect: string
	matched?: string
	verdict: Verdict
}

/** The full policy decision for a single tool_call. */
export type PolicyDecision =
	| { action: "allow" }
	| { action: "deny"; reason: string; blockingRules: BlockingRule[] }
	| { action: "ask"; reason: string; blockingRules: BlockingRule[] }

export interface BlockingRule {
	layer: "tool" | "group" | "aspect" | "externalDirectory"
	key: string
	aspect?: string
	pattern?: string
}

// ─── tool-metadata registry (assembled at session_start) ─────────────────────

/** The merged tool-metadata for a single tool (built-in + package.json + user overrides). */
export interface ResolvedToolMetadata {
	groups: string[]
	fields: FieldBindings
}
