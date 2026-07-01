---
name: no-cache-for-user-mutable-data
description: Files the user can edit mid-session — rule files, config files, settings — should be re-read on every access, not cached. Use when designing a tool, gate, or extension that consumes user-owned files. Caching here is a UX bug, not an optimization.
---

# No cache for user-mutable data

When a tool or extension reads a file the user can edit at any time — rule files, config files, settings, prompt templates — the file should be **re-read on every access**, not cached. Caching is a UX bug here, not an optimization: the user edits, the tool ignores the edit, the user is confused.

The latency cost of re-reading is small for small files (markdown, JSON, YAML) and is dwarfed by the cost of a confused user. The performance argument for caching is rarely load-bearing.

## When to Use

Lead with the symptom: "I edited the rules file and the gate still uses the old version until I restart the session." Use this skill when:

- A tool or extension reads a file from `~/.pi/agent/` or `<project>/.pi/`.
- A gate, rule engine, or config-driven behavior consumes a user-supplied file.
- A cached `Promise<content>` is the result of one-shot `readFile`.
- The user might reasonably want to edit the file and have changes take effect immediately.

## Key Facts

- **The cache key matters.** Caching on `cwd` is wrong: a user who switches directories is not necessarily editing the file. Caching on `mtime` adds a stat call but doesn't catch the common case (the user edits, the session has the same cwd). Caching on session start ignores all mid-session edits.
- **The latency argument is weak.** For files under 100KB (typical rules, configs, prompts), `readFile` is sub-millisecond. The round-trip to the LLM dwarfs the read. Caching the read saves nothing the user would notice.
- **The "fail-open if read fails" contract interacts badly with caching.** If the cache holds a stale "successful read" result, the user edits a corrupted file, and the cache is consulted — the tool uses the old content. Re-reading catches the new state.
- **The session boundary is a real boundary.** It's tempting to argue "the user is unlikely to edit a file mid-session" — but sessions can be long (an entire afternoon of work), and edits do happen. The cost of being wrong (caching stale content) is higher than the cost of being right (re-reading).

## Steps

1. **Identify user-mutable files.** Anything in `~/.pi/agent/`, `~/.config/pi*/`, `<project>/.pi/`, or any project-relative config. Treat as live data, never cached.
2. **Call the read function per access.** Where a cached `Promise<content>` would be, call `readFile` (or the higher-level loader) per access. The function should be fast enough that this is not a concern.
3. **For multi-file concatenations, re-read all of them per access.** If the loader reads four files and joins them, do not memoize the result. The cost of joining is negligible; the cost of stale data is real.
4. **Reserve caching for things that don't change.** Model identifiers, compiled regexes, evaluation metrics — these are session-stable. Rule files, user prompts, config — these are not.
5. **Document the policy in the README.** Make it explicit: "rules are re-read on every bash call. User edits take effect immediately." A confused user is the worst outcome.

## Notes

- This is a general principle for any user-facing runtime. The same rule applies to IDE settings, shell aliases, env vars read from files, etc.
- The exception is when the file is large (megabytes) and the read cost dominates. For typical rule files (a few KB to a few dozen KB), no exception is warranted.
- The "session" boundary is a soft signal, not a hard one. The user can keep a session open while editing. Caching on session start is a UX bug in the user's mental model: they think their edit took effect.
- Surfaced in the implementation of `pi-do-it-right` — see `packages/pi-do-it-right/src/lib/rules.ts` `loadRules` and the tool_call handler that calls it per bash call.
- Counter-example: settings (model, auth, defaults) ARE cached for the session. Those change rarely and the user has explicit "Refresh" affordances via `/do-it-right` menu if needed.
