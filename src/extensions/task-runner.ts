/**
 * runner — a safer, structured replacement for the bash tool.
 *
 * Instead of freeform shell strings, the LLM passes a cmd array.
 * Commands are validated against an allowlist before execution.
 * Output streams in real-time and is truncated by default (ctrl+o to expand).
 *
 * Config files (merged in order, project wins):
 *   ~/.pi/agent/runner.json
 *   ~/.pi/runner.json
 *   <cwd>/.pi/runner.json
 *
 * Config schema:
 * {
 *   "allowedCommands": [
 *     "pnpm run *",        // any pnpm run subcommand  (trailing-space wildcard)
 *     "pnpm:*",           // same — :* suffix is equivalent to trailing ' *'
 *     "npm run build",    // exact match, no wildcard
 *     "git * --dry-run",  // * anywhere, spans multiple words
 *     "* --version"       // any command ending with --version
 *   ],
 *   "deniedCommands": [
 *     "pnpm run deploy *" // deny takes precedence over allow
 *   ]
 * }
 *
 * Pattern syntax (mirrors Claude Code's Bash permission syntax):
 *   No wildcard    — exact match against the joined command string
 *   Trailing ' *'  — prefix match with word boundary (space or end-of-string)
 *   Trailing ':*'  — identical to trailing ' *'
 *   '*' elsewhere  — glob-style: * matches any sequence of chars including spaces
 *   Standalone '*' — matches everything
 *
 * Evaluation order: deny → allow → blocked. Deny rules always win.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve as resolvePath } from "node:path"

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui"
import minimist from "minimist"
import { Type } from "typebox"

import { progressiveKill, spawnStreaming } from "../lib/extension-utils.ts"
import { checkRules, type Rule, type RuleLevel, type RuleScope } from "../lib/permissions.ts"

// ─── constants ───────────────────────────────────────────────────────────────

const DEFAULT_VISIBLE_LINES = 20

// ─── config ──────────────────────────────────────────────────────────────────
//
// Config files are plain JSON, loaded from three locations (project wins):
//
//   1. <cwd>/.pi/runner.json     — project-local  (highest priority)
//   2. ~/.pi/runner.json         — user-global
//   3. ~/.pi/agent/runner.json   — user-global alternative (lowest priority)
//
// The most specific matching pattern wins across all files.  When two patterns
// tie on specificity, project beats user beats global.
//
// Schema:
// {
//   "rules": {
//     "pnpm run *": "allow",   // prefix pattern
//     "rm *":       "deny",
//     "*":          "ask"      // catch-all — interactive approval (pending)
//   }
// }

interface RunnerConfig {
  rules?: Record<string, RuleLevel>
  // legacy fields — present only in old-format configs, migrated on read
  allowedCommands?: string[]
  deniedCommands?: string[]
  replaceDefaults?: boolean
}

const SCOPE_FILES: { scope: RuleScope; path: (cwd: string) => string }[] = [
  { scope: "project", path: (cwd) => join(cwd, ".pi", "runner.json") },
  { scope: "user", path: () => join(homedir(), ".pi", "runner.json") },
  { scope: "global", path: () => join(homedir(), ".pi", "agent", "runner.json") },
]

// Parallel array of old task-runner.json paths, one per scope.
const LEGACY_FILES: { scope: RuleScope; legacyPath: (cwd: string) => string }[] = [
  { scope: "project", legacyPath: (cwd) => join(cwd, ".pi", "task-runner.json") },
  { scope: "user", legacyPath: () => join(homedir(), ".pi", "task-runner.json") },
  { scope: "global", legacyPath: () => join(homedir(), ".pi", "agent", "task-runner.json") },
]

/** Convert the allowedCommands/deniedCommands/replaceDefaults fields into a rules map. */
function convertLegacyFields(raw: RunnerConfig): Record<string, RuleLevel> {
  const rules: Record<string, RuleLevel> = { ...(raw.rules ?? {}) }
  for (const pattern of raw.allowedCommands ?? []) {
    if (!(pattern in rules)) rules[pattern] = "allow"
  }
  for (const pattern of raw.deniedCommands ?? []) {
    if (!(pattern in rules)) rules[pattern] = "deny"
  }
  // replaceDefaults is dropped — the concept no longer exists
  return rules
}

