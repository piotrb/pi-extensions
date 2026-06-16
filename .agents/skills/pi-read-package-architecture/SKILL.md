---
name: pi-read-package-architecture
description: When working inside a packages/pi-<name>/ directory, read the per-package architecture file first — README.md, architecture.md, or whatever the package convention provides. Use when making changes that span multiple files in a package, or when onboarding to an unfamiliar package.
---

You are about to make a change inside a `packages/pi-<name>/` directory. Before you write any code, read the package's per-package architecture file.

## Why

Every `pi-*` package has a different shape, a different set of hard rules, and a different relationship to the other packages. The package's own architecture file is the fastest way to learn those specifics. Skipping the read is the most common cause of cross-cutting mistakes: you implement against the wrong convention, you miss a hard rule, you refactor something that is load-bearing.

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

## What this skill does not do

- It does not cover the `pi-hackery` package's specific layout — see `pi-hackery-folder-layout` for the bases/skills split.
- It does not cover creating a new package — see `pi-package-scaffold`.

## Related

- `pi-hackery-folder-layout`
