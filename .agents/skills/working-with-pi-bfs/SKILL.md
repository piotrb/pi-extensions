---
name: working-with-pi-bfs
description: Core facts about the pi-bfs package — it is transitional, marked private, and pending migration to a future pi-fd package. Use when working on, depending on, or evaluating the pi-bfs package.
---

You are working on, depending on, or evaluating the `pi-bfs` package. The package is in a specific lifecycle state that affects everything you do with it.

## What the package does

A single-tool wrapper around the `bfs` (breadth-first file finder) CLI. Registers one tool (`bfs`) that lets the agent run breadth-first file lookups instead of using `find` via bash.

## Core rules

- **Do not extend `pi-bfs`.** The package is pending migration to a future `pi-fd` package (which will wrap `fd` instead of `bfs`). New features belong in the future `pi-fd` package, or in a different existing package if `fd` migration is not yet in scope.
- **Do not publish `pi-bfs`.** It is marked `"private": true` in `package.json`. The `private: true` flag is the signal to npm tooling that this package is workspace-internal and must not be published.
- **Treat `pi-bfs` as a temporary dependency.** If your work depends on it, plan for the `pi-fd` migration. For content search in the meantime, use `pi-ripgrep`.

## Module structure

```
packages/pi-bfs/
  src/extensions/bfs.ts            # one registerTool call
  src/extensions/bfs.test.ts       # co-located test
  plans/migrate-to-fd.md           # migration plan (NOT shipped; excluded by `files` allowlist)
```

There is no `src/lib/`. The package is a single-tool wrapper, not a complex one.

## How to extend it

**You should not.** The migration is in progress. If a feature is needed:

- Content search → use `pi-ripgrep` (the recommended bridge until `pi-fd` lands).
- File finding with new semantics → propose the feature for the future `pi-fd` package, or implement it in a different existing package.

The `plans/migrate-to-fd.md` file in the package describes the migration path. Read it before proposing any change to the `bfs` tool.

## Migration status

The package is transitional. The `plans/migrate-to-fd.md` file describes the path to a future `pi-fd` package that wraps `fd` instead of `bfs`. Once `pi-fd` lands, `pi-bfs` will be retired.

## Dependencies

- **Outbound:** `@piotrb/pi-extension-utils` (`spawnStreaming`).
- **Inbound:** pi-runtime. No other package depends on `pi-bfs` (it is leaf-level in the workspace).

## What you do not do

- Do not add new features, options, or flags to the `bfs` tool. The migration is in progress; changes will be lost.
- Do not change the `private: true` flag. The package is intentionally unpublished.
- Do not import the `bfs` tool from a new package. If you need breadth-first file finding, use `pi-ripgrep` or wait for `pi-fd`.
- Do not update `plans/migrate-to-fd.md` ad-hoc. It is a working document maintained alongside the migration work.

## What this skill does not do

- It does not cover the canonical `pi-*` package shape — see `pi-package-scaffold`.