/**
 * If legacyPath (task-runner.json) exists and newPath (runner.json) does not,
 * convert the content and write it to newPath.  Returns true if migration was
 * performed.  Skips if runner.json already exists to avoid overwriting.
 */
function migrateLegacyFile(legacyPath: string, newPath: string): boolean {
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
 * to the rules map in place and return true.  No-ops and returns false if the
 * file is already in the new format or cannot be read/written.
 */
function upgradeConfigIfNeeded(filePath: string): boolean {
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

interface LoadRulesResult {
  rules: Rule[]
  upgraded: string[] // paths of files that were auto-migrated
}

function loadRules(cwd: string): LoadRulesResult {
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

// ─── helpers ─────────────────────────────────────────────────────────────────

function shellQuote(arg: string): string {
  // Only quote if the arg contains characters that need escaping
  if (/[^a-zA-Z0-9._\-/=:@%,+~]/.test(arg)) {
    return "'" + arg.replace(/'/g, "'\\''") + "'"
  }
  return arg
}

function formatCmd(cmd: string[]): string {
  return cmd.map(shellQuote).join(" ")
}

// ─── tool details type ───────────────────────────────────────────────────────

interface RunDetails {
  cmd: string[]
  cwd: string
  exitCode: number | null
  totalLines: number
  streaming?: boolean
}

// ─── extension ───────────────────────────────────────────────────────────────

function buildDescription(cwd: string): string {
  const { rules } = loadRules(cwd)
  const seen = new Set<string>()
  const launchers: string[] = []
  for (const { pattern, level } of rules) {
    if (level !== "allow") continue
    const key = pattern.split(/[ :*]/)[0] ?? pattern
    if (key && !seen.has(key)) {
      seen.add(key)
      launchers.push(key)
    }
  }
  const launcherClause =
    launchers.length > 0
      ? `Limited to configured launchers: ${launchers.join(", ")}.`
      : "No launchers configured — add allow rules via runner.json."
  return [
    `Run a bash command. ${launcherClause}`,
    "Pass cmd as an array of strings — no shell interpolation, no freeform strings.",
    "Disallowed commands return an error listing the permitted patterns.",
    "Configure rules via runner.json at .pi/, ~/.pi/, or ~/.pi/agent/.",
  ].join(" ")
}

// ─── running task registry ───────────────────────────────────────────────────

interface RunningTask {
  toolCallId: string
  label: string
  kill: () => void
}

const runningTasks = new Map<string, RunningTask>()

const WIDGET_KEY = "runner-kill-hint"

function updateTaskWidget(ctx: ExtensionContext): void {
  if (runningTasks.size === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined)
    return
  }
  const count = runningTasks.size
  const taskWord = count === 1 ? "task" : "tasks"
  ctx.ui.setWidget(
    WIDGET_KEY,
    (_tui, theme) => {
      const line = theme.fg("warning", `◉ ${count} ${taskWord} running`) + theme.fg("dim", "  alt+k to kill")
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      return { render: () => [line], invalidate: () => {} }
    },
    { placement: "belowEditor" },
  )
}

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── kill shortcut ─────────────────────────────────────────────────────────

  pi.registerShortcut("alt+k", {
    description: "Kill a running task",
    handler: async (ctx) => {
      if (runningTasks.size === 0) {
        ctx.ui.notify("No tasks running", "info")
        return
      }

      const items: SelectItem[] = [...runningTasks.values()].map((t) => ({
        value: t.toolCallId,
        label: t.label,
      }))

      const result = await ctx.ui.custom<string | null>(
        (tui, theme, _kb, done) => {
          const container = new Container()
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
          container.addChild(new Text(theme.fg("accent", theme.bold("Kill Task")), 1, 0))

          const selectList = new SelectList(items, Math.min(items.length, 10), {
            selectedPrefix: (t) => theme.fg("error", t),
            selectedText: (t) => theme.fg("error", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          })
          selectList.onSelect = (item) => {
            done(item.value)
          }
          selectList.onCancel = () => {
            done(null)
          }
          container.addChild(selectList)
          container.addChild(new Text(theme.fg("dim", "↑↓ navigate  •  enter kill  •  esc cancel"), 1, 0))
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

          return {
            render: (w) => container.render(w),
            invalidate: () => {
              container.invalidate()
            },
            handleInput: (data) => {
              selectList.handleInput(data)
              tui.requestRender()
            },
          }
        },
        { overlay: true, overlayOptions: { width: "60%", minWidth: 44 } },
      )

      if (result != null) {
        const task = runningTasks.get(result)
        if (task) {
          task.kill()
          ctx.ui.notify(`Killing: ${task.label}`, "info")
        }
      }
    },
  })

  pi.registerTool({
    name: "run",
    label: "Run",
    description: buildDescription(process.cwd()),

    parameters: Type.Object({
      cmd: Type.Array(Type.String(), {
        description: 'Command + arguments as an array, e.g. ["pnpm", "run", "build"]',
        minItems: 1,
      }),
      env: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Extra environment variables to inject",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Working directory (default: project root)",
        }),
      ),
    }),

    // ── execute ──────────────────────────────────────────────────────────────

    async execute(_toolCallId: string, params, signal, onUpdate, ctx) {
      if (!Array.isArray(params.cmd)) {
        return {
          content: [{ type: "text" as const, text: 'cmd must be an array of strings, e.g. ["pnpm", "run", "build"]' }],
          details: { cmd: [], cwd: ctx.cwd, exitCode: -1, totalLines: 0 },
          isError: true,
        }
      }

      const { rules, upgraded } = loadRules(ctx.cwd)
      if (upgraded.length > 0) {
        ctx.ui.notify(
          `runner: auto-migrated ${upgraded.length} config file${upgraded.length > 1 ? "s" : ""} to the new rules format:\n` +
            upgraded.map((p) => `  ${p}`).join("\n"),
          "info",
        )
      }
      const verdict = checkRules(params.cmd, rules)

      // ── permission check ────────────────────────────────────────────────────
      if (verdict !== "allow") {
        let errorLines: string[]
        if (verdict === "ask") {
          errorLines = [`Command requires approval (interactive mode not yet available): ${formatCmd(params.cmd)}`]
        } else if (verdict === "deny") {
          const denyRules = rules.filter((r) => r.level === "deny")
          errorLines = [
            `Command denied: ${formatCmd(params.cmd)}`,
            "",
            "Denied patterns:",
            ...denyRules.map((r) => `  • ${r.pattern}  [${r.scope}]`),
          ]
        } else {
          const allowRules = rules.filter((r) => r.level === "allow")
          errorLines = [
            `Command not allowed: ${formatCmd(params.cmd)}`,
            "",
            allowRules.length > 0
              ? `Allowed patterns:\n${allowRules.map((r) => `  • ${r.pattern}  [${r.scope}]`).join("\n")}`
              : "No allow rules configured. Add rules via runner.json or /runner-permission.",
          ]
        }
        return {
          content: [{ type: "text" as const, text: errorLines.join("\n") }],
          details: { cmd: params.cmd, cwd: ctx.cwd, exitCode: -1, totalLines: 0 },
          isError: true,
        }
      }

      // ── run ────────────────────────────────────────────────────────────────
      const workingDir = params.cwd ? resolvePath(ctx.cwd, params.cwd) : ctx.cwd

      const [bin, ...args] = params.cmd

      const { lines, exitCode, spawnError } = await spawnStreaming(bin, args, {
        cwd: workingDir,
        signal,
        env: params.env,
        onSpawn: (child) => {
          runningTasks.set(_toolCallId, {
            toolCallId: _toolCallId,
            label: formatCmd(params.cmd),
            kill: () => progressiveKill(child),
          })
          updateTaskWidget(ctx)
        },
        onLines: (accumulated) => {
          onUpdate?.({
            content: [{ type: "text", text: accumulated.join("\n") }],
            details: {
              cmd: params.cmd,
              cwd: workingDir,
              exitCode: null,
              totalLines: accumulated.length,
              streaming: true,
            },
          })
        },
      })

      runningTasks.delete(_toolCallId)
      updateTaskWidget(ctx)

      if (spawnError) {
        return {
          content: [{ type: "text" as const, text: spawnError }],
          details: { cmd: params.cmd, cwd: workingDir, exitCode: -1, totalLines: 0 },
          isError: true,
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { cmd: params.cmd, cwd: workingDir, exitCode, totalLines: lines.length },
        isError: exitCode !== 0,
      }
    },

    // ── renderCall ───────────────────────────────────────────────────────────

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("$ "))
      text += theme.fg("accent", formatCmd(args.cmd))
      if (args.cwd) {
        text += theme.fg("dim", `  (in ${args.cwd})`)
      }
      if (args.env && Object.keys(args.env).length > 0) {
        const envStr = Object.entries(args.env)
          .map(([k, v]) => `${k}=${shellQuote(v)}`)
          .join(" ")
        text += theme.fg("dim", `  env: ${envStr}`)
      }
      return new Text(text, 0, 0)
    },

    // ── renderResult ─────────────────────────────────────────────────────────

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as RunDetails | undefined
      const content = result.content[0]
      const raw = content.type === "text" ? content.text : ""
      const lines = raw.length > 0 ? raw.split("\n") : []
      const totalLines = lines.length

      // ── streaming (partial) ───────────────────────────────────────────────
      if (isPartial) {
        const tail = lines.slice(-DEFAULT_VISIBLE_LINES)
        let text = theme.fg("warning", "▶ running…")
        if (tail.length > 0) {
          const hidden = totalLines - tail.length
          if (hidden > 0) {
            text += "\n" + theme.fg("muted", `  (${hidden} earlier lines)`)
          }
          text += "\n" + tail.map((l) => theme.fg("dim", l)).join("\n")
        }
        return new Text(text, 0, 0)
      }

      // ── finished ──────────────────────────────────────────────────────────
      const exitCode = details?.exitCode ?? null
      const failed = exitCode !== null && exitCode !== 0

      // status badge
      let text = failed ? theme.fg("error", `✗ exit ${exitCode}`) : theme.fg("success", "✓ done")

      text += theme.fg("dim", `  ${totalLines} line${totalLines !== 1 ? "s" : ""}`)

      if (totalLines === 0) {
        text += theme.fg("muted", "  (no output)")
        return new Text(text, 0, 0)
      }

      if (expanded) {
        // show everything
        text += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n")
      } else {
        // show first DEFAULT_VISIBLE_LINES, then a hint
        const visible = lines.slice(0, DEFAULT_VISIBLE_LINES)
        text += "\n" + visible.map((l) => theme.fg("dim", l)).join("\n")

        const hidden = totalLines - visible.length
        if (hidden > 0) {
          text += "\n" + theme.fg("muted", `  (${hidden} more line${hidden !== 1 ? "s" : ""},  ctrl+o to expand)`)
        }
      }

      return new Text(text, 0, 0)
    },
  })

  // ── /runner-permission ────────────────────────────────────────────────────────

  pi.registerCommand("runner-permission", {
    description:
      "Manage runner permission rules. " +
      "Usage: /runner-permission list  |  /runner-permission [allow|ask|deny] [--user|--global] [--remove] <pattern>  " +
      "--user writes to ~/.pi/runner.json, --global to ~/.pi/agent/runner.json  " +
      "(default: <cwd>/.pi/runner.json)",

    getArgumentCompletions(prefix) {
      const tokens = prefix.trimStart().split(/\s+/)
      const first = tokens[0] ?? ""
      const second = tokens[1] ?? ""

      // First token: suggest subcommand or level
      if (tokens.length <= 1) {
        return ["list", "allow", "ask", "deny"]
          .filter((t) => t.startsWith(first))
          .map((value) => ({ value, label: value }))
      }

      // Second token: flags (only for level subcommands, not list)
      if (tokens.length === 2 && first !== "list") {
        const flags = [
          { value: "--user", description: "Write to ~/.pi/runner.json" },
          { value: "--global", description: "Write to ~/.pi/agent/runner.json" },
          { value: "--remove", description: "Remove the pattern instead of adding it" },
        ]
        const suggestions = flags
          .filter((f) => !tokens.includes(f.value) && f.value.startsWith(second))
          .map((f) => ({ value: f.value, label: f.value, description: f.description }))
        if (suggestions.length > 0) return suggestions
      }

      return null
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async handler(args, ctx) {
      // Parse: list  |  [allow|ask|deny] [--user] [--global] [--remove] <pattern...>
      const parsed = minimist(args.trim().split(/\s+/).filter(Boolean), {
        boolean: ["user", "global", "remove"],
        default: { user: false, global: false, remove: false },
      })

      const subcommand = parsed._[0] as string | undefined

      // Always run upgrade check and surface any migrations
      const { rules, upgraded } = loadRules(ctx.cwd)
      if (upgraded.length > 0) {
        const home = homedir()
        ctx.ui.notify(
          `runner: auto-migrated ${upgraded.length} config file${upgraded.length > 1 ? "s" : ""} to the new rules format:\n` +
            upgraded.map((p) => `  ${p.replace(home, "~")}`).join("\n"),
          "info",
        )
      }

      // ── list ───────────────────────────────────────────────────────────────
      if (subcommand === "list") {
        const home = homedir()
        const scopeOrder: RuleScope[] = ["project", "user", "global"]
        const sections = scopeOrder.map((scope) => {
          const entry = SCOPE_FILES.find((f) => f.scope === scope)
          if (!entry) return ""
          const filePath = entry.path(ctx.cwd).replace(home, "~")
          const scopeRules = rules.filter((r) => r.scope === scope)
          if (scopeRules.length === 0) {
            return `${scope.toUpperCase()}  (${filePath})\n  (no rules)`
          }
          const maxLen = Math.max(...scopeRules.map((r) => r.pattern.length))
          const rows = scopeRules.map((r) => `  ${r.pattern.padEnd(maxLen)}  → ${r.level}`).join("\n")
          return `${scope.toUpperCase()}  (${filePath})\n${rows}`
        })
        ctx.ui.notify("runner rules\n\n" + sections.join("\n\n"), "info")
        return
      }

      // ── add / remove ───────────────────────────────────────────────────────
      const level = subcommand
      const pattern = parsed._.slice(1).join(" ")

      if (level !== "allow" && level !== "ask" && level !== "deny") {
        ctx.ui.notify(
          "Usage:\n" +
            "  /runner-permission list\n" +
            "  /runner-permission [allow|ask|deny] [--user|--global] [--remove] <pattern>\n\n" +
            "  allow    — run the command without prompting\n" +
            "  ask      — require interactive approval (pending)\n" +
            "  deny     — always block the command\n" +
            "  --user   — write to ~/.pi/runner.json\n" +
            "  --global — write to ~/.pi/agent/runner.json\n" +
            "  --remove — remove the pattern instead of adding it",
          "info",
        )
        return
      }

      if (!pattern) {
        ctx.ui.notify("Error: no pattern specified.", "error")
        return
      }

      // Resolve target file and scope label
      let configPath: string
      let scopeLabel: string
      if (parsed.global) {
        configPath = join(homedir(), ".pi", "agent", "runner.json")
        scopeLabel = "global"
      } else if (parsed.user) {
        configPath = join(homedir(), ".pi", "runner.json")
        scopeLabel = "user"
      } else {
        configPath = join(ctx.cwd, ".pi", "runner.json")
        scopeLabel = "project"
      }

      // Read existing config or start fresh
      let config: RunnerConfig = {}
      if (existsSync(configPath)) {
        try {
          config = JSON.parse(readFileSync(configPath, "utf-8")) as RunnerConfig
        } catch {
          ctx.ui.notify(`Error: could not parse ${configPath}`, "error")
          return
        }
      }

      const existingRules = config.rules ?? {}

      if (parsed.remove) {
        if (!(pattern in existingRules)) {
          ctx.ui.notify(`Pattern not found in ${scopeLabel} rules: ${pattern}`, "info")
          return
        }
        const { [pattern]: _removed, ...rest } = existingRules
        config.rules = rest
        mkdirSync(dirname(configPath), { recursive: true })
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
        ctx.ui.notify(`Removed from ${scopeLabel} rules:\n  ${pattern}`, "info")
      } else {
        const existing = existingRules[pattern]
        if (existing === level) {
          ctx.ui.notify(`Rule already present in ${scopeLabel}: ${pattern} → ${level}`, "info")
          return
        }
        config.rules = { ...existingRules, [pattern]: level }
        mkdirSync(dirname(configPath), { recursive: true })
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        const verb = existing !== undefined ? `Updated in` : `Added to`
        ctx.ui.notify(`${verb} ${scopeLabel} rules:\n  ${pattern} → ${level}`, "info")
      }
    },
  })
}
