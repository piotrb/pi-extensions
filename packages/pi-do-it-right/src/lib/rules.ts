/**
 * rules — markdown rule-file loader.
 *
 * Reads up to four files and concatenates them in deterministic order:
 *   1. Bundled  — <package>/src/extensions/auto-reject-rules.md
 *   2. Override — ~/.pi/agent/auto-reject-rules-override.md
 *   3. Global   — ~/.pi/agent/auto-reject-rules.md
 *   4. Project  — <cwd>/.pi/auto-reject-rules.md
 *
 * The override file, when present, REPLACES the bundled file — not the
 * other user files. Order when override is present:
 *   override, global, project.
 * Order when override is absent:
 *   bundled, global, project.
 *
 * Missing files (ENOENT) are silently skipped. Other errors (permission
 * denied, EISDIR) are also skipped, never thrown — the extension is
 * fail-open by design.
 *
 * Returns "" when no rule files contribute (the bundled file should
 * always contribute in production; a missing bundled file is a serious
 * bug but the loader still degrades gracefully).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Per-project rules path. Resolved relative to a `cwd` argument. */
export function projectRulesPath(cwd: string): string {
  return join(cwd, ".pi", "auto-reject-rules.md")
}

/** Per-project override path. Same convention as projectRulesPath. */
export function projectOverrideRulesPath(cwd: string): string {
  return join(cwd, ".pi", "auto-reject-rules-override.md")
}

/** Per-user rules path (global scope). */
export function globalRulesPath(home: string = homedir()): string {
  return join(home, ".pi", "agent", "auto-reject-rules.md")
}

/** Per-user override path (global scope). */
export function globalOverrideRulesPath(home: string = homedir()): string {
  return join(home, ".pi", "agent", "auto-reject-rules-override.md")
}

/** Absolute path to the bundled rules file shipped with the package. */
export function bundledRulesPath(importMetaUrl: string = import.meta.url): string {
  return fileURLToPath(new URL("../extensions/auto-reject-rules.md", importMetaUrl))
}

/** Resolved paths for all four sources. Exported for tests + introspection. */
export interface RulesPaths {
  bundled: string
  globalOverride: string
  global: string
  project: string
}

/**
 * Compute the four paths to read.
 *
 * `homedirFn` defaults to `os.homedir()`. `importMetaUrl` defaults to
 * `import.meta.url`. Both are injection seams for tests.
 */
export function resolvePaths(
  cwd: string,
  homedirFn: () => string = homedir,
  importMetaUrl: string = import.meta.url,
): RulesPaths {
  return {
    bundled: bundledRulesPath(importMetaUrl),
    globalOverride: globalOverrideRulesPath(homedirFn()),
    global: globalRulesPath(homedirFn()),
    project: projectRulesPath(cwd),
  }
}

/**
 * Load and concatenate the rules files in deterministic order.
 *
 * Concatenation order with the override file present:
 *   globalOverride, global, project  (bundled is skipped — overridden)
 *
 * Concatenation order without the override file:
 *   bundled, global, project
 *
 * A blank line is inserted between non-empty halves so the model can
 * visually distinguish them.
 *
 * Returns "" when none of the contributing files has content.
 *
 * Injection seams (all optional, all for tests):
 *   - `homedirFn`       — controls global + globalOverride paths
 *   - `importMetaUrl`   — controls bundled path (so tests can point
 *                         at a hermetic fixture file)
 *   - `paths`           — when provided, overrides everything else;
 *                         tests use this to hermeticize all four files
 */
export async function loadRules(
  cwd: string,
  homedirFn: () => string = homedir,
  importMetaUrl: string = import.meta.url,
  paths?: RulesPaths,
): Promise<string> {
  const resolved = paths ?? resolvePaths(cwd, homedirFn, importMetaUrl)

  const [bundled, globalOverride, global, project] = await Promise.all([
    safeRead(resolved.bundled),
    safeRead(resolved.globalOverride),
    safeRead(resolved.global),
    safeRead(resolved.project),
  ])

  const parts: string[] = []
  if (globalOverride.length > 0) {
    // Override wins over bundled.
    parts.push(globalOverride)
  } else if (bundled.length > 0) {
    parts.push(bundled)
  }
  if (global.length > 0) parts.push(global)
  if (project.length > 0) parts.push(project)
  return parts.join("\n\n")
}

/** One rules source. Either a `path` (and possibly `content` if
 *  read) and a flag indicating whether this source was contributed
 *  to the final concatenation (i.e. suppressed by override or empty). */
export interface RuleSource {
  /** Stable id for the source. One of: "bundled" | "globalOverride" | "global" | "project" */
  id: "bundled" | "globalOverride" | "global" | "project"
  /** Absolute filesystem path. */
  path: string
  /** UTF-8 contents ("" if missing or unreadable). */
  content: string
  /** Line count of `content`. 0 when the file is missing/empty. */
  lineCount: number
  /** When true, the bundled file was not contributed to the final
   *  concatenation because the global override replaced it. */
  suppressed: boolean
  /** When true, the file was present and contributed to the final
   *  concatenation. (Empty files are present but contribute nothing.) */
  present: boolean
}

