import { isAbsolute, relative } from "node:path"

/**
 * Render a `path`-mode aspect value for display in the policy-ask UI.
 *
 * The user wants to see paths relative to the project root, but a path
 * that escapes the project root (`` ../foo ``) is awkward to read
 * without the absolute form for context. The convention is:
 *
 *   - Already-relative input: pass through unchanged. Some tools pass
 *     `` src/foo.ts `` as a relative path; we don't mangle it into
 *     `` ../../cwd/src/foo.ts ``.
 *   - Absolute input inside cwd: show the relative form alone
 *     (`` src/foo.ts ``) — clean and readable.
 *   - Absolute input outside cwd: show the relative form plus the
 *     absolute form in parens (`` `../foo` (`/abs/foo`) ``) — matches
 *     the directory-permissions modal's `` formatDirectoryPath ``
 *     convention so the user can tell *which* `` ../foo `` is meant.
 *
 * This is the canonical "path aspect for display" formatter. The
 * matcher does its own relativization (see `` aspects.ts ``), so this
 * helper is purely cosmetic.
 */
export function formatPathForDisplay(value: string, cwd: string): string {
  if (!isAbsolute(value)) return value
  const rel = relative(cwd, value)
  // `relative` returns "" when the input IS the cwd. Render as "."
  // so the user sees something rather than an empty display.
  if (rel === "") return "."
  // A leading ".." means the path escapes cwd. Show both forms so
  // the absolute is recoverable from the display.
  if (rel.startsWith("..")) return `\`${rel}\` (\`${value}\`)`
  return rel
}
