import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import type { ConfigLayers } from "./modal/debug-modal.ts"
import { deepMergeToolMetadata } from "./tool-metadata.ts"
import { type AllowedPath, type Config, type Mode, type ToolMetadata, YOLO_MODE } from "./types.ts"

const PROJECT_PATH = (cwd: string) => join(cwd, ".pi", "tool-policy.json")
const USER_PATH = () => join(homedir(), ".pi", "tool-policy.json")

/**
 * The stock config shipped with the extension. Used as the base layer when
 * neither the project nor the user config files exist.
 *
 * Stock modes form a chain of inheritance, narrowest first:
 *
 *   `readonly` — permissive base. Allows the `readonly` and `metadata`
 *                tags, asks for everything else. A new `readonly` mode
 *                that this config introduces; users who want a stricter
 *                read-only mode can drop in a different one.
 *   `default`  — extends `readonly`. Adds the `mutating`, `execution`,
 *                and `network` `ask` overrides. The everyday mode.
 *   `edit`     — extends `default`. Adds the `mutating: allow` override
 *                so file writes/edits go through without prompting. Still
 *                asks for `execution` and `network` because those can
 *                have side effects beyond a single file.
 *   `plan`     — extends `readonly` directly (skipping `default`).
 *                Overrides `mutating`, `execution`, and `network` to
 *                `deny` and sets `defaultDecision: deny`. The
 *                read-then-plan mode; nothing mutates, nothing executes.
 *
 * Why `plan` extends `readonly` and not `default`? Plan mode wants
 * `mutating: deny`, not `mutating: ask` — extending `default` would
 * first inherit `mutating: ask` from `default`, then override it to
 * `deny`. Functionally the same after deep-merge, but the intent is
 * cleaner this way: `plan` only needs `readonly`'s permissive base
 * (the things it allows) and adds its own restrictions on top.
 *
 * Stock `toolMetadata` provides base tags + aspect declarations for the
 * 7 built-in tools. Extension tools (pfs_*, git_*, bfs, ripgrep, run, Agent,
 * todo, ask_user_question, mcp) get no stock metadata — the user's config
 * sets them, or the extension's own package.json ships them via
 * `pi.toolMetadata` (see tool-metadata.ts).
 */
export const STOCK_CONFIG: Config = {
  modeOrder: ["default", "readonly", "edit", "plan"],
  modes: {
    readonly: {
      description: "Read-only base; allows readonly and metadata, asks for everything else",
      defaultDecision: "ask",
      tagRules: {
        readonly: "allow",
        metadata: "allow",
      },
      toolRules: {},
      aspectRules: {},
    },
    default: {
      description: "Permissive baseline; auto-allow readonly, ask for everything else",
      extends: ["readonly"],
      defaultDecision: "ask",
      tagRules: {
        mutating: "ask",
        execution: "ask",
        network: "ask",
      },
      toolRules: {},
      aspectRules: {},
    },
    edit: {
      description: "Permissive edit mode; mutating operations allowed",
      extends: ["default"],
      defaultDecision: "ask",
      tagRules: {
        mutating: "allow",
      },
      toolRules: {},
      aspectRules: {},
    },
    plan: {
      description: "Read-only; plan changes without making them",
      extends: ["readonly"],
      defaultDecision: { verdict: "deny", reason: "plan mode denies all by default" },
      tagRules: {
        mutating: { verdict: "deny", reason: "mutating operations not allowed in plan mode" },
        execution: { verdict: "deny", reason: "execution not allowed in plan mode" },
        network: { verdict: "deny", reason: "network access not allowed in plan mode" },
      },
      toolRules: {},
      aspectRules: {},
      additionalInstructions: {
        mode: "replace",
        text: "You are in plan mode. You may not modify files, run commands, or take any side-effecting action. Generate a plan and present it to the user; do not execute it.",
      },
    },
  },
  allowedPaths: [],
  taggingRules: [
    {
      tool: "bash",
      fields: { command: ["wc *", "ls", "ls *"] },
      action: { type: "addTags", tags: ["readonly"] },
    },
    {
      tool: "bash",
      fields: { command: ["mkdir *", "rmdir *", "rm *"] },
      action: { type: "addTags", tags: ["mutating"] },
    },
  ],
  toolMetadata: {
    read: { tags: ["readonly"], aspects: { path: { mode: "path", fields: ["path"] } } },
    write: { tags: ["mutating"], aspects: { path: { mode: "path", fields: ["path"] } } },
    edit: { tags: ["mutating"], aspects: { path: { mode: "path", fields: ["path"] } } },
    grep: { tags: ["readonly"], aspects: { path: { mode: "path", fields: ["path"] } } },
    find: { tags: ["readonly"], aspects: { path: { mode: "path", fields: ["path"] } } },
    ls: { tags: ["readonly"], aspects: { path: { mode: "path", fields: ["path"] } } },
    bash: {
      tags: ["execution"],
      aspects: { bash_cmd: { mode: "bash", fields: ["command"] } },
    },
  },
}

