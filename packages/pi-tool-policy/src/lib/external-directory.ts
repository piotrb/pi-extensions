import { isAbsolute, relative, resolve } from "node:path"

export type ExternalDecision = "allow" | "deny"

interface ExternalEntry {
  decision: ExternalDecision
  /** Optional normalized path to use for the tool call. */
  normalizedPath?: string
}

/**
 * In-memory gate for tool argument paths that escape `ctx.cwd`.
 *
 * Phase 3's policy engine calls `shouldPrompt(path, cwd)` on every tool_call
 * with a `path`-aspect-bound field. The recorded-decision cache is consulted
 * in Phase 5 (and used by the TUI modal in Phase 6 to short-circuit the
 * prompt for already-approved paths).
 */
export class ExternalDirectoryState {
  private store = new Map<string, ExternalEntry>()

  /** True if the absolute path is outside `cwd` AND not pre-approved. */
  shouldPrompt(path: string, cwd: string): boolean {
    const abs = isAbsolute(path) ? path : resolve(cwd, path)
    if (this.isInside(abs, cwd)) return false
    return !this.store.has(abs)
  }

  /** Record a decision for a path. `normalizedPath` is the optional "customize the path" form. */
  record(path: string, decision: ExternalDecision, normalizedPath?: string): void {
    this.store.set(path, { decision, normalizedPath })
  }

  /** Retrieve a recorded decision (or undefined). */
  get(path: string): ExternalEntry | undefined {
    return this.store.get(path)
  }

  /** Reset all state. Called on session_start. */
  reset(): void {
    this.store.clear()
  }

  private isInside(abs: string, cwd: string): boolean {
    const rel = relative(cwd, abs)
    return !rel.startsWith("..") && !isAbsolute(rel)
  }
}
