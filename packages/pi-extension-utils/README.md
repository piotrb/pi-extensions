# extension-utils

Shared utilities for pi extensions.

## Install

```sh
pnpm add extension-utils
```

## Exports

The package exports three spawn helpers and four pattern-matchers used by the policy engine.

### Spawn helpers

- `spawnStreaming(bin, args, options)` — Spawn a subprocess, stream stdout+stderr as accumulated lines. Options: `cwd`, `signal`, `env`, `notFoundHint`, `timeoutMs` (default 30 000), `onLines` (called on every chunk with a complete line), `onSpawn` (called synchronously with the ChildProcess).
- `progressiveKill(child, termDelayMs?, killDelayMs?)` — Graceful process termination (SIGINT → SIGTERM → SIGKILL). Returns a cleanup function that cancels pending timers. Defaults: 5 000 ms each.
- `scheduleProcessTimeout(ms, child, onTimeout)` — Schedule a timeout for a child process. After `ms` triggers `progressiveKill` and calls `onTimeout`. The timer is auto-cancelled on process exit. Pass `Infinity` to skip scheduling. Returns a cancel function.

### Pattern matchers

These are the v2 pattern language used by `pi-tool-policy` for tool-call gating and by `pi-task-runner` for command allow/deny rules. They were lifted from `pi-task-runner`'s pre-lift `patternToRegex`; the runner now re-imports them from this package.

- `genericPatternToRegex(pattern)` — Compile a generic pattern string to a RegExp. No bash word-boundary on trailing ` *`. Use for paths, URLs, globs, and any other pattern space where the `*` does not need to match across the end of a word. Standalone `*` matches any sequence including spaces.
- `bashPatternToRegex(pattern)` — Same as `genericPatternToRegex` but with the trailing-` *` word-boundary semantics suitable for shell command patterns. A pattern `"git *"` matches `"git status"` AND `"git"` alone (the word-boundary covers end-of-string). Patterns like `"git:*"` are normalized to `"git *"`. Use for `cmd`-type aspects and any rule that matches against a shell command.
- `specificity(pattern)` — Count the non-wildcard characters in a pattern. Higher = more specific. Used by `pi-task-runner` for rule-priority tiebreaking when multiple rules match the same command. A `*`-only pattern has specificity `0`; an exact-match pattern like `pnpm run test` has specificity `13`.
- `lastMatch(entries, value, regexOf)` — Last-match-wins resolver. Given an ordered record of `{pattern: V}` entries and a value to test, returns the value `V` from the LAST matching pattern. Returns `undefined` when no pattern matches and no `*` fallback is set. The `regexOf` parameter is a `(pattern) => RegExp` mapper so callers can choose `bashPatternToRegex` or `genericPatternToRegex` per pattern. Used by `pi-tool-policy`'s aspect matcher.

## Usage

```typescript
import { spawnStreaming } from "extension-utils"

const result = await spawnStreaming("rg", ["--color=never", "pattern", "."], {
  cwd: process.cwd(),
  signal: abortController.signal,
  notFoundHint: "brew install ripgrep",
})
```

## Development

```sh
pnpm install
pnpm run check  # typecheck + lint + test
```
