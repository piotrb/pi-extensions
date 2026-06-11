import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { Config, Scope, Verdict } from "./types.ts"

const PROJECT_PATH = (cwd: string) => join(cwd, ".pi", "tool-policy.json")
const USER_PATH = () => join(homedir(), ".pi", "tool-policy.json")

/**
 * The stock config shipped with the extension. Used as the base layer when
 * neither the project nor the user config files exist. The user-level fields
 * layer on top of this, then the project-level fields win on key-by-key.
 *
 * The stock config ships **no opinions** beyond the fail-closed default and
 * the 7 built-in pi tools' tool/metadata blocks:
 *   - `defaultDecision: "ask"` — the policy's only built-in verdict.
 *   - `tools` — verdicts for the 7 built-in pi tools only (read, write, edit,
 *     grep, find, ls, bash). Extension tools (pfs_*, git_*, bfs, ripgrep, run,
 *     Agent, todo, ask_user_question, mcp) get no opinion here; the user
 *     sets verdicts in their config, OR the extension's own package.json
 *     ships them via `pi.toolMetadata` and the tool-metadata registry
 *     (see src/lib/tool-metadata.ts) aggregates them.
 *   - `aspects` — empty. The policy has no built-in denylists or allowlists
 *     for any aspect kind (path, url, glob, bash_cmd, regex). The user
 *     defines their own patterns.
 *   - `groupVerdicts` — empty. The user defines their own group taxonomy.
 *   - `metadata` — built-in tool metadata for the 7 built-in pi tools only.
 *     Groups are still assigned (readonly / mutating / execution) so the
 *     user's `groupVerdicts` entries have something to bind to, but with
 *     an empty `groupVerdicts` map those group assignments have no policy
 *     effect until the user defines one.
 */
export const STOCK_CONFIG: Config = {
  defaultDecision: "ask",
  aspects: {},
  groupVerdicts: {},
  tools: {
    read: "ask",
    write: "ask",
    edit: "ask",
    grep: "ask",
    find: "ask",
    ls: "ask",
    bash: "ask",
  },
  metadata: {
    read: { groups: ["readonly"], fields: { path: { aspect: "path" } } },
    write: { groups: ["mutating"], fields: { path: { aspect: "path" } } },
    edit: { groups: ["mutating"], fields: { path: { aspect: "path" } } },
    grep: { groups: ["readonly"], fields: { path: { aspect: "path" } } },
    find: { groups: ["readonly"], fields: { path: { aspect: "path" } } },
    ls: { groups: ["readonly"], fields: { path: { aspect: "path" } } },
    bash: { groups: ["execution"], fields: { command: { aspect: "bash_cmd" } } },
  },
}

export interface LoadedConfig {
  config: Config
  sources: { project: boolean; user: boolean }
}

/**
 * Load + merge project-over-user config. Falls back to STOCK_CONFIG if
 * neither file exists. Hot-reload contract: every call re-reads both files
 * from disk — there is no in-memory cache, no mtime check, no file watcher.
 * The 2 readFile + 2 JSON.parse is well under 1ms on SSD, so the cost is
 * negligible compared to the matcher cost.
 */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const [projectRaw, userRaw] = await Promise.all([readJsonSafe(PROJECT_PATH(cwd)), readJsonSafe(USER_PATH())])

  const project = projectRaw ?? {}
  const user = userRaw ?? {}

  // Shallow merge: project wins key-by-key. Within each key, the project's
  // value is used as-is (no deep merge in v1). STOCK_CONFIG is the base
  // layer that fills in fields neither the user nor project overrides.
  const merged: Config = { ...STOCK_CONFIG, ...user, ...project }

  return {
    config: merged,
    sources: { project: projectRaw !== null, user: userRaw !== null },
  }
}

/**
 * Write a single rule to the appropriate scope's config file. Synchronous on
 * disk — the next loadConfig() call will see the change with no cache
 * invalidation step required.
 *
 * The aspect layer is NOT implemented in v1: writing a per-aspect-pattern
 * rule would need to mutate a single key inside `config.aspects[name].patterns`,
 * which the current rule-editor UI does not surface. The modal/rule editor
 * skips aspect writes entirely; calling writeRuleToFile with the "aspect"
 * layer throws.
 */
export async function writeRuleToFile(
  scope: Scope,
  layer: "tool" | "group" | "defaultDecision",
  key: string,
  verdict: Verdict,
  cwd: string,
): Promise<void> {
  const path = scope === "project" ? PROJECT_PATH(cwd) : USER_PATH()
  const existing = (await readJsonSafe(path)) ?? {}
  const config: Config = existing

  if (layer === "defaultDecision") {
    config.defaultDecision = verdict
  } else if (layer === "tool") {
    config.tools = { ...config.tools, [key]: verdict }
  } else {
    // The remaining branch is `layer === "group"` — TypeScript's narrowing
    // would flag the explicit comparison as always-true, so the implicit
    // `else` is the cleanest expression of the discriminated union.
    config.groupVerdicts = { ...config.groupVerdicts, [key]: verdict }
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8")
}

async function readJsonSafe(path: string): Promise<Config | null> {
  try {
    const raw = await readFile(path, "utf-8")
    return JSON.parse(raw) as Config
  } catch {
    // ENOENT (file missing) and JSON parse errors both resolve to "no
    // config at this path". The merger falls back to STOCK_CONFIG.
    return null
  }
}
