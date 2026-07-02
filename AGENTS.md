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

`check` shape: Turbo runs the four tasks declared in `turbo.json` — `//#format:check` and `//#lint` once at the repo root, then `typecheck` and `test` per package in parallel. Cache hits make repeat runs near-instant. See `pi-extension-toolchain` for the full Turbo conventions.

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
  pi-tool-policy/
    src/extensions/
      tool-policy.ts         — mode hotkey, /tool_policy command, tool_call gate
    src/lib/
      types.ts               — v2 type definitions (Mode, AnyVerdict, RuleResult, …)
      aspects.ts             — matchAspect() for path/url/bash/glob/regex
      policy.ts              — per-mode single-pass matcher
      permission-config.ts   — loadConfig() with extends deep-merge + cycle detection
      tool-metadata.ts       — aggregateToolMetadata() (built-in + package.json + config)
      tagging-rules.ts       — applyTaggerRules() (augments effective tag set)
      directory-permissions.ts — DirectoryPermissionsState + checkAndPrompt guardrail
      mode-controller.ts     — ModeController (cycle/setMode/additionalInstructions)
      modal/
        directory-permissions-modal.ts — tag-aware prompt + custom-path sub-modal
        tool-policy-modal.ts           — mode switcher + warnings viewer
    schemas/
      tool-policy.schema.json — JSON Schema 2020-12 for the config
```

Each `packages/<name>/` is its own npm package with its own `package.json`, `tsconfig.json`, and `README.md`. Extensions list their entry point under `"pi": { "extensions": [...] }` in their `package.json`.

## Key rules

- **Imports**: use `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` — never the old `@mariozechner/*` package names.
- **pi-extension-utils**: import shared utilities using the scoped package specifier: `import { spawnStreaming } from "@piotrb/pi-extension-utils"`. The workspace links this via `"@piotrb/pi-extension-utils": "workspace:*"` in each consumer's `dependencies`.
- **No barrel/index file**: extensions are listed directly in `package.json`, there is no `index.ts`.
- **Module style**: ESM only (`"type": "module"`). NodeNext module resolution — local imports keep `.ts` extensions (pi's runtime handles them via jiti).
- **Shared tsconfig**: each package's `tsconfig.json` extends `../../tsconfig.base.json` with `"include": ["src/**/*"]`. Do not duplicate compilerOptions.
- **File operations**: prefer `pfs_mv`, `pfs_cp`, `pfs_unlink`, `pfs_rmdir` for filesystem moves/deletes. Use `git_mv` only when you explicitly need git to track the rename in the index.
- **Tests assert behavior, not data, and do not duplicate the producer.** When lifting a function to a shared lib (`pi-extension-utils`, etc.), delete the duplicate tests in the consumer — the lib's own tests cover the lifted function. The consumer's test file covers only consumer-specific surface (how it composes the lib, its own config schema, the rules it derives). A test that compares an object to a hardcoded literal of itself is documentation, not verification; if it would still pass with `() => undefined` swapped in, remove or rewrite it. Loader/merger tests exercise the loader/merger logic, not the data shape it returns.

### Tool surface rules

These are derived from repeated cross-session corrections. Read this section before calling the `run` tool or any filesystem mutation.

- **Full workspace check is the default.** Use `pnpm run check` for end-to-end validation (format + lint + typecheck + test). Do not filter to a single package unless explicitly iterating on that package — the scoped filter (`pnpm turbo run typecheck test --filter=<pkg>`) is for single-package iteration, not for "skipping parts of the check". The full check must cover all four layers.
- **`pnpm run check` needs a higher timeout.** The default 30s is shorter than a cold full-workspace run. Pass an explicit timeout whenever invoking it.
- **Pre-existing failures are not out of scope.** If `pnpm run check` fails on a file you did not touch, fix it as part of the same change. Do not assume pre-existing issues are someone else's problem.
- **Try `eslint --fix` before manual edits.** For import order, type-imports, and formatting, run `pnpm turbo //#lint` (or `eslint . --fix` on a file) before hand-editing. Most of these are auto-fixed.
- **Never auto-run interactive or user-facing tools.** `changeset`, `npm login`, anything that prompts — leave it for the user. The agent runs non-interactive commands only.
- **Verify after every edit and every retry.** `edit` only checks that `oldText` was found — not that the result is correct. After every `edit` call, read the affected region (5-10 lines) to confirm the file's literal state. When retrying a failing `run` or any other call, compare the new arguments literally to the previous attempt; if identical, the mistake is unchanged and retrying the same form is wasted work.
- **Read `@`-referenced files directly.** When a user message contains an `@`-prefixed path (e.g. pointing at an `AGENTS.md` or a `.agents/skills/.../SKILL.md`), the path is the literal file location — read it with the `read` tool. Do **not** dispatch a search subagent, do not guess the path, do not glob for it. `@` references from a user message resolve the same way they resolve inside `AGENTS.md` (relative to the file the reference appears in, or project root for direct user input). The `read` tool is always the right call.

