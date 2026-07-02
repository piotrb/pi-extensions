---
title: pi-package-scaffold — how to scaffold a new pi-* package
category: workflow
severity: high
tags:
  - pi-package
  - scaffolding
  - peer-mirroring
  - package-layout
applies_when:
  - initializing a new packages/pi-<name>/ directory
  - migrating an out-of-tree package into the workspace
  - creating a placeholder for a package whose source hasn't been written yet
  - auditing the structure of an existing pi-* package
---

# Problem

When adding a new `pi-*` extension package to this monorepo, the natural temptation is to write a `package.json`, a `tsconfig.json`, and a `src/extensions/<name>.ts` from scratch. But every `pi-*` package in `packages/` follows the same canonical shape. Inventing the structure from scratch produces drift — fields added in one package that don't exist in others, missing `peerDependencies` that other packages have, tests in the wrong location, etc. The convention is to mirror the most similar existing peer and adjust only what is specific to the new package.

# Context

The existing peers are the ground truth. The flat layout, the `pi.extensions` declaration, the `pi.toolMetadata` block, the `files` allowlist — all of these are observed in the existing peers, not invented. A peer's `package.json` has the fields it has for a reason specific to that peer; do not propagate without justification. The hard rules that every package must follow (no `compilerOptions` in per-package tsconfig, no `index.ts` re-export, etc.) are listed in `pi-package-hard-rules` — read that first.

# Solution

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

# Why this works

- **Peer mirroring eliminates drift.** Every `pi-*` package follows the same canonical shape because they were all built by mirroring a peer. New packages added the same way stay consistent; new packages written from scratch don't.
- **The peer tells you what fields are justified.** A field present in one peer but not others exists for a reason specific to that peer. The convention is to ask before propagating, not to assume.
- **The empty-package case is its own shape.** Scaffolding a placeholder is different from scaffolding a real package: no `pi.extensions`, no `pi.toolMetadata`, a no-op source file, a placeholder test. The shape is documented so the scaffolding workflow doesn't skip it.

# Prevention

- **Don't write `package.json` from a memorized template.** Read a peer, lift its structure. The peer is the source of truth; the template is not.
- **Don't propagate fields from one peer to another without justification.** A field in `pi-tool-policy`'s `package.json` that doesn't exist in `pi-ripgrep` is there for `pi-tool-policy`-specific reasons. Don't add it to a new package unless the new package has the same reason.
- **Don't add `pi.toolMetadata` for tools that do not have path/url/bash/glob/regex aspects.** `pi.toolMetadata` is for tools that need the policy engine to understand their inputs; adding it to a tool that doesn't need it creates noise.
- **Don't trim `peerDependencies` to zero just because the package is empty** — but do trim to actual imports. An empty package's peerDeps are still the imports the source will eventually need.
- **Common pitfalls:**
  - **Pre-existing format issues.** `pnpm run check` reports ~497 files with prettier issues across the whole repo. Those are not the scaffold's problem; do not chase them.
  - **Do not auto-publish** a `private: true` package.
