/**
 * runner-config — config loading and persistence for the runner extension.
 *
 * Extracted from task-runner.ts so both the extension and the modal UI can
 * share the same config logic without a circular dependency.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { RuleLevel, RuleScope } from "./permissions.ts"
import { type Rule } from "./permissions.ts"

// ─── types ───────────────────────────────────────────────────────────────────

export interface RunnerConfig {
  rules?: Record<string, RuleLevel>
  /** Whether to wrap commands with the `rtk` binary when it is present on PATH. Defaults to true. */
  rtkEnabled?: boolean
  // legacy fields — present only in old-format configs, migrated on read
  allowedCommands?: string[]
  deniedCommands?: string[]
  replaceDefaults?: boolean
}

export interface LoadRulesResult {
  rules: Rule[]
  upgraded: string[] // paths of files that were auto-migrated
}

// ─── scope file map ──────────────────────────────────────────────────────────

export const SCOPE_FILES: { scope: RuleScope; path: (cwd: string) => string }[] = [
  { scope: "project", path: (cwd) => join(cwd, ".pi", "runner.json") },
  { scope: "user", path: () => join(homedir(), ".pi", "runner.json") },
  { scope: "global", path: () => join(homedir(), ".pi", "agent", "runner.json") },
]

// Parallel array of old task-runner.json paths, one per scope.
export const LEGACY_FILES: { scope: RuleScope; legacyPath: (cwd: string) => string }[] = [
  { scope: "project", legacyPath: (cwd) => join(cwd, ".pi", "task-runner.json") },
  { scope: "user", legacyPath: () => join(homedir(), ".pi", "task-runner.json") },
  { scope: "global", legacyPath: () => join(homedir(), ".pi", "agent", "task-runner.json") },
]

/**
 * The two scopes exposed in the modal UI.  "global" (~/.pi/agent/runner.json)
 * is barely distinguishable from "user" (~/.pi/runner.json) and is not offered
 * as a target when adding or editing rules.  Existing global rules are still
 * loaded and displayed for reference.
 */
export const UI_SCOPES: { scope: "project" | "user"; label: string; pathHint: (cwd: string) => string }[] = [
  { scope: "project", label: "project", pathHint: (cwd) => join(cwd, ".pi", "runner.json") },
  { scope: "user", label: "user", pathHint: () => join(homedir(), ".pi", "runner.json") },
]

// ─── legacy migration ────────────────────────────────────────────────────────

/** Convert the allowedCommands/deniedCommands/replaceDefaults fields into a rules map. */
export function convertLegacyFields(raw: RunnerConfig): Record<string, RuleLevel> {
  const rules: Record<string, RuleLevel> = { ...(raw.rules ?? {}) }
  for (const pattern of raw.allowedCommands ?? []) {
    if (!(pattern in rules)) rules[pattern] = "allow"
  }
  for (const pattern of raw.deniedCommands ?? []) {
    if (!(pattern in rules)) rules[pattern] = "deny"
  }
  return rules
}

/**
 * If legacyPath (task-runner.json) exists and newPath (runner.json) does not,
 * convert the content and write it to newPath.  Returns true if migration was
 * performed.
 */
export function migrateLegacyFile(legacyPath: string, newPath: string): boolean {
  if (!existsSync(legacyPath) || existsSync(newPath)) return false
  try {
    const raw = JSON.parse(readFileSync(legacyPath, "utf-8")) as RunnerConfig
    const rules = convertLegacyFields(raw)
    const { allowedCommands: _a, deniedCommands: _d, replaceDefaults: _r, ...rest } = raw
    const migrated: RunnerConfig = { ...rest, rules }
    mkdirSync(dirname(newPath), { recursive: true })
    writeFileSync(newPath, JSON.stringify(migrated, null, 2) + "\n", "utf-8")
    rmSync(legacyPath)
    return true
  } catch {
    return false
  }
}

/**
 * If the file uses the old allowedCommands/deniedCommands format, migrate it
 * to the rules map in place and return true.
 */
