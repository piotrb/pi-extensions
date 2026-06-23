import { readFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { ToolInfo } from "@earendil-works/pi-coding-agent"

import type { ResolvedToolMetadata, ToolMetadata } from "./types.ts"

/**
 * Walk up from `startDir` looking for a `package.json`. Returns the
 * directory containing the FIRST `package.json` we find, or `null` if we
 * hit the filesystem root without finding one.
 *
 * The monorepo convention puts source files under `src/extensions/<name>.ts`
 * and the package.json at the package root, so a flat `<dir>/package.json`
 * read would always miss. Walking up is the right model for any layout
 * where the source file lives in a subdirectory of the package.
 */
async function findPackageJsonDir(startDir: string): Promise<string | null> {
  let dir: string | undefined = startDir
  while (dir && dir !== dirname(dir)) {
    try {
      const candidate = join(dir, "package.json")
      const s = await stat(candidate)
      if (s.isFile()) return dir
    } catch {
      // ENOENT at this level — try the parent.
    }
    dir = dirname(dir)
  }
  return null
}

/**
 * Built-in tool metadata. Includes the 7 built-in tools (read, write, edit,
 * grep, find, ls, bash). Monorepo custom tools (pfs_*, git_*, bfs, ripgrep)
 * are layered in by reading their package.json (see `aggregateToolMetadata`).
 */
export const STOCK_BUILTIN_TOOL_METADATA: Record<string, ToolMetadata> = {
  read: { tags: ["readonly"], aspects: { path: { mode: "path", fields: ["path"] } } },
  write: { tags: ["mutating"], aspects: { path: { mode: "path", fields: ["path"] } } },
  edit: { tags: ["mutating"], aspects: { path: { mode: "path", fields: ["path"] } } },
  grep: { tags: ["readonly"], aspects: { path: { mode: "path", fields: ["path"] } } },
  find: { tags: ["readonly"], aspects: { path: { mode: "path", fields: ["path"] } } },
  ls: { tags: ["readonly"], aspects: { path: { mode: "path", fields: ["path"] } } },
  bash: {
    tags: ["execution"],
    // `command` is a single string (the shell command itself). The bash-mode
    // matcher joins this string with " " if it sees a string[] — but for
    // bash it's always a string, so no format hint is needed.
    aspects: { bash_cmd: { mode: "bash", fields: ["command"] } },
  },
}

/**
 * A diagnostic emitted by `aggregateToolMetadata`. The shape varies by
 * warning type — each variant carries the fields a renderer needs to
 * format a useful message.
 */
export type ToolMetadataWarning =
  | { type: "orphan-aspect-reference"; tool: string; aspect: string }
  | {
      /** Two or more `pi.toolMetadata` sources declared the same tool name.
       *  `sources` is the list of contributing package directories (at
       *  least two entries) so the user can find and fix the conflict. */
      type: "duplicate-tool"
      tool: string
      sources: string[]
    }
  | { type: "package-json-not-found"; tool: string; dir: string }
  | { type: "package-json-unreadable"; tool: string; dir: string; error: string }
  | { type: "package-json-invalid"; tool: string; dir: string; error: string }

export interface AggregateResult {
  /**
   * Final, merged metadata per tool — used by the policy matcher at
   * tool_call time. Built-in + per-extension `pi.toolMetadata` from
   * package.json + config overrides, folded together.
   */
  metadata: Map<string, ResolvedToolMetadata>
  /**
   * Pre-merge per-extension contributions. Just the `pi.toolMetadata` blocks
   * read out of each extension's package.json, keyed by tool name. Useful
   * for debugging "what did each extension actually declare?" before the
   * merge with the built-ins.
   *
   * Config overrides are NOT included here — they layer on top of the
   * package.json contributions, after this snapshot is taken.
   */
  discovered: Record<string, ToolMetadata>
  warnings: ToolMetadataWarning[]
}

/**
 * Aggregate tool metadata from three layers:
 *   1. STOCK_BUILTIN_TOOL_METADATA (built-in tools)
 *   2. package.json readers (each extension's `pi.toolMetadata` block)
 *   3. configOverrides (the user's `config.toolMetadata` wins)
 *
 * Orphan-aspect validation: for each tool, walk its override's `aspects`
 * keys; if the merged metadata doesn't declare the aspect, push a warning.
 */
export async function aggregateToolMetadata(
  tools: readonly ToolInfo[],
  configOverrides: Record<string, ToolMetadata> = {},
): Promise<AggregateResult> {
  const result = new Map<string, ResolvedToolMetadata>()
  const warnings: ToolMetadataWarning[] = []

  // Layer 1: built-in.
  const merged: Record<string, ToolMetadata> = { ...STOCK_BUILTIN_TOOL_METADATA }

  // Layer 2: package.json readers. We snapshot each extension's contribution
  // into `discovered` BEFORE merging it into the final `merged` map, so the
  // debug view can show "what each extension declared" without the built-in
  // layer polluting the picture. If two extensions declare the same tool,
  // their contributions accumulate into a single discovered entry (last
  // write wins on the same key — the same merge semantics as the final
  // result).
  const discovered: Record<string, ToolMetadata> = {}
  // Dedup by the tool's SOURCE dir (so we don't re-walk the same tree for
  // multiple tools registered from one package). The package.json's actual
  // dir may be a parent of this.
  const seenSourceDirs = new Set<string>()
  // Track which sources contributed to each tool name, so a second
  // extension declaring the same tool name is surfaced as a hard-fail
  // warning (see the duplicate-tool warning below). The built-in STOCK
  // is the baseline, so each built-in tool is pre-registered with the
  // sentinel source "<built-in>" — this also catches the "package.json
  // shadows a built-in" case the user almost certainly didn't intend.
  const toolSources = new Map<string, string[]>()
  for (const toolName of Object.keys(STOCK_BUILTIN_TOOL_METADATA)) {
    toolSources.set(toolName, ["<built-in>"])
  }
  for (const tool of tools) {
    const sourceInfo = tool.sourceInfo
    if (!sourceInfo.path) continue
    const sourceDir = dirname(sourceInfo.path)
    if (seenSourceDirs.has(sourceDir)) continue
    seenSourceDirs.add(sourceDir)

    // Walk up from the source dir to find the nearest package.json. The
    // monorepo puts source files under src/extensions/<tool>.ts with the
    // package.json at the package root, so a flat read of <sourceDir>/package.json
    // would always miss.
    const pkgDir = await findPackageJsonDir(sourceDir)
    if (!pkgDir) {
      warnings.push({
        type: "package-json-not-found",
        tool: tool.name,
        dir: sourceDir,
      })
      continue
    }
    let raw: string
    try {
      raw = await readFile(join(pkgDir, "package.json"), "utf-8")
    } catch (err) {
      warnings.push({
        type: "package-json-unreadable",
        tool: tool.name,
        dir: pkgDir,
        error: (err as Error).message,
      })
      continue
    }
    let pkg: { pi?: { toolMetadata?: Record<string, ToolMetadata> } }
    try {
      pkg = JSON.parse(raw) as { pi?: { toolMetadata?: Record<string, ToolMetadata> } }
    } catch (err) {
      warnings.push({
        type: "package-json-invalid",
        tool: tool.name,
        dir: pkgDir,
        error: (err as Error).message,
      })
      continue
    }
    const meta = pkg.pi?.toolMetadata
    if (meta && typeof meta === "object") {
      for (const [toolName, value] of Object.entries(meta)) {
        merged[toolName] = deepMergeToolMetadata(merged[toolName], value)
        discovered[toolName] = deepMergeToolMetadata(discovered[toolName], value)
        // Track which sources contributed to each tool name. Two
        // different extensions declaring the same tool name is a
        // collision — emit a hard-fail warning so the conflict is
        // visible (and the user can fix it before the silent last-write-wins
        // produces confusing behavior in the matcher).
        const prev = toolSources.get(toolName)
        if (prev && !prev.includes(pkgDir)) {
          toolSources.set(toolName, [...prev, pkgDir])
          warnings.push({ type: "duplicate-tool", tool: toolName, sources: [...prev, pkgDir] })
        } else if (!prev) {
          toolSources.set(toolName, [pkgDir])
        }
      }
    }
  }

  // Layer 3: config overrides (config wins).
  for (const [toolName, value] of Object.entries(configOverrides)) {
    merged[toolName] = deepMergeToolMetadata(merged[toolName], value)
  }

  // Resolve and validate.
  for (const tool of tools) {
    const meta = merged[tool.name]
    if (!meta) {
      result.set(tool.name, { tags: [], fields: {} })
      continue
    }
    result.set(tool.name, { tags: meta.tags ?? [], fields: meta.aspects })
  }

  // Orphan-aspect validation: for each tool with a config override, check
  // that every aspect the override declares is either:
  //   (a) in the BUILT-IN metadata, OR
  //   (b) explicitly added by the override itself.
  // A typo in the override (e.g. an override accidentally removing an aspect
  // and re-adding it with a typo'd name) would otherwise be silently accepted.
  // We compare against the BUILT-IN set so that NEW aspects added by the
  // override (e.g. the user extends the tool's metadata with a new aspect)
  // are not flagged as orphans.
  for (const tool of tools) {
    const override = configOverrides[tool.name]
    if (!override?.aspects) continue
    const builtInAspects = new Set(Object.keys(STOCK_BUILTIN_TOOL_METADATA[tool.name]?.aspects ?? {}))
    for (const aspectName of Object.keys(override.aspects)) {
      if (!builtInAspects.has(aspectName)) {
        warnings.push({ type: "orphan-aspect-reference", tool: tool.name, aspect: aspectName })
      }
    }
  }

  return { metadata: result, discovered, warnings }
}

export function deepMergeToolMetadata(base: ToolMetadata | undefined, override: ToolMetadata): ToolMetadata {
  if (!base) return override
  return {
    tags: [...(base.tags ?? []), ...(override.tags ?? [])].filter((t, i, a) => a.indexOf(t) === i),
    aspects: { ...base.aspects, ...override.aspects },
    // Last-write-wins per layer: a non-boolean `enabled` (e.g. a typo'd
    // `enable: true` from package.json) falls back to the base value rather
    // than collapsing to `undefined`, so a malformed declaration is a no-op
    // instead of a type-cast surprise. `enabled: false` is a real declaration
    // and overrides `enabled: true` on the base; an unset `enabled` inherits
    // from the base.
    enabled: typeof override.enabled === "boolean" ? override.enabled : base.enabled,
  }
}
