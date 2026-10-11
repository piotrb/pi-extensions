import { merge } from "ts-deepmerge"

import type { Config } from "./types.ts"

/**
 * Layer-merge primitive for `pi-tool-policy` configs.
 *
 * `composeConfig(...layers)` folds an arbitrary number of full-`Config`
 * layers into a single resolved `Config`. Each layer that follows
 * the previous carries overrides that win on a per-field basis:
 *
 * - **`modeOrder`** — concat with dedup across layers. Dedup
 *   preserves first occurrence — the cycle order is whatever the
 *   first layer listed, with later layers' entries appended (or
 *   skipping duplicates if already present in the first layer).
 *   The **active mode** is the user's current
 *   `RuntimeState.currentModeName()`; `modeOrder` only describes
 *   the cycle, not the active mode. The handler at `tool_call`
 *   reads the active mode from `RuntimeState` and uses
 *   `resolveMode(active, merged)` to walk inheritance — the
 *   `modeOrder` ordering is independent.
 * - **`modes`** — `Record<string, Mode>` is union-merged per mode
 *   name (matching the existing `mergeModes` deep-merge shape:
 *   child wins on scalar keys, tagRules/toolRules/aspectRules are
 *   union-merged).
 * - **`allowedPaths`** — concat across layers. Entries are atomic
 *   (path + tags); dedup preserves the first occurrence.
 * - **`taggingRules`** — concat across layers. Rules are atomic
 *   (`{tool, fields?, aspects?}`); dedup preserves the first
 *   occurrence.
 * - **`toolMetadata`** — `Record<string, ToolMetadata>` is
 *   union-merged per tool name: `tags` are union-deduped;
 *   `aspects` are shallow-merged (key-by-key union).
 *
 * Layer count must be ≥ 1; passing zero layers throws (a fold with
 * no input has no defined result shape).
 *
 * Returns `{ config, warnings }` so the surface mirrors
 * `loadConfig`'s `LoadedConfig`. `composeConfig` itself emits no
 * warnings of its own — the warnings list is reserved for
 * `inventoryWarnings`-style cycle / unknown-`extends` checks that
 * consumers may run on the merged result.
 *
 * The deep-merge is delegated to `ts-deepmerge@^8.0.0`. The
 * default options (`mergeArrays: true`, `uniqueArrayItems: true`,
 * `allowUndefinedOverrides: true`) match every per-field rule
 * above:
 * - Arrays concat with dedup → `modeOrder` / `allowedPaths` /
 *   `taggingRules`.
 * - Objects recursively merge → `modes` / `toolMetadata` per-key.
 * - `undefined` overrides — we don't use `undefined` as a sentinel
 *   (the `__delete` semantics were dropped as part of the
 *   simplified Unit 6 design), so the default's behavior of
 *   "treat right-side `undefined` as a no-op" is what we want.
 */
export function composeConfig(...layers: Config[]): { config: Config; warnings: string[] } {
  if (layers.length === 0) {
    throw new Error("composeConfig requires at least one layer")
  }

  // Fold via `merge`. ts-deepmerge's default options
  // (mergeArrays: true, uniqueArrayItems: true) give us array
  // concat-dedup — exactly what every per-field rule above
  // requires.
  const merged = layers.reduce<Config>(
    (acc, layer) => merge(acc, layer),
    // The seed is the empty `Config` shape; every field is present
    // (possibly empty) so the ts-deepmerge input is structurally
    // a `Config` and the output is structurally a `Config`. This
    // avoids the `Partial<Config>` wriggle and keeps the type
    // story honest.
    {
      modeOrder: [],
      modes: {},
      allowedPaths: [],
      taggingRules: [],
      toolMetadata: {},
    },
  )

  return { config: merged, warnings: [] }
}
