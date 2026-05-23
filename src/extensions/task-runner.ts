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
 *   "allowedCommands": [["pnpm"], ["pnpm", "run"], ["my-script"]],
 *   "replaceDefaults": false   // if true, discard built-in defaults
 * }
 *
 * Allowed command matching: cmd matches a pattern when the pattern is a
 * prefix of cmd.  ["pnpm"] allows any pnpm subcommand; ["pnpm","run"] only
 * allows `pnpm run …`.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve as resolvePath } from "node:path"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"

import { spawnStreaming } from "../lib/extension-utils.ts"

// ─── defaults ────────────────────────────────────────────────────────────────

const DEFAULT_ALLOWED: string[][] = [["pnpm", "run"], ["npm", "run"], ["bun", "run"], ["task"]]

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
//   // Each entry is an array representing a command prefix.
//   // A cmd matches when the entry is a leading slice of cmd.
//   // ["pnpm"]         → allows any:  pnpm install, pnpm run build, …
//   // ["pnpm", "run"]  → allows only: pnpm run <anything>
//   "allowedCommands": [
//     ["pnpm"],
//     ["pnpm", "run"],
//     ["my-script"]
//   ],
//
//   // Set to true in any file to discard the built-in defaults
//   // (pnpm / npm / bun / task) and use only the commands listed
//   // across all config files.
//   "replaceDefaults": false
// }

interface TaskRunnerConfig {
  allowedCommands?: string[][]
  replaceDefaults?: boolean
}

function loadConfig(cwd: string): TaskRunnerConfig {
  const paths = [
    join(homedir(), ".pi", "agent", "task-runner.json"),
    join(homedir(), ".pi", "task-runner.json"),
    join(cwd, ".pi", "task-runner.json"),
  ]

  let allowedCommands: string[][] = []
  let replaceDefaults = false

  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as TaskRunnerConfig
      if (raw.replaceDefaults) replaceDefaults = true
      if (Array.isArray(raw.allowedCommands)) {
        allowedCommands = [...allowedCommands, ...raw.allowedCommands]
      }
    } catch {
      // ignore malformed config
    }
  }

  return { allowedCommands, replaceDefaults }
}

function resolveAllowed(config: TaskRunnerConfig): string[][] {
  const extra = config.allowedCommands ?? []
  return config.replaceDefaults ? extra : [...DEFAULT_ALLOWED, ...extra]
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

function matchesPattern(cmd: string[], pattern: string[]): boolean {
  if (cmd.length < pattern.length) return false
  return pattern.every((part, i) => cmd[i] === part)
}

function isAllowed(cmd: string[], allowed: string[][]): boolean {
  return allowed.some((pattern) => matchesPattern(cmd, pattern))
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
  const allowed = resolveAllowed(config)
  // Unique by first element, preserving order
  const seen = new Set<string>()
  const launchers: string[] = []
  for (const pattern of allowed) {
    const key = pattern[0]
    if (!seen.has(key)) {
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
      const config = loadConfig(ctx.cwd)
      const allowed = resolveAllowed(config)

      // ── allowlist check ────────────────────────────────────────────────────
      if (!isAllowed(params.cmd, allowed)) {
        const patternList = allowed.map((p) => `  • ${formatCmd(p)}`).join("\n")
        return {
          content: [
            {
              type: "text" as const,
              text: [`Command not allowed: ${formatCmd(params.cmd)}`, "", "Allowed patterns:", patternList].join("\n"),
            },
          ],
          details: {
            cmd: params.cmd,
            cwd: ctx.cwd,
            exitCode: -1,
            totalLines: 0,
          },
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
      const raw = content?.type === "text" ? content.text : ""
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
}
