import type { Config, Mode } from "./types.ts"

/**
 * Inventory walker: collects cycle / unknown-`extends` warnings across
 * **all** modes in `rawConfig` without mutating it.
 *
 * Distinct from `resolveMode`:
 *
 * - `resolveMode(name, config)` returns one resolved mode for the
 *   matcher to consume; it strips `extends` and pushes warnings as
 *   a side effect of walking a single chain.
 * - `inventoryWarnings(config)` returns a fresh warning array;
 *   the input config is read-only (no mutation, no strip).
 *
 * Together they enforce the principle: the loader merges (it does
 * NOT call `resolveMode` and does NOT strip `extends`), and the
 * matcher / JIT consumer calls `resolveMode` itself.
 *
 * Behavior:
 * - Walks every mode in `rawConfig.modes` via a DFS on the
 *   `extends` graph. The walker reads `extends` to traverse; it
 *   never assigns to it.
 * - Emits a cycle warning naming the cycle path the first time
 *   a name is re-entered on the current DFS stack.
 * - Emits an unknown-mode warning for each `extends` target not
 *   in `rawConfig.modes`.
 * - Returns a fresh array. The input `rawConfig` is untouched.
 */
export function inventoryWarnings(rawConfig: Config): string[] {
  const warnings: string[] = []
  const visited = new Set<string>()
  const stack = new Set<string>()

  function walk(name: string): void {
    if (stack.has(name)) {
      warnings.push(`Cycle detected in extends chain at mode '${name}' (visited: ${[...stack].join(" → ")} → ${name})`)
      return
    }
    if (visited.has(name)) return
    visited.add(name)
    stack.add(name)
    const m = rawConfig.modes[name]
    if (!m) {
      // Unreachable under loadConfig's contract (stock + merged layers
      // cover every reachable name), but guard against cycles that
      // reference an outside key the loader couldn't see.
      stack.delete(name)
      return
    }
    if (m.extends) {
      for (const ext of m.extends) {
        if (!(ext in rawConfig.modes)) {
          warnings.push(`Mode '${name}' extends unknown mode '${ext}'; treating as base`)
          continue
        }
        walk(ext)
      }
    }
    stack.delete(name)
  }

  for (const name of Object.keys(rawConfig.modes)) {
    walk(name)
  }
  return warnings
}

/**
 * Resolve a single mode's `extends` chain against the given `rawConfig`.
 *
 * Walks the `extends` declarations on `modeName` (and any parents),
 * deep-merging each parent into the child via `deepMergeMode`. The
 * returned mode has no `extends` field — the inheritance has been
 * applied. Warnings are collected per call so callers can decide
 * whether to surface them via `/tool_policy` or via a status-line
 * notice.
 *
 * Behavior contracts:
 * - **Standalone mode**: no `extends`, no parent → returns the mode
 *   with its own fields, no `extends` key in the result.
 * - **Child overrides parent**: a child that sets `defaultDecision: "deny"`
 *   and a parent that has `tagRules: { readonly: "allow" }` produce
 *   a mode with both fields: `defaultDecision: "deny"` (child wins)
 *   and `tagRules: { readonly: "allow", ...childTagRules }` (union).
 * - **Cycle**: A → B → A → returns the partially-resolved mode and
 *   pushes a warning naming the cycle path. The matcher's input
 *   stays valid (no `Mode` with `extends` block reaches it).
 * - **Unknown extends**: "ghost" not in `rawConfig.modes` → push a
 *   warning, skip the missing parent (the rest of the chain still
 *   resolves).
 * - **Mode not in config**: returns a safe-default mode and pushes
 *   a warning (so a stale `currentModeName` from the timeline doesn't
 *   crash the matcher).
 */
export function resolveMode(modeName: string, rawConfig: Config): { mode: Mode; warnings: string[] } {
  const warnings: string[] = []

  if (!(modeName in rawConfig.modes)) {
    warnings.push(`resolveMode: mode '${modeName}' not found in config; using safe default`)
    return { mode: safeDefaultMode(), warnings }
  }

  const visiting = new Set<string>()
  const mode = resolveOne(modeName, rawConfig, warnings, visiting)
  return { mode, warnings }
}

function resolveOne(name: string, rawConfig: Config, warnings: string[], visiting: Set<string>): Mode {
  const m = rawConfig.modes[name]
  // Caller (`resolveMode`) already guards against the first-visit missing-mode
  // case. This recursive function is only reached with a name that came out
  // of `rawConfig.modes[name].extends`, but with `noUncheckedIndexedAccess`
  // the compiler can't follow that, so guard again here.
  if (!m) {
    warnings.push(`resolveOne: missing mode '${name}'; using safe default`)
    return safeDefaultMode()
  }

  // Cycle: already in the chain being resolved on this call. Push a
  // warning and return the raw mode (the matcher can still run with
  // an unresolved `extends` field, but we strip it to keep the
  // post-condition clean — the field is the contract this function
  // makes with its callers).
  if (visiting.has(name)) {
    warnings.push(`Cycle detected in extends chain at mode '${name}' (visited: ${[...visiting].join(" → ")} → ${name})`)
    return stripExtends(m)
  }

  visiting.add(name)

  let merged: Mode = stripExtends(m)

  if (m.extends) {
    for (const ext of m.extends) {
      if (!(ext in rawConfig.modes)) {
        warnings.push(`Mode '${name}' extends unknown mode '${ext}'; treating as base`)
        continue
      }
      const parent = resolveOne(ext, rawConfig, warnings, visiting)
      merged = deepMergeMode(parent, merged)
    }
  }

  visiting.delete(name)
  return merged
}

/**
 * Deep-merge parent → child for a Mode block. Both `parent` and `child`
 * are required `Mode` objects (the caller has already stripped `extends`
 * and filled any missing fields). Child wins on scalar keys; tagRules,
 * toolRules, and aspectRules are union-merged (parent fills in, child
 * wins per key).
 *
 * `additionalInstructions` is optional on `Mode`, so the only `??` in
 * here is for that one optional scalar — `description` and
 * `defaultDecision` are required on the `Mode` type and so child wins
 * outright.
 */
function deepMergeMode(parent: Mode, child: Mode): Mode {
  return {
    description: child.description,
    defaultDecision: child.defaultDecision,
    tagRules: { ...parent.tagRules, ...child.tagRules },
    toolRules: { ...parent.toolRules, ...child.toolRules },
    aspectRules: { ...parent.aspectRules, ...child.aspectRules },
    additionalInstructions: child.additionalInstructions ?? parent.additionalInstructions,
  }
}

function stripExtends(mode: Mode): Mode {
  const { extends: _unused, ...rest } = mode
  return rest
}

function safeDefaultMode(): Mode {
  return {
    description: "",
    defaultDecision: "ask",
    tagRules: {},
    toolRules: {},
    aspectRules: {},
  }
}