export interface LoadedConfig {
  config: Config
  warnings: string[]
  sources: { project: boolean; user: boolean }
  /**
   * The three raw `modes` layers that fed into the final merged config,
   * plus the merged result. Used by the debug menu's "Config Layers"
   * view to show which fields came from stock vs. user vs. project.
   */
  layers: ConfigLayers
}

/**
 * Deep-merge parent → child for a Mode block.
 *   description, extends, defaultDecision, additionalInstructions: child wins
 *   tagRules: child wins per key, parent fills in
 *   aspectRules: child wins per key, parent fills in
 *   toolRules[tool]: replaced as a list (child is source of truth)
 */
function deepMergeMode(parent: Mode, child: Partial<Mode>): Mode {
  const merged: Mode = {
    description: child.description ?? parent.description,
    extends: child.extends ?? parent.extends,
    defaultDecision: child.defaultDecision ?? parent.defaultDecision,
    tagRules: { ...parent.tagRules, ...(child.tagRules ?? {}) },
    toolRules: { ...parent.toolRules, ...(child.toolRules ?? {}) },
    aspectRules: { ...parent.aspectRules, ...(child.aspectRules ?? {}) },
    additionalInstructions: child.additionalInstructions ?? parent.additionalInstructions,
  }
  return merged
}

/**
 * Merge two `modes` records (parent and child). For each mode name present
 * in either, produce a `Mode` that has all the parent's fields filled in
 * and the child's overrides applied. Modes unique to either side are
 * returned as-is (with the partial defaults filled by the other side
 * where possible).
 */
function mergeModes(parent: Record<string, Mode>, child: Record<string, Partial<Mode>>): Record<string, Mode> {
  const out: Record<string, Mode> = {}
  for (const [name, parentMode] of Object.entries(parent)) {
    const childMode = child[name]
    out[name] = childMode ? deepMergeMode(parentMode, childMode) : parentMode
  }
  for (const [name, childMode] of Object.entries(child)) {
    if (!(name in out)) {
      // Child introduces a new mode with no parent fallback. Provide
      // safe defaults so the matcher can still run (a fully-undefined
      // `defaultDecision` would still resolve to "ask" downstream, but
      // the in-shape defaults make the layer structure explicit).
      out[name] = deepMergeMode(
        {
          description: "",
          defaultDecision: "ask",
          tagRules: {},
          toolRules: {},
          aspectRules: {},
        },
        childMode,
      )
    }
  }
  return out
}

/**
 * Merge two `toolMetadata` records. Each tool entry is `ToolMetadata`:
 *   tags: union-deduped
 *   aspects: shallow-merged (same key wins; different keys accumulate)
 *
 * Tools unique to either side are returned as-is, with the same union-dedup
 * for `tags` and a `{...defaults, ...override}` for `aspects`.
 */
function mergeToolMetadata(
  parent: Record<string, ToolMetadata>,
  child: Record<string, ToolMetadata>,
): Record<string, ToolMetadata> {
  const out: Record<string, ToolMetadata> = {}
  for (const [name, parentMeta] of Object.entries(parent)) {
    const childMeta = child[name]
    out[name] = childMeta ? deepMergeToolMetadata(parentMeta, childMeta) : parentMeta
  }
  for (const [name, childMeta] of Object.entries(child)) {
    if (!(name in out)) {
      out[name] = {
        tags: [...(childMeta.tags ?? [])],
        aspects: { ...childMeta.aspects },
      }
    }
  }
  return out
}

function detectExtendsCycles(modes: Record<string, Mode>, warnings: string[]): void {
  const visited = new Set<string>()
  const stack = new Set<string>()
  function dfs(name: string, path: string[]): void {
    if (stack.has(name)) {
      warnings.push(`Cycle in extends graph: ${[...path, name].join(" → ")} → ${name}`)
      return
    }
    if (visited.has(name)) return
    visited.add(name)
    stack.add(name)
    const m = modes[name]
    if (m?.extends) {
      for (const ext of m.extends) {
        dfs(ext, [...path, name])
      }
    }
    stack.delete(name)
  }
  for (const name of Object.keys(modes)) {
    dfs(name, [])
  }
}

function resolveExtends(modes: Record<string, Mode>, warnings: string[]): Record<string, Mode> {
  detectExtendsCycles(modes, warnings)
  const resolved: Record<string, Mode> = {}
  function resolve(name: string, visiting = new Set<string>()): Mode {
    if (resolved[name]) return resolved[name]
    if (visiting.has(name)) {
      // Cycle: leave the offending mode partially resolved.
      warnings.push(`Cycle detected while resolving mode ${name}; leaving as-is`)
      return modes[name]!
    }
    visiting.add(name)
    const m = modes[name]!
    let merged = m
    if (m.extends) {
      for (const ext of m.extends) {
        if (!(ext in modes)) {
          warnings.push(`Mode ${name} extends unknown mode ${ext}; treating as base`)
          continue
        }
        const parent = resolve(ext, visiting)
        merged = deepMergeMode(parent, merged)
      }
    }
    // After deep-merge, drop the `extends` field (it was applied).
    const { extends: _e, ...rest } = merged
    resolved[name] = rest
    visiting.delete(name)
    return rest
  }
  for (const name of Object.keys(modes)) {
    resolve(name)
  }
  return resolved
}

