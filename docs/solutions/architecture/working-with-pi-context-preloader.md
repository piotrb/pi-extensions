---
title: working with pi-context-preloader (lifecycle-only package, AGENTS.md @-ref preloader)
category: architecture
severity: high
tags:
  - pi-context-preloader
  - context-preloader
  - lifecycle-only
  - session_start
  - before_agent_start
  - AGENTS.md
  - at-ref
  - preload
  - system-prompt
  - auto-inject
  - MAX_DEPTH
applies_when:
  - working on, depending on, or evaluating the pi-context-preloader package
  - extending the @-reference syntax (REF_RE)
  - debugging a stale or missing preload
  - understanding why a referenced file is not in the system prompt
  - the only pi-* package that hooks lifecycle events without registering tools
---

# Problem

`pi-context-preloader` is the only package in the workspace that hooks lifecycle events without registering tools. Its job is to scan every `AGENTS.md` file the agent loads, extract `@path` references, and inject the referenced files into the system prompt before each agent turn. Without a single reference for the package's invariants, the agent re-walks `AGENTS.md` per turn (defeats the cache), skips the `session_start` cache clear (stale content leaks), or uses absolute reference paths (the doubled-prefix trap).

This solution covers the package overview. The lifecycle hook pattern (the three-phase shape, the one-shot guard, the cache clear on `session_start`) is in `pi-lifecycle-hooks`. The canonical `pi-*` package shape is in `pi-package-scaffold`. The `@`-reference path conventions (the doubled-prefix trap) are in `hackery-file-management`.

# Context

`pi-context-preloader` exists so the agent never has to manually `@` reference skills. Without the preloader, every `AGENTS.md` reference would be a manual `read` tool call by the agent. With the preloader, the references are resolved and injected at session start; the agent sees the preloaded content as part of the system prompt.

The package is **lifecycle-only** (no `registerTool` calls) and is the canonical example of the "Publishable, hooks lifecycle events" scaffold variant (see `pi-package-scaffold`).

# Solution

## What the package does

Auto-preloads `@path` references from `AGENTS.md` into the system prompt. Walks every `AGENTS.md` file pi loads (cwd + parent directories + `~/.pi/agent/AGENTS.md`), extracts `@path` references, resolves them recursively up to `MAX_DEPTH=5`, deduplicates across the tree, and injects the file contents into the system prompt before each agent turn. The agent never has to manually `@` reference skills — preloading happens at session start.

## Core rules

- **`session_start` MUST clear the cache.** Otherwise stale content leaks across sessions. The cache is per-session by design; a new session starts from a clean slate.
- **The `before_agent_start` injection is one-shot per session.** Adding more preloaded content means appending to the cached `appended` string, not re-scanning `AGENTS.md` on every turn. The per-turn cost is one string append, not a re-walk.
- **Files that don't exist or are unreadable are silently skipped** (with a log entry at `~/.pi/context-preloader.log`). The preloader must never fail the agent turn because a referenced file is missing.
- **Reference paths are relative to the containing file, not the project root.** Writing `@.agents/skills/<other>/SKILL.md` inside a skill at `.agents/skills/<this>/SKILL.md` is a bug — the preloader resolves it to `.agents/skills/<this>/.agents/skills/<other>/SKILL.md`. The doubled-prefix trap is the most common reference bug. See `hackery-file-management` for the full convention.

## Module structure

```
packages/pi-context-preloader/
  src/extensions/context-preloader.ts        # the entire extension (~190 lines)
  src/extensions/context-preloader.test.ts   # co-located test
```

There is no `src/lib/`. The package is a single file, not a complex one. The whole extension is in one `pi.on(...)` call site.

## `@path` reference resolution

```ts
const REF_RE = /@([\w./\\-]+\.\w+)/g
const MAX_DEPTH = 5

function resolveRefs(content: string, cwd: string, visited: Set<string>, depth: number): RefNode[]
```

- Matches `@` followed by any path-like string with a file extension.
- Resolved relative to the file containing the reference (not the project root).
- Recursive: a loaded file's own `@refs` are followed up to `MAX_DEPTH` deep.
- Deduplicated via `visited` set across the full resolution tree.

The reference path is always relative to the file that contains the reference — see `hackery-file-management` for the convention and the doubled-prefix trap.

## AGENTS.md discovery

```ts
function findAgentsMd(cwd: string): string[] {
  // walks cwd -> parent -> ... -> /
  // also includes ~/.pi/agent/AGENTS.md (global)
}
```

The walk goes from `cwd` up to the filesystem root, plus the user-level `~/.pi/agent/AGENTS.md`. The first `AGENTS.md` found at each level is included; the walk does not stop at the first one.

## Dependencies

- **Outbound:** Node stdlib only (`node:fs`, `node:os`, `node:path`).
- **Inbound:** pi-runtime (the system prompt). No tool calls into this package.
- **Peer deps:** just `@earendil-works/pi-coding-agent` — no `tui`, no `typebox`. The package is the minimal peer-deps example: no UI components, no schema library, just the runtime API.

## The three-phase pattern

`pi-context-preloader` is the canonical example of the three-phase pattern (load → pre-scan → inject) described in `pi-lifecycle-hooks`:

