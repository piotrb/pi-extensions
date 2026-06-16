---
name: working-with-pi-context-preloader
description: Core facts about the pi-context-preloader package — the only package that hooks lifecycle events instead of registering tools. Auto-preloads @path references from AGENTS.md into the system prompt before each agent turn. Use when working on, depending on, or evaluating the pi-context-preloader package.
---

You are working on, depending on, or evaluating the `pi-context-preloader` package. It is the only package in the workspace that hooks lifecycle events instead of registering tools. Its job is to scan every `AGENTS.md` file the agent loads, extract `@path` references, and inject the referenced files into the system prompt before each agent turn.

## What the package does

Auto-preloads `@path` references from `AGENTS.md` into the system prompt. Walks every `AGENTS.md` file pi loads (cwd + parent directories + `~/.pi/agent/AGENTS.md`), extracts `@path` references, resolves them recursively up to `MAX_DEPTH=5`, deduplicates across the tree, and injects the file contents into the system prompt before each agent turn. The agent never has to manually `@` reference skills — preloading happens at session start.

## Core rules

- **`session_start` MUST clear the cache.** Otherwise stale content leaks across sessions. The cache is per-session by design; a new session starts from a clean slate.
- **The `before_agent_start` injection is one-shot per session.** Adding more preloaded content means appending to the cached `appended` string, not re-scanning `AGENTS.md` on every turn. The per-turn cost is one string append, not a re-walk.
- **Files that don't exist or are unreadable are silently skipped** (with a log entry at `~/.pi/context-preloader.log`). The preloader must never fail the agent turn because a referenced file is missing.

## Module structure

```
packages/pi-context-preloader/
  src/extensions/context-preloader.ts        # the entire extension (~190 lines)
  src/extensions/context-preloader.test.ts   # co-located test
```

There is no `src/lib/`. The package is a single file, not a complex one.

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

The reference path is always relative to the file that contains the reference — see `learning-management` for the convention and the doubled-prefix trap.

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
- **Peer deps:** just `@earendil-works/pi-coding-agent` — no `tui`, no `typebox`.

## Hard rules

- **`session_start` MUST clear the cache** — otherwise stale content leaks across sessions.
- **The `before_agent_start` injection is one-shot per session** — adding more preloaded content means appending to the cached `appended` string.
- **Files that don't exist or are unreadable are silently skipped** (with a log entry at `~/.pi/context-preloader.log`).
- **Reference paths are relative to the containing file, not the project root.** Writing `@.agents/skills/<other>/SKILL.md` inside a skill at `.agents/skills/<this>/SKILL.md` is a bug — the preloader resolves it to `.agents/skills/<this>/.agents/skills/<other>/SKILL.md`.

## How to extend it

When adding a new AGENTS.md reference convention:

1. Update `REF_RE` to match the new syntax.
2. Update `resolveRefs` to handle the new path shape.
3. Add a test in `src/extensions/context-preloader.test.ts` that walks a fixture tree and asserts the resolved set.
4. Run `pnpm --filter @piotrb/pi-context-preloader run typecheck test`.

When adding a new lifecycle hook:

1. Find the right phase in the `pi.on(...)` call sites — see `pi-lifecycle-hooks` for the three-phase pattern (load, pre-scan, inject).
2. Add the hook alongside the existing ones in `src/extensions/context-preloader.ts`.
3. Co-locate the test in `src/extensions/context-preloader.test.ts`. The one-shot-per-session guard pattern is load-bearing.

## What you do not do

- Do not re-walk `AGENTS.md` on every agent turn. The `before_agent_start` injection is one-shot per session; turn-level additions go to the cached `appended` string.
- Do not throw on missing or unreadable referenced files. Log and skip; the preloader must never fail the agent turn.
- Do not use absolute reference paths. All `@refs` are relative to the containing file.
- Do not skip the `session_start` cache clear. Without it, content from a previous session leaks into the new one.

## What this skill does not do

- It does not cover the lifecycle hook pattern in detail — see `pi-lifecycle-hooks`.
- It does not cover the canonical `pi-*` package shape — see `pi-package-scaffold`.
- It does not cover the `@`-reference path conventions — see `learning-management`.