/**
 * Walk every mode's regex-aspect rules and try to compile every pattern
 * as a RegExp. Push a warning for any pattern that throws. Scoped to
 * the `regex` aspect kind because that's the only aspect whose matcher
 * (in `aspects.ts`) wraps the pattern in `new RegExp(...)` and silently
 * swallows the throw — path / url / bash / glob aspects use picomatch
 * or pattern-string matchers that either compile differently or throw
 * loudly.
 */
function validateAspectPatterns(modes: Record<string, Mode>, warnings: string[]): void {
  for (const [modeName, mode] of Object.entries(modes)) {
    for (const [aspectName, aspect] of Object.entries(mode.aspectRules)) {
      if (aspectName !== "regex") continue
      for (const pattern of Object.keys(aspect.patterns)) {
        try {
          new RegExp(pattern)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          warnings.push(`Invalid regex pattern in mode '${modeName}' aspect '${aspectName}': ${pattern} (${message})`)
        }
      }
    }
  }
}

async function readJsonSafe(path: string): Promise<Partial<Config> | null> {
  try {
    const raw = await readFile(path, "utf-8")
    return JSON.parse(raw) as Partial<Config>
  } catch {
    return null
  }
}

/**
 * Load + merge project-over-user config. Falls back to STOCK_CONFIG if
 * neither file exists. Hot-reload contract: every call re-reads both files
 * from disk — there is no in-memory cache, no mtime check, no file watcher.
 */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const [projectRaw, userRaw] = await Promise.all([readJsonSafe(PROJECT_PATH(cwd)), readJsonSafe(USER_PATH())])

  const project = projectRaw ?? {}
  const user = userRaw ?? {}

  // Deep-merge per top-level key: project wins. Mode blocks and toolMetadata
  // blocks use their respective deep-merge helpers so a user override that
  // touches only one field (e.g. `aspectRules.path`) doesn't drop the
  // stock `tagRules`, `defaultDecision`, or `aspects` on the same mode /
  // tool. Without this, a partial override would produce a mode with
  // `tagRules: undefined`, which crashes the policy matcher the first
  // time a tool with the `readonly` tag is invoked.
  const merged: Config = {
    modeOrder: project.modeOrder ?? user.modeOrder ?? STOCK_CONFIG.modeOrder,
    modes: mergeModes(mergeModes(STOCK_CONFIG.modes, user.modes ?? {}), project.modes ?? {}),
    allowedPaths: [...STOCK_CONFIG.allowedPaths, ...(user.allowedPaths ?? []), ...(project.allowedPaths ?? [])],
    taggingRules: [...STOCK_CONFIG.taggingRules, ...(user.taggingRules ?? []), ...(project.taggingRules ?? [])],
    toolMetadata: mergeToolMetadata(
      mergeToolMetadata(STOCK_CONFIG.toolMetadata, user.toolMetadata ?? {}),
      project.toolMetadata ?? {},
    ),
  }

  // Inject the emergency-off "YOLO" mode. Synthetic, not user-configurable,
  // listed last so the cycle wraps to it as a last resort. The user can
  // reach it via the cycle hotkey or /tool_policy.
  merged.modes[YOLO_MODE] = {
    description: "EMERGENCY OFF — extension disabled, all tool calls pass through",
    defaultDecision: "allow",
    tagRules: {},
    toolRules: {},
    aspectRules: {},
  }
  if (!merged.modeOrder.includes(YOLO_MODE)) {
    merged.modeOrder = [...merged.modeOrder, YOLO_MODE]
  }

  const warnings: string[] = []

  // Validate every aspect pattern is a valid regex source. Patterns that
  // fail to compile are added to `warnings` (visible via /tool_policy) but
  // the config is still loaded — a malformed pattern produces a matcher
  // that no-ops on every call (see aspects.ts). Surfacing the warning at
  // load time means a typo in the config (e.g. "[unclosed") is reported
  // in the modal instead of silently disabling the rule.
  validateAspectPatterns(merged.modes, warnings)

  // Resolve extends with cycle detection.
  merged.modes = resolveExtends(merged.modes, warnings)

  // Resolve project-level relative allowedPaths to absolute.
  merged.allowedPaths = merged.allowedPaths.map((entry) => resolveAllowedPath(entry, cwd))

  return {
    config: merged,
    warnings,
    sources: { project: projectRaw !== null, user: userRaw !== null },
    layers: {
      stock: STOCK_CONFIG.modes,
      user: user.modes ?? {},
      project: project.modes ?? {},
      merged: merged.modes,
      modeOrder: merged.modeOrder,
    },
  }
}

function resolveAllowedPath(entry: AllowedPath, cwd: string): AllowedPath {
  if (entry.path.startsWith("/")) return entry // already absolute
  return { ...entry, path: resolve(cwd, entry.path) }
}
