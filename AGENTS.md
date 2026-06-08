# Agent Guidelines — pi-extensions

## After every edit, run the check command

**No exceptions.** After any change to a `.ts` or config file, run:

```sh
pnpm check
```

This runs `pnpm -r run typecheck`, `prettier --check .`, `pnpm -r run lint`, and `pnpm -r run test` in sequence. Fix all errors before moving on. Do not batch edits and check at the end — run after each individual edit so failures are easy to localise.

If `pnpm check` is not available (e.g. `node_modules` not installed), run:

```sh
pnpm install
pnpm check
```

## Project structure

This is a **pnpm workspace**. Each pi extension is its own publishable npm package under `packages/`, with shared low-level helpers in `packages/extension-utils/`.

```
packages/
  pi-extension-utils/
    src/
      extension-utils.ts     — shared utilities: spawnStreaming, progressiveKill, scheduleProcessTimeout
  pi-bfs/
    src/extensions/
      bfs.ts                 — bfs breadth-first file finder tool
  pi-context-preloader/
    src/extensions/
      context-preloader.ts   — auto-preload @refs from AGENTS.md into system prompt
  pi-git/
    src/extensions/
      git.ts                 — git_status / git_add / git_rm / git_mv / git_diff / git_restore / git_commit / git_log / git_push
  pi-pfs/
    src/extensions/
      pfs.ts                 — pfs_unlink / pfs_rmdir / pfs_cp / pfs_mv filesystem tools
  pi-ripgrep/
    src/extensions/
      ripgrep.ts             — ripgrep tool wrapper
  pi-task-runner/
    src/extensions/
      task-runner.ts         — run tool with permission rules
    src/lib/
      permissions.ts         — pattern-based rule matching
      runner-config.ts       — config loading and persistence
      runner-modal.ts        — TUI modal for managing permissions
```

Each `packages/<name>/` is its own npm package with its own `package.json`, `tsconfig.json`, and `README.md`. Extensions list their entry point under `"pi": { "extensions": [...] }` in their `package.json`.

## Key rules

- **Imports**: use `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` — never the old `@mariozechner/*` package names.
- **pi-extension-utils**: import shared utilities using the bare package specifier: `import { spawnStreaming } from "pi-extension-utils"`. The workspace links this via `"pi-extension-utils": "workspace:*"` in each consumer's `dependencies`.
- **No barrel/index file**: extensions are listed directly in `package.json`, there is no `index.ts`.
- **Module style**: ESM only (`"type": "module"`). NodeNext module resolution — local imports keep `.ts` extensions (pi's runtime handles them via jiti).
- **Shared tsconfig**: each package's `tsconfig.json` extends `../../tsconfig.base.json` with `"include": ["src/**/*"]`. Do not duplicate compilerOptions.
- **File operations**: prefer `pfs_mv`, `pfs_cp`, `pfs_unlink`, `pfs_rmdir` for filesystem moves/deletes. Use `git_mv` only when you explicitly need git to track the rename in the index.
- **Skills**: any change to `.ai/*.md` MUST update the Skills section below in the same commit. See @.ai/skill-index-maintenance.md.

## Workspace commands

```sh
pnpm install                             # install all workspace packages
pnpm run check                           # aggregate: typecheck → format → lint → test (all -r)
pnpm -r run typecheck                    # tsc --noEmit in every package
pnpm -r run lint                         # eslint in every package (delegates to root config)
pnpm -r run test                         # vitest run in every package that has tests
pnpm --filter pi-task-runner run check      # single-package check
pnpm --filter pi-bfs run typecheck          # single-package typecheck
```

## Skills

**Core (always loaded):**

@.ai/pi-extension-toolchain.md
@.ai/pi-npm-extension-package.md
@.ai/skill-index-maintenance.md

**Secondary (load when relevant):**

- `.ai/pi-npm-publishing.md` — load when preparing to publish packages to npm, configuring scopes, or setting up publishConfig
