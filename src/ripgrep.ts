/**
 * ripgrep — structured wrapper around `rg` for the LLM.
 *
 * Exposes the most useful rg flags as typed parameters instead of requiring
 * the LLM to construct a raw command string.  Output is streamed in real time
 * and truncated by default (ctrl+o to expand full results).
 *
 * Requires ripgrep to be installed: https://github.com/BurntSushi/ripgrep
 *   brew install ripgrep  |  apt install ripgrep  |  cargo install ripgrep
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawnStreaming } from "./extension-utils.ts";
import { Type } from "typebox";

const DEFAULT_VISIBLE_LINES = 30;

// ─── details stored alongside the result ─────────────────────────────────────

interface RgDetails {
  pattern: string;
  paths: string[];
  totalLines: number;
  streaming?: boolean;
  exitCode: number | null;
}

// ─── extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ripgrep",
    label: "ripgrep",
    description: [
      "Search file contents using ripgrep (rg).",
      "Prefer this over bash+grep for any file content search.",
      "Supports regex patterns, glob filters, file-type filters, context lines,",
      "fixed-string matching, and more.",
      "Output is line-number-prefixed and streamed; truncated at",
      `${DEFAULT_VISIBLE_LINES} lines by default (ctrl+o to expand).`,
    ].join(" "),

    parameters: Type.Object({
      // ── core ──────────────────────────────────────────────────────────────
      pattern: Type.String({
        description:
          "Search pattern. Interpreted as a regex unless fixedStrings is true.",
      }),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Files or directories to search (default: current working directory).",
        }),
      ),

      // ── pattern matching ──────────────────────────────────────────────────
      fixedStrings: Type.Optional(
        Type.Boolean({
          description:
            "Treat pattern as a literal string, not a regex. Equivalent to rg -F.",
        }),
      ),
      ignoreCase: Type.Optional(
        Type.Boolean({
          description: "Case-insensitive search. Equivalent to rg -i.",
        }),
      ),
      smartCase: Type.Optional(
        Type.Boolean({
          description:
            "Case-insensitive if pattern is all lowercase, case-sensitive otherwise. Equivalent to rg -S.",
        }),
      ),
      wordRegexp: Type.Optional(
        Type.Boolean({
          description:
            "Only match whole words (pattern surrounded by word boundaries). Equivalent to rg -w.",
        }),
      ),
      invertMatch: Type.Optional(
        Type.Boolean({
          description: "Print lines that do NOT match. Equivalent to rg -v.",
        }),
      ),
      multiline: Type.Optional(
        Type.Boolean({
          description:
            "Allow patterns to match across multiple lines. Equivalent to rg -U.",
        }),
      ),

      // ── file filtering ────────────────────────────────────────────────────
      glob: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description:
            "Include/exclude files by glob pattern. Prefix with ! to exclude. " +
            'e.g. "*.ts" or ["*.ts", "!*.test.ts"]. Equivalent to rg --glob.',
        }),
      ),
      type: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description:
            "Only search files matching a known type. " +
            'e.g. "ts", "js", "rust", "py". Equivalent to rg -t. ' +
            "Run `rg --type-list` to see all types.",
        }),
      ),
      typeNot: Type.Optional(
        Type.Union([Type.String(), Type.Array(Type.String())], {
          description:
            "Exclude files matching a known type. Equivalent to rg -T.",
        }),
      ),
      hidden: Type.Optional(
        Type.Boolean({
          description:
            "Search hidden files and directories (dotfiles). Equivalent to rg --hidden.",
        }),
      ),
      noIgnore: Type.Optional(
        Type.Boolean({
          description:
            "Don't respect .gitignore / .ignore / .rgignore files. Equivalent to rg --no-ignore.",
        }),
      ),
      followSymlinks: Type.Optional(
        Type.Boolean({
          description: "Follow symbolic links. Equivalent to rg -L.",
        }),
      ),
      maxDepth: Type.Optional(
        Type.Integer({
          description:
            "Limit directory traversal depth. Equivalent to rg --max-depth.",
          minimum: 0,
        }),
      ),

      // ── output format ─────────────────────────────────────────────────────
      context: Type.Optional(
        Type.Integer({
          description:
            "Show N lines before and after each match. Equivalent to rg -C.",
          minimum: 0,
        }),
      ),
      beforeContext: Type.Optional(
        Type.Integer({
          description: "Show N lines before each match. Equivalent to rg -B.",
          minimum: 0,
        }),
      ),
      afterContext: Type.Optional(
        Type.Integer({
          description: "Show N lines after each match. Equivalent to rg -A.",
          minimum: 0,
        }),
      ),
      count: Type.Optional(
        Type.Boolean({
          description:
            "Print only the count of matching lines per file. Equivalent to rg -c.",
        }),
      ),
      filesWithMatches: Type.Optional(
        Type.Boolean({
          description:
            "Print only the names of files with at least one match. Equivalent to rg -l.",
        }),
      ),
      noLineNumber: Type.Optional(
        Type.Boolean({
          description:
            "Suppress line numbers from output (line numbers are shown by default). Equivalent to rg -N.",
        }),
      ),
      maxCount: Type.Optional(
        Type.Integer({
          description:
            "Stop reading a file after N matches. Equivalent to rg -m.",
          minimum: 1,
        }),
      ),
      sortBy: Type.Optional(
        Type.Union(
          [
            Type.Literal("path"),
            Type.Literal("modified"),
            Type.Literal("accessed"),
            Type.Literal("created"),
            Type.Literal("none"),
          ],
          {
            description:
              'Sort results. "path" is alphabetical. "none" (default) is fastest. Equivalent to rg --sort.',
          },
        ),
      ),
    }),

    // ── execute ──────────────────────────────────────────────────────────────

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const args: string[] = [];

      // Always emit line numbers (suppressed only if noLineNumber)
      if (!params.noLineNumber) args.push("--line-number");

      // No terminal colour codes — we parse and theme ourselves
      args.push("--color=never");

      // pattern matching
      if (params.fixedStrings) args.push("--fixed-strings");
      if (params.ignoreCase) args.push("--ignore-case");
      if (params.smartCase) args.push("--smart-case");
      if (params.wordRegexp) args.push("--word-regexp");
      if (params.invertMatch) args.push("--invert-match");
      if (params.multiline) args.push("--multiline");

      // file filtering
      const globs = params.glob
        ? Array.isArray(params.glob)
          ? params.glob
          : [params.glob]
        : [];
      for (const g of globs) args.push("--glob", g);

      const types = params.type
        ? Array.isArray(params.type)
          ? params.type
          : [params.type]
        : [];
      for (const t of types) args.push("--type", t);

      const typeNots = params.typeNot
        ? Array.isArray(params.typeNot)
          ? params.typeNot
          : [params.typeNot]
        : [];
      for (const t of typeNots) args.push("--type-not", t);

      if (params.hidden) args.push("--hidden");
      if (params.noIgnore) args.push("--no-ignore");
      if (params.followSymlinks) args.push("--follow");
      if (params.maxDepth != null) args.push("--max-depth", String(params.maxDepth));

      // output format
      if (params.context != null) args.push("--context", String(params.context));
      if (params.beforeContext != null)
        args.push("--before-context", String(params.beforeContext));
      if (params.afterContext != null)
        args.push("--after-context", String(params.afterContext));
      if (params.count) args.push("--count");
      if (params.filesWithMatches) args.push("--files-with-matches");
      if (params.maxCount != null) args.push("--max-count", String(params.maxCount));
      if (params.sortBy && params.sortBy !== "none")
        args.push("--sort", params.sortBy);

      // pattern + paths (always last)
      args.push("--", params.pattern);
      if (params.paths && params.paths.length > 0) {
        args.push(...params.paths);
      }

      const { lines, exitCode, spawnError } = await spawnStreaming("rg", args, {
        cwd: ctx.cwd,
        signal,
        notFoundHint: "brew install ripgrep  |  apt install ripgrep  |  cargo install ripgrep",
        onLines: (accumulated) => {
          onUpdate?.({
            content: [{ type: "text", text: accumulated.join("\n") }],
            details: {
              pattern: params.pattern,
              paths: params.paths ?? [],
              totalLines: accumulated.length,
              exitCode: null,
              streaming: true,
            } as RgDetails,
          });
        },
      });

      if (spawnError) {
        return {
          content: [{ type: "text" as const, text: spawnError }],
          details: { pattern: params.pattern, paths: params.paths ?? [], totalLines: 0, exitCode: -1 } as RgDetails,
          isError: true,
        };
      }

      // rg exit codes: 0 = matches found, 1 = no matches, 2 = error
      const noMatches = exitCode === 1 && lines.length === 0;
      return {
        content: [{ type: "text" as const, text: noMatches ? "No matches found." : lines.join("\n") }],
        details: { pattern: params.pattern, paths: params.paths ?? [], totalLines: lines.length, exitCode } as RgDetails,
        isError: exitCode === 2,
      };
    },

    // ── renderCall ───────────────────────────────────────────────────────────

    renderCall(args, theme) {
      // Reconstruct a human-readable rg invocation for display
      const parts: string[] = ["rg"];

      if (args.fixedStrings) parts.push("-F");
      if (args.ignoreCase) parts.push("-i");
      if (args.smartCase) parts.push("-S");
      if (args.wordRegexp) parts.push("-w");
      if (args.invertMatch) parts.push("-v");
      if (args.multiline) parts.push("-U");
      if (args.hidden) parts.push("--hidden");
      if (args.noIgnore) parts.push("--no-ignore");
      if (args.followSymlinks) parts.push("-L");
      if (args.count) parts.push("-c");
      if (args.filesWithMatches) parts.push("-l");
      if (args.maxDepth != null) parts.push(`--max-depth=${args.maxDepth}`);
      if (args.maxCount != null) parts.push(`-m${args.maxCount}`);
      if (args.context != null) parts.push(`-C${args.context}`);
      if (args.beforeContext != null) parts.push(`-B${args.beforeContext}`);
      if (args.afterContext != null) parts.push(`-A${args.afterContext}`);

      const globs = args.glob
        ? Array.isArray(args.glob)
          ? args.glob
          : [args.glob]
        : [];
      for (const g of globs) parts.push(`--glob='${g}'`);

      const types = args.type
        ? Array.isArray(args.type)
          ? args.type
          : [args.type]
        : [];
      for (const t of types) parts.push(`-t${t}`);

      const typeNots = args.typeNot
        ? Array.isArray(args.typeNot)
          ? args.typeNot
          : [args.typeNot]
        : [];
      for (const t of typeNots) parts.push(`-T${t}`);

      if (args.sortBy && args.sortBy !== "none") parts.push(`--sort=${args.sortBy}`);

      // pattern — highlighted differently from flags
      const patternStr = args.pattern.includes(" ")
        ? `'${args.pattern}'`
        : args.pattern;

      let text = theme.fg("toolTitle", theme.bold(parts.join(" ") + " "));
      text += theme.fg("accent", patternStr);

      if (args.paths && args.paths.length > 0) {
        text += theme.fg("dim", "  " + args.paths.join(" "));
      }

      return new Text(text, 0, 0);
    },

    // ── renderResult ─────────────────────────────────────────────────────────

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as RgDetails | undefined;
      const content = result.content[0];
      const raw = content?.type === "text" ? content.text : "";
      const lines = raw.length > 0 ? raw.split("\n") : [];
      const totalLines = lines.length;

      // ── streaming ─────────────────────────────────────────────────────────
      if (isPartial) {
        const tail = lines.slice(-DEFAULT_VISIBLE_LINES);
        let text = theme.fg("warning", "▶ searching…");
        if (tail.length > 0) {
          const hidden = totalLines - tail.length;
          if (hidden > 0) {
            text += "\n" + theme.fg("muted", `  (${hidden} earlier lines)`);
          }
          text += "\n" + tail.map((l) => theme.fg("dim", l)).join("\n");
        }
        return new Text(text, 0, 0);
      }

      // ── no matches ────────────────────────────────────────────────────────
      if (details?.exitCode === 1 || totalLines === 0) {
        return new Text(theme.fg("muted", "No matches found."), 0, 0);
      }

      // ── error ─────────────────────────────────────────────────────────────
      if (details?.exitCode === 2) {
        const errLine = lines[0] ?? "rg error";
        return new Text(theme.fg("error", `✗ ${errLine}`), 0, 0);
      }

      // ── results ───────────────────────────────────────────────────────────
      let text = theme.fg("success", `${totalLines} line${totalLines !== 1 ? "s" : ""}`);

      if (expanded) {
        text += "\n" + lines.map((l) => renderLine(l, theme)).join("\n");
      } else {
        const visible = lines.slice(0, DEFAULT_VISIBLE_LINES);
        text += "\n" + visible.map((l) => renderLine(l, theme)).join("\n");
        const hidden = totalLines - visible.length;
        if (hidden > 0) {
          text +=
            "\n" +
            theme.fg(
              "muted",
              `  (${hidden} more line${hidden !== 1 ? "s" : ""},  ctrl+o to expand)`,
            );
        }
      }

      return new Text(text, 0, 0);
    },
  });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

type Theme = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>>[2];

/**
 * Colour a single output line.
 * rg lines look like:  path/to/file.ts:42:  matched content
 * or context lines:    path/to/file.ts-42-  context content   (separator is -)
 */
function renderLine(line: string, theme: Theme): string {
  // Match: <file>:<line>:<content>  or  <file>-<line>-<content>
  const m = line.match(/^([^:\n]+)([:−\-])(\d+)([:−\-])(.*)$/);
  if (m) {
    const [, file, sep1, lineNo, sep2, content] = m;
    const isMatch = sep1 === ":" && sep2 === ":";
    return (
      theme.fg("dim", file) +
      theme.fg("muted", sep1) +
      theme.fg(isMatch ? "accent" : "muted", lineNo) +
      theme.fg("muted", sep2) +
      (isMatch ? theme.fg("dim", content) : theme.fg("muted", content))
    );
  }
  // Separator lines between context groups (rg prints --)
  if (line === "--") return theme.fg("muted", "──");
  return theme.fg("dim", line);
}
