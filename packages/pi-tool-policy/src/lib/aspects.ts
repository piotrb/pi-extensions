import { basename, relative } from "node:path"

import { bashPatternToRegex, genericPatternToRegex, lastMatch } from "@piotrb/pi-extension-utils"
import picomatch from "picomatch"

import type { AnyVerdict, AspectRule, Verdict } from "./types.ts"

/** Result of matching a single value against an aspect. */
export interface AspectMatch {
  /** The verdict from the matched pattern. */
  verdict: Verdict
  /** The pattern that matched (last match wins). */
  pattern: string
}

// Module-level cache for compiled picomatch matchers, keyed by pattern string.
// Avoids re-compiling the same pattern across many `matchAspect` calls.
// Bounded implicitly by the size of the user's config (typically a few hundred
// patterns at most).
const picomatchCache = new Map<string, (input: string) => boolean>()

function normalizeAnyVerdict(v: AnyVerdict): Verdict {
  return typeof v === "string" ? v : v.verdict
}

/**
 * Match a value against an aspect's pattern map. Returns the LAST matching
 * pattern's verdict (last-match-wins). Returns `undecided` if no pattern matches
 * AND no `*` default is set.
 *
 * Cost: O(n) per call, where n is the number of patterns in `aspect.patterns`.
 * Each pattern is compiled via `regexOf` (bash or generic) for the `url` and
 * `bash_cmd` cases, or via picomatch for the `path` and `glob` cases. The
 * picomatch matchers are cached per call site to avoid repeated compilation.
 */
export function matchAspect(name: string, value: string, aspect: AspectRule, cwd: string): AspectMatch | "undecided" {
  // For `regex` aspect, treat each pattern as a literal RegExp source and
  // run `new RegExp(pattern).test(value)`. Last match wins.
  if (name === "regex") {
    let lastRegexMatch: { pattern: string; verdict: Verdict } | undefined
    for (const [pattern, v] of Object.entries(aspect.patterns)) {
      try {
        if (new RegExp(pattern).test(value)) {
          lastRegexMatch = { pattern, verdict: normalizeAnyVerdict(v) }
        }
      } catch {
        // Skip invalid regex patterns silently — they will be flagged at config-load time.
      }
    }
    return lastRegexMatch ?? "undecided"
  }

  // For `glob` aspect, use raw picomatch (per the design's "Raw `picomatch` for globs" decision).
  // Match the basename of the value (filename-only globs) with `{ dot: true }`.
  if (name === "glob") {
    const normalized = basename(value)
    let lastGlobMatch: { pattern: string; verdict: Verdict } | undefined
    for (const [pattern, v] of Object.entries(aspect.patterns)) {
      if (picomatch.isMatch(normalized, pattern, { dot: true })) {
        lastGlobMatch = { pattern, verdict: normalizeAnyVerdict(v) }
      }
    }
    return lastGlobMatch ?? "undecided"
  }

  // For `path` aspect, use picomatch (per the design's "picomatch for path/url/glob matchers"
  // decision). Match against `path.relative(cwd, absolute)` (the user's config uses
  // gitignore-style patterns rooted at cwd). Each pattern is a picomatch pattern; `*` is
  // single-segment, `**` is opt-in cross-segment.
  if (name === "path") {
    const normalized = relative(cwd, value).replace(/^\.\//, "")
    let lastPathMatch: { pattern: string; verdict: Verdict } | undefined
    for (const [pattern, v] of Object.entries(aspect.patterns)) {
      let matcher: ((input: string) => boolean) | undefined = picomatchCache.get(pattern)
      if (matcher === undefined) {
        matcher = picomatch(pattern, { dot: true })
        picomatchCache.set(pattern, matcher)
      }
      if (matcher(normalized)) {
        lastPathMatch = { pattern, verdict: normalizeAnyVerdict(v) }
      }
    }
    return lastPathMatch ?? "undecided"
  }

  // Dispatch on aspect name — "url" / "bash_cmd" / fallback.
  const regexOf = aspect.mode === "bash" ? bashPatternToRegex : genericPatternToRegex
  const normalized = normalize(name, value)
  const matched = lastMatch(aspect.patterns, normalized, (pattern) => {
    // lastMatch expects a (pattern, value) -> RegExp mapper; we wrap the
    // pattern-to-regex call so the verdict can stay typed as AnyVerdict.
    return regexOf(pattern)
  })
  if (matched === undefined) return "undecided"
  return { verdict: normalizeAnyVerdict(matched.value), pattern: matched.pattern }
}

/**
 * Match an array of values against an aspect's pattern map. Runs the
 * scalar `matchAspect` per element and combines the verdicts: deny > ask >
 * allow. Returns the matched pattern from the highest-strictness
 * element, or `undecided` if no element matched.
 *
 * Used for `mode: "X[]"` aspects where the input value is intrinsically
 * a list (e.g. `paths: string[]` for `git_add`). The strictness combine
 * means: a deny on ANY element deny-s the whole call, an ask on any
 * element with no deny ask-s the whole call, otherwise allow.
 */
export function matchAspectEach(
  name: string,
  values: string[],
  aspect: AspectRule,
  cwd: string,
): AspectMatch | "undecided" {
  let best: AspectMatch | "undecided" = "undecided"
  for (const v of values) {
    if (!v) continue
    const result = matchAspect(name, v, aspect, cwd)
    if (result === "undecided") continue
    if (best === "undecided" || STRICTNESS[result.verdict] > STRICTNESS[best.verdict]) {
      best = result
    }
  }
  return best
}

/** Strictness ranking: deny > ask > allow. */
const STRICTNESS: Record<Verdict, number> = { deny: 3, ask: 2, allow: 1 }

/** Normalize a value for matching based on the aspect's semantics. */
function normalize(name: string, value: string): string {
  switch (name) {
    case "url": {
      // new URL() with https:// fallback for bare hosts.
      try {
        return new URL(value).toString()
      } catch {
        return `https://${value}`
      }
    }
    case "command":
      // Bash mode — caller has already joined string[] with " ".
      return value
    default:
      return value
  }
}
