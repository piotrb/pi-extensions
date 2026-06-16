---
name: pi-package-scaffold
description: Scaffold a fresh pi-<name> extension package by mirroring the most similar existing packages/pi-* peer — same shape, lifted structure, adjusted for the new package's specifics. Use when initializing a new packages/pi-<name>/ directory or migrating an out-of-tree package into the workspace.
---

You scaffold a new `pi-<name>` extension package in this monorepo. The structure is not invented; it is lifted from the most similar existing peer and adjusted.

## The convention

Every `pi-*` package in `packages/` follows the same canonical shape. New packages are not written from a template — they are written by **reading one or two existing peers and mirroring their structure**, changing only what is specific to the new package (name, description, tools, dependencies).

The existing peers are the ground truth. If a peer's `package.json` has a field the others do not, that field was added for a reason specific to that peer; do not propagate it without justification.

## How to pick the peer

Read the existing packages under `packages/` and identify the one whose situation most closely matches the new package:

- **Publishable, registers tools with path aspects** → mirror `pi-ripgrep` (smallest, simplest) or `pi-git` (multi-tool).
- **Publishable, hooks lifecycle events** → mirror `pi-context-preloader` (the only lifecycle-only package).
- **Publishable, depends on `pi-extension-utils`** → mirror `pi-tool-policy`.
- **Private/transitional** → mirror `pi-bfs` (unscoped, `private: true`).
- **Empty, no source code yet** → there is no peer; lift `pi-ripgrep`'s shape and strip what does not apply (see "Scaffolding an empty package" below).

If the new package does not fit any of these, the convention is to ask the user which peer to mirror.

## How to mirror

For each file in the canonical shape, start from the peer's version and apply the minimum set of changes:

1. **`package.json`** — copy the peer's. Rename `name`, `description`, `keywords`, `repository`/`bugs`/`homepage`, and `pi.extensions` entry. Adjust `peerDependencies` and `dependencies` to actual imports. If the new package registers tools with path aspects, copy the relevant `pi.toolMetadata` block. If the new package has no `pi.extensions` yet (empty package), strip the field entirely and replace it with the `pi.skills` annotation (see "Scaffolding an empty package").
2. **`tsconfig.json`** — copy the peer's. The peer should be just `extends` + `include`. Do not add `compilerOptions`; the base is the canonical home for those.
3. **`README.md`** — write fresh, but follow the section ordering used by the peer (title, one-line description, status, usage notes, scripts). The README is not copy-pasted; the peer's structure is.
4. **`src/extensions/<name>.ts`** — copy the peer's entry file. Replace its `registerTool`/`registerCommand`/lifecycle calls with whatever the new package registers. If the new package is empty, the file is a no-op default export.
5. **`src/extensions/<name>.test.ts`** — copy the peer's test scaffolding. Adapt the test cases to whatever the new package does. Empty packages get a placeholder test that asserts the placeholder loads.

Do not invent fields the peer does not have. Do not add fields "for completeness" that have no current use.

## Scaffolding an empty package

A package that has source code yet to be written starts with:

- `package.json` lifted from `pi-ripgrep` minus `pi.extensions` and `pi.toolMetadata`. Add a `pi.skills: "./skills"` field and a `pi._comment` explaining why `pi.extensions` is absent.
- A `tsconfig.json` like any other package.
- A `README.md` explaining the package is empty, where the skills live, and what is planned.
- A `src/extensions/<name>.ts` with a no-op default export and a docstring. Co-located test asserting the placeholder loads and registers nothing.

Once source lands, add `pi.extensions`, replace the placeholder source with real code, and update the description.

## `pi.skills` annotation

A self-declared convention for packages whose destination skills live under `packages/<name>/skills/` rather than the workspace-wide `.agents/skills/`. There is no runtime consumer for this field — it documents where the package's skills live for human and tooling readers.

Use it when a package ships its own skill tree distinct from the workspace-wide learnings.

## Hard rules

These rules apply to every `pi-*` package in this workspace. They are non-negotiable; do not deviate even if the peer package you are mirroring appears to.

- **Imports.** Use `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` — never the old `@mariozechner/*`.
- **No `compilerOptions` in per-package tsconfig.** The base is the canonical home; adding `compilerOptions` to a per-package tsconfig silently shadows the base.
- **No barrel/index.ts.** Extensions are listed in `package.json`'s `pi.extensions` directly. Do not create an `index.ts` re-export.
- **Internal cross-package deps use `workspace:*`.** E.g. `pi-extension-utils: "workspace:*"` in a consumer's `dependencies`. The `workspace:*` symlink is dev-only — see the next rule.
- **`pi-extension-utils` must be published to npm as a runtime dep.** If a package consumes `pi-extension-utils` via `workspace:*`, that package must also be published to npm. The dev symlink does not satisfy a prod install.
- **`.ts` keeps its extension on local imports.** pi's jiti handles resolution; `allowImportingTsExtensions` makes tsc accept them. Do not strip `.ts` in imports.
- **Trim `peerDependencies` to actual imports.** `pi-context-preloader` does not need `@earendil-works/pi-tui` or `typebox`. A package with no source has no runtime peerDeps; devDeps can be `@types/node`, `typescript`, `vitest` only.
- **Co-located tests.** `<name>.test.ts` next to source, not in `__tests__/` or a separate `tests/` directory.
- **`files` allowlist.** `["src/**/*.ts", "!src/**/*.test.ts", "README.md"]`. The `plans/` directory is automatically excluded. `pi-tool-policy` adds `schemas/**/*.json` for its JSON Schema; copy that only if your package ships schemas.
- **All packages `private: true` or `publishConfig.access: "public"`** for publishing. The `private: true` flag is the signal that the package is workspace-internal and not published.
- **Use `pfs_*` for filesystem operations from the agent loop.** Prefer `pfs_mv`, `pfs_cp`, `pfs_unlink`, `pfs_rmdir` over bash equivalents. Use `git_mv` only when git must track the rename in the index.

## Common pitfalls

- **Pre-existing format issues.** `pnpm run check` reports ~497 files with prettier issues across the whole repo. Those are not the scaffold's problem; do not chase them.
- **Do not auto-publish** a `private: true` package.

## What you do not do

- Do not write `package.json` from a memorized template. Read a peer, lift its structure.
- Do not propagate fields from one peer to another without justification.
- Do not add `pi.toolMetadata` for tools that do not have path/url/bash/glob/regex aspects.
- Do not trim `peerDependencies` to *zero* just because the package is empty — but do trim to actual imports.

## Related

- @.agents/skills/pi-register-tool/SKILL.md
- @.agents/skills/pi-multi-tool-package/SKILL.md
- @.agents/skills/pi-fs-tools/SKILL.md
- @.agents/skills/pi-lifecycle-hooks/SKILL.md
- @.agents/skills/pi-hackery-folder-layout/SKILL.md
