import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

import type { AnyVerdict, AspectRule, Config, ToolRuleEntry } from "./types.ts"

/** Persistence scope for a new rule. */
export type RuleScope = "user" | "project"

const PROJECT_PATH = (cwd: string) => join(cwd, ".pi", "tool-policy.json")
const USER_PATH = () => join(homedir(), ".pi", "tool-policy.json")

/**
 * Read the raw config for the given scope, returning an empty object if
 * missing. Does NOT apply STOCK_CONFIG — that's the loader's job. The writer
 * preserves the user's existing structure.
 */
async function readScopeConfig(scope: RuleScope, cwd: string): Promise<Partial<Config>> {
  const path = scope === "user" ? USER_PATH() : PROJECT_PATH(cwd)
  try {
    const raw = await readFile(path, "utf-8")
    return JSON.parse(raw) as Partial<Config>
  } catch {
    return {}
  }
}

async function writeScopeConfig(scope: RuleScope, cwd: string, config: Partial<Config>): Promise<void> {
  const path = scope === "user" ? USER_PATH() : PROJECT_PATH(cwd)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(config, null, 2), "utf-8")
}

/**
 * Add a `toolRule` entry to the active mode's `toolRules[toolName]` list in
 * the given scope. The new entry is APPENDED to the existing list (so the
 * user's existing order is preserved — and the matcher's per-mode fold is
 * order-independent so it doesn't matter).
 */
export async function addToolRule(
  scope: RuleScope,
  cwd: string,
  modeName: string,
  toolName: string,
  entry: ToolRuleEntry,
): Promise<void> {
  const config = await readScopeConfig(scope, cwd)
  const modes = { ...(config.modes ?? {}) }
  const mode = { ...(modes[modeName] ?? {}) } as Config["modes"][string]
  const toolRules: Record<string, ToolRuleEntry[]> = { ...mode.toolRules }
  toolRules[toolName] = [...(toolRules[toolName] ?? []), entry]
  mode.toolRules = toolRules
  modes[modeName] = mode
  await writeScopeConfig(scope, cwd, { ...config, modes })
}

/**
 * Convenience: add a "broad" `toolRule` entry (no fields clause — matches
 * every call to the tool). Equivalent to:
 *   addToolRule(scope, cwd, modeName, toolName, { verdict: "allow" })
 */
export async function addBroadAllow(scope: RuleScope, cwd: string, modeName: string, toolName: string): Promise<void> {
  return addToolRule(scope, cwd, modeName, toolName, { verdict: "allow" })
}

/**
 * Add an aspect-rule pattern. The pattern is added to the named
 * aspect's `patterns` map; existing patterns are preserved. If the
 * aspect rule (or its patterns map) doesn't exist yet, it's created.
 * The pattern's verdict is `allow` by default.
 */
export async function addAspectRule(
  scope: RuleScope,
  cwd: string,
  modeName: string,
  aspectName: string,
  pattern: string,
  verdict: AnyVerdict = "allow",
): Promise<void> {
  if (pattern.length === 0) throw new Error("addAspectRule: pattern must be non-empty")
  const config = await readScopeConfig(scope, cwd)
  const modes = { ...(config.modes ?? {}) }
  const mode = { ...(modes[modeName] ?? {}) } as Config["modes"][string]
  const aspectRules: Record<string, AspectRule> = { ...mode.aspectRules }
  const existing: AspectRule = aspectRules[aspectName] ?? { patterns: {} }
  const patterns: Record<string, AnyVerdict> = { ...existing.patterns, [pattern]: verdict }
  aspectRules[aspectName] = { ...existing, patterns }
  mode.aspectRules = aspectRules
  modes[modeName] = mode
  await writeScopeConfig(scope, cwd, { ...config, modes })
}
