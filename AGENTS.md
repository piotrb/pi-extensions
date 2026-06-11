# Agent Guidelines — pi-extensions

## After every edit, run the check command

**No exceptions.** After any change to a `.ts` or config file, run the relevant check, and **read the affected region (5-10 lines) to verify the file's literal state**. `edit` reports success when `oldText` is found, not when the result is correct — duplicate lines, truncated lines, and `oldText` matches in the wrong location have all shipped past verification. The default `run` tool timeout (30s) is shorter than a full workspace check, so for a single-package edit run the scoped Turbo filter (typically well under 30s):

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

### Tool surface rules

These are derived from repeated cross-session corrections. Read this section before calling the `run` tool or any filesystem mutation.

- **Use `run`, not bash.** All project commands go through the `run` tool (and filesystem ops through `pfs_*`). Do not use `bash`, `rm`, `mv`, `cp`, or `mkdir` for project files. If a tool is unavailable, stop and ask the user — do not workaround.
- **`run` cmd is a JSON array of args, not a shell string.** Pass `["pnpm", "install"]`, not `"pnpm install"`. Never quote args, never pass absolute paths to commands, never use shell interpolation. If a launcher is allowed, the args are the exact argv.
- **Full workspace check is the default.** Use `pnpm run check` for end-to-end validation (format + lint + typecheck + test). Do not filter to a single package unless explicitly iterating on that package — the scoped filter (`pnpm turbo run typecheck test --filter=<pkg>`) is for single-package iteration, not for "skipping parts of the check". The full check must cover all four layers.
- **`pnpm run check` needs a higher timeout.** The default 30s is shorter than a cold full-workspace run. Pass an explicit timeout whenever invoking it.
- **Pre-existing failures are not out of scope.** If `pnpm run check` fails on a file you did not touch, fix it as part of the same change. Do not assume pre-existing issues are someone else's problem.
- **Try `eslint --fix` before manual edits.** For import order, type-imports, and formatting, run `pnpm turbo //#lint` (or `eslint . --fix` on a file) before hand-editing. Most of these are auto-fixed.
- **Never auto-run interactive or user-facing tools.** `changeset`, `npm login`, anything that prompts — leave it for the user. The agent runs non-interactive commands only.
- **Verify after every edit and every retry.** `edit` only checks that `oldText` was found — not that the result is correct. After every `edit` call, read the affected region (5-10 lines) to confirm the file's literal state. When retrying a failing `run` or any other call, compare the new arguments literally to the previous attempt; if identical, the mistake is unchanged and retrying the same form is wasted work.
- **Read `@`-referenced files directly.** When a user message contains `@<path>` (e.g. `@AGENTS.md`, `@about-turbo.md`, `@.ai/skill.md`), the path is the literal file location — read it with the `read` tool. Do **not** dispatch a search subagent, do not guess the path, do not glob for it. `@` references from a user message resolve the same way they resolve inside `AGENTS.md` (relative to the file the reference appears in, or project root for direct user input). The `read` tool is always the right call.

### Skill scope rules

These apply while a meta-skill (`design`, `plan`, `blueprint`, `discover`, `research`, `explore`, `revise`, `validate`, `code-review`, `changelog`, `create-handoff`, `resume-handoff`, `migrate-to-guidance`, `annotate-guidance`, `annotate-inline`, `architecture-review`) is active. Out-of-scope actions inside one of these skills have produced the largest single-session token wastes on record.

- **Stay in artifact space.** A skill's deliverable is its artifact under `.rpiv/artifacts/<kind>/`, not source code. Do not `write`, `edit`, or `pfs_*` anything under `packages/*/src/` while a meta-skill is active. If the next step would touch source, stop and ask the user — do not implement.
- **"Update X" / "just do Y" is a complete instruction.** Treat it as the full scope. Do not branch into adjacent work, do not re-enter a previous skill, do not auto-spawn the next skill in the pipeline. If ambiguity exists, surface it in a single sentence of plain prose; do not open an `ask_user_question` for clarifications the instruction did not request.
- **Do not auto-dispatch reviewer subagents.** Skills like `plan`, `blueprint`, `design`, and `code-review` may _recommend_ running `artifact-code-reviewer` / `artifact-coverage-reviewer` in their workflow, but the recommendation must be confirmed by the user before spawning them. Default: do not run reviewers unless the user invoked a review explicitly or said "go ahead" after the recommendation.
- **A meta-skill ends when its artifact is written.** Do not chain into the next skill (`design` → `plan`, `plan` → `implement`, etc.) without the user invoking it. Ending a skill is a stopping point, not a launchpad.

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
