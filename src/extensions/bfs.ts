/**
 * bfs — structured wrapper around the `bfs` breadth-first file finder.
 *
 * bfs is a find-compatible tool that traverses in breadth-first order by
 * default, making it great for finding files without wandering deep into
 * irrelevant subdirectories first.
 *
 * https://tavianator.com/projects/bfs.html
 * Install: brew install bfs  |  apt install bfs
 *
 * Only read-only/print actions are exposed — no -delete, -exec, -ok etc.
 * Output is streamed in real time and truncated by default (ctrl+o to expand).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"

import { spawnStreaming } from "../lib/extension-utils.ts"

const DEFAULT_VISIBLE_LINES = 30

// ─── details ─────────────────────────────────────────────────────────────────

interface BfsDetails {
  paths: string[]
  totalLines: number
  exitCode: number | null
  streaming?: boolean
}

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "bfs",
    label: "bfs",
    description: [
      "Find files and directories using bfs (breadth-first search, find-compatible).",
      "Prefer this over bash+find for any filesystem search.",
      "Results are returned shallowest-first, making it easy to get an overview",
      "before diving deep.",
      "Supports name/path/type/size/time filters, depth limits, hidden-file control,",
      "and regex matching.",
      `Output is streamed; truncated at ${DEFAULT_VISIBLE_LINES} lines by default (ctrl+o to expand).`,
    ].join(" "),

    parameters: Type.Object({
      // ── search roots ──────────────────────────────────────────────────────
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Paths to search (default: current working directory). " + "Multiple paths are searched in order.",
        }),
      ),

      // ── name / path matching ──────────────────────────────────────────────
      name: Type.Optional(
        Type.String({
          description:
            "Match files whose name (basename) matches a glob, e.g. '*.ts'. " +
            "Case-sensitive. Use iname for case-insensitive.",
        }),
      ),
      iname: Type.Optional(
        Type.String({
          description: "Like name but case-insensitive.",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description:
            "Match files whose full path matches a glob, e.g. '*/src/*.ts'. " +
            "Case-sensitive. Use ipath for case-insensitive.",
        }),
      ),
      ipath: Type.Optional(
        Type.String({
          description: "Like path but case-insensitive.",
        }),
      ),
      regex: Type.Optional(
        Type.String({
          description:
            "Match files whose full path matches a POSIX extended regex " +
            "(bfs uses -E / posix-extended by default here). " +
            "e.g. '.*/test/.*\\.ts$'",
        }),
      ),

      // ── type filter ───────────────────────────────────────────────────────
      type: Type.Optional(
        Type.Union(
          [
            Type.Literal("f"),
            Type.Literal("d"),
            Type.Literal("l"),
            Type.Literal("s"),
            Type.Literal("p"),
            Type.Literal("b"),
            Type.Literal("c"),
          ],
          {
            description:
              "Only match entries of this type: " +
              "f=file, d=directory, l=symlink, s=socket, p=pipe, b=block device, c=char device.",
          },
        ),
      ),

      // ── depth control ────────────────────────────────────────────────────
      maxDepth: Type.Optional(
        Type.Integer({
          description: "Ignore files deeper than N levels below the search root.",
          minimum: 0,
        }),
      ),
      minDepth: Type.Optional(
        Type.Integer({
          description: "Ignore files shallower than N levels below the search root.",
          minimum: 0,
        }),
      ),

      // ── hidden / ignore ───────────────────────────────────────────────────
      noHidden: Type.Optional(
        Type.Boolean({
          description: "Exclude hidden files and directories (names starting with '.'). " + "Equivalent to -nohidden.",
        }),
      ),
      followSymlinks: Type.Optional(
        Type.Union([Type.Literal("none"), Type.Literal("args"), Type.Literal("all")], {
          description:
            "'none' = never follow (default), " +
            "'args' = follow symlinks given as search paths only (-H), " +
            "'all' = follow all symlinks (-L).",
        }),
      ),
      noMountCross: Type.Optional(
        Type.Boolean({
          description: "Don't descend into directories on different filesystems/mount points (-xdev).",
        }),
      ),

      // ── size / time filters ───────────────────────────────────────────────
      size: Type.Optional(
        Type.String({
          description:
            "Match files by size. Prefix with + (greater than) or - (less than). " +
            "Units: c=bytes, k=KiB, M=MiB, G=GiB. e.g. '+1M', '-100k', '512c'.",
        }),
      ),
      empty: Type.Optional(
        Type.Boolean({
          description: "Match only empty files or directories.",
        }),
      ),
      newer: Type.Optional(
        Type.String({
          description: "Match files modified more recently than the given file path.",
        }),
      ),
      since: Type.Optional(
        Type.String({
          description: "Match files modified since the given timestamp, e.g. '2024-01-01'.",
        }),
      ),
      mtime: Type.Optional(
        Type.String({
          description: "Match files modified N days ago. Prefix with + (more than) or - (less than). e.g. '-7', '+30'.",
        }),
      ),

      // ── permissions / ownership ───────────────────────────────────────────
      executable: Type.Optional(
        Type.Boolean({
          description: "Match files the current user can execute.",
        }),
      ),
      readable: Type.Optional(
        Type.Boolean({
          description: "Match files the current user can read.",
        }),
      ),
      writable: Type.Optional(
        Type.Boolean({
          description: "Match files the current user can write.",
        }),
      ),

      // ── output / traversal ────────────────────────────────────────────────
      sorted: Type.Optional(
        Type.Boolean({
          description:
            "Visit directory entries in sorted (alphabetical) order (-s). " +
            "Slightly slower but gives deterministic output.",
        }),
      ),
      unique: Type.Optional(
        Type.Boolean({
          description: "Skip files already seen (useful when symlinks could cause duplicates).",
        }),
      ),
      depthFirst: Type.Optional(
        Type.Boolean({
          description:
            "Search in depth-first post-order instead of breadth-first (-depth). " +
            "Descendants are printed before their parent directory.",
        }),
      ),
      exclude: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description:
            "Exclude paths matching this glob (or array of globs) from the search entirely. " +
            "e.g. 'node_modules' or ['node_modules', '.git', 'dist']. " +
            "Equivalent to -exclude -name GLOB.",
        }),
      ),
    }),

    // ── execute ──────────────────────────────────────────────────────────────

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const bfsArgs: string[] = []

      // ── symlink flags (must come first) ───────────────────────────────────
      if (params.followSymlinks === "args") bfsArgs.push("-H")
      else if (params.followSymlinks === "all") bfsArgs.push("-L")

      // ── always use extended regex so the regex param is intuitive ─────────
      if (params.regex) bfsArgs.push("-E")

      // ── sorted traversal ─────────────────────────────────────────────────
      if (params.sorted) bfsArgs.push("-s")

      // ── search paths ──────────────────────────────────────────────────────
      if (params.paths && params.paths.length > 0) {
        bfsArgs.push(...params.paths)
      }

      // ── options ───────────────────────────────────────────────────────────
      if (params.maxDepth != null) bfsArgs.push("-maxdepth", String(params.maxDepth))
      if (params.minDepth != null) bfsArgs.push("-mindepth", String(params.minDepth))
      if (params.noHidden) bfsArgs.push("-nohidden")
      if (params.noMountCross) bfsArgs.push("-xdev")
      if (params.depthFirst) bfsArgs.push("-depth")
      if (params.unique) bfsArgs.push("-unique")

      // ── exclude globs ─────────────────────────────────────────────────────
      const excludes = params.exclude ? (Array.isArray(params.exclude) ? params.exclude : [params.exclude]) : []
      for (const ex of excludes) {
        bfsArgs.push("-exclude", "-name", ex)
      }

      // ── tests ─────────────────────────────────────────────────────────────
      if (params.name) bfsArgs.push("-name", params.name)
      if (params.iname) bfsArgs.push("-iname", params.iname)
      if (params.path) bfsArgs.push("-path", params.path)
      if (params.ipath) bfsArgs.push("-ipath", params.ipath)
      if (params.regex) bfsArgs.push("-regex", params.regex)
      if (params.type) bfsArgs.push("-type", params.type)
      if (params.size) bfsArgs.push("-size", params.size)
      if (params.empty) bfsArgs.push("-empty")
      if (params.newer) bfsArgs.push("-newer", params.newer)
      if (params.since) bfsArgs.push("-since", params.since)
      if (params.mtime) bfsArgs.push("-mtime", params.mtime)
      if (params.executable) bfsArgs.push("-executable")
      if (params.readable) bfsArgs.push("-readable")
      if (params.writable) bfsArgs.push("-writable")

      // ── always print — no -delete or -exec allowed ───────────────────────
      bfsArgs.push("-print")

      const { lines, exitCode, spawnError } = await spawnStreaming("bfs", bfsArgs, {
        cwd: ctx.cwd,
        signal,
        notFoundHint: "brew install bfs  |  apt install bfs",
        onLines: (accumulated) => {
          onUpdate?.({
            content: [{ type: "text", text: accumulated.join("\n") }],
            details: {
              paths: params.paths ?? [],
              totalLines: accumulated.length,
              exitCode: null,
              streaming: true,
            },
          })
        },
      })

      if (spawnError) {
        return {
          content: [{ type: "text" as const, text: spawnError }],
          details: { paths: params.paths ?? [], totalLines: 0, exitCode: -1 },
          isError: true,
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.length === 0 ? "No results found." : lines.join("\n") }],
        details: { paths: params.paths ?? [], totalLines: lines.length, exitCode },
        isError: exitCode !== 0,
      }
    },

    // ── renderCall ───────────────────────────────────────────────────────────

    renderCall(args, theme) {
      const flags: string[] = []

      if (args.followSymlinks === "args") flags.push("-H")
      else if (args.followSymlinks === "all") flags.push("-L")
      if (args.sorted) flags.push("-s")
      if (args.depthFirst) flags.push("-depth")
      if (args.noHidden) flags.push("-nohidden")
      if (args.noMountCross) flags.push("-xdev")
      if (args.unique) flags.push("-unique")
      if (args.maxDepth != null) flags.push(`-maxdepth ${args.maxDepth}`)
      if (args.minDepth != null) flags.push(`-mindepth ${args.minDepth}`)
      if (args.type) flags.push(`-type ${args.type}`)
      if (args.name) flags.push(`-name '${args.name}'`)
      if (args.iname) flags.push(`-iname '${args.iname}'`)
      if (args.path) flags.push(`-path '${args.path}'`)
      if (args.ipath) flags.push(`-ipath '${args.ipath}'`)
      if (args.regex) flags.push(`-regex '${args.regex}'`)
      if (args.size) flags.push(`-size ${args.size}`)
      if (args.empty) flags.push("-empty")
      if (args.newer) flags.push(`-newer ${args.newer}`)
      if (args.since) flags.push(`-since '${args.since}'`)
      if (args.mtime) flags.push(`-mtime ${args.mtime}`)
      if (args.executable) flags.push("-executable")
      if (args.readable) flags.push("-readable")
      if (args.writable) flags.push("-writable")

      const excludes = args.exclude ? (Array.isArray(args.exclude) ? args.exclude : [args.exclude]) : []
      for (const ex of excludes) flags.push(`-exclude -name '${ex}'`)

      const searchPaths = args.paths && args.paths.length > 0 ? args.paths.join(" ") : "."

      let text = theme.fg("toolTitle", theme.bold("bfs "))
      text += theme.fg("accent", searchPaths)
      if (flags.length > 0) {
        text += theme.fg("dim", "  " + flags.join("  "))
      }

      return new Text(text, 0, 0)
    },

    // ── renderResult ─────────────────────────────────────────────────────────

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as BfsDetails | undefined
      const content = result.content[0]
      const raw = content?.type === "text" ? content.text : ""
      const lines = raw.length > 0 ? raw.split("\n") : []
      const totalLines = lines.length

      // ── streaming ─────────────────────────────────────────────────────────
      if (isPartial) {
        const tail = lines.slice(-DEFAULT_VISIBLE_LINES)
        let text = theme.fg("warning", "▶ searching…")
        const hidden = totalLines - tail.length
        if (hidden > 0) {
          text += "\n" + theme.fg("muted", `  (${hidden} earlier results)`)
        }
        if (tail.length > 0) {
          text += "\n" + tail.map((l) => renderPath(l, theme)).join("\n")
        }
        return new Text(text, 0, 0)
      }

      // ── error ─────────────────────────────────────────────────────────────
      if (details?.exitCode !== 0 && details?.exitCode != null) {
        const errLine = lines[0] ?? "bfs error"
        return new Text(theme.fg("error", `✗ ${errLine}`), 0, 0)
      }

      // ── no results ────────────────────────────────────────────────────────
      if (totalLines === 0) {
        return new Text(theme.fg("muted", "No results found."), 0, 0)
      }

      // ── results ───────────────────────────────────────────────────────────
      let text = theme.fg("success", `${totalLines} result${totalLines !== 1 ? "s" : ""}`)

      if (expanded) {
        text += "\n" + lines.map((l) => renderPath(l, theme)).join("\n")
      } else {
        const visible = lines.slice(0, DEFAULT_VISIBLE_LINES)
        text += "\n" + visible.map((l) => renderPath(l, theme)).join("\n")
        const hidden = totalLines - visible.length
        if (hidden > 0) {
          text += "\n" + theme.fg("muted", `  (${hidden} more result${hidden !== 1 ? "s" : ""},  ctrl+o to expand)`)
        }
      }

      return new Text(text, 0, 0)
    },
  })
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type Theme = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>>[2]

/**
 * Colour a path line from bfs output.
 * Highlights the basename differently from the directory portion.
 */
function renderPath(line: string, theme: Theme): string {
  if (!line) return ""
  const slash = line.lastIndexOf("/")
  if (slash === -1) return theme.fg("accent", line)
  const dir = line.slice(0, slash + 1)
  const base = line.slice(slash + 1)
  // Distinguish directories (no extension / trailing slash) from files
  const isDir = base === "" || !base.includes(".")
  return theme.fg("dim", dir) + theme.fg(isDir ? "warning" : "accent", base)
}
