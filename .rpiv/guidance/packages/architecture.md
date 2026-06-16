# packages/ — extension monorepo

5 self-contained pi-extensions + 1 shared library + 1 transitional package. Each package is a publishable npm module under `@piotrb/pi-*` (or `private: true`).

The canonical per-package shape, the tool registration pattern, the workspace hard rules, and the procedure for adding a new tool are encoded as skills — see `pi-package-scaffold`, `pi-register-tool`, and the per-package `working-with-*` skills listed in `.agents/learning-index.md`.

## Outliers

| Package                | Why it breaks the shape                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `pi-extension-utils`   | Pure library — no `pi.extensions` field, exports `src/extension-utils.ts` directly. See `working-with-pi-extension-utils`. |
| `pi-bfs`               | `private: true`, has a `plans/migrate-to-fd.md` (transitional). See `working-with-pi-bfs`. |
| `pi-task-runner`       | Adds `src/lib/` for internal helpers (permission matcher, config loader, TUI modal). See `working-with-pi-task-runner` and `pi-task-runner-permission-pattern`. |
| `pi-context-preloader` | Hooks lifecycle events instead of registering tools. See `pi-lifecycle-hooks`. |
| `pi-ripgrep`           | Has `plans/extend-and-replace-grep.md` (transitional). |
