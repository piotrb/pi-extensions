# Agent Guidelines — pi-extensions

## After every edit, run the check command

**No exceptions.** After any change to a `.ts` or config file, run the relevant check. The default `run` tool timeout (30s) is shorter than a full workspace check, so for a single-package edit run the scoped Turbo filter (typically well under 30s):

```sh
# Single package — typecheck + test only (format+lint still need a full check)
pnpm turbo run typecheck test --filter=<pkg>

# Or just typecheck or just test:
pnpm --filter <pkg> run typecheck
pnpm --filter <pkg> run test

# Full workspace — root format+lint + per-package typecheck+test, all in parallel
pnpm run check
```

`check` shape: Turbo runs the four tasks declared in `turbo.json` — `//#format:check` and `//#lint` once at the repo root, then `typecheck` and `test` per package in parallel. Cache hits make repeat runs near-instant. See `.ai/pi-extension-toolchain.md` for the full Turbo conventions.

If `pnpm check` is not available (e.g. `node_modules` not installed), run:

```sh
pnpm install
pnpm check
```

## Project structure

This is a **pnpm workspace**. Each pi extension is its own publishable npm package under `packages/`, with shared low-level helpers in `packages/pi-extension-utils/`.

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
- **pi-extension-utils**: import shared utilities using the scoped package specifier: `import { spawnStreaming } from "@piotrb/pi-extension-utils"`. The workspace links this via `"@piotrb/pi-extension-utils": "workspace:*"` in each consumer's `dependencies`.
- **No barrel/index file**: extensions are listed directly in `package.json`, there is no `index.ts`.
- **Module style**: ESM only (`"type": "module"`). NodeNext module resolution — local imports keep `.ts` extensions (pi's runtime handles them via jiti).
- **Shared tsconfig**: each package's `tsconfig.json` extends `../../tsconfig.base.json` with `"include": ["src/**/*"]`. Do not duplicate compilerOptions.
- **File operations**: prefer `pfs_mv`, `pfs_cp`, `pfs_unlink`, `pfs_rmdir` for filesystem moves/deletes. Use `git_mv` only when you explicitly need git to track the rename in the index.
- **Skills**: any change to `.ai/*.md` MUST update the Skills section below in the same commit. The `.rpiv/guidance/` tree has its own maintenance workflow (run `annotate-guidance`) and is not covered by this rule. See @.ai/skill-index-maintenance.md.

## Workspace commands

```sh
pnpm install                             # install all workspace packages
pnpm run check                           # turbo run //#format:check //#lint typecheck test
pnpm turbo typecheck test                # per-package typecheck+test (parallel, cached)
pnpm turbo //#lint                       # root lint (eslint . over whole tree)
pnpm turbo //#format:check               # root format check (prettier --check .)
pnpm --filter <pkg> run typecheck        # single-package typecheck
pnpm --filter <pkg> run test             # single-package test
```

## Skills

**Core (always loaded):**

@.ai/pi-extension-toolchain.md
@.ai/skill-index-maintenance.md
@.rpiv/guidance/architecture.md

**Secondary (load when relevant):**

- `.ai/pi-npm-publishing.md` — load when preparing to publish packages to npm, configuring scopes, or setting up publishConfig
- `.rpiv/guidance/` — read on demand when entering a package or layer; the root file lists what's available