export function upgradeConfigIfNeeded(filePath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as RunnerConfig
    const hasOld =
      Array.isArray(raw.allowedCommands) || Array.isArray(raw.deniedCommands) || raw.replaceDefaults !== undefined
    if (!hasOld) return false

    const rules = convertLegacyFields(raw)
    const { allowedCommands: _a, deniedCommands: _d, replaceDefaults: _r, ...rest } = raw
    const upgraded: RunnerConfig = { ...rest, rules }
    writeFileSync(filePath, JSON.stringify(upgraded, null, 2) + "\n", "utf-8")
    return true
  } catch {
    return false
  }
}

// ─── load ─────────────────────────────────────────────────────────────────────

export function loadRules(cwd: string): LoadRulesResult {
  const rules: Rule[] = []
  const upgraded: string[] = []

  // First pass: migrate any old task-runner.json → runner.json (filename + format)
  for (const legacy of LEGACY_FILES) {
    const scopeFile = SCOPE_FILES.find((f) => f.scope === legacy.scope)
    if (!scopeFile) continue
    if (migrateLegacyFile(legacy.legacyPath(cwd), scopeFile.path(cwd))) {
      upgraded.push(scopeFile.path(cwd))
    }
  }

  // Second pass: load runner.json files, upgrading format if still needed
  for (const { scope, path } of SCOPE_FILES) {
    const p = path(cwd)
    if (!existsSync(p)) continue
    if (upgradeConfigIfNeeded(p)) upgraded.push(p)
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as RunnerConfig
      if (raw.rules && typeof raw.rules === "object" && !Array.isArray(raw.rules)) {
        for (const [pattern, level] of Object.entries(raw.rules)) {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (level === "allow" || level === "ask" || level === "deny") {
            rules.push({ pattern, level, scope })
          }
        }
      }
    } catch {
      // ignore malformed config
    }
  }

  return { rules, upgraded }
}

// ─── write / delete ───────────────────────────────────────────────────────────

/** Resolve the config file path for a given scope. */
export function scopeToConfigPath(scope: RuleScope, cwd: string): string {
  const entry = SCOPE_FILES.find((f) => f.scope === scope)
  if (!entry) throw new Error(`Unknown scope: ${scope}`)
  return entry.path(cwd)
}

/** Write or overwrite a single rule in the given config file. */
export function writeRuleToFile(configPath: string, pattern: string, level: RuleLevel): void {
  let config: RunnerConfig = {}
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8")) as RunnerConfig
    } catch {
      // start fresh on malformed file
    }
  }
  config.rules = { ...(config.rules ?? {}), [pattern]: level }
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
}

// ─── rtk setting ─────────────────────────────────────────────────────────────

const USER_CONFIG_PATH = join(homedir(), ".pi", "runner.json")

/**
 * Read whether RTK wrapping is enabled.  Stored in the user-level config
 * (~/.pi/runner.json) and defaults to true when not explicitly set.
 */
export function readRtkEnabled(): boolean {
  if (!existsSync(USER_CONFIG_PATH)) return true
  try {
    const config = JSON.parse(readFileSync(USER_CONFIG_PATH, "utf-8")) as RunnerConfig
    return config.rtkEnabled !== false
  } catch {
    return true
  }
}

/** Persist the RTK enabled flag to the user-level config. */
export function writeRtkEnabled(enabled: boolean): void {
  let config: RunnerConfig = {}
  if (existsSync(USER_CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(USER_CONFIG_PATH, "utf-8")) as RunnerConfig
    } catch {
      // start fresh on malformed file
    }
  }
  config.rtkEnabled = enabled
  mkdirSync(dirname(USER_CONFIG_PATH), { recursive: true })
  writeFileSync(USER_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8")
}

/** Remove a single rule from the given config file. Does nothing if not found. */
export function removeRuleFromFile(configPath: string, pattern: string): void {
  if (!existsSync(configPath)) return
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as RunnerConfig
    if (!config.rules || !(pattern in config.rules)) return
    const { [pattern]: _removed, ...rest } = config.rules
    config.rules = rest
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
  } catch {
    // ignore
  }
}
