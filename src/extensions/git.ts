/**
 * git — structured tools for common git staging and commit operations.
 *
 * Exposes four tools:
 *   git_status — show working tree status (parsed porcelain v2 → JSON)
 *   git_add    — stage files (git add)
 *   git_rm     — remove files from index / working tree (git rm)
 *   git_mv     — move or rename files (git mv)
 *   git_commit — record a commit (git commit)
 *
 * Each tool runs the real git binary, streams output, and renders a compact
 * summary in the TUI.  Destructive flags (--force on add/rm, --amend on
 * commit) are explicit typed parameters so the LLM must be intentional.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"

import { spawnStreaming } from "../lib/extension-utils.ts"

// ─── shared ──────────────────────────────────────────────────────────────────

interface GitDetails {
  argv: string[] // full git sub-command + args for display
  exitCode: number | null
  totalLines: number
  streaming?: boolean
}

type Theme = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>>[2]

// ─── porcelain v2 parser ─────────────────────────────────────────────────────

interface BranchInfo {
  oid: string
  head: string
  upstream?: string
  ahead?: number
  behind?: number
}

interface OrdinaryEntry {
  type: "ordinary"
  indexStatus: string
  worktreeStatus: string
  path: string
}

interface RenamedEntry {
  type: "renamed"
  indexStatus: string
  worktreeStatus: string
  path: string
  origPath: string
  score: number
}

interface UnmergedEntry {
  type: "unmerged"
  indexStatus: string
  worktreeStatus: string
  path: string
}

interface UntrackedEntry {
  type: "untracked"
  path: string
}

type StatusEntry = OrdinaryEntry | RenamedEntry | UnmergedEntry | UntrackedEntry

interface GitStatus {
  branch: BranchInfo
  entries: StatusEntry[]
  stats: { staged: number; unstaged: number; untracked: number; unmerged: number }
}

function parsePorcelainV2(lines: string[]): GitStatus {
  const branch: BranchInfo = { oid: "", head: "" }
  const entries: StatusEntry[] = []

  for (const line of lines) {
    // ── branch headers ────────────────────────────────────────────────────
    if (line.startsWith("# branch.oid ")) {
      branch.oid = line.slice(13)
    } else if (line.startsWith("# branch.head ")) {
      branch.head = line.slice(14)
    } else if (line.startsWith("# branch.upstream ")) {
      branch.upstream = line.slice(18)
    } else if (line.startsWith("# branch.ab ")) {
      const m = /^\+(-?\d+) -(-?\d+)$/.exec(line.slice(12))
      if (m) {
        branch.ahead = parseInt(m[1], 10)
        branch.behind = parseInt(m[2], 10)
      }
    }
    // ── ordinary changed entry ────────────────────────────────────────────
    // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    else if (line.startsWith("1 ")) {
      const parts = line.split(" ")
      const xy = parts[1] ?? ""
      const path = parts.slice(8).join(" ")
      entries.push({ type: "ordinary", indexStatus: xy[0] ?? " ", worktreeStatus: xy[1] ?? " ", path }) // eslint-disable-line @typescript-eslint/no-unnecessary-condition
    }
    // ── renamed / copied entry ────────────────────────────────────────────
    // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
    else if (line.startsWith("2 ")) {
      const parts = line.split(" ")
      const xy = parts[1] ?? ""
      const scoreField = parts[8] ?? ""
      const score = parseInt(scoreField.slice(1), 10)
      const pathField = parts.slice(9).join(" ")
      const tabIdx = pathField.indexOf("\t")
      const path = tabIdx === -1 ? pathField : pathField.slice(0, tabIdx)
      const origPath = tabIdx === -1 ? "" : pathField.slice(tabIdx + 1)
      entries.push({ type: "renamed", indexStatus: xy[0] ?? " ", worktreeStatus: xy[1] ?? " ", path, origPath, score }) // eslint-disable-line @typescript-eslint/no-unnecessary-condition
    }
    // ── unmerged entry ────────────────────────────────────────────────────
    // u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
    else if (line.startsWith("u ")) {
      const parts = line.split(" ")
      const xy = parts[1] ?? ""
      const path = parts.slice(10).join(" ")
      entries.push({ type: "unmerged", indexStatus: xy[0] ?? " ", worktreeStatus: xy[1] ?? " ", path }) // eslint-disable-line @typescript-eslint/no-unnecessary-condition
    }
    // ── untracked ─────────────────────────────────────────────────────────
    else if (line.startsWith("? ")) {
      entries.push({ type: "untracked", path: line.slice(2) })
    }
  }

  const staged = entries.filter(
    (e) => e.type !== "untracked" && e.type !== "unmerged" && e.indexStatus !== " " && e.indexStatus !== ".",
  ).length
  const unstaged = entries.filter(
    (e) => e.type !== "untracked" && e.type !== "unmerged" && e.worktreeStatus !== " " && e.worktreeStatus !== ".",
  ).length
  const untracked = entries.filter((e) => e.type === "untracked").length
  const unmerged = entries.filter((e) => e.type === "unmerged").length

  return { branch, entries, stats: { staged, unstaged, untracked, unmerged } }
}

const STATUS_LABELS: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "unmerged",
  "?": "untracked",
}

function statusLabel(ch: string): string {
  return STATUS_LABELS[ch] ?? ch
}

/** Run a git sub-command, streaming stdout+stderr via onUpdate. */
async function runGit(
  subArgs: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: { content: { type: "text"; text: string }[]; details: GitDetails }) => void) | undefined,
): Promise<{ content: { type: "text"; text: string }[]; details: GitDetails; isError: boolean }> {
  const { lines, exitCode, spawnError } = await spawnStreaming("git", subArgs, {
    cwd,
    signal,
    notFoundHint: "Install git: https://git-scm.com",
    onLines: (accumulated) => {
      onUpdate?.({
        content: [{ type: "text", text: accumulated.join("\n") }],
        details: { argv: subArgs, totalLines: accumulated.length, exitCode: null, streaming: true },
      })
    },
  })

  if (spawnError) {
    return {
      content: [{ type: "text", text: spawnError }],
      details: { argv: subArgs, totalLines: 0, exitCode: -1 },
      isError: true,
    }
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { argv: subArgs, totalLines: lines.length, exitCode },
    isError: exitCode !== 0,
  }
}

