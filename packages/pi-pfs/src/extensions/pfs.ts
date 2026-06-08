/**
 * pfs — project filesystem tools.
 *
 * Exposes four tools for basic filesystem manipulation, all scoped to the
 * project root.  Paths are always relative — absolute paths are rejected.
 *
 *   pfs_unlink  — delete a single file (no force, no recursion)
 *   pfs_rmdir   — remove an empty directory
 *   pfs_cp      — copy a file or directory tree; destination folder must exist
 *   pfs_mv      — move a file or directory; destination folder must exist
 */

import * as fs from "node:fs/promises"
import * as nodePath from "node:path"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Type } from "typebox"

// ─── helpers ─────────────────────────────────────────────────────────────────

type Theme = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>>[2]

/** Resolve a user-supplied relative path against the project root (ctx.cwd).
 *  Throws a descriptive error string if the path is absolute or escapes the root. */
function resolveProjectPath(rel: string, root: string): string {
  if (nodePath.isAbsolute(rel)) {
    throw new Error(`Path must be relative to the project root, got absolute path: ${rel}`)
  }
  const resolved = nodePath.resolve(root, rel)
  if (!resolved.startsWith(root + nodePath.sep) && resolved !== root) {
    throw new Error(`Path escapes the project root: ${rel}`)
  }
  return resolved
}

function ok(text: string): { content: { type: "text"; text: string }[]; details: { ok: true }; isError: false } {
  return { content: [{ type: "text", text }], details: { ok: true }, isError: false }
}

function fail(text: string): { content: { type: "text"; text: string }[]; details: { ok: false }; isError: true } {
  return { content: [{ type: "text", text }], details: { ok: false }, isError: true }
}

function renderOp(
  result: { content: { type: string; text?: string }[]; isError?: boolean },
  theme: Theme,
  runningLabel: string,
  isPartial: boolean,
): InstanceType<typeof Text> {
  if (isPartial) return new Text(theme.fg("warning", `▶ ${runningLabel}`), 0, 0)
  const c = result.content[0]!
  const raw = c.type === "text" ? (c as { type: string; text: string }).text : ""
  const color = result.isError ? "error" : "success"
  const icon = result.isError ? "✗" : "✓"
  return new Text(theme.fg(color, `${icon} ${raw}`), 0, 0)
}

/** Recursively copy src → dest using Node's built-in recursive cp. */
async function cpRecursive(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, { recursive: true })
}

// ─── system prompt ─────────────────────────────────────────────────────────

