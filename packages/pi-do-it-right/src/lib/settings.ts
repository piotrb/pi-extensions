/**
 * settings — JSON config-file loader for the extension's runtime knobs.
 *
 * Reads one file at session start:
 *   ~/.pi/agent/auto-reject-rules.json
 *
 * Schema (all fields optional; defaults applied on load):
 *
 *   {
 *     "model": { "provider": "anthropic", "id": "claude-haiku-4-5" }
 *   }
 *
 * Missing file (ENOENT) returns DEFAULT_SETTINGS silently. Malformed JSON
 * also returns DEFAULT_SETTINGS and emits a one-line warning — a corrupt
 * config file should never crash the agent loop.
 *
 * The `homedirFn` parameter is an injection seam for tests — production
 * callers omit it and get the real `os.homedir()`. Mirrors `rules.ts`.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ModelRef {
  provider: string
  id: string
}

export interface Settings {
  model: ModelRef
}

export const DEFAULT_SETTINGS: Settings = {
  model: { provider: "anthropic", id: "claude-haiku-4-5" },
}

export function settingsPath(home: string = homedir()): string {
  return join(home, ".pi", "agent", "auto-reject-rules.json")
}

/**
 * Load the user's settings file and apply defaults.
 *
 * Swallows ALL errors (ENOENT, EACCES, EISDIR, JSON parse errors) — the
 * extension is fail-open by design, and a broken config file is the same
 * class of failure as a broken rules file.
 *
 * Malformed JSON triggers a single stderr warn so the user knows their
 * config is being ignored.
 */
export async function loadSettings(homedirFn: () => string = homedir): Promise<Settings> {
  const path = settingsPath(homedirFn())
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch {
    return DEFAULT_SETTINGS
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(`[do-it-right] ${path} is not valid JSON; using defaults: ${String(err)}`)
    return DEFAULT_SETTINGS
  }

  return mergeWithDefaults(parsed)
}

/** Apply default values to a parsed-but-unvalidated settings blob.
 *  Returns DEFAULT_SETTINGS when any required field is missing or of the
 *  wrong type — strict semantics: a partially-valid config is treated as
 *  no config at all. The user can always start with the defaults and
 *  edit one field at a time to learn what's accepted. */
function mergeWithDefaults(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS
  const obj = raw as Record<string, unknown>

  const modelRaw = obj.model
  if (typeof modelRaw !== "object" || modelRaw === null) return DEFAULT_SETTINGS
  const modelObj = modelRaw as Record<string, unknown>

  if (typeof modelObj.provider !== "string") return DEFAULT_SETTINGS
  if (typeof modelObj.id !== "string") return DEFAULT_SETTINGS

  return { model: { provider: modelObj.provider, id: modelObj.id } }
}

/**
 * Save settings to disk, atomic via write-then-rename.
 *
 * Writes `<path>.tmp`, then `rename`s it over the real path. A crash
 * between write and rename leaves the original file intact; a reader
 * either sees the old file (full) or sees no file (defaults apply
 * fail-open). Either way the agent loop survives.
 *
 * `homedirFn` and `settingsDirFn` are injection seams for tests.
 */
export async function saveSettings(settings: Settings, homedirFn: () => string = homedir): Promise<void> {
  const path = settingsPath(homedirFn())
  const tmpPath = `${path}.tmp`
  const json = JSON.stringify(settings, null, 2) + "\n"
  // Ensure the parent directory exists on first save — a freshly installed
  // pi may not have ~/.pi/agent/ yet. mkdir(..., {recursive: true}) is a
  // no-op when the directory already exists.
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(tmpPath, json, "utf8")
  await rename(tmpPath, path)
}
