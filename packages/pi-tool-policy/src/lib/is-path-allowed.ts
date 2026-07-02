import { isAbsolute, relative } from "node:path"

import type { AllowedPath } from "./types.ts"

/**
 * Lexical containment: `absPath` is inside `grantPath` if the relative
 * path from `grantPath` to `absPath` does not start with `..` or `/`.
 * No realpath.
 */
export function isInsidePath(absPath: string, grantPath: string): boolean {
  const rel = relative(grantPath, absPath)
  return !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * Pure: is `absPath` allowed under the given `allowedPaths` config for a
 * tool whose `effectiveTags` cover the path's required tags?
 *
 * - An entry with empty `tags` covers every effective tag set (allowAny).
 * - Otherwise ALL of the entry's `tags` must appear in `effectiveTags`.
 * - If any entry covers the path with matching tags, the path is allowed.
 * - Empty `allowedPaths` denies everything.
 */
export function isPathAllowed(absPath: string, effectiveTags: string[], allowedPaths: AllowedPath[]): boolean {
  for (const entry of allowedPaths) {
    if (!isInsidePath(absPath, entry.path)) continue
    if (entry.tags.length === 0) return true
    if (entry.tags.every((t) => effectiveTags.includes(t))) return true
  }
  return false
}
