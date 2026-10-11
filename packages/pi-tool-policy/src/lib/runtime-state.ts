import { isAbsolute, relative } from "node:path"

import type { AllowedPath, Config, Mode, ToolRuleEntry } from "./types.ts"

/**
 * SessionEvent: a single timeline entry under `customType:
 * "pi-tool-policy-runtime"`. Three event kinds cover the in-memory
 * mutations the extension makes within a session:
 *
 * - `setMode`: the user cycled to a different mode (Alt+M or
 *   `/tool_policy`).
 * - `addSessionAllowedPath`: the directory modal recorded a
 *   session-scoped grant for a path.
 * - `addRuntimeGrant`: the policy-ask modal recorded an
 *   "allow for this session" tool grant.
 *
 * The runtime never reads the timeline at runtime; events are
 * read once at `session_start` to rebuild `RuntimeState`.
 */
export type SessionEvent =
  | { type: "setMode"; modeName: string; timestamp?: string }
  | {
      type: "addSessionAllowedPath"
      entry: AllowedPath
      timestamp?: string
    }
  | {
      type: "addRuntimeGrant"
      grant: RuntimeGrantPayload
      timestamp?: string
    }

/** Runtime grant payload — same shape as the old `RuntimeGrant`. */
export interface RuntimeGrantPayload {
  modeName: string
  toolName: string
  fields?: Record<string, string>
}

/** Discriminator constant for the timeline customType. */
export const RUNTIME_CUSTOM_TYPE = "pi-tool-policy-runtime"

export type SessionEventTimeline = readonly SessionEvent[]

/** Append-callback signature: write a `CustomEntry` to the timeline. */
export type AppendEntryFn = (customType: string, data: unknown) => void

/** Default no-op append-callback used in tests that don't care
 * about timeline writes. */
const noopAppend: AppendEntryFn = (_customType, _data) => {
  // Default `RuntimeState.fromTimeline` doesn't write to the timeline
  // — tests that don't care about the timeline writes leave this in
  // place. Production callers inject a real append-callback that
  // calls `pi.appendEntry(RUNTIME_CUSTOM_TYPE, data)`.
}

/**
 * The in-memory state class for `pi-tool-policy`. Built once at
 * `session_start` from the timeline (so persisted session events
 * survive reload). Reads expose the current state; writes update
 * the in-memory state AND append to the timeline (via the
 * injected append-callback), so a future reload replays them.
 */
export class RuntimeState {
  private _currentModeName: string
  private _sessionAllowedPaths: AllowedPath[]
  private _runtimeGrants: RuntimeGrantPayload[]
  private _appendEntry: AppendEntryFn
  private _config: Config

  private constructor(
    initialModeName: string,
    sessionAllowedPaths: AllowedPath[],
    runtimeGrants: RuntimeGrantPayload[],
    appendEntry: AppendEntryFn,
    config: Config,
  ) {
    this._currentModeName = initialModeName
    this._sessionAllowedPaths = sessionAllowedPaths
    this._runtimeGrants = runtimeGrants
    this._appendEntry = appendEntry
    this._config = config
  }

  /**
   * Rebuild the in-memory state from a session-start timeline of
   * session events. The `config` provides the initial mode name
   * (its `modeOrder[0]`) when the timeline contains no `setMode`
   * event.
   *
   * The append-callback defaults to a no-op (used in tests);
   * production callers (the handler) inject one that calls
   * `pi.appendEntry(RUNTIME_CUSTOM_TYPE, data)`.
   */
  static fromTimeline(
    timeline: SessionEventTimeline,
    config: Config,
    _cwd: string,
    appendEntry: AppendEntryFn = noopAppend,
  ): RuntimeState {
    const initialModeName = config.modeOrder[0] ?? "default"
    const sessionAllowedPaths: AllowedPath[] = []
    const runtimeGrants: RuntimeGrantPayload[] = []
    let currentModeName = initialModeName

    for (const event of timeline) {
      switch (event.type) {
        case "setMode":
          currentModeName = event.modeName
          break
        case "addSessionAllowedPath":
          sessionAllowedPaths.push(event.entry)
          break
        case "addRuntimeGrant":
          runtimeGrants.push(event.grant)
          break
      }
    }

    return new RuntimeState(currentModeName, sessionAllowedPaths, runtimeGrants, appendEntry, config)
  }

  /**
   * Read: the active mode name. */
  currentModeName(): string {
    return this._currentModeName
  }

  /**
   * Project this runtime state as a session-layer `Config`.
   *
   * The session contributes two pieces of state to the merged
   * config:
   *
   * - `modeOrder`: a single-entry array with the active mode name.
   *   When `composeConfig` folds this onto the stock/user/project
   *   order, dedup-with-first-occurrence keeps the active mode in
   *   its stock position (or appends it at the end if the session
   *   introduced a brand-new mode). The active-mode pointer is read
   *   from `RuntimeState.currentModeName()`; `modeOrder` only
   *   describes the cycle.
   * - `allowedPaths`: a copy of `sessionAllowedPaths()` — the
   *   set of paths the directory modal granted this session.
   *   Merged via concat onto the loaded config's allowed paths.
   *
   * Every other field is the session's no-op contribution:
   * `modes: {}`, `taggingRules: []`, `toolMetadata: {}`. The
   * session doesn't author modes, tagger rules, or tool
   * metadata — those come from the on-disk config only.
   *
   * This shape is a valid `Config` (every required field
   * present). Pass it to `composeConfig(loaded.config,
   * runtimeState.asSessionLayer())` to fold the session's
   * overrides into the matched config.
   */
  asSessionLayer(): Config {
    return {
      modeOrder: [this._currentModeName],
      allowedPaths: [...this._sessionAllowedPaths],
      modes: {},
      taggingRules: [],
      toolMetadata: {},
    }
  }

