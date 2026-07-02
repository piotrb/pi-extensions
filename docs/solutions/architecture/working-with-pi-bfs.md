---
title: working with pi-bfs (transitional single-tool wrapper pending migration to pi-fd)
category: architecture
severity: high
tags:
  - pi-bfs
  - bfs
  - bfs-cli
  - find
  - fd
  - pi-fd
  - transitional
  - private-package
  - single-tool-wrapper
  - migrate-to-fd
applies_when:
  - working on, depending on, or evaluating the pi-bfs package
  - considering adding a feature to pi-bfs
  - needing breadth-first file finding in the workspace
  - planning the pi-fd migration
  - wondering why pi-bfs is marked private or has no features
---

# Problem

`pi-bfs` is a single-tool wrapper around the `bfs` (breadth-first file finder) CLI. It is in a specific lifecycle state — **transitional, marked private, and pending migration to a future `pi-fd` package** — that affects everything you do with it. Without a single reference for the package's invariants, the agent extends the package (the migration will throw the work away), publishes it (the `private: true` flag is meant to block this), or treats it as a stable dependency (it isn't; `pi-fd` will replace it).

This solution covers the package overview. The canonical `pi-*` package shape is in `pi-package-scaffold`. The hard rules (including `private: true` semantics) are in `pi-package-hard-rules`. The `pi-bfs` → `pi-fd` migration plan is in `packages/pi-bfs/plans/migrate-to-fd.md` (not shipped; excluded by the `files` allowlist).

# Context

`pi-bfs` exists because `bfs` is a `find`-compatible tool that traverses in breadth-first order by default, making it easy to get an overview before diving deep. It was added before the workspace adopted `pi-fd` (which wraps `fd` instead of `bfs`). The `bfs` binary requires a separate install (`brew install bfs`, `apt install bfs`) that most users won't have; `fd` is already installed as a dependency of pi's built-in `find` tool. The migration to `pi-fd` will give the workspace a file-finder that's already on every user's machine.

The migration is in progress, not complete. Until `pi-fd` lands, `pi-bfs` is the only sanctioned way the agent does breadth-first file finding.

# Solution

## What the package does

A single-tool wrapper around the `bfs` (breadth-first file finder) CLI. Registers one tool (`bfs`) that lets the agent run breadth-first file lookups instead of using `find` via bash. Supports name/path/type/size/time filters, depth limits, hidden-file control, and regex matching. Output is streamed in real time and truncated by default (ctrl+o to expand).

## Core rules

- **Do not extend `pi-bfs`.** The package is pending migration to a future `pi-fd` package (which will wrap `fd` instead of `bfs`). New features belong in the future `pi-fd` package, or in a different existing package if `fd` migration is not yet in scope. The migration plan is in `packages/pi-bfs/plans/migrate-to-fd.md`.
- **Do not publish `pi-bfs`.** It is marked `"private": true` in `package.json`. The `private: true` flag is the signal to npm tooling that this package is workspace-internal and must not be published. Removing the flag is forbidden.
- **Treat `pi-bfs` as a temporary dependency.** If your work depends on it, plan for the `pi-fd` migration. For content search in the meantime, use `pi-ripgrep`. For `pi-fd`-equivalent work, wait for the migration or implement the feature elsewhere.
- **The `bfs` binary must be installed separately.** Unlike the built-in `find` (which uses `ensureTool("fd", true)` to auto-download), `pi-bfs` does not auto-install. Users must have `bfs` in `PATH` (via `brew install bfs` or `apt install bfs`). If `bfs` is missing, the tool fails hard.

## Module structure

```
packages/pi-bfs/
  src/extensions/bfs.ts            # one registerTool call
  src/extensions/bfs.test.ts       # co-located test
  plans/migrate-to-fd.md           # migration plan (NOT shipped; excluded by `files` allowlist)
```

