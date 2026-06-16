# Learning Index

A dispatch index for the workspace's learnings. Each entry is slightly more detailed than the
skill's own `description` — one short paragraph explaining what the skill does and under what
circumstances to use it, so a reader can route without loading the skill itself.

The index is a derived artifact. After **any** edit to a learning (create, update, or retire),
update the matching entry here. Do not leave the index inconsistent with the skills it dispatches to.

Referenced from `AGENTS.md`. (The `@`-references in this index are relative to this file's directory — see the `learning-management` skill for the convention.)

## Dispatch tiers

This index uses a two-tier dispatch system. See `pi-skill-dispatch-tiers` for the convention.

- **Core skills** are preloaded by `pi-context-preloader` via the `@`-reference below. Every agent sees them in every session.
- **Conditional skills** are listed by name + description only. The agent reads the description and loads them on demand with the `read` tool.

## Core skills

### `pi-package-scaffold`

@skills/pi-package-scaffold/SKILL.md

Scaffolds a fresh `pi-<name>` extension package in the workspace. Reads the most similar existing
peer under `packages/` and mirrors its structure, applying the minimum set of changes for the new
package's specifics. Use this skill when initializing a new `packages/pi-<name>/` directory or
migrating an out-of-tree package into the workspace.

### `pi-extension-toolchain`

@skills/pi-extension-toolchain/SKILL.md

The TypeScript + ESLint + Prettier toolchain for this pnpm workspace — tsconfig hierarchy,
ESLint config, script naming conventions, and key gotchas. Use this skill when setting up or
auditing the build toolchain for any package, or when chasing a toolchain failure.

### `pi-monorepo-overview`

@skills/pi-monorepo-overview/SKILL.md

The pi-extensions monorepo at a glance — flat layout, no build step, plugin ecosystem, project
map, and the canonical command set. Use this skill when orienting to the repo, when you need
the high-level shape, or when answering questions about what this project is.

## Conditional skills

### `hackery-update-skill`

Manages the published skills inside the `packages/pi-hackery/skills/` tree. Takes a target skill
name, reads the corresponding base under `packages/pi-hackery/bases/skills/`, and either creates
or updates the published snapshot at `packages/pi-hackery/skills/<name>/SKILL.md`. Enforces
frontmatter rules (matching name, no colons in description) and approval-gates every edit.
Use this skill when the user asks to update or create a skill whose destination is in
`packages/pi-hackery/skills/`.

### `pi-skill-frontmatter-colon-rule`

Documents the YAML safety rule: a skill's `description` (and other unquoted scalar) frontmatter
fields must not contain a `:` character. Provides workarounds (comma, em-dash, parentheses, or
wrapping in quotes) and a verification command. Use this skill when authoring or editing a skill's
frontmatter, or when reviewing a skill for frontmatter safety.

### `base-publisher-hand-off`

Documents the editing convention for the `packages/pi-hackery/` base/published split. Teaches
that base edits go to `packages/pi-hackery/bases/skills/<name>.md`, the published snapshot is
not edited directly, and a handoff message naming `hackery-update-skill` is surfaced for
propagation. Use this skill when about to edit a skill whose destination is in
`packages/pi-hackery/skills/`.

### `pi-register-tool`

The canonical `registerTool` pattern for `pi-*` extension packages. Typebox schema for the input,
execute function returning the pi tool protocol (`{ content: [{ type: "text", text }] }`).
Use this skill when adding a new tool to a `pi-*` package, or when reviewing a tool's input or
output shape.

### `pi-multi-tool-package`

The pattern for packages that register multiple related tools in a single entry file: a `TOOLS`
array, descriptions table, schemas table, and executor factory, all wired in a loop. Use this
skill when adding a new tool to a package that already has a tools table, or when designing a
new multi-tool package.

### `pi-lifecycle-hooks`

The pattern for `pi-*` extensions that hook lifecycle events instead of registering tools —
`session_start`, `resources_discover`, `before_agent_start`, `tool_call`. Teaches the
three-phase pattern (load, pre-scan, inject) and the one-shot-per-session guard. Use this skill
when designing an extension that observes the agent loop, mutates the system prompt, or gates
tool calls.

### `pi-fs-tools`

The pattern for `pi-*` extensions that wrap atomic filesystem operations: use `node:fs/promises`
directly (no subprocess spawn, no `pi-extension-utils`), validate paths are relative to the
project root, reject `..` escapes at the boundary. Use this skill when designing `pfs`-style
tools or any extension that does atomic fs work.

### `pi-hackery-folder-layout`

The layered folder structure of `packages/pi-hackery/` — `bases/`, `skills/`, `.agents/`,
`bases/agents/`, `bases/skills/`, `plans/`. Teaches where each kind of file goes and why the
two skill trees (workspace learnings vs. pi-hackery's own skills) are distinct. Use this skill
when working inside pi-hackery, deciding where a new file goes, or onboarding a new agent to
this package.

### `pi-read-package-architecture`

The cross-layer reference convention: when working inside a `packages/pi-<name>/` directory,
read the per-package architecture file (README.md, architecture.md, or whatever the package
convention provides) before making changes. Use this skill when making changes that span
multiple files in a package, or when onboarding to an unfamiliar package.

### `pi-skill-dispatch-tiers`

The convention for the two-tier dispatch system: core (preloaded via `@`-reference) and
conditional (loaded on demand by description). The dispatch index is the source of truth for
which is which. Use this skill when deciding where a new skill goes, or when auditing the
tier assignment of an existing skill.

### `pi-package-specific-skill-naming`

The naming convention for package-specific learnings. Two patterns: `working-with-<package>`
for the core entry point (the agent's first read when working on or with a package), and
`<package-name>-<topic>` for one specific area within the package. Use this skill when you
have package-specific knowledge to encode and you are deciding how to name and structure
the skill(s).

### `working-with-pi-bfs`

Core facts about the `pi-bfs` package — it is transitional, marked `private`, and pending
migration to a future `pi-fd` package. Use this skill when working on, depending on, or
evaluating the `pi-bfs` package.

### `working-with-pi-context-preloader`

Core facts about the `pi-context-preloader` package — the only package that hooks lifecycle
events instead of registering tools. Auto-preloads `@path` references from `AGENTS.md` into
the system prompt before each agent turn, with a `session_start` cache clear and a
one-shot-per-session `before_agent_start` injection. Use this skill when working on,
depending on, or evaluating the `pi-context-preloader` package.

### `working-with-pi-extension-utils`

Core facts about the `pi-extension-utils` package — a pure shared library with 3 spawn
helpers consumed by 4 other packages, must be published to npm. Use this skill when working
on, depending on, or evaluating the `pi-extension-utils` package.

### `working-with-pi-git`

Core facts about the `pi-git` package — 9 structured git tools (`git_status`, `git_add`,
`git_rm`, `git_mv`, `git_diff`, `git_restore`, `git_commit`, `git_log`, `git_push`) in one
file, wrapping the `git` CLI via `spawnStreaming`. The canonical "many tools in one file"
example. Errors surface via exit codes (not throws), the `cwd` parameter is `ctx.cwd` unless
overridden. Use this skill when working on, depending on, or evaluating the `pi-git`
package.

### `working-with-pi-pfs`

Core facts about the `pi-pfs` package — 4 atomic filesystem tools (`pfs_unlink`, `pfs_rmdir`,
`pfs_cp`, `pfs_mv`) using `node:fs/promises` directly, with path validation that rejects
absolute paths and `..` escapes at the boundary. Does not use `pi-extension-utils` (atomic
operations, not subprocess spawns). Use this skill when working on, depending on, or
evaluating the `pi-pfs` package.

### `working-with-pi-ripgrep`

Core facts about the `pi-ripgrep` package — single-tool ripgrep wrapper registered as
`name: "ripgrep"` (not `"grep"`), with a transitional state pending the migration to
register under the built-in name. The external `rg` dependency is required. Use this skill
when working on, depending on, or evaluating the `pi-ripgrep` package.

### `working-with-pi-task-runner`

Core facts about the `pi-task-runner` package — the `run` tool that replaces bash inside pi's
agent loop, with a layered permission rule system. Use this skill when working on, depending
on, or evaluating the `pi-task-runner` package.

### `pi-task-runner-permission-pattern`

The permission pattern syntax for the `pi-task-runner` `run` tool — pattern shapes,
specificity, scope priority, and the `undecided` verdict semantics. Use this skill when
adding or debugging a permission rule in `.pi/runner.json`, or when working in
`src/lib/permissions.ts`.

### `working-with-pi-tool-policy`

Core facts about the `pi-tool-policy` package — a 4-layer permission policy (aspects,
groupVerdicts, tools, externalDirectory) that gates every `tool_call`. Use this skill when
working on, depending on, or evaluating the `pi-tool-policy` package.

### `pi-tool-policy-mode-controller`

The mode controller, aspect kinds, and matcher internals for the `pi-tool-policy` package —
verdict enum, per-mode single-pass evaluation, tool-metadata aggregation, and tagging-rule
semantics. Covers the post-`FieldBinding`-refactor v2 type contract (`BaseAspectMode`,
`FieldBinding`, `isArrayBinding`, `fieldName`) and the per-field dispatch loop, but defers the
dispatch-key gotcha to `pi-tool-policy-per-field-aspect-cardinality`. Use this skill when
working in `src/lib/` of `pi-tool-policy`, designing a new mode, or debugging a matcher
decision.

### `pi-tool-policy-per-field-aspect-cardinality`

The per-field `FieldBinding` shape for `AspectDeclaration` in `pi-tool-policy` — the data
model (`FieldBinding = string | { field, mode?: "scalar" | "array" }`, the 5-value
`BaseAspectMode` enum with no `[]` suffix), the per-field dispatch loop in `policy.ts` and
`coverage.ts`, the mixed-cardinality test pattern, and the dispatch-key gotcha (the per-binding
loop must pass `decl.mode` to `matchAspect` / `matchAspectEach`, not the `aspectName` from
`Object.entries` — a real bug latent in the post-refactor working tree). Use this skill when
changing the `FieldBinding` shape, when a non-`"path"` aspectName bound to `mode: "path"` is
producing surprising matcher results, or when writing a regression test for the `git_mv`
`source` aspect case.

### `pi-npm-publishing`

npm publishing conventions and release workflow for `@piotrb/pi-*` extension packages — scope,
access, versioning with changesets, OIDC trusted publishing, and developer release flow. Use
this skill when preparing a release, declaring a changeset, configuring npm Trusted Publishing
for a new package, or checking whether a package should be published.
