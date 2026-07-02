---
title: workflow-tool output vs. validation pipelines (when a tool's untracked state breaks `pnpm run check`)
category: workflow
severity: medium
tags:
  - workflow
  - toolchain
  - prettierignore
  - gitignore
  - pnpm-check
  - session-artifacts
  - untracked-state
  - compound-engineering
  - session-checkpoint
applies_when:
  - the workspace-level `pnpm run check` pipeline fails on a file you didn't author
  - the failing file is untracked AND lives under a workflow-tool output directory (e.g. `.context/`, `.pi/`, `_session/`)
  - deciding where to fix a validation-pipeline failure caused by a workflow tool's output
  - adding a new ignore entry to `.prettierignore` or `.gitignore` for workflow-tool state
  - reviewing a PR that adds an ignore entry — checking it's narrow and well-justified
---

# Problem

The repo's validation pipelines (`pnpm run check` runs `prettier --check .`, `eslint .`, `tsc --noEmit`, and `vitest run` across the whole tree) glob everything under the repo root by default. Workflow tools (session checkpoints, agent task lists, scratch directories) write JSON or other files to paths the pipelines scan. The result: a pipeline failure on a file the developer didn't author, with no obvious culprit. Without a single reference for the failure mode and the right fix, the agent either modifies the workflow tool's output (and gets it overwritten next session) or chases a phantom format/lint issue in a generated artifact.

This solution covers the dev-workflow side of the toolchain. The four-layer pipeline (TypeScript + ESLint + Prettier + Turbo) is in `pi-extension-toolchain`. The shape and rationale for `prettierignore` / `gitignore` entries live here.

# Context

The repo has at least three workflow-tool output directories that produce state outside source control:

- **`.pi/`** — pi's runtime state (task list, logs). Already in `.gitignore` (the `.pi/pi-task-list` entry covers it for prettier; the broader `.pi/` patterns cover git).
- **`.context/`** — Compound Engineering session artifacts (handoffs, checkpoints). Written by `session_checkpoint save` / `context_handoff save` during agent runs. **Not** in `.gitignore` or `.prettierignore` by default — these tools ship with the workflow, not the repo's tooling config.
- **`_session/`, `.agent/`, `<other-vendor-namespaces>`** — analogous state from other agent harnesses; the same shape (untracked, written by a tool, scanned by the pipeline) repeats per vendor.

The pipeline failure mode is consistent across all three: a tool writes a file (often untracked JSON) to a path under the repo root; the next `pnpm run check` flags it as malformed (prettier) or unscannable (eslint). The naive fix — modifying the file — is overwritten the next time the tool runs. The correct fix — adding the directory to `.prettierignore` (and possibly `.gitignore`) — is durable.

# Solution

## The fix is `.prettierignore` (and possibly `.gitignore`), not the file

When `pnpm run check` fails on a file the developer didn't author:

1. **Check `git status`.** If the file is untracked and lives under a workflow-tool output directory, it is the tool's output, not the developer's. Don't fix the file.
2. **Identify the tool.** The directory name (`context/`, `pi/`, etc.) usually maps to the tool that wrote it. For this repo's Compound Engineering workflow, `.context/compound-engineering/checkpoints/*.json` is the `session_checkpoint` tool's output.
3. **Add the directory to `.prettierignore`** (one line: `.context/` or equivalent). This stops the validation pipeline from scanning it without affecting any other tooling. The directory may also need a `.gitignore` entry if it's not already excluded — but for the failure mode described here, `.prettierignore` is the load-bearing one.
4. **Do not edit the workflow tool's output.** The tool will overwrite the fix on the next run.

## Why this is the right fix

- **Idempotent**: `.prettierignore` reads at the start of each pipeline run. Adding the directory once stops the failure permanently (until someone removes the ignore entry).
- **Narrow**: a one-line entry is auditable in PR review. The reviewer can confirm "yes, this is a workflow-tool directory, and yes, it produces untracked state" without reading the file.
- **Honest about the file's role**: the file is workflow session state, not source code. The ignore entry is a declaration that the file is not subject to source-code validation — which is true.
- **Survives reformatting**: prettier, eslint, and tsc all respect `.prettierignore` / `tsconfig.exclude` for their own scope. The fix persists across tool upgrades.

## What the fix is NOT

- **Modifying the file** (e.g. running `prettier --write` on it) — the tool will overwrite the change.
- **Deleting the file** — the tool will recreate it; the user may also be relying on it across sessions.
- **Adding `--ignore-path` overrides per-command** — fragile, requires changes in many places (root `package.json`, turbo task definitions, IDE settings). One `.prettierignore` line is simpler.
- **Modifying the tool's output path** — that is the workflow tool maintainer's decision, not the repo's. (It is also possible in principle — e.g. `session_checkpoint save` could write to `~/.pi/sessions/` outside the repo — but the tool's current behavior is what we work with.)

