import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import type { Config } from "./types.ts"

/** The cache returned by `applyEnabledOverrides`. Threaded through the
 *  extension entry's `session_start` + `tool_call` calls so a no-op
 *  reload (same config signature) does not call `pi.setActiveTools`
 *  redundantly per tool_call. */
export interface EnabledCache {
  /** Stable string fingerprint of the (true, false) tool-name lists. */
  signature: string
  /** The set that was last applied. Kept for diagnostics. */
  set: Set<string>
}

/**
 * Reconcile the runtime active-tools set against the merged config's
 * `toolMetadata[*].enabled` declarations.
 *
 * Algorithm:
 *  1. Walk `config.toolMetadata` and collect `enabled: true` → `toolsToEnable`,
 *     `enabled: false` → `toolsToDisable`. Tools that don't declare `enabled`
 *     are ignored (no override → no change).
 *  2. If both lists are empty, return `{ signature: "no-overrides", set: empty }`
 *     without mutating the runtime. The caller can treat this as a no-op.
 *  3. Otherwise, compute the new active set:
 *     - Start from `pi.getActiveTools()`.
 *     - Remove every name in `toolsToDisable` (that exists in the current set).
 *     - Add every name in `toolsToEnable` (the runtime's `setActiveToolsByName`
 *       silently ignores names that are not in `pi.getAllTools()`).
 *     - Call `pi.setActiveTools(newSet)`.
 *  4. Return a fresh cache entry with the signature and the resolved set.
 *
 * The cache is per-session: declared once in the extension entry closure
 * and passed back in on every call. The caller is responsible for skipping
 * the call when YOLO mode is active (so the "all tools pass" YOLO escape
 * stays intact — see `extensions/tool-policy.ts` for the gate).
 *
 * This is the first writer of `setActiveTools` in the workspace. If a
 * future extension also calls `setActiveTools`, the second writer wins
 * for the rest of the session.
 */
export function applyEnabledOverrides(
  config: Config,
  pi: ExtensionAPI,
  cached?: { signature: string; set: Set<string> },
): { signature: string; set: Set<string> } {
  const toolsToEnable: string[] = []
  const toolsToDisable: string[] = []
  for (const [toolName, meta] of Object.entries(config.toolMetadata)) {
    if (meta.enabled === true) toolsToEnable.push(toolName)
    else if (meta.enabled === false) toolsToDisable.push(toolName)
  }

  // Stable signature: order-sensitive so a config edit that adds the
  // same tools in a different order still re-applies. Empty list
  // serializes to `[]` which is a real, distinct signature from
  // "no overrides declared" (we short-circuit that case below).
  const signature = `${JSON.stringify([...toolsToEnable].sort())}|${JSON.stringify([...toolsToDisable].sort())}`

  if (toolsToEnable.length === 0 && toolsToDisable.length === 0) {
    return cached ?? { signature: "no-overrides", set: new Set() }
  }

  if (cached?.signature === signature) {
    return cached
  }

  const current = pi.getActiveTools()
  const disableSet = new Set(toolsToDisable)
  const enableSet = new Set(toolsToEnable)
  const next = [...new Set([...current.filter((name) => !disableSet.has(name)), ...toolsToEnable])]
  // Note: `next` is computed defensively (filter + concat + dedupe) even
  // though the runtime's `setActiveToolsByName` already drops unknown
  // names — keeping the set clean at the call boundary means the cache's
  // `set` reflects what was actually pushed, not what was attempted.
  void enableSet // set kept for symmetry; the runtime filter is the real gate

  pi.setActiveTools(next)

  return { signature, set: new Set(next) }
}