There is no `src/lib/`. The package is a single-tool wrapper, not a complex one. The migration plan in `plans/` is a working document — it is excluded from the published tarball by the `files` allowlist (so consumers of the workspace won't see it) but is visible to anyone working on the package.

## The `bfs` tool

The canonical shape (see `pi-register-tool` for the full pattern):

```ts
pi.registerTool({
  name: "bfs",
  label: "bfs",
  description: [
    "Find files and directories using bfs (breadth-first search, find-compatible).",
    "Prefer this over bash+find for any filesystem search.",
    // ...
  ].join(" "),
  parameters: Type.Object({
    /* name, path, type, depth, size, time, regex, etc. */
  }),
  execute: async (_id, p, ctx) => {
    return streamResult(spawnStreaming("bfs", [...flags, ...p.paths], { cwd: p.cwd }))
  },
})
```

The tool is read-only: only the print actions of `bfs` are exposed. No `-delete`, `-exec`, `-ok`. The streaming wrapper (`@piotrb/pi-extension-utils` `spawnStreaming`) handles output and process lifecycle.

## Migration status

The package is transitional. The `plans/migrate-to-fd.md` file describes the path to a future `pi-fd` package that wraps `fd` instead of `bfs`. The migration involves:

- **Rename** `packages/pi-bfs` → `packages/pi-fd`.
- **Swap binary** from `bfs` to `fd` using `ensureTool("fd", true)` (auto-download).
- **Register** as `name: "find"` to replace pi's built-in `find` tool.
- **Adopt** the built-in's `--full-path` glob handling, `--no-require-git` flag, and `--hidden` default.
- **Implement** the fd parameter mapping (the table in `migrate-to-fd.md` covers ~25 parameters).
- **Drop** features that `fd` doesn't support (`readable`/`writable`, `depthFirst`, `unique`).
- **Keep** streaming via `onUpdate`, `renderCall` TUI display, and the type/depth/size/time filters.

Once `pi-fd` lands, `pi-bfs` will be retired.

## Dependencies

- **Outbound:** `@piotrb/pi-extension-utils` (`spawnStreaming`).
- **Inbound:** pi-runtime. No other package depends on `pi-bfs` (it is leaf-level in the workspace).

# Why this works

- **The transitional status is honest.** `pi-bfs` is a placeholder until `pi-fd` lands. Marking it `private: true` keeps the workspace from accidentally publishing a temporary tool. The "do not extend" rule keeps the migration simple.
- **The `bfs` → `fd` migration is well-scoped.** The parameter mapping is a table; the new package is a renamed, parameter-mapped rewrite. Most of the work is mechanical. The features that need design thought (e.g. dropping `readable`/`writable`) are listed explicitly.
- **The `plans/` directory is the working area.** The migration plan is in `plans/migrate-to-fd.md` and is excluded from the published tarball. The plan is the place to track migration progress; the `bfs.ts` source is the place to keep the current tool working.

# Prevention

- **Do not add new features, options, or flags to the `bfs` tool.** The migration is in progress; changes will be lost. If a feature is needed, propose it for the future `pi-fd` package, or implement it in a different existing package.
- **Do not change the `private: true` flag.** The package is intentionally unpublished. Removing the flag would expose a transitional tool to npm consumers and create a public artifact the workspace has to maintain.
- **Do not import the `bfs` tool from a new package.** If you need breadth-first file finding, use `pi-ripgrep` (for content search) or wait for `pi-fd` (for path search). A new package that imports `bfs` is a new package that depends on a transitional artifact.
- **Do not update `plans/migrate-to-fd.md` ad-hoc.** It is a working document maintained alongside the migration work. Changes to the plan should be reviewed with the migration owner.
- **Do not assume the `bfs` binary is installed.** Unlike the built-in `find` (which uses `ensureTool("fd", true)` to auto-download), `pi-bfs` does not auto-install. Document the install requirement in the package README.
- **Do not auto-publish `pi-bfs`.** The `private: true` flag blocks `pnpm publish`. If the flag is removed (which is forbidden), the package would be published to npm and create a public artifact the workspace doesn't want to maintain.

# Verification

- **Private flag** is tested by `pnpm publish --dry-run` on the package; the command fails or warns that the package is private.
- **The `bfs` tool** has a co-located test (`bfs.test.ts`) that exercises the parameter mapping and the streaming output. The test does not require `bfs` to be installed; it uses a mock or skips on `ENOENT`.
- **The migration plan** is in `plans/migrate-to-fd.md` and is excluded from the published tarball by the `files` allowlist. Verify with `pnpm pack --dry-run` and inspect the tarball.

# Related

- `pi-package-scaffold` — the canonical `pi-*` package shape; `pi-bfs` is the example for the "Private/transitional" case.
- `pi-package-hard-rules` — the cross-cutting invariants for any `pi-*` package, including the `private: true` semantics and the publishing-flow invariants.
- `pi-npm-publishing` — the release workflow, including the publish table that lists `pi-bfs` as `private: true` (pending migration).
- `pi-fs-tools` — the `fs/promises` pattern; `pi-bfs` uses the `spawnStreaming` pattern (not `fs/promises`) because `bfs` is an external CLI.
- `pi-ripgrep` — the recommended bridge for content search until `pi-fd` lands. `pi-ripgrep` wraps `rg` (a content search tool); `pi-bfs` wraps `bfs` (a path search tool). They are complementary, not alternatives.
