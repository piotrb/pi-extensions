/**
 * git — structured tools for common git staging and commit operations.
 *
 * Exposes three tools:
 *   git_add    — stage files (git add)
 *   git_rm     — remove files from index / working tree (git rm)
 *   git_commit — record a commit (git commit)
 *
 * Each tool runs the real git binary, streams output, and renders a compact
 * summary in the TUI.  Destructive flags (--force on add/rm, --amend on
 * commit) are explicit typed parameters so the LLM must be intentional.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawnStreaming } from "./extension-utils.ts";
import { Type } from "typebox";

// ─── shared ──────────────────────────────────────────────────────────────────

interface GitDetails {
  argv: string[];   // full git sub-command + args for display
  exitCode: number | null;
  totalLines: number;
  streaming?: boolean;
}

type Theme = Parameters<
  NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>
>[2];

/** Run a git sub-command, streaming stdout+stderr via onUpdate. */
async function runGit(
  subArgs: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: { content: Array<{ type: "text"; text: string }>; details: GitDetails }) => void) | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: GitDetails; isError: boolean }> {
  const { lines, exitCode, spawnError } = await spawnStreaming("git", subArgs, {
    cwd,
    signal,
    notFoundHint: "Install git: https://git-scm.com",
    onLines: (accumulated) => {
      onUpdate?.({
        content: [{ type: "text", text: accumulated.join("\n") }],
        details: { argv: subArgs, totalLines: accumulated.length, exitCode: null, streaming: true },
      });
    },
  });

  if (spawnError) {
    return {
      content: [{ type: "text", text: spawnError }],
      details: { argv: subArgs, totalLines: 0, exitCode: -1 },
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { argv: subArgs, totalLines: lines.length, exitCode },
    isError: exitCode !== 0,
  };
}

/** Render a finished git result: status badge + output lines. */
function renderGitResult(
  result: { content: Array<{ type: string; text?: string }>; details: unknown; isError?: boolean },
  expanded: boolean,
  isPartial: boolean,
  theme: Theme,
  runningLabel = "running…",
  visibleLines = 20,
): InstanceType<typeof Text> {
  const details = result.details as GitDetails | undefined;
  const content = result.content[0];
  const raw = content?.type === "text" ? (content as { type: string; text: string }).text : "";
  const lines = raw.length > 0 ? raw.split("\n") : [];
  const totalLines = lines.length;

  if (isPartial) {
    const tail = lines.slice(-visibleLines);
    let text = theme.fg("warning", `▶ ${runningLabel}`);
    const hidden = totalLines - tail.length;
    if (hidden > 0) text += "\n" + theme.fg("muted", `  (${hidden} earlier lines)`);
    if (tail.length > 0) text += "\n" + tail.map((l) => theme.fg("dim", l)).join("\n");
    return new Text(text, 0, 0);
  }

  const failed = details?.exitCode !== 0 && details?.exitCode != null;
  let text = failed
    ? theme.fg("error", `✗ exit ${details?.exitCode}`)
    : theme.fg("success", "✓ done");

  if (totalLines > 0) {
    if (expanded) {
      text += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n");
    } else {
      const visible = lines.slice(0, visibleLines);
      text += "\n" + visible.map((l) => theme.fg("dim", l)).join("\n");
      const hidden = totalLines - visible.length;
      if (hidden > 0) {
        text += "\n" + theme.fg("muted", `  (${hidden} more line${hidden !== 1 ? "s" : ""},  ctrl+o to expand)`);
      }
    }
  }

  return new Text(text, 0, 0);
}

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── git_add ────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "git_add",
    label: "git add",
    description: [
      "Stage file changes for the next commit (git add).",
      "Specify paths to stage individual files or directories.",
      "Use all=true to stage everything (-A: new, modified, and deleted files).",
      "Use update=true to stage only modifications and deletions to already-tracked files (-u).",
    ].join(" "),

    parameters: Type.Object({
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Files or directories to stage. Supports pathspecs and globs. " +
            "Required unless all or update is true.",
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
          description:
            "Allow staging files that are otherwise ignored by .gitignore (-f). " +
            "Use with care.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description:
            "Don't actually stage anything; just show what would be added (-n).",
        }),
      ),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      const args: string[] = ["add"];
      if (params.force) args.push("--force");
      if (params.dryRun) args.push("--dry-run");
      if (params.all) args.push("--all");
      else if (params.update) args.push("--update");
      args.push("--");
      if (params.paths && params.paths.length > 0) args.push(...params.paths);
      return runGit(args, ctx.cwd, signal, onUpdate);
    },

    renderCall(args, theme) {
      const flags: string[] = [];
      if (args.all) flags.push("-A");
      else if (args.update) flags.push("-u");
      if (args.force) flags.push("-f");
      if (args.dryRun) flags.push("--dry-run");

      let text = theme.fg("toolTitle", theme.bold("git add"));
      if (flags.length > 0) text += theme.fg("dim", " " + flags.join(" "));

      if (args.all) {
        text += theme.fg("accent", " (all changes)");
      } else if (args.update) {
        text += theme.fg("accent", " (tracked files)");
      } else if (args.paths && args.paths.length > 0) {
        text += theme.fg("accent", " " + args.paths.join(" "));
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      return renderGitResult(result, expanded, isPartial, theme, "staging…");
    },
  });

  // ── git_rm ─────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "git_rm",
    label: "git rm",
    description: [
      "Remove files from the index and optionally the working tree (git rm).",
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
          description:
            "Allow recursive removal when a directory is given as a path (-r).",
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
          description:
            "Don't actually remove anything; show what would be removed (-n).",
        }),
      ),
    }),

    async execute(_id, params, signal, onUpdate, ctx) {
      const args: string[] = ["rm"];
      if (params.cached) args.push("--cached");
      if (params.recursive) args.push("-r");
      if (params.force) args.push("--force");
      if (params.dryRun) args.push("--dry-run");
      args.push("--");
      args.push(...params.paths);
      return runGit(args, ctx.cwd, signal, onUpdate);
    },

    renderCall(args, theme) {
      const flags: string[] = [];
      if (args.cached) flags.push("--cached");
      if (args.recursive) flags.push("-r");
      if (args.force) flags.push("-f");
      if (args.dryRun) flags.push("--dry-run");

      let text = theme.fg("toolTitle", theme.bold("git rm"));
      if (flags.length > 0) text += theme.fg("dim", " " + flags.join(" "));
      text += theme.fg("accent", " " + args.paths.join(" "));

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      return renderGitResult(result, expanded, isPartial, theme, "removing…");
    },
  });

  // ── git_commit ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "git_commit",
    label: "git commit",
    description: [
      "Record staged changes as a new commit (git commit).",
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
          description:
            "Bypass pre-commit and commit-msg hooks (--no-verify). Use with care.",
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
      const args: string[] = ["commit"];

      if (params.all) args.push("--all");
      if (params.amend) args.push("--amend");
      if (params.noEdit) args.push("--no-edit");
      if (params.noVerify) args.push("--no-verify");
      if (params.allowEmpty) args.push("--allow-empty");
      if (params.author) args.push("--author", params.author);
      if (params.date) args.push("--date", params.date);
      if (params.message) args.push("--message", params.message);

      return runGit(args, ctx.cwd, signal, onUpdate);
    },

    renderCall(args, theme) {
      const flags: string[] = [];
      if (args.all) flags.push("-a");
      if (args.amend) flags.push("--amend");
      if (args.noEdit) flags.push("--no-edit");
      if (args.noVerify) flags.push("--no-verify");
      if (args.allowEmpty) flags.push("--allow-empty");
      if (args.author) flags.push(`--author='${args.author}'`);
      if (args.date) flags.push(`--date='${args.date}'`);

      let text = theme.fg("toolTitle", theme.bold("git commit"));
      if (flags.length > 0) text += theme.fg("dim", " " + flags.join(" "));

      if (args.message) {
        // Render each line of the commit message indented below the header.
        // A conventional commit message may have a subject, a blank line,
        // and a body — preserve that structure visually.
        const msgLines = args.message.split("\n");
        for (const [i, line] of msgLines.entries()) {
          const isSubject = i === 0;
          text +=
            "\n" +
            theme.fg("dim", "  ") +
            theme.fg(isSubject ? "accent" : "dim", line);
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) {
        return renderGitResult(result, expanded, isPartial, theme, "committing…");
      }

      const details = result.details as GitDetails | undefined;
      const content = result.content[0];
      const raw = content?.type === "text" ? (content as { type: string; text: string }).text : "";
      const lines = raw.length > 0 ? raw.split("\n") : [];
      const totalLines = lines.length;
      const failed = details?.exitCode !== 0 && details?.exitCode != null;

      if (failed) {
        let text = theme.fg("error", `✗ exit ${details?.exitCode}`);
        const visible = lines.slice(0, 20);
        if (visible.length > 0) {
          text += "\n" + visible.map((l) => theme.fg("dim", l)).join("\n");
          const hidden = totalLines - visible.length;
          if (hidden > 0) {
            text += "\n" + theme.fg("muted", `  (${hidden} more lines,  ctrl+o to expand)`);
          }
        }
        return new Text(text, 0, 0);
      }

      // Parse git commit output for the sha + subject line
      // Typical output: "[main 1a2b3c4] commit message\n 1 file changed, …"
      const header = lines.find((l) => l.match(/^\[.+\s[0-9a-f]+\]/));
      const stats = lines.filter((l) =>
        l.match(/\d+ (file|insertion|deletion)/)
      );

      let text = theme.fg("success", "✓ committed");

      if (header) {
        // Highlight the sha portion inside [branch sha]
        const styled = header.replace(
          /\[([^\s]+)\s([0-9a-f]+)\]/,
          (_m, branch, sha) =>
            theme.fg("dim", "[") +
            theme.fg("warning", branch) +
            theme.fg("dim", " ") +
            theme.fg("accent", sha) +
            theme.fg("dim", "]"),
        );
        text += "  " + styled;
      }

      if (stats.length > 0 && (expanded || !header)) {
        text += "\n" + stats.map((l) => theme.fg("dim", l)).join("\n");
      } else if (stats.length > 0) {
        text += theme.fg("muted", "  " + stats[0].trim());
      }

      if (expanded && lines.length > 0) {
        text += "\n" + lines.map((l) => theme.fg("dim", l)).join("\n");
      }

      return new Text(text, 0, 0);
    },
  });
}