const PFS_SYSTEM_PROMPT = `
## Project filesystem tools

For all file and directory manipulation within the project, use the pfs_* tools
instead of bash commands. All paths must be relative to the project root —
absolute paths and paths that escape the root are rejected.

| Tool       | Use for                           |
|------------|-----------------------------------|
| pfs_unlink | Delete a single file              |
| pfs_rmdir  | Remove an empty directory         |
| pfs_cp     | Copy a file or directory tree     |
| pfs_mv     | Move or rename a file or directory|

Never use bash rm, mv, cp, or mkdir for project files when these tools are available.
`.trim()

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", (event: { systemPrompt: string }) => {
    return { systemPrompt: `${event.systemPrompt}\n\n${PFS_SYSTEM_PROMPT}` }
  })

  // ── pfs_unlink ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "pfs_unlink",
    label: "pfs unlink",
    description: [
      "Delete a single file from the project (equivalent to rm for a file).",
      "Path must be relative to the project root.",
      "Does not support directories, force-deletion, or glob patterns.",
    ].join(" "),

    parameters: Type.Object({
      path: Type.String({
        description: "Relative path (from project root) of the file to delete.",
      }),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = nodePath.resolve(ctx.cwd)
      let abs: string
      try {
        abs = resolveProjectPath(params.path, root)
      } catch (e) {
        return fail(String(e))
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>
      try {
        stat = await fs.stat(abs)
      } catch {
        return fail(`No such file: ${params.path}`)
      }
      if (!stat.isFile()) {
        return fail(`Not a file (use pfs_rmdir for directories): ${params.path}`)
      }

      try {
        await fs.unlink(abs)
      } catch (e) {
        return fail(`Failed to delete ${params.path}: ${String(e)}`)
      }

      return ok(`Deleted ${params.path}`)
    },

    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("pfs unlink")) + "  " + theme.fg("accent", args.path), 0, 0)
    },

    renderResult(result, { isPartial }, theme) {
      return renderOp(result, theme, "deleting…", isPartial)
    },
  })

  // ── pfs_rmdir ───────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "pfs_rmdir",
    label: "pfs rmdir",
    description: [
      "Remove an empty directory from the project.",
      "Fails if the directory is not empty.",
      "Path must be relative to the project root.",
    ].join(" "),

    parameters: Type.Object({
      path: Type.String({
        description: "Relative path (from project root) of the empty directory to remove.",
      }),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = nodePath.resolve(ctx.cwd)
      let abs: string
      try {
        abs = resolveProjectPath(params.path, root)
      } catch (e) {
        return fail(String(e))
      }

      let stat: Awaited<ReturnType<typeof fs.stat>>
      try {
        stat = await fs.stat(abs)
      } catch {
        return fail(`No such path: ${params.path}`)
      }
      if (!stat.isDirectory()) {
        return fail(`Not a directory (use pfs_unlink for files): ${params.path}`)
      }

      try {
        await fs.rmdir(abs) // rmdir rejects non-empty dirs natively
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // ENOTEMPTY is the common case; give a friendlier message
        if (msg.includes("ENOTEMPTY") || msg.includes("not empty")) {
          return fail(`Directory is not empty: ${params.path}`)
        }
        return fail(`Failed to remove ${params.path}: ${msg}`)
      }

      return ok(`Removed ${params.path}`)
    },

    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("pfs rmdir")) + "  " + theme.fg("accent", args.path), 0, 0)
    },

    renderResult(result, { isPartial }, theme) {
      return renderOp(result, theme, "removing…", isPartial)
    },
  })

  // ── pfs_cp ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "pfs_cp",
    label: "pfs cp",
    description: [
      "Copy a file or directory tree within the project.",
      "Both source and destination paths must be relative to the project root.",
      "The destination parent directory must already exist.",
      "If the source is a directory, it is copied recursively.",
    ].join(" "),

    parameters: Type.Object({
      source: Type.String({
        description: "Relative path (from project root) of the file or directory to copy.",
      }),
      destination: Type.String({
        description:
          "Relative path (from project root) for the copy target. " + "The parent directory must already exist.",
      }),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = nodePath.resolve(ctx.cwd)
      let srcAbs: string, destAbs: string
      try {
        srcAbs = resolveProjectPath(params.source, root)
        destAbs = resolveProjectPath(params.destination, root)
      } catch (e) {
        return fail(String(e))
      }

      try {
        await fs.stat(srcAbs)
      } catch {
        return fail(`Source does not exist: ${params.source}`)
      }

      const destParent = nodePath.dirname(destAbs)
      try {
        const parentStat = await fs.stat(destParent)
        if (!parentStat.isDirectory()) {
          return fail(`Destination parent is not a directory: ${nodePath.relative(root, destParent)}`)
        }
      } catch {
        return fail(`Destination folder does not exist: ${nodePath.relative(root, destParent)}`)
      }

      try {
        await cpRecursive(srcAbs, destAbs)
      } catch (e) {
        return fail(`Failed to copy: ${String(e)}`)
      }

      return ok(`Copied ${params.source} → ${params.destination}`)
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("pfs cp")) +
          "  " +
          theme.fg("accent", args.source) +
          theme.fg("dim", " → ") +
          theme.fg("accent", args.destination),
        0,
        0,
      )
    },

    renderResult(result, { isPartial }, theme) {
      return renderOp(result, theme, "copying…", isPartial)
    },
  })

  // ── pfs_mv ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "pfs_mv",
    label: "pfs mv",
    description: [
      "Move (rename) a file or directory within the project.",
      "Both source and destination paths must be relative to the project root.",
      "The destination parent directory must already exist.",
      "This is a pure filesystem move — it does NOT update the git index.",
      "Use git_mv instead when you want git to track the rename.",
    ].join(" "),

    parameters: Type.Object({
      source: Type.String({
        description: "Relative path (from project root) of the file or directory to move.",
      }),
      destination: Type.String({
        description:
          "Relative path (from project root) for the move target. " + "The parent directory must already exist.",
      }),
    }),

    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = nodePath.resolve(ctx.cwd)
      let srcAbs: string, destAbs: string
      try {
        srcAbs = resolveProjectPath(params.source, root)
        destAbs = resolveProjectPath(params.destination, root)
      } catch (e) {
        return fail(String(e))
      }

      try {
        await fs.stat(srcAbs)
      } catch {
        return fail(`Source does not exist: ${params.source}`)
      }

      const destParent = nodePath.dirname(destAbs)
      try {
        const parentStat = await fs.stat(destParent)
        if (!parentStat.isDirectory()) {
          return fail(`Destination parent is not a directory: ${nodePath.relative(root, destParent)}`)
        }
      } catch {
        return fail(`Destination folder does not exist: ${nodePath.relative(root, destParent)}`)
      }

      try {
        await fs.rename(srcAbs, destAbs)
      } catch (e) {
        return fail(`Failed to move: ${String(e)}`)
      }

      return ok(`Moved ${params.source} → ${params.destination}`)
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("pfs mv")) +
          "  " +
          theme.fg("accent", args.source) +
          theme.fg("dim", " → ") +
          theme.fg("accent", args.destination),
        0,
        0,
      )
    },

    renderResult(result, { isPartial }, theme) {
      return renderOp(result, theme, "moving…", isPartial)
    },
  })
}
