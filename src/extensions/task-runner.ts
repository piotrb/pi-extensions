/**
 * task-runner — a safer, structured replacement for the bash tool.
 *
 * Instead of freeform shell strings, the LLM passes a cmd array.
 * Commands are validated against an allowlist before execution.
 * Output streams in real-time and is truncated by default (ctrl+o to expand).
 *
 * Config files (merged in order, project wins):
 *   ~/.pi/agent/task-runner.json
 *   ~/.pi/task-runner.json
 *   <cwd>/.pi/task-runner.json
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
 *   ],
 *   "replaceDefaults": false  // if true, discard built-in defaults for allowedCommands
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve as resolvePath } from "node:path"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import minimist from "minimist"
import { Type } from "typebox"

import { spawnStreaming } from "../lib/extension-utils.ts"
import { check, type PermissionSet } from "../lib/permissions.ts"

// ─── defaults ────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED: string[] = [
  "pnpm run *",
  "pnpm add *",
  "pnpm remove *",
  "npm run *",
  "npm add *",
  "npm remove *",
  "bun run *",
  "bun add *",
  "bun remove *",
  "task *",
]

const DEFAULT_VISIBLE_LINES = 20

// ─── config ──────────────────────────────────────────────────────────────────
//
// Config files are plain JSON, loaded and merged in this order:
//
//   1. ~/.pi/agent/task-runner.json   — user-global (all projects)
//   2. ~/.pi/task-runner.json         — user-global alternative location
//   3. <cwd>/.pi/task-runner.json     — project-local (checked into repo)
//
// Each file is optional.  allowedCommands arrays are unioned across all
// present files, so project config extends rather than replaces global config.
//
// Schema:
// {
//   // Each entry is a pattern string using Claude Code's Bash permission syntax.
//   // "pnpm run *"  → any pnpm run subcommand (trailing ' *' = prefix + word boundary)
//   // "pnpm:*"      → identical to "pnpm *" (':*' suffix is shorthand)
//   // "npm run build" → exact match
//   // "git * --dry-run" → * spans multiple words
//   "allowedCommands": [
//     "pnpm run *",
//     "my-script *"
//   ],
//   "deniedCommands": [
//     "pnpm run deploy *"  // deny takes precedence over allow
//   ],
//
//   // Set to true in any file to discard the built-in defaults
//   // (pnpm / npm / bun / task) and use only the commands listed
//   // across all config files.
//   "replaceDefaults": false
// }

interface TaskRunnerConfig {
  allowedCommands?: string[]
  deniedCommands?: string[]
  replaceDefaults?: boolean
}

function loadConfig(cwd: string): TaskRunnerConfig {
  const paths = [
    join(homedir(), ".pi", "agent", "task-runner.json"),
    join(homedir(), ".pi", "task-runner.json"),
    join(cwd, ".pi", "task-runner.json"),
  ]

  let allowedCommands: string[] = []
  let deniedCommands: string[] = []
  let replaceDefaults = false

  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as TaskRunnerConfig
      if (raw.replaceDefaults) replaceDefaults = true
      if (Array.isArray(raw.allowedCommands)) {
        allowedCommands = [...allowedCommands, ...raw.allowedCommands]
      }
      if (Array.isArray(raw.deniedCommands)) {
        deniedCommands = [...deniedCommands, ...raw.deniedCommands]
      }
    } catch {
      // ignore malformed config
    }
  }

  return { allowedCommands, deniedCommands, replaceDefaults }
}

function resolvePermissions(config: TaskRunnerConfig): PermissionSet {
  const allow = config.replaceDefaults
    ? (config.allowedCommands ?? [])
    : [...DEFAULT_ALLOWED, ...(config.allowedCommands ?? [])]
  const deny = config.deniedCommands ?? []
  return { allow, deny }
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
  const config = loadConfig(cwd)
  const { allow } = resolvePermissions(config)
  // Unique by leading word, preserving order
  const seen = new Set<string>()
  const launchers: string[] = []
  for (const pattern of allow) {
    const key = pattern.split(/[ :*]/)[0] ?? pattern
    if (key && !seen.has(key)) {
      seen.add(key)
      launchers.push(key)
    }
  }
  const list = launchers.join(", ")
  return [
    `Run a bash command. Limited to standard tool launchers: ${list}.`,
    "Pass cmd as an array of strings — no shell interpolation, no freeform strings.",
    "Disallowed commands return an error listing the permitted patterns.",
    "Extra launchers can be configured via task-runner.json at",
    "~/.pi/agent/, ~/.pi/, or .pi/ in the project root.",
  ].join(" ")
}

export default function (pi: ExtensionAPI) {
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

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!Array.isArray(params.cmd)) {
        return {
          content: [{ type: "text" as const, text: 'cmd must be an array of strings, e.g. ["pnpm", "run", "build"]' }],
          details: { cmd: [], cwd: ctx.cwd, exitCode: -1, totalLines: 0 },
          isError: true,
        }
      }

      const permissions = resolvePermissions(loadConfig(ctx.cwd))
      const verdict = check(params.cmd, permissions)

      // ── permission check ────────────────────────────────────────────────────
      if (verdict !== "allow") {
        const isDenied = verdict === "deny"
        const errorLines = isDenied
          ? [
              `Command denied: ${formatCmd(params.cmd)}`,
              "",
              "Denied patterns:",
              ...permissions.deny.map((p) => `  • ${p}`),
            ]
          : [
              `Command not allowed: ${formatCmd(params.cmd)}`,
              "",
              "Allowed patterns:",
              ...permissions.allow.map((p) => `  • ${p}`),
            ]
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

  // ── /task-permission ───────────────────────────────────────────────────────────

  pi.registerCommand("task-permission", {
    description:
      "Add or remove an allow/deny pattern in task-runner config. " +
      "Usage: /task-permission [allow|deny] [--user] [--remove] <pattern>  " +
      "--user writes to ~/.pi/task-runner.json (default: <cwd>/.pi/task-runner.json)  " +
      "--remove removes the pattern instead of adding it",

    getArgumentCompletions(prefix) {
      const tokens = prefix.trimStart().split(/\s+/)
      const first = tokens[0] ?? ""
      const second = tokens[1] ?? ""

      // First token: suggest allow / deny
      if (tokens.length <= 1) {
        return ["allow", "deny"].filter((t) => t.startsWith(first)).map((value) => ({ value, label: value }))
      }

      // Second token: suggest flags (if not already present)
      if (tokens.length === 2) {
        const flags = [
          { value: "--user", description: "Write to user-global config (~/.pi/task-runner.json)" },
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
      // Parse: [allow|deny] [--user] <pattern...>
      const parsed = minimist(args.trim().split(/\s+/).filter(Boolean), {
        boolean: ["user", "remove"],
        default: { user: false, remove: false },
      })

      const list = parsed._[0] as string | undefined
      const pattern = parsed._.slice(1).join(" ")

      if (list !== "allow" && list !== "deny") {
        ctx.ui.notify(
          "Usage: /task-permission [allow|deny] [--user] [--remove] <pattern>\n" +
            "  allow     Add to / remove from allowedCommands\n" +
            "  deny      Add to / remove from deniedCommands\n" +
            "  --user    Write to ~/.pi/task-runner.json instead of <cwd>/.pi/task-runner.json\n" +
            "  --remove  Remove the pattern instead of adding it",
          "info",
        )
        return
      }

      if (!pattern) {
        ctx.ui.notify("Error: no pattern specified.", "error")
        return
      }

      const configPath = parsed.user
        ? join(homedir(), ".pi", "task-runner.json")
        : join(ctx.cwd, ".pi", "task-runner.json")

      // Read existing config or start fresh
      let config: TaskRunnerConfig = {}
      if (existsSync(configPath)) {
        try {
          config = JSON.parse(readFileSync(configPath, "utf-8")) as TaskRunnerConfig
        } catch {
          ctx.ui.notify(`Error: could not parse ${configPath}`, "error")
          return
        }
      }

      const key = list === "allow" ? "allowedCommands" : "deniedCommands"
      const existing = config[key] ?? []
      const scope = parsed.user ? "user" : "project"

      if (parsed.remove) {
        if (!existing.includes(pattern)) {
          ctx.ui.notify(`Pattern not found in ${key}: ${pattern}`, "info")
          return
        }
        config[key] = existing.filter((p) => p !== pattern)
        mkdirSync(dirname(configPath), { recursive: true })
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
        ctx.ui.notify(`Removed from ${key} (${scope}):\n  ${pattern}`, "info")
      } else {
        if (existing.includes(pattern)) {
          ctx.ui.notify(`Pattern already present in ${key}: ${pattern}`, "info")
          return
        }
        config[key] = [...existing, pattern]
        mkdirSync(dirname(configPath), { recursive: true })
        writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8")
        ctx.ui.notify(`Added to ${key} (${scope}):\n  ${pattern}`, "info")
      }
    },
  })
}
