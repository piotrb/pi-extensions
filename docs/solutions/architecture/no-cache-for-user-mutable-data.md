---
title: No cache for user-mutable data
category: architecture
severity: high
tags:
  - caching
  - user-data
  - ux
  - file-io
  - session-state
  - config-loading
applies_when:
  - designing a tool, gate, or extension in this repo that consumes user-owned files
  - reading rule files, config files, settings, or prompt templates at runtime
  - deciding between a cached Promise<content> and a per-access readFile
  - a user has reported "I edited the rules file and the gate still uses the old version"
---

# Problem

In this repo, tools and extensions that read user-editable files (rule files, config, settings, prompt templates) cache the read result and silently ignore mid-session user edits. The user changes the file, expects the change to take effect, and instead sees the old behavior — and is left to figure out why. Caching is treated as a performance optimization here, but it is actually a UX bug: the cost of being wrong (the user is confused, the rule is wrong) is much higher than the cost of being right (a sub-millisecond re-read).

The canonical instance is `pi-do-it-right`'s `loadRules` and the `tool_call` handler that calls it per bash invocation. The rule loader must re-read on every access; memoizing the rules (or any other user-mutable input) breaks the user's mental model of "I edited the file, the change is live."

# Context

Any tool or extension in this repo that reads files the user can edit at any time. The classic cases are gates and rule engines that load rules from `~/.pi/agent/`, `<project>/.pi/`, or a project-relative config directory. The read is typically `readFile` (or a higher-level loader that does a one-shot read and memoizes the result). The session is long — an afternoon of work is normal — and the user may edit the file in another window during the session.

The exception is large files (megabytes) where the read cost dominates. For typical rule files, configs, and prompts (a few KB to a few dozen KB), this exception does not apply.

# Solution

Re-read user-mutable files on every access. Do not memoize the result.

1. **Identify user-mutable files.** Anything in `~/.pi/agent/`, `~/.config/pi*/`, `<project>/.pi/`, or any project-relative config. Treat as live data, never cached.
2. **Call the read function per access.** Where a cached `Promise<content>` would be, call `readFile` (or the higher-level loader) per access. The function should be fast enough that this is not a concern.
3. **For multi-file concatenations, re-read all of them per access.** If the loader reads four files and joins them, do not memoize the result. The cost of joining is negligible; the cost of stale data is real.
4. **Reserve caching for things that don't change.** Model identifiers, compiled regexes, evaluation metrics — these are session-stable. Rule files, user prompts, config — these are not.
5. **Document the policy in the README.** Make it explicit: "rules are re-read on every bash call. User edits take effect immediately." A confused user is the worst outcome.

# Why this works

- **The latency argument is weak.** For files under 100KB (typical rules, configs, prompts), `readFile` is sub-millisecond. The round-trip to the LLM dwarfs the read. Caching the read saves nothing the user would notice.
- **The "fail-open if read fails" contract interacts badly with caching.** If the cache holds a stale "successful read" result, the user edits a corrupted file, and the cache is consulted — the tool uses the old content. Re-reading catches the new state.
- **The session boundary is a soft signal, not a hard one.** The user can keep a session open while editing. Caching on session start is a UX bug in the user's mental model: they think their edit took effect.
- **The cache key matters.** Caching on `cwd` is wrong: a user who switches directories is not necessarily editing the file. Caching on `mtime` adds a stat call but doesn't catch the common case (the user edits, the session has the same cwd). Caching on session start ignores all mid-session edits.
- **The "user is unlikely to edit mid-session" argument is empirical and wrong.** Sessions can be long (an entire afternoon of work), and edits do happen. The cost of being wrong (caching stale content) is higher than the cost of being right (re-reading).

# Prevention

- **Default to no cache** for any file in a user-mutable location. Add caching only with explicit justification (large file, measured latency cost).
- **Never store a `Promise<content>`** as a long-lived module variable for user-mutable content. The promise resolves once and the result is stale forever.
- **If a tool exposes a "Refresh" affordance**, that's a strong signal that caching is the wrong default. The user shouldn't have to know to refresh — edits should take effect immediately.
- **Counter-example: session-stable settings are fine to cache.** Model identifiers, auth tokens, compiled regexes, evaluation metrics — these don't change in a session, and caching them is a real optimization. The line is "does the user edit this mid-session?" If yes, re-read. If no, cache.
- **Reference implementation: `pi-do-it-right`.** See `packages/pi-do-it-right/src/lib/rules.ts` `loadRules` and the `tool_call` handler that calls it per bash call. The pattern is: load per access, never memoize the rules themselves; cache the parsed/compiled representation only if it's expensive to compute AND the source hasn't changed.