/** Read each of the four rules sources and return its state. Does
 *  not concatenate — callers (the Rules view, the test harness, etc.)
 *  can render each source independently. */
export async function loadRuleSources(
  cwd: string,
  homedirFn: () => string = homedir,
  importMetaUrl: string = import.meta.url,
  paths?: RulesPaths,
): Promise<RuleSource[]> {
  const resolved = paths ?? resolvePaths(cwd, homedirFn, importMetaUrl)

  const [bundled, globalOverride, global, project] = await Promise.all([
    safeRead(resolved.bundled),
    safeRead(resolved.globalOverride),
    safeRead(resolved.global),
    safeRead(resolved.project),
  ])

  const overrideActive = globalOverride.length > 0
  const list: RuleSource[] = []

  list.push({
    id: "bundled",
    path: resolved.bundled,
    content: bundled,
    lineCount: countLines(bundled),
    suppressed: overrideActive,
    present: !overrideActive && bundled.length > 0,
  })

  list.push({
    id: "globalOverride",
    path: resolved.globalOverride,
    content: globalOverride,
    lineCount: countLines(globalOverride),
    suppressed: false,
    present: globalOverride.length > 0,
  })

  list.push({
    id: "global",
    path: resolved.global,
    content: global,
    lineCount: countLines(global),
    suppressed: false,
    present: global.length > 0,
  })

  list.push({
    id: "project",
    path: resolved.project,
    content: project,
    lineCount: countLines(project),
    suppressed: false,
    present: project.length > 0,
  })

  return list
}

function countLines(s: string): number {
  if (s.length === 0) return 0
  return s.split("\n").length
}

/** Result of saving a rules file. */
export interface SaveRulesResult {
  /** True when the file was written. False when the save was a no-op
   *  (the content matched what's already on disk). */
  saved: boolean
  /** Absolute path of the file that was written. */
  path: string
}

/** Persist a rules file's new content to disk. Creates the parent
 *  directory if it doesn't exist (so the user can save a fresh rules
 *  file at a path that has never been written to).
 *
 *  Does NOT touch the bundled or override files — those are part of
 *  the package / a deliberate user choice, and the editor refuses to
 *  open them as editable. The check is enforced at the call site,
 *  not here, so this function is reusable for any path.
 *
 *  On a write error, returns `{ saved: false, path }` rather than
 *  throwing. The caller surfaces the error to the user; the gate
 *  itself never depends on a successful save. */
export async function saveRulesFile(
  path: string,
  content: string,
  deps: { writeFile?: typeof writeFile } = {},
): Promise<SaveRulesResult> {
  const writer = deps.writeFile ?? writeFile
  try {
    await mkdir(dirname(path), { recursive: true })
    await writer(path, content, "utf8")
    return { saved: true, path }
  } catch {
    return { saved: false, path }
  }
}

/** Stable label for each rule-file source, used in the menu. */
export const SOURCE_LABELS: Record<RuleSource["id"], string> = {
  bundled: "built-in",
  globalOverride: "override",
  global: "user",
  project: "project",
}

/** Result of building the rules-list SelectItems for the UI. */
export interface RulesListView {
  /** Items in display order. Suppressed sources are filtered out. */
  items: {
    value: RuleSource["id"]
    label: string
    description: string
  }[]
  /** When non-null, a header line explaining why the bundled source
   *  is missing from the list. */
  suppressionNote: string | null
  /** The full set of RuleSources, in the same order as `items`. */
  sources: RuleSource[]
}

/** Build the SelectItem[] for the rules menu, plus a status note for
 *  the suppression case. Pure: takes a list of RuleSources, returns
 *  the menu shape. Tested directly without a TUI. */
export function buildRulesList(sources: RuleSource[]): RulesListView {
  const bundled = sources.find((s) => s.id === "bundled")
  const suppressionNote = bundled?.suppressed
    ? `Built-in is suppressed by the global override (${bundled.path} → ${sources.find((s) => s.id === "globalOverride")?.path})`
    : null

  const visible = sources.filter((s) => !(s.id === "bundled" && s.suppressed))

  const items = visible.map((s) => ({
    value: s.id,
    label: labelFor(s),
    description: s.path,
  }))

  return { items, suppressionNote, sources: visible }
}

function labelFor(s: RuleSource): string {
  const idLabel = SOURCE_LABELS[s.id]
  if (!s.present) {
    return `${idLabel} — (missing)`
  }
  if (s.lineCount === 0) {
    return `${idLabel} — 0 lines (empty)`
  }
  return `${idLabel} — ${s.lineCount} lines`
}

/**
 * Read a file as UTF-8 text. Any error path returns "" — ENOENT,
 * EACCES, EISDIR, anything. We do not want a broken rules file to
 * crash the agent loop.
 */
async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch {
    return ""
  }
}