## Worked example: `.context/` from `session_checkpoint`

The `session_checkpoint save` tool writes `.context/compound-engineering/checkpoints/<plan-slug>.json`. The JSON looks like:

```json
{
  "planPath": "docs/plans/tool-policy-decomposition-and-test-surface.md",
  "completedUnits": ["Unit 1: YOLO is a stock mode"],
  "updatedAt": "2026-07-02T22:08:49.614Z",
  "status": "active"
}
```

This is a JSON snapshot, not a developer-authored document. When `pnpm run check` runs, `prettier --check .` scans it (prettier formats JSON by default) and complains about field ordering. The fix is a single line in `.prettierignore`:

```text
.pi/pi-task-list
.context/         # ← new line
pnpm-lock.yaml
.turbo/
```

The line is added once, persisted in git, and the failure never recurs.

## Detecting whether to fix via prettierignore vs. gitignore

| Symptom                                                     | Fix                                                                                                                         |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `prettier --check` warns about an untracked file            | Add to `.prettierignore`. The file may stay untracked.                                                                      |
| `git status` shows a directory you don't want committed     | Add to `.gitignore`. The directory may or may not be in `.prettierignore` (untracked files still trip prettier if scanned). |
| Both — an untracked workflow-tool output dir trips prettier | Add to both (the existing pattern: `.pi/pi-task-list` for prettier; broader `.pi/` patterns for git).                       |

For most workflow-tool outputs, the prettier fix is the load-bearing one (because the user wants the validation pipeline to pass), and the gitignore is secondary (because the user doesn't want the file committed, but it's their choice — the file is untracked by default).

## Adjacent patterns to follow when adding ignore entries

- **Add a brief comment** next to the entry (e.g. `# compound-engineering session-checkpoint output`) so future reviewers don't have to grep to figure out why the directory is excluded.
- **Group with existing entries.** The existing `.prettierignore` lists `.pi/pi-task-list` and `.turbo/`; add the new entry near the existing workflow state ignores.
- **Don't blanket-ignore large trees.** `.prettierignore` entries like `node_modules/` are fine because the tree is well-known. Workflow-tool entries should be narrow — a directory, not a glob — so the next person adding a workflow tool knows the precedent.

# Why this works

- **The pipeline's contract is "scan everything in the repo".** A workflow tool's output violates that contract — the file is in the repo, but it's not source. `.prettierignore` is the explicit override mechanism; it's the right tool for the job.
- **The failure is reproducible.** Every `pnpm run check` run hits it (until the fix lands). The fix is one line; the absence of the fix is one failing CI run.
- **The fix is decoupled from the tool.** We don't change the workflow tool's behavior; we declare the tool's output as out-of-scope for source validation. If the tool changes its output path or format, the fix still works.

# Prevention

- **Do not modify the workflow tool's output file.** It will be overwritten. Fix the pipeline config instead.
- **Do not silence the pipeline.** `--no-verify` on git hooks, `--ignore-unknown` on prettier, or "skip lint" comments all defer the failure; they don't fix it.
- **Do not add a blanket ignore for "everything that looks auto-generated".** Narrow per-directory entries are auditable. A glob like `**/*.json` or `**/generated/**` is too coarse and will hide real source files.
- **Do not assume the failure is in your code.** If `pnpm run check` fails on a file you didn't author, `git status` is the first move. Untracked + workflow-tool directory = this solution's failure mode.
- **When adding a new workflow tool**, audit which validation pipelines scan the tool's output directory. Add the directory to `.prettierignore` (and `.gitignore` if needed) before the tool is first used, to prevent the failure from appearing in CI.

# Verification

- `pnpm run check` passes (23/23 turbo tasks) after the `.prettierignore` line is added.
- The workflow tool continues to write its output file (no regression — the tool is unchanged).
- A new PR adding the entry is reviewable: the reviewer can confirm the file path is a tool output, not source code, and the ignore entry is narrowly scoped.
- The same pattern (`*.json` under a workflow-tool directory, with the tool's name in the comment) is the precedent for the next workflow tool added.

# Related

- `pi-extension-toolchain` — the four-layer pipeline (TypeScript + ESLint + Prettier + Turbo) and how the root configs propagate. The specific `.prettierignore` entry pattern is the load-bearing piece.
- `pi-package-scaffold` — mentions "pre-existing format issues" as a caveat for the scaffolder, but doesn't cover the workflow-tool-output case. This solution is the complementary doc.
- `solution-reusability-test` — the framework for deciding whether to write a new solution; this doc passes the test (it generalizes beyond one session, addresses a recurring failure mode, has a narrow `applies_when`).