1. **`session_start`** — clear the cache (closure variable reset).
2. **`resources_discover`** — walk `AGENTS.md` files, resolve `@refs` recursively, deduplicate, store in cache.
3. **`before_agent_start`** — read the cache, append the preloaded content to the system prompt (one-shot guard so subsequent turns are no-ops).

The pattern is the same as `pi-tool-policy`'s variant (clear mode state on `session_start`, pre-scan rules on `resources_discover`, gate `tool_call` against cached rules). The shape is canonical; the contents are package-specific. See `pi-lifecycle-hooks` for the full pattern and the common pitfalls.

## How to extend it

When adding a new `AGENTS.md` reference convention:

1. Update `REF_RE` to match the new syntax.
2. Update `resolveRefs` to handle the new path shape.
3. Add a test in `src/extensions/context-preloader.test.ts` that walks a fixture tree and asserts the resolved set.
4. Run `pnpm --filter @piotrb/pi-context-preloader run typecheck test`.

When adding a new lifecycle hook:

1. Find the right phase in the `pi.on(...)` call sites — see `pi-lifecycle-hooks` for the three-phase pattern (load, pre-scan, inject).
2. Add the hook alongside the existing ones in `src/extensions/context-preloader.ts`.
3. Co-locate the test in `src/extensions/context-preloader.test.ts`. The one-shot-per-session guard pattern is load-bearing.

# Why this works

- **The pre-scan happens once per session.** The expensive walk (AGENTS.md files + recursive `@ref` resolution) runs on `resources_discover`, not on `before_agent_start`. The per-turn handler is a fast read of the cache.
- **The one-shot guard prevents unbounded prompt growth.** Without the guard, the preloaded content would be appended on every turn; the LLM would see duplicates; tokens would be wasted. With the guard, the first turn injects, subsequent turns are no-ops, the prompt is stable.
- **Reference paths are relative to the containing file.** The doubled-prefix trap (writing `@.agents/skills/<other>/SKILL.md` inside `.agents/skills/<this>/SKILL.md` and ending up at `<this>/.agents/skills/<other>/SKILL.md`) is avoided by following the containing-file rule. The convention is in `hackery-file-management`.
- **Files that don't exist are silently skipped.** The agent's session is not blocked by a missing reference. The preloader logs to `~/.pi/context-preloader.log` so the user can debug, but the turn continues.

# Prevention

- **Do not re-walk `AGENTS.md` on every agent turn.** The `before_agent_start` injection is one-shot per session; turn-level additions go to the cached `appended` string.
- **Do not throw on missing or unreadable referenced files.** Log and skip; the preloader must never fail the agent turn.
- **Do not use absolute reference paths.** All `@refs` are relative to the containing file. Absolute paths bypass the `path.relative` resolution and produce unexpected results.
- **Do not skip the `session_start` cache clear.** Without it, content from a previous session leaks into the new one. The first symptom is "why is the agent acting on yesterday's data?" The fix is mechanical: every closure-cached variable gets a reset in the `session_start` handler.
- **Do not add `pi-tui` or `typebox` to `peerDependencies`.** The package does not need them. Adding them bloats the peer-deps minimalism the package is the canonical example of.
- **Do not extend the preloader to register a tool.** The package is lifecycle-only by design. Adding `registerTool` calls breaks the canonical shape and the peer-deps minimalism.
- **Do not write a `@-reference` that points to itself.** The `visited` set prevents infinite recursion, but a self-reference is still a bug — the file is in the resolution set, and the agent sees the file's own content twice (once as the file, once as the reference target).

# Verification

- **Cache clear on `session_start`** is tested by starting a session, preloading content, ending the session, starting a new session, and asserting the new session's preloaded content does not include the old session's data.
- **One-shot injection** is tested by calling `before_agent_start` twice in a row and asserting the second call is a no-op (the system prompt is unchanged from the first call).
- **Silent skip on missing files** is tested by referencing a non-existent file and asserting the agent turn continues (no throw) and the log file gets an entry.
- **Doubled-prefix trap** is tested by writing a fixture tree with a nested reference and asserting the resolution goes to the doubled-prefix path (the test documents the bug as a known gotcha, not a test that should pass).
- **Peer-deps minimalism** is tested by inspecting `package.json` and asserting the only peer dep is `@earendil-works/pi-coding-agent`.

# Related

- `pi-lifecycle-hooks` — the three-phase pattern (load, pre-scan, inject), the one-shot guard, the cache clear on `session_start`. `pi-context-preloader` is the canonical example.
- `pi-package-scaffold` — the canonical `pi-*` package shape; `pi-context-preloader` is the example for the "Publishable, hooks lifecycle events" variant.
- `pi-package-hard-rules` — the cross-cutting invariants, including the peer-deps minimalism rule.
- `hackery-file-management` — the `@`-reference path conventions, including the doubled-prefix trap.
- `pi-hackery-folder-layout` — the workspace's two skill trees (workspace learnings vs. `pi-hackery` framework skills); the `@`-reference convention is the same for both.
- `pi-monorepo-overview` — the workspace layout, including `AGENTS.md` as the project entry point.
