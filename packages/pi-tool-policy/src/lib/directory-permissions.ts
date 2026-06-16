import { isAbsolute, relative, resolve } from "node:path"

import type { AllowedPath } from "./types.ts"

interface Grant {
  /** Required tags (empty = matches any tool). */
  tags: string[]
  /** Absolute path. */
  path: string
  /** True for the CWD auto-grant (resets on session_start, persists across calls). */
  isCwd: boolean
  /** True for non-persistent session grants (wiped on session_end). */
  persistent: boolean
}

export interface DirectoryGrantSnapshot {
  /** Required tags (empty = matches any tool). */
  tags: string[]
  /** Absolute path. */
  path: string
  /** True for the CWD auto-grant. */
  isCwd: boolean
  /** True for config/CWD grants; false for session-only modal grants. */
  persistent: boolean
}

/**
 * In-memory tag-aware state for the directory-permissions guardrail.
 *
 * Tracks session grants and computes whether a (path, effectiveTags) pair
 * is allowed. The CWD is auto-added at session_start with `tags: []`
 * (matches any tool).
 */
export class DirectoryPermissionsState {
  private store = new Map<string, Grant>()

  /** True if `absPath` is contained in `grantPath` (lexical containment, no realpath). */
  private static isInside(absPath: string, grantPath: string): boolean {
    const rel = relative(grantPath, absPath)
    return !rel.startsWith("..") && !isAbsolute(rel)
  }

  /** Public: check whether a path is already in the grant store. */
  has(path: string): boolean {
    return this.store.has(path)
  }

  /** Clear the in-memory state and re-add the CWD auto-grant. */
  reset(cwd: string): void {
    this.store.clear()
    const absCwd = resolve(cwd)
    this.store.set(absCwd, { tags: [], path: absCwd, isCwd: true, persistent: true })
  }

  /** True if any grant covers (absPath, effectiveTags). */
  matches(absPath: string, effectiveTags: string[]): boolean {
    for (const grant of this.store.values()) {
      if (DirectoryPermissionsState.isInside(absPath, grant.path)) {
        if (grant.tags.length === 0) return true
        if (grant.tags.every((t) => effectiveTags.includes(t))) return true
      }
    }
    return false
  }

  /**
   * Per-tag grant status for the (absPath, effectiveTags) pair.
   * Returns the subset of effectiveTags NOT yet covered by any grant for this path.
   */
  isGranted(absPath: string, effectiveTags: string[]): { granted: boolean; missingTags: string[] } {
    const coveredTags = new Set<string>()
    let anyGrantCovers = false
    for (const grant of this.store.values()) {
      if (!DirectoryPermissionsState.isInside(absPath, grant.path)) continue
      anyGrantCovers = true
      if (grant.tags.length === 0) {
        // allowAny: covers all tags.
        for (const t of effectiveTags) coveredTags.add(t)
      } else {
        for (const t of grant.tags) coveredTags.add(t)
      }
    }
    const missingTags = effectiveTags.filter((t) => !coveredTags.has(t))
    return { granted: anyGrantCovers && missingTags.length === 0, missingTags }
  }

  /** Add a grant. */
  record(absPath: string, tags: string[], opts: { allowAny?: boolean; persistent?: boolean } = {}): void {
    const grantTags = opts.allowAny ? [] : tags
    this.store.set(absPath, { tags: grantTags, path: absPath, isCwd: false, persistent: opts.persistent ?? true })
  }

  /** Dump the current grant store for diagnostics. */
  snapshot(): DirectoryGrantSnapshot[] {
    return [...this.store.values()].map((grant) => ({
      tags: [...grant.tags],
      path: grant.path,
      isCwd: grant.isCwd,
      persistent: grant.persistent,
    }))
  }
}

// ─── Guardrail layer (Phase 6) ─────────────────────────────────────────────────

/** Result returned by the directory-permissions modal. */
export interface GrantResult {
  decision: "allow" | "deny" | "custom"
  /** The original path. */
  path: string
  /** Tags granted (for "allow" / "custom"). Empty for "deny". */
  tags: string[]
  /** For "custom": the user-provided path. */
  customPath?: string
}

