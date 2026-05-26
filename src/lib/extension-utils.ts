/**
 * extension-utils — shared utilities for pi extensions.
 *
 * Import with a relative path:
 *   import { spawnStreaming } from "../lib/extension-utils.ts";
 */

import { type ChildProcess, spawn } from "node:child_process"

// ─── spawnStreaming ───────────────────────────────────────────────────────────

export interface SpawnResult {
  lines: string[]
  exitCode: number | null
  /** Set when the binary could not be spawned at all (e.g. not found in PATH). */
  spawnError?: string
}

export interface SpawnStreamingOptions {
  cwd: string
  signal?: AbortSignal
  env?: Record<string, string>
  /**
   * Human-readable install hint shown when the binary is not found (ENOENT).
   * e.g. "brew install ripgrep"
   * Falls back to a generic message if omitted.
   */
  notFoundHint?: string
  /**
   * Maximum time (ms) to wait before killing the child process and resolving
   * with a timeout error. Defaults to 30 000 ms (30 s). Pass Infinity to
   * disable.
   */
  timeoutMs?: number
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
  onLines?: (lines: string[]) => void
}

// ─── progressiveKill ───────────────────────────────────────────────────────────────

/**
 * Send SIGINT to `child`, then SIGTERM after `termDelayMs`, then SIGKILL after
 * another `killDelayMs`. Timers are cleared as soon as the process exits.
 *
 * Returns a cleanup function that cancels any pending timers (safe to call
 * after the process has already exited).
 */
export function progressiveKill(child: ChildProcess, termDelayMs = 5_000, killDelayMs = 5_000): () => void {
  child.kill("SIGINT")

  const termTimer = setTimeout(() => {
    child.kill("SIGTERM")
  }, termDelayMs)

  const killTimer = setTimeout(() => {
    child.kill("SIGKILL")
  }, termDelayMs + killDelayMs)

  const cleanup = () => {
    clearTimeout(termTimer)
    clearTimeout(killTimer)
  }

  child.once("exit", cleanup)

  return cleanup
}

// ─── scheduleProcessTimeout ─────────────────────────────────────────────────────────

/**
 * Schedule a timeout for a child process. After `ms` milliseconds:
 *   1. Triggers a progressive kill on the child (SIGINT → SIGTERM → SIGKILL).
 *   2. Calls `onTimeout` so the caller can resolve/reject.
 *
 * The timer is automatically cancelled if the process exits before the timeout,
 * so callers do not need to call the returned cancel function in their close/error
 * handlers. Pass `Infinity` to skip scheduling entirely.
 *
 * Returns a cancel function (useful for early cancellation in other paths).
 */
export function scheduleProcessTimeout(ms: number, child: ChildProcess, onTimeout: () => void): () => void {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  if (ms === Infinity) return () => {}

  const cancel = () => {
    clearTimeout(timer)
  }

  const timer = setTimeout(() => {
    child.removeListener("exit", cancel)
    progressiveKill(child)
    onTimeout()
  }, ms)

  child.once("exit", cancel)

  return cancel
}

// ─── spawnStreaming ───────────────────────────────────────────────────────────────

/**
 * Spawn a subprocess, stream stdout+stderr as accumulated lines, and resolve
 * with the full output once the process exits.
 *
 * - stdout and stderr are merged into a single ordered stream (same as 2>&1).
 * - Lines are split on `\n`; a trailing incomplete line is held in a buffer
 *   and flushed when the process closes.
 * - The abort signal triggers progressive kill (SIGINT → SIGTERM → SIGKILL).
 * - Timeout triggers the same progressive kill sequence.
 * - ENOENT is converted to a friendly error using `notFoundHint`.
 */
export function spawnStreaming(bin: string, args: string[], options: SpawnStreamingOptions): Promise<SpawnResult> {
  const { cwd, signal, env, notFoundHint, onLines, timeoutMs = 30_000 } = options

  return new Promise<SpawnResult>((resolve) => {
    const outputLines: string[] = []
    let pending = "" // incomplete last line, not yet newline-terminated
    let settled = false

    const child = spawn(bin, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: env ? { ...process.env, ...env } : process.env,
    })

    signal?.addEventListener("abort", () => progressiveKill(child))

    scheduleProcessTimeout(timeoutMs, child, () => {
      if (settled) return
      settled = true
      resolve({
        lines: outputLines,
        exitCode: null,
        spawnError: `${bin}: timed out after ${timeoutMs / 1000}s`,
      })
    })

    const handleChunk = (chunk: Buffer) => {
      pending += chunk.toString()
      const parts = pending.split("\n")
      pending = parts.pop() ?? ""
      if (parts.length === 0) return // no complete lines yet
      outputLines.push(...parts)
      onLines?.(outputLines)
    }

    child.stdout.on("data", handleChunk)
    child.stderr.on("data", handleChunk)

    child.on("close", (exitCode) => {
      if (settled) return
      settled = true
      // Flush any remaining partial line
      if (pending) outputLines.push(pending)
      resolve({ lines: outputLines, exitCode })
    })

    child.on("error", (err) => {
      if (settled) return
      settled = true
      const isEnoent = (err as NodeJS.ErrnoException).code === "ENOENT"
      const spawnError = isEnoent
        ? notFoundHint
          ? `${bin}: command not found. ${notFoundHint}`
          : `${bin}: command not found`
        : `Failed to spawn ${bin}: ${err.message}`
      resolve({ lines: [], exitCode: null, spawnError })
    })
  })
}
