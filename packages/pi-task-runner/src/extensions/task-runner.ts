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

import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { relative as relativePath, resolve as resolvePath } from "node:path"

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui"
import minimist from "minimist"
import { progressiveKill, spawnStreaming } from "pi-extension-utils"
import { Type } from "typebox"

import { checkRules, type RuleScope } from "../lib/permissions.ts"
import { loadRules, readRtkEnabled, removeRuleFromFile, SCOPE_FILES, writeRuleToFile } from "../lib/runner-config.ts"
import { openRunnerModal } from "../lib/runner-modal.ts"

// ─── constants ───────────────────────────────────────────────────────────────

const DEFAULT_VISIBLE_LINES = 20

// ─── config ──────────────────────────────────────────────────────────────────
// Loaded from runner-config.ts — see that module for schema and migration docs.

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

// ─── cwd jail ───────────────────────────────────────────────────────────────

/**
 * Resolve `requestedCwd` relative to `projectRoot` and verify the result
 * stays at or inside the project root.  Returns the resolved absolute path
 * on success, or a string error message on failure.
 */
function resolveJailedCwd(requestedCwd: string, projectRoot: string): { dir: string } | { error: string } {
  const resolved = resolvePath(projectRoot, requestedCwd)
  // Ensure the resolved path is the root itself or a strict descendant.
  const inside = resolved === projectRoot || resolved.startsWith(projectRoot + "/")
  if (!inside) {
    const displayResolved = relativePath(projectRoot, resolved)
    return {
      error:
        `cwd '${requestedCwd}' resolves outside the project root (→ '${displayResolved}').` +
        " Only paths at or beneath the project root are allowed.",
    }
  }
  return { dir: resolved }
}

// ─── tool details type ───────────────────────────────────────────────────────

interface RunDetails {
  cmd: string[]
  cwd: string
  /** The relative cwd as passed by the caller, if explicitly specified. */
  requestedCwd?: string
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

// ─── rtk detection ──────────────────────────────────────────────────────────

function detectRtk(): boolean {
  try {
    const result = spawnSync("which", ["rtk"], { encoding: "utf-8" })
    return result.status === 0
  } catch {
    return false
  }
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
  const rtkAvailable = detectRtk()

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
          description:
            "Working directory relative to the project root (default: project root). " +
            "Must resolve to a path at or inside the project root — paths that escape (e.g. '..') are rejected.",
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
      let workingDir = ctx.cwd
      if (params.cwd) {
        const jailResult = resolveJailedCwd(params.cwd, ctx.cwd)
        if ("error" in jailResult) {
          return {
            content: [{ type: "text" as const, text: jailResult.error }],
            details: { cmd: params.cmd, cwd: ctx.cwd, requestedCwd: params.cwd, exitCode: -1, totalLines: 0 },
            isError: true,
          }
        }
        workingDir = jailResult.dir
      }

      // Wrap with rtk if available and enabled; permission check used the original cmd.
      const effectiveCmd = rtkAvailable && readRtkEnabled() ? ["rtk", ...params.cmd] : params.cmd
      const [bin, ...args] = effectiveCmd as [string, ...string[]]

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
              requestedCwd: params.cwd,
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
          details: { cmd: params.cmd, cwd: workingDir, requestedCwd: params.cwd, exitCode: -1, totalLines: 0 },
          isError: true,
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { cmd: params.cmd, cwd: workingDir, requestedCwd: params.cwd, exitCode, totalLines: lines.length },
        isError: exitCode !== 0,
      }
    },

    // ── renderCall ───────────────────────────────────────────────────────────

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("$ "))
      if (rtkAvailable && readRtkEnabled()) {
        text += theme.fg("dim", "rtk ") + theme.fg("accent", formatCmd(args.cmd))
      } else {
        text += theme.fg("accent", formatCmd(args.cmd))
      }
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
      const content = result.content[0]!
      const raw = content.type === "text" ? (content as { type: string; text: string }).text : ""
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

      if (details?.requestedCwd) {
        text += theme.fg("dim", `  in ${details.requestedCwd}`)
      }

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

      const subcommand = parsed._[0]

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
      const scopeKey: RuleScope = parsed.global ? "global" : parsed.user ? "user" : "project"
      const scopeLabel = scopeKey
      const scopeEntry = SCOPE_FILES.find((f) => f.scope === scopeKey)
      if (!scopeEntry) return
      const configPath = scopeEntry.path(ctx.cwd)

      if (parsed.remove) {
        // Check existence before removing so we can give a clear message.
        const { rules: currentRules } = loadRules(ctx.cwd)
        const exists = currentRules.some((r) => r.scope === scopeKey && r.pattern === pattern)
        if (!exists) {
          ctx.ui.notify(`Pattern not found in ${scopeLabel} rules: ${pattern}`, "info")
          return
        }
        removeRuleFromFile(configPath, pattern)
        ctx.ui.notify(`Removed from ${scopeLabel} rules:\n  ${pattern}`, "info")
      } else {
        const { rules: currentRules } = loadRules(ctx.cwd)
        const existing = currentRules.find((r) => r.scope === scopeKey && r.pattern === pattern)
        if (existing?.level === level) {
          ctx.ui.notify(`Rule already present in ${scopeLabel}: ${pattern} → ${level}`, "info")
          return
        }
        writeRuleToFile(configPath, pattern, level)
        const verb = existing ? "Updated in" : "Added to"
        ctx.ui.notify(`${verb} ${scopeLabel} rules:\n  ${pattern} → ${level}`, "info")
      }
    },
  })

  // ── /runner ───────────────────────────────────────────────────────────────

  pi.registerCommand("runner", {
    description: "Open the runner settings UI",

    async handler(_args, ctx) {
      await openRunnerModal(ctx, ctx.cwd)
    },
  })
}