/** Args passed to the directory-permissions modal. */
export interface DirectoryPromptArgs {
  /** Absolute path the tool is trying to access. */
  path: string
  /** Current project directory, used to render a cwd-relative path for humans. */
  cwd: string
  effectiveTags: string[]
  grantedTags: string[]
}

/** The directory-permissions modal opener signature (consumed by the guardrail). */
export type OpenDirectoryModal = (args: DirectoryPromptArgs) => Promise<GrantResult | null>

/** Outcome of the directory-permissions guardrail. */
export interface CheckResult {
  allowed: boolean
  /** Set when the user denies or cancels. */
  denialReason?: string
}

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent"

import type { ResolvedToolMetadata } from "./types.ts"

/**
 * Wire the directory-permissions state and the modal into a guardrail function.
 *
 * Loops-internally-to-layer: for each ungranted path, opens the modal,
 * accumulates grants, re-checks. Multi-path tools iterate over all path fields.
 */
export async function checkAndPrompt(
  state: DirectoryPermissionsState,
  event: ToolCallEvent,
  toolMetadata: Map<string, ResolvedToolMetadata>,
  effectiveTags: string[],
  allowedPathsConfig: AllowedPath[],
  ctx: { cwd: string },
  openModal: OpenDirectoryModal,
): Promise<CheckResult> {
  // Merge config allowedPaths into state (project-relative already resolved
  // by the config loader).
  for (const entry of allowedPathsConfig) {
    if (!state.has(entry.path)) {
      state.record(entry.path, entry.tags, { allowAny: entry.tags.length === 0, persistent: true })
    }
  }

  const meta = toolMetadata.get(event.toolName)
  if (!meta) {
    return { allowed: true } // tools without metadata skip the guardrail
  }

  const args = event.input as Record<string, unknown>

  // Collect path-aspect-bound field names. Only `mode: "path"` aspects
  // apply to filesystem paths; URL/bash aspects don't, and glob/regex
  // are basename-only and are also skipped.
  const pathFields: string[] = []
  for (const decl of Object.values(meta.fields)) {
    if (decl.mode !== "path") continue
    for (const binding of decl.fields) {
      // AspectDeclaration.fields is `FieldBinding[]`; the field name is
      // the string or the `field` of the object form.
      const field = typeof binding === "string" ? binding : binding.field
      pathFields.push(field)
    }
  }

  // Collect all path-bound values (string or string[]).
  const absPaths: string[] = []
  for (const field of pathFields) {
    const value = args[field]
    if (typeof value === "string") {
      absPaths.push(isAbsolute(value) ? value : resolve(ctx.cwd, value))
    } else if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === "string") {
          absPaths.push(isAbsolute(v) ? v : resolve(ctx.cwd, v))
        }
      }
    }
  }

  for (const abs of absPaths) {
    let result = state.isGranted(abs, effectiveTags)
    while (!result.granted) {
      const modalResult = await openModal({
        path: abs,
        cwd: ctx.cwd,
        effectiveTags,
        grantedTags: effectiveTags.filter((t) => !result.missingTags.includes(t)),
      })
      if (!modalResult || modalResult.decision === "deny") {
        // Deny is non-persistent — don't record anything.
        return { allowed: false, denialReason: "Rejected by user: directory not allowed" }
      }
      if (modalResult.decision === "custom" && modalResult.customPath) {
        // Recurse: check the new custom path.
        const customAbs = isAbsolute(modalResult.customPath)
          ? modalResult.customPath
          : resolve(ctx.cwd, modalResult.customPath)
        // Also grant the ORIGINAL path with the same tags so the for-loop's
        // isGranted check passes when we re-evaluate it (per the bug fix:
        // the for-loop moves on after the while exits; without this record,
        // the original path was silently allowed despite only a sibling being
        // granted).
        state.record(abs, modalResult.tags, { persistent: false })
        state.record(customAbs, modalResult.tags, { persistent: false })
        result = state.isGranted(customAbs, effectiveTags)
        continue
      }
      // "allow" with the modal's tags.
      state.record(abs, modalResult.tags, { persistent: false })
      result = state.isGranted(abs, effectiveTags)
    }
  }

  return { allowed: true }
}
