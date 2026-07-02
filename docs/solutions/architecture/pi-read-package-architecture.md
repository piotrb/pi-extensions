---
title: read the per-package architecture file first
category: architecture
severity: medium
tags:
  - conventions
  - packages
  - onboarding
  - architecture
applies_when:
  - making a change that spans multiple files in a pi-* package
  - onboarding to an unfamiliar pi-* package
  - the change touches a file in a sub-directory of a package (e.g. src/lib/)
  - the user names a specific file or convention in a package
  - reviewing what a package does before depending on it
---

# Problem

When working inside a `packages/pi-<name>/` directory, the agent needs to know the package's specific shape, hard rules, and module structure before writing any code. Without reading the package's architecture file first, the agent implements against the wrong convention, misses a hard rule, or refactors something that is load-bearing. The most common cause of cross-cutting mistakes in this workspace is skipping the read.

# Context

Every `pi-*` package has a different shape, a different set of hard rules, and a different relationship to the other packages. The package's own architecture file is the fastest way to learn those specifics. The repo-wide invariants are in `pi-package-hard-rules`; the per-package delta is in the package's own doc.

# Solution

## Why

The package's `working-with-pi-<name>` skill is the canonical entry point for a `pi-*` package — read it first. When the skill is absent, fall back to the package's `README.md` and the source itself.

## How

For the package you are about to enter, locate the architecture file in this order:

1. `packages/<name>/architecture.md` — if the package has one, prefer this.
2. `packages/<name>/README.md` — the package's own entry doc; covers usage, structure, and conventions.
3. `packages/<name>/src/` — the source itself, when the docs are thin or absent.

Read end-to-end before editing. Look for:

- **Hard rules** — the package's non-negotiable constraints (path validation, transaction boundaries, state lifetimes).
- **Module structure** — which files exist, what each one is for, what is exported.
- **Dependencies** — what the package imports and what depends on it.
- **Cross-layer references** — links to other skills (in `.agents/skills/`) or the package's own tree.

## When to re-read

Re-read the architecture file when:

- The change spans multiple files in the package.
- The change touches a file you have not read in this session.
- The change is in a sub-directory of the package (e.g. `src/lib/`) and the package has a per-directory architecture doc.
- The user names a specific file or convention you have not seen.
- The package's structure has changed since you last read it (e.g. files added or removed).

## When to skip

Skip the read when:

- The change is a single-line fix with a clear, well-scoped target.
- The package is the one you have been working in for the entire session.
- The change is in a workspace-wide config (`AGENTS.md`, `tsconfig.base.json`, etc.) that is not package-specific.

# Why this works

- **The per-package file is faster than grep.** Reading one file gives you the package's shape, hard rules, and module structure in one read. Grep across the source gives you fragments, not the design intent.
- **The hard rules are non-obvious from the source alone.** Path validation in `pi-pfs` (resolve + relative check), transaction boundaries in `pi-tool-policy` (group verdicts), state lifetimes in `pi-do-it-right` (the rule loader) — these are design decisions that don't show up in the type signatures.
- **Skipping the read is the most common cause of cross-cutting mistakes.** The user reports "you implemented against the wrong convention" or "you missed a hard rule" — both are symptoms of skipping the architecture file. Re-read is cheap; rework is expensive.

# Prevention

- **Skip the read for single-line fixes with a clear, well-scoped target** — the read overhead exceeds the risk. But if the fix is in a file you have not read in this session, read it first.
- **Skip the read for workspace-wide config changes** (`AGENTS.md`, `tsconfig.base.json`, etc.) — these are not package-specific. See `pi-monorepo-overview` for the workspace layout.
- **Don't skip the read for sub-directory changes** — `src/lib/` may have its own architecture doc. The `pi-tool-policy` package has `src/lib/modal/` as a sub-system; reading just `README.md` misses the modal's role.
- **This solution does not cover the `pi-hackery` package's specific layout** — see `pi-hackery-folder-layout` for the bases/skills split. `pi-hackery` is the one package with a non-flat layout; the read order is different.
- **This solution does not cover creating a new package** — see `pi-package-scaffold` for the procedure.
- **This solution does not cover the canonical invariants for all packages** — see `pi-package-hard-rules` for the workspace-wide rules. The per-package read is the **delta**; the canonical rules are the baseline.