### Skill scope rules

These apply while a meta-skill (`design`, `plan`, `blueprint`, `discover`, `research`, `explore`, `revise`, `validate`, `code-review`, `changelog`, `create-handoff`, `resume-handoff`, `migrate-to-guidance`, `annotate-guidance`, `annotate-inline`, `architecture-review`) is active. Out-of-scope actions inside one of these skills have produced the largest single-session token wastes on record.

- **"Update X" / "just do Y" is a complete instruction.** Treat it as the full scope. Do not branch into adjacent work, do not re-enter a previous skill, do not auto-spawn the next skill in the pipeline. If ambiguity exists, surface it in a single sentence of plain prose; do not open an `ask_user_question` for clarifications the instruction did not request.
- **Do not auto-dispatch reviewer subagents.** Skills like `plan`, `blueprint`, `design`, and `code-review` may _recommend_ running `artifact-code-reviewer` / `artifact-coverage-reviewer` in their workflow, but the recommendation must be confirmed by the user before spawning them. Default: do not run reviewers unless the user invoked a review explicitly or said "go ahead" after the recommendation.
- **A meta-skill ends when its artifact is written.** Do not chain into the next skill (`design` → `plan`, `plan` → `implement`, etc.) without the user invoking it. Ending a skill is a stopping point, not a launchpad.
- **Wait for explicit confirmation during workshops.** When the user is iterating on an issue with you (asking questions, raising concerns, asking for explanations), do not start writing artifacts, spawning sub-agents, or producing deliverables until they say "go", "do it", "write it", or equivalent. "I though you're just X" / "I didn't confirm yet" / "we're just working through issues" all mean: stop and continue the conversation. A workshop is a conversation, not a green light.
- **Don't fabricate the next step from a deliverable.** After writing/updating an artifact (design, plan, review), do not invent a follow-up action — running reviewers, kicking off the next skill, opening a multi-choice question, writing tests. The user invoked a single deliverable; that is the deliverable. If you believe a follow-up is useful, name it in one sentence of prose and wait.

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

@docs/solutions/architecture/pi-package-specific-skill-naming.md

**Secondary (load when relevant):**

- Solutions are discovered at lookup time by grep on the frontmatter fields (`tags`, `title`, `applies_when`) per the `05-learn` workflow. The naming convention for package-specific solutions is in the core reference above.

## Emergency escape: `__yolo__` mode in `pi-tool-policy`

If a bug in `pi-tool-policy` is blocking the agent from working (e.g. a malformed config, a `tagRules` access crash, an `evaluate` regression), switch the policy extension into its synthetic **YOLO mode** to fully disable the gate:

- Hotkey: press **Alt+M** until the status bar reads `mode: __yolo__ (EMERGENCY OFF)`.
- Or: run `/tool_policy` and pick `⚠ ○ __yolo__` (the YOLO entry is the last option, marked with a warning icon).
- Or: from any list, the YOLO mode is auto-injected into every `loadConfig()` call and listed last in `modeOrder` so the cycle wraps to it as a last resort.

When YOLO is active the `tool_call` handler returns `undefined` immediately — no policy check, no directory guard, no ask modal. The user can repair the config and cycle back to a normal mode (`default` / `plan` / `edit`) without reloading the session. YOLO is **not** user-configurable; it lives in code at `YOLO_MODE` in `packages/pi-tool-policy/src/lib/types.ts`.