  /** Read: a copy of the granted session paths. */
  sessionAllowedPaths(): AllowedPath[] {
    return [...this._sessionAllowedPaths]
  }

  /** Read: a copy of the runtime grants. */
  runtimeGrants(): RuntimeGrantPayload[] {
    return [...this._runtimeGrants]
  }

  /**
   * Read: the union of tags from session-allowed-path entries.
   * The directory guardrail augments the per-call `effectiveTags`
   * (built from static + tagger rules) with these session tags.
   */
  effectiveTags(): string[] {
    const tags = new Set<string>()
    for (const entry of this._sessionAllowedPaths) {
      for (const t of entry.tags) tags.add(t)
    }
    return [...tags]
  }

  /**
   * Apply runtime grants to a `Mode`'s `toolRules` for the matcher.
   * Each grant becomes a `ToolRuleEntry`. Returns a NEW mode object;
   * never mutates the input. Replaces the old `RuntimeGrants.applyFor`.
   */
  applyGrantsFor(modeName: string, mode: Mode): Mode {
    const matching = this._runtimeGrants.filter((g) => g.modeName === modeName)
    if (matching.length === 0) return mode
    const newToolRules: Record<string, ToolRuleEntry[]> = { ...mode.toolRules }
    for (const g of matching) {
      const fields = g.fields
        ? (Object.fromEntries(Object.entries(g.fields).map(([k, v]) => [k, [v]])) as Record<string, string[]>)
        : undefined
      const entry: ToolRuleEntry = fields ? { fields, verdict: "allow" } : { verdict: "allow" }
      newToolRules[g.toolName] = [...(newToolRules[g.toolName] ?? []), entry]
    }
    return { ...mode, toolRules: newToolRules }
  }

  /**
   * Write: set the active mode. Updates in-memory state AND
   * appends a `setMode` event to the timeline via the callback.
   * No-op when the mode is not in the config (avoids spurious
   * events for stale UI clicks).
   */
  setMode(modeName: string): void {
    if (!(modeName in this._config.modes)) return
    this._currentModeName = modeName
    this._appendEntry(RUNTIME_CUSTOM_TYPE, {
      type: "setMode",
      modeName,
      timestamp: new Date().toISOString(),
    })
  }

  /** Write: record a session-scoped allowed path. */
  addSessionAllowedPath(entry: AllowedPath): void {
    this._sessionAllowedPaths.push(entry)
    this._appendEntry(RUNTIME_CUSTOM_TYPE, {
      type: "addSessionAllowedPath",
      entry,
      timestamp: new Date().toISOString(),
    })
  }

  /** Write: record a runtime grant. */
  addRuntimeGrant(grant: RuntimeGrantPayload): void {
    this._runtimeGrants.push(grant)
    this._appendEntry(RUNTIME_CUSTOM_TYPE, {
      type: "addRuntimeGrant",
      grant,
      timestamp: new Date().toISOString(),
    })
  }

  // ─── Session-level directory guardrail helpers ──────────────────

  /**
   * Check if a path is granted by any session-allowed-path entry.
   * Pure: reads the in-memory store; does NOT trigger a modal.
   *
   * Semantics: an entry with `tags: []` covers any tag set; an
   * entry with non-empty `tags` covers only matching effective
   * tags (all of the entry's tags must appear in the request's
   * effective tags). A path is "covered" by an entry when the
   * request's path is inside the entry's path (lexical
   * containment, no realpath) — the same shape `isPathAllowed`
   * (Unit 3) uses.
   */
  isPathGranted(absPath: string, effectiveTags: string[]): boolean {
    for (const entry of this._sessionAllowedPaths) {
      if (!isPathInside(absPath, entry.path)) continue
      if (entry.tags.length === 0) return true
      if (entry.tags.every((t) => effectiveTags.includes(t))) return true
    }
    return false
  }
}

/** Lexical containment (no realpath): is `absPath` inside `root`? */
function isPathInside(absPath: string, root: string): boolean {
  if (root === "" || root === "/") return true
  const rel = relative(root, absPath)
  return !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * Project the timeline's session events back into a `Partial<Config>`
 * for `composeConfig` (Unit 6) to layer on top of the on-disk
 * config. Pure: reads the timeline; does NOT touch it.
 *
 * NOTE: As of Unit 6, the canonical accessor is
 * `RuntimeState.asSessionLayer()` (an instance method that returns
 * a strict `Config`). This function is retained for test
 * compatibility / debugging surfaces; new code should prefer the
 * instance method.
 */
export function sessionToConfigLayer(timeline: SessionEventTimeline, _config: Config, _cwd: string): Partial<Config> {
  const allowedPaths: AllowedPath[] = []
  let lastSetMode: string | undefined

  for (const event of timeline) {
    switch (event.type) {
      case "addSessionAllowedPath":
        allowedPaths.push(event.entry)
        break
      case "addRuntimeGrant":
        // Per-mode grants: handled at consumer time via
        // `applyGrantsFor`. Unit 6's `composeConfig` ignores them.
        break
      case "setMode":
        lastSetMode = event.modeName
        break
    }
  }

  const out: Partial<Config> = {}
  if (allowedPaths.length > 0) out.allowedPaths = allowedPaths
  if (lastSetMode !== undefined) out.modeOrder = [lastSetMode]
  return out
}
