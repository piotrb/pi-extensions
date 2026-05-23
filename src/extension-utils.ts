/**
 * extension-utils — shared utilities for pi extensions.
 *
 * Import with a relative path:
 *   import { spawnStreaming } from "./extension-utils.ts";
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

// Required by pi's extension loader — this file is a shared utility module,
// not a standalone extension.
export default function (_pi: ExtensionAPI) {}

// ─── spawnStreaming ───────────────────────────────────────────────────────────

export interface SpawnResult {
  lines: string[];
  exitCode: number | null;
  /** Set when the binary could not be spawned at all (e.g. not found in PATH). */
  spawnError?: string;
}

export interface SpawnStreamingOptions {
  cwd: string;
  signal?: AbortSignal;
  env?: Record<string, string>;
  /**
   * Human-readable install hint shown when the binary is not found (ENOENT).
   * e.g. "brew install ripgrep"
   * Falls back to a generic message if omitted.
   */
  notFoundHint?: string;
  /**
   * Called each time one or more complete lines are flushed from the output
   * buffer — i.e. on every chunk that contains at least one newline.
   *
   * Receives the full accumulated lines array so far (not just the new ones),
   * so callers can pass it straight to onUpdate without extra bookkeeping.
   *
   * Not called for the final flush on process close — use the resolved value
   * for that.
   */
  onLines?: (lines: string[]) => void;
}

/**
 * Spawn a subprocess, stream stdout+stderr as accumulated lines, and resolve
 * with the full output once the process exits.
 *
 * - stdout and stderr are merged into a single ordered stream (same as 2>&1).
 * - Lines are split on `\n`; a trailing incomplete line is held in a buffer
 *   and flushed when the process closes.
 * - The abort signal sends SIGTERM to the child.
 * - ENOENT is converted to a friendly error using `notFoundHint`.
 */
export function spawnStreaming(
  bin: string,
  args: string[],
  options: SpawnStreamingOptions,
): Promise<SpawnResult> {
  const { cwd, signal, env, notFoundHint, onLines } = options;

  return new Promise<SpawnResult>((resolve) => {
    const outputLines: string[] = [];
    let pending = ""; // incomplete last line, not yet newline-terminated

    const child = spawn(bin, args, {
      cwd,
      shell: false,
      env: env ? { ...process.env, ...env } : process.env,
    });

    signal?.addEventListener("abort", () => child.kill("SIGTERM"));

    const handleChunk = (chunk: Buffer) => {
      pending += chunk.toString();
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      if (parts.length === 0) return; // no complete lines yet
      outputLines.push(...parts);
      onLines?.(outputLines);
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);

    child.on("close", (exitCode) => {
      // Flush any remaining partial line
      if (pending) outputLines.push(pending);
      resolve({ lines: outputLines, exitCode });
    });

    child.on("error", (err) => {
      const isEnoent = (err as NodeJS.ErrnoException).code === "ENOENT";
      const spawnError = isEnoent
        ? notFoundHint
          ? `${bin}: command not found. ${notFoundHint}`
          : `${bin}: command not found`
        : `Failed to spawn ${bin}: ${err.message}`;
      resolve({ lines: [], exitCode: null, spawnError });
    });
  });
}