/** Render a finished git result: status badge + output lines. */
function renderGitResult(
  result: { content: { type: string; text?: string }[]; details: unknown; isError?: boolean },
  expanded: boolean,
  isPartial: boolean,
  theme: Theme,
  runningLabel = "running…",
  visibleLines = 20,
): InstanceType<typeof Text> {
  const details = result.details as GitDetails | undefined
  const content = result.content[0]
  const raw = content.type === "text" ? (content as { type: string; text: string }).text : ""
  const lines = raw.length > 0 ? raw.split("\n") : []
  const totalLines = lines.length

  if (isPartial) {
    const tail = lines.slice(-visibleLines)
    let text = theme.fg("warning", `▶ ${runningLabel}`)
    const hidden = totalLines - tail.length
    if (hidden > 0) text += "\n" + theme.fg("muted", `  (${hidden} earlier lines)`)
    if (tail.length > 0) text += "\n" + tail.map((l) => theme.fg("dim", l)).join("\n")
    return new Text(text, 0, 0)
  }

  const failed = details?.exitCode !== 0 && details?.exitCode != null
  let text = failed ? theme.fg("error", `✗ exit ${details.exitCode}`) : theme.fg("success", "✓ done")

  if (totalLines > 0) {
    if (expanded) {
      text += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n")
    } else {
      const visible = lines.slice(0, visibleLines)
      text += "\n" + visible.map((l) => theme.fg("dim", l)).join("\n")
      const hidden = totalLines - visible.length
      if (hidden > 0) {
        text += "\n" + theme.fg("muted", `  (${hidden} more line${hidden !== 1 ? "s" : ""},  ctrl+o to expand)`)
      }
    }
  }

  return new Text(text, 0, 0)
}

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── git_add ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "git_status",
    label: "git status",
    description: [
      "Show the working tree status (git status).",
      "Returns parsed JSON — branch info, staged/unstaged/untracked entries, and summary stats.",
      "Safe to call at any time to inspect repo state.",
    ].join(" "),

    parameters: Type.Object({
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description: "Limit status to these paths (default: entire working tree).",
        }),
      ),
    }),

    async execute(_id, params, signal, _onUpdate, ctx) {
      const args = ["status", "--porcelain=v2", "--branch"]
      if (params.paths && params.paths.length > 0) args.push("--", ...params.paths)

      const { lines, exitCode, spawnError } = await spawnStreaming("git", args, {
        cwd: ctx.cwd,
        signal,
        notFoundHint: "Install git: https://git-scm.com",
      })

      if (spawnError) {
        return {
          content: [{ type: "text" as const, text: spawnError }],
          details: { exitCode: -1 },
          isError: true,
        }
      }

      const status = parsePorcelainV2(lines)

      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        details: { status, exitCode },
        isError: exitCode !== 0,
      }
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("git status")), 0, 0)
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as { status?: GitStatus; exitCode: number | null }
      const status = details.status

      if (!status) {
        const c = result.content[0]
        const raw = c.type === "text" ? c.text : ""
        return new Text(theme.fg("error", raw), 0, 0)
      }

      const { branch, entries, stats } = status
      const lines: string[] = []

      // branch line
      let branchLine = theme.fg("toolTitle", "branch ") + theme.fg("accent", branch.head)
      if (branch.upstream) {
        branchLine += theme.fg("dim", " → ") + theme.fg("muted", branch.upstream)
      }
      if (branch.ahead !== undefined && branch.behind !== undefined) {
        const parts: string[] = []
        if (branch.ahead > 0) parts.push(theme.fg("success", `↑${branch.ahead}`))
        if (branch.behind > 0) parts.push(theme.fg("warning", `↓${branch.behind}`))
        if (parts.length > 0) branchLine += " " + parts.join(" ")
      }
      lines.push(branchLine)

      if (entries.length === 0) {
        lines.push(theme.fg("success", "✓ clean"))
        return new Text(lines.join("\n"), 0, 0)
      }

      // summary badges
      const badges: string[] = []
      if (stats.staged > 0) badges.push(theme.fg("success", `${stats.staged} staged`))
      if (stats.unstaged > 0) badges.push(theme.fg("warning", `${stats.unstaged} unstaged`))
      if (stats.untracked > 0) badges.push(theme.fg("dim", `${stats.untracked} untracked`))
      if (stats.unmerged > 0) badges.push(theme.fg("error", `${stats.unmerged} unmerged`))
      if (badges.length > 0) lines.push(badges.join("  "))

      if (!expanded) return new Text(lines.join("\n"), 0, 0)

      // per-entry detail (expanded)
      for (const entry of entries) {
        if (entry.type === "untracked") {
          lines.push(theme.fg("dim", "  ? ") + theme.fg("dim", entry.path))
        } else if (entry.type === "unmerged") {
          lines.push(theme.fg("error", "  U ") + entry.path)
        } else if (entry.type === "renamed") {
          const iLabel = statusLabel(entry.indexStatus)
          const wLabel = entry.worktreeStatus !== " " ? "+" + statusLabel(entry.worktreeStatus) : ""
          const label = [iLabel, wLabel].filter(Boolean).join("/")
          lines.push(
            theme.fg("success", "  R ") +
              theme.fg("accent", entry.origPath) +
              theme.fg("dim", " → ") +
              theme.fg("accent", entry.path) +
              theme.fg("muted", ` (${label})`),
          )
        } else {
          const iCh = entry.indexStatus !== " " ? entry.indexStatus : ""
          const wCh = entry.worktreeStatus !== " " ? entry.worktreeStatus : ""
          const iColor = iCh ? "success" : "dim"
          const wColor = wCh ? "warning" : "dim"
          const indicator = theme.fg(iColor, iCh || " ") + theme.fg(wColor, wCh || " ")
          lines.push("  " + indicator + " " + theme.fg("dim", entry.path))
        }
      }

      return new Text(lines.join("\n"), 0, 0)
    },
  })

  pi.registerTool({
    name: "git_add",
    label: "git add",
    description: [
      "Stage file changes for the next commit (git add).",
      "Only use when the user explicitly asks to stage or commit files.",
      "Specify paths to stage individual files or directories.",
      "Use all=true to stage everything (-A: new, modified, and deleted files).",
      "Use update=true to stage only modifications and deletions to already-tracked files (-u).",
    ].join(" "),

    parameters: Type.Object({
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Files or directories to stage. Supports pathspecs and globs. " + "Required unless all or update is true.",
        }),
      ),
      all: Type.Optional(
        Type.Boolean({
          description:
            "Stage all changes in the working tree: new files, modifications, and deletions (-A). " +
            "Equivalent to git add -A.",
        }),
      ),
      update: Type.Optional(
        Type.Boolean({
          description:
            "Stage modifications and deletions to already-tracked files only; " +
            "does not stage untracked new files (-u).",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "Allow staging files that are otherwise ignored by .gitignore (-f). " + "Use with care.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description: "Don't actually stage anything; just show what would be added (-n).",
        }),
      ),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      const args: string[] = ["add"]
      if (params.force) args.push("--force")
      if (params.dryRun) args.push("--dry-run")
      if (params.all) args.push("--all")
      else if (params.update) args.push("--update")
      args.push("--")
      if (params.paths && params.paths.length > 0) args.push(...params.paths)
      return runGit(args, ctx.cwd, signal, onUpdate)
    },

    renderCall(args, theme) {
      const flags: string[] = []
      if (args.all) flags.push("-A")
      else if (args.update) flags.push("-u")
      if (args.force) flags.push("-f")
      if (args.dryRun) flags.push("--dry-run")

      let text = theme.fg("toolTitle", theme.bold("git add"))
      if (flags.length > 0) text += theme.fg("dim", " " + flags.join(" "))

      if (args.all) {
        text += theme.fg("accent", " (all changes)")
      } else if (args.update) {
        text += theme.fg("accent", " (tracked files)")
      } else if (args.paths && args.paths.length > 0) {
        text += theme.fg("accent", " " + args.paths.join(" "))
      }

      return new Text(text, 0, 0)
    },

    renderResult(result, { expanded, isPartial }, theme) {
      return renderGitResult(result, expanded, isPartial, theme, "staging…")
    },
  })

  // ── git_rm ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "git_rm",
    label: "git rm",
    description: [
      "Remove files from the index and optionally the working tree (git rm).",
      "Only use when the user explicitly asks to remove files from git tracking.",
      "Use cached=true to only remove from the index while keeping the file on disk",
      "(useful for untracking a file without deleting it).",
      "Use recursive=true when removing a directory.",
    ].join(" "),

    parameters: Type.Object({
      paths: Type.Array(Type.String(), {
        description: "Files or directories to remove. At least one path is required.",
        minItems: 1,
      }),
      cached: Type.Optional(
        Type.Boolean({
          description:
            "Remove from the index only; leave the file on disk (--cached). " +
            "Use this to stop tracking a file without deleting it.",
        }),
      ),
      recursive: Type.Optional(
        Type.Boolean({
          description: "Allow recursive removal when a directory is given as a path (-r).",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Override the up-to-date safety check and force removal (-f). " +
            "Use with care — staged changes will be lost.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description: "Don't actually remove anything; show what would be removed (-n).",
        }),
      ),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      const args: string[] = ["rm"]
      if (params.cached) args.push("--cached")
      if (params.recursive) args.push("-r")
      if (params.force) args.push("--force")
      if (params.dryRun) args.push("--dry-run")
      args.push("--")
      args.push(...params.paths)
      return runGit(args, ctx.cwd, signal, onUpdate)
    },

    renderCall(args, theme) {
      const flags: string[] = []
      if (args.cached) flags.push("--cached")
      if (args.recursive) flags.push("-r")
      if (args.force) flags.push("-f")
      if (args.dryRun) flags.push("--dry-run")

      let text = theme.fg("toolTitle", theme.bold("git rm"))
      if (flags.length > 0) text += theme.fg("dim", " " + flags.join(" "))
      text += theme.fg("accent", " " + args.paths.join(" "))

      return new Text(text, 0, 0)
    },

    renderResult(result, { expanded, isPartial }, theme) {
      return renderGitResult(result, expanded, isPartial, theme, "removing…")
    },
  })

  // ── git_mv ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "git_mv",
    label: "git mv",
    description: [
      "Move or rename a file, directory, or symlink (git mv).",
      "Only use when the user explicitly asks to move or rename files.",
      "Updates the index automatically — no separate git add needed.",
      "Use force=true to overwrite an existing destination file.",
      "Use dryRun=true to preview what would happen without making changes.",
    ].join(" "),

    parameters: Type.Object({
      source: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
        description: "Source path(s). When moving multiple files, destination must be a directory.",
      }),
      destination: Type.String({
        description: "Destination path or directory.",
      }),
      force: Type.Optional(
        Type.Boolean({
          description: "Allow overwriting an existing file at the destination (-f).",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description: "Show what would be moved without actually moving anything (-n).",
        }),
      ),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      const args: string[] = ["mv"]
      if (params.force) args.push("--force")
      if (params.dryRun) args.push("--dry-run")
      const sources = Array.isArray(params.source) ? params.source : [params.source]
      args.push(...sources, params.destination)
      return runGit(args, ctx.cwd, signal, onUpdate)
    },

    renderCall(args, theme) {
      const flags: string[] = []
      if (args.force) flags.push("-f")
      if (args.dryRun) flags.push("--dry-run")

      const sources = Array.isArray(args.source) ? args.source : [args.source]
      let text = theme.fg("toolTitle", theme.bold("git mv"))
      if (flags.length > 0) text += theme.fg("dim", " " + flags.join(" "))
      text += theme.fg("accent", " " + sources.join(" "))
      text += theme.fg("dim", " → ")
      text += theme.fg("accent", args.destination)
      return new Text(text, 0, 0)
    },

    renderResult(result, { expanded, isPartial }, theme) {
      return renderGitResult(result, expanded, isPartial, theme, "moving…")
    },
  })

  // ── git_commit ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "git_commit",
    label: "git commit",
    description: [
      "Record staged changes as a new commit (git commit).",
      "Only use when the user explicitly asks to commit — do not commit automatically after edits.",
      "A commit message is required unless amend+noEdit is used.",
      "Use all=true to automatically stage modifications and deletions to tracked files (-a).",
      "Use amend=true to rewrite the most recent commit.",
    ].join(" "),

    parameters: Type.Object({
      message: Type.Optional(
        Type.String({
          description:
            "Commit message (-m). Required for new commits. " +
            "Can be omitted when using amend+noEdit to keep the existing message.",
        }),
      ),
      all: Type.Optional(
        Type.Boolean({
          description:
            "Automatically stage modifications and deletions to already-tracked files before committing (-a). " +
            "Does not stage untracked new files.",
        }),
      ),
      amend: Type.Optional(
        Type.Boolean({
          description:
            "Replace the tip of the current branch by creating a new commit (--amend). " +
            "Rewrites the most recent commit.",
        }),
      ),
      noEdit: Type.Optional(
        Type.Boolean({
          description:
            "When amending, reuse the existing commit message without opening an editor (--no-edit). " +
            "Only meaningful with amend=true.",
        }),
      ),
      noVerify: Type.Optional(
        Type.Boolean({
          description: "Bypass pre-commit and commit-msg hooks (--no-verify). Use with care.",
        }),
      ),
      allowEmpty: Type.Optional(
        Type.Boolean({
          description:
            "Allow creating a commit with no changes (--allow-empty). " +
            "Normally git refuses to record a commit that has no diff.",
        }),
      ),
      author: Type.Optional(
        Type.String({
          description:
            'Override the commit author (--author). Format: "Name <email>" ' +
            'or a short-form like "Name <>" that git resolves from history.',
        }),
      ),
      date: Type.Optional(
        Type.String({
          description:
            "Override the author date (--date). Accepts any format git understands, " +
            'e.g. "2024-06-01T12:00:00" or "now".',
        }),
      ),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      const args: string[] = ["commit"]

      if (params.all) args.push("--all")
      if (params.amend) args.push("--amend")
      if (params.noEdit) args.push("--no-edit")
      if (params.noVerify) args.push("--no-verify")
      if (params.allowEmpty) args.push("--allow-empty")
      if (params.author) args.push("--author", params.author)
      if (params.date) args.push("--date", params.date)
      if (params.message) args.push("--message", params.message)

      return runGit(args, ctx.cwd, signal, onUpdate)
    },

    renderCall(args, theme) {
      const flags: string[] = []
      if (args.all) flags.push("-a")
      if (args.amend) flags.push("--amend")
      if (args.noEdit) flags.push("--no-edit")
      if (args.noVerify) flags.push("--no-verify")
      if (args.allowEmpty) flags.push("--allow-empty")
      if (args.author) flags.push(`--author='${args.author}'`)
      if (args.date) flags.push(`--date='${args.date}'`)

      let text = theme.fg("toolTitle", theme.bold("git commit"))
      if (flags.length > 0) text += theme.fg("dim", " " + flags.join(" "))

      if (args.message) {
        // Render each line of the commit message indented below the header.
        // A conventional commit message may have a subject, a blank line,
        // and a body — preserve that structure visually.
        const msgLines = args.message.split("\n")
        for (const [i, line] of msgLines.entries()) {
          const isSubject = i === 0
          text += "\n" + theme.fg("dim", "  ") + theme.fg(isSubject ? "accent" : "dim", line)
        }
      }

      return new Text(text, 0, 0)
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return renderGitResult(result, expanded, isPartial, theme, "committing…")
      }

      const details = result.details as GitDetails | undefined
      const content = result.content[0]
      const raw = content.type === "text" ? (content as { type: string; text: string }).text : ""
      const lines = raw.length > 0 ? raw.split("\n") : []
      const totalLines = lines.length
      const failed = details?.exitCode !== 0 && details?.exitCode != null

      if (failed) {
        let text = theme.fg("error", `✗ exit ${details.exitCode}`)
        const visible = lines.slice(0, 20)
        if (visible.length > 0) {
          text += "\n" + visible.map((l) => theme.fg("dim", l)).join("\n")
          const hidden = totalLines - visible.length
          if (hidden > 0) {
            text += "\n" + theme.fg("muted", `  (${hidden} more lines,  ctrl+o to expand)`)
          }
        }
        return new Text(text, 0, 0)
      }

      // Parse git commit output for the sha + subject line
      // Typical output: "[main 1a2b3c4] commit message\n 1 file changed, …"
      const header = lines.find((l) => /^\[.+\s[0-9a-f]+\]/.exec(l))
      const stats = lines.filter((l) => /\d+ (file|insertion|deletion)/.exec(l))

      let text = theme.fg("success", "✓ committed")

      if (header) {
        // Highlight the sha portion inside [branch sha]
        const styled = header.replace(
          /\[([^\s]+)\s([0-9a-f]+)\]/,
          (_m: string, branch: string, sha: string) =>
            theme.fg("dim", "[") +
            theme.fg("warning", branch) +
            theme.fg("dim", " ") +
            theme.fg("accent", sha) +
            theme.fg("dim", "]"),
        )
        text += "  " + styled
      }

      if (stats.length > 0 && (expanded || !header)) {
        text += "\n" + stats.map((l) => theme.fg("dim", l)).join("\n")
      } else if (stats.length > 0) {
        text += theme.fg("muted", "  " + stats[0].trim())
      }

      if (expanded && lines.length > 0) {
        text += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n")
      }

      return new Text(text, 0, 0)
    },
  })
}
