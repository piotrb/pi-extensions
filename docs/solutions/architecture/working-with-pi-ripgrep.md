---
title: working with pi-ripgrep (single-tool rg wrapper, transitional)
category: architecture
severity: high
tags:
  - pi-ripgrep
  - ripgrep
  - rg
  - single-tool-wrapper
  - transitional
  - notFoundHint
  - extend-and-replace-grep
  - content-search
  - external-dependency
applies_when:
  - working on, depending on, or evaluating the pi-ripgrep package
  - adding a new flag to the ripgrep tool
  - debugging a "rg not found" error
  - understanding why the tool is registered as "ripgrep" not "grep"
  - planning the extend-and-replace-grep migration
  - choosing between pi-ripgrep and the built-in grep
---

# Problem

`pi-ripgrep` is a single-tool wrapper around the `rg` (ripgrep) CLI, registered as `name: "ripgrep"` (not the built-in `"grep"`). The package is in a specific lifecycle state — **transitional, with a plan to migrate the registration to the built-in `grep` name** — and `rg` is an external system dependency. Without a single reference for the package's invariants, the agent registers a second `ripgrep` tool (breaks the single-tool shape), bundles `rg` as a dependency (the spawn expects it in PATH), renames to `name: "grep"` early (the migration plan says wait), or uses the built-in `grep` for new work (the `ripgrep` tool is the recommended bridge).

This solution covers the package overview. The canonical `pi-*` package shape is in `pi-package-scaffold`. The canonical `registerTool` pattern is in `pi-register-tool`. The `extend-and-replace-grep` migration plan is in `packages/pi-ripgrep/plans/extend-and-replace-grep.md` (not shipped; excluded by the `files` allowlist). The relationship to `pi-bfs` is in `working-with-pi-bfs` (both single-tool, both transitional, both with `plans/` directories).

# Context

`pi-ripgrep` exists because the built-in `grep` tool lacks ripgrep's most useful flags (`--type`, `--type-not`, `--smart-case`, `--word-regexp`, `--invert-match`, `--multiline`, etc.) and doesn't stream output. The `ripgrep` tool wraps `rg` with typed parameters for these flags and streams output via `spawnStreaming`. The package is the **canonical single-tool wrapper** example (see `pi-package-scaffold` for the scaffold variant).

The package is **transitional** with a plan to migrate to `name: "grep"` (the built-in name). Until the migration lands, the agent has both `ripgrep` and the built-in `grep` available. The migration is not in progress as a separate task — it's a planned future change.

# Solution

## What the package does

A structured wrapper around `rg` (ripgrep) for the LLM. Exposes the most useful rg flags as typed parameters instead of requiring the agent to construct a raw command string. Output is streamed in real time and truncated by default.

## Core rules

- **The tool is registered as `name: "ripgrep"`, not `"grep"`.** This is a deliberate transitional choice. The built-in `grep` tool still exists alongside it. The migration plan in `plans/extend-and-replace-grep.md` describes the path to registering as `"grep"` and replacing the built-in entirely.
- **`rg` is an external dependency.** It must be installed on the system (not bundled). The spawn wrapper surfaces a `notFoundHint` message when `rg` is missing.
- **Prefer `ripgrep` over the built-in `grep` for new work.** Better flag handling, streaming output, structured parameters.
- **Do not register a second tool under the `ripgrep` name.** If a feature is needed, add a parameter to the existing tool, not a sibling registration.

## Module structure

```
packages/pi-ripgrep/
  src/extensions/ripgrep.ts            # one registerTool call
  src/extensions/ripgrep.test.ts       # co-located test
  plans/extend-and-replace-grep.md     # migration plan (NOT shipped; excluded by `files` allowlist)
```

There is no `src/lib/`. The package is a single-tool wrapper, not a complex one. The `plans/` directory is the working area for the migration, excluded from the published tarball by the `files` allowlist.

## The `ripgrep` tool

The canonical shape (see `pi-register-tool` for the full pattern):

```ts
pi.registerTool({
  name: "ripgrep",
  label: "ripgrep",
  description: [
    "Search files for a regex pattern using ripgrep (rg).",
    "Prefer this over the built-in grep for any code search.",
    "Supports type filtering (--type, --type-not), smart-case, word-regexp,",
    "invert-match, multiline, files-with-matches, max-count, and more.",
    `Output is streamed; truncated at ${DEFAULT_VISIBLE_LINES} lines by default (ctrl+o to expand).`,
  ].join(" "),
  parameters: Type.Object({
    pattern: Type.String(),
    paths: Type.Optional(Type.Array(Type.String())),
    cwd: Type.Optional(Type.String()),
    // ... type filters, output control, etc.
  }),
  execute: async (_id, p, ctx) => {
    return streamResult(spawnStreaming("rg", [...flags, ...p.paths], { cwd: p.cwd }))
  },
})
```

The `notFoundHint` message points to `rg` install instructions (`brew install ripgrep`, `apt install ripgrep`) when the spawn fails with `ENOENT`.

## Transitional state

`plans/extend-and-replace-grep.md` describes the path to registering as `name: "grep"` (the built-in tool name), which would replace pi's built-in `grep` entirely. The migration involves:

- **Register** as `name: "grep"` (shadow the built-in).
- **Adopt** the built-in's `ensureTool("rg", true)` for auto-download.
- **Parse** `rg --json` output for structured access to file path, line number, and match text.
- **Adopt** the built-in's match-limit and byte-limit truncation with clear notices.
- **Keep** the streaming output, `type`/`typeNot` filtering, and the additional `rg` parameters (`smartCase`, `wordRegexp`, `invertMatch`, `multiline`, `filesWithMatches`, `noLineNumber`, `maxCount`, `sortBy`, `hidden`, `noIgnore`, `followSymlinks`).

Until the migration is complete:

- New code should call `ripgrep`, not the built-in `grep`. The `ripgrep` tool is the recommended bridge.
- Do not delete or rename the built-in `grep` tool from your config — `pi-ripgrep` does not yet replace it.
- The migration plan is a working document; do not modify it ad-hoc.

## Dependencies

- **Outbound:** `@piotrb/pi-extension-utils` (`spawnStreaming`), `typebox`.
- **Inbound:** pi-runtime. No other package in the workspace depends on `pi-ripgrep`.
- **External (system):** `rg` (ripgrep) must be installed on the system. The package does not bundle it.

## Tool metadata

`pi-ripgrep` declares a `pi.toolMetadata` block in `package.json`. The block binds the `cwd` and `paths` fields to path aspects (for the directory-permissions guardrail) and declares the `rg`-specific filters as custom aspects (for the policy engine to gate). The metadata is consumed by `pi-tool-policy`'s `aggregateToolMetadata` (see `pi-tool-policy-mode-controller`).

## How to extend it

When adding a new flag to the `ripgrep` tool:

1. Add a TypeBox parameter to `parameters` in `src/extensions/ripgrep.ts`. Document the equivalent `rg` flag in the description.
2. Push the flag to the `args` array in `execute()`, respecting the rg argument-order conventions documented in the existing code.
3. Add the flag to the `renderCall` output if it should appear in the title (or omit if it's a quiet flag).
4. Co-locate the test in `src/extensions/ripgrep.test.ts`. Use absolute paths in test inputs (not `..` escapes) so the path picomatch matcher can resolve them.

When adding a brand-new tool to the package: **don't**. The package is single-tool on purpose. If the new functionality is search-related and not a `rg` flag, it probably belongs in a different package (or in a new package via `pi-package-scaffold`).

# Why this works

- **The `name: "ripgrep"` registration is the bridge.** It gives the agent access to ripgrep's full flag set without conflicting with the built-in `grep`. When the migration lands, the registration will shadow the built-in; until then, both tools coexist.
- **`rg` as an external dependency keeps the package small.** Bundling `rg` would add 10MB+ to the install; the spawn wrapper surfaces a `notFoundHint` when it's missing. The user is expected to have `rg` in PATH.
- **Streaming output matters on large codebases.** The built-in `grep` collects everything then renders once; `pi-ripgrep` streams as `rg` runs. On a search that produces 10,000 matches, the agent sees results immediately rather than waiting for the full output.
- **The `type` filter is the most-used rg flag in practice.** `rg --type ts` / `rg --type-not json` is the common case. The built-in `grep` has no type filtering; the `ripgrep` tool does.

# Prevention

- **Do not register the tool as `name: "grep"` until the migration plan in `plans/extend-and-replace-grep.md` is implemented.** The dual-registration window is a transitional state. Shadowing the built-in early would prevent users from falling back to the built-in if `pi-ripgrep` breaks.
- **Do not bundle `rg` as a dependency.** It is an external system tool. Bundling it would bloat the install and create version-management overhead.
- **Do not catch and ignore `rg`'s exit codes.** The streaming wrapper surfaces them as the `details.exitCode` field; downstream consumers can render them. Catching the exit code in the executor would lose the signal.
- **Do not modify `plans/extend-and-replace-grep.md` ad-hoc.** It is a working document maintained alongside the migration work. Changes to the plan should be reviewed with the migration owner.
- **Do not register a second tool under the `ripgrep` name.** If a feature is needed, add a parameter to the existing tool, not a sibling registration.
- **Do not use the built-in `grep` for new work** when the `ripgrep` tool is available. The `ripgrep` tool has better flag handling, streaming output, and structured parameters. The built-in `grep` is a fallback for users who can't or won't install `rg`.
- **Do not add a `notFoundHint` for a different binary.** The hint is specific to `rg` install instructions. A second tool would need its own hint.

# Verification

- **The `ripgrep` tool is registered** is verified by `pnpm test` running `ripgrep.test.ts`, which exercises the executor against a real `rg` invocation (or mocks `rg` if it's not installed in the test environment).
- **The `notFoundHint` message** is tested by attempting to spawn a non-existent binary, asserting the result includes the hint text.
- **The tool is registered as `name: "ripgrep"`** is verified by inspecting `src/extensions/ripgrep.ts` — the `name` field should be `"ripgrep"`, not `"grep"`.
- **The migration plan is in `plans/`** and is excluded from the published tarball by the `files` allowlist. Verify with `pnpm pack --dry-run` and inspect the tarball.

# Related

- `pi-package-scaffold` — the canonical `pi-*` package shape; `pi-ripgrep` is the example for the "Publishable, registers tools with path aspects, single-tool" variant.
- `pi-register-tool` — the canonical `registerTool` pattern; the `ripgrep` tool is the simplest example of the pattern.
- `pi-multi-tool-package` — the multi-tool convention; `pi-ripgrep` is the **single-tool** counterpart, contrasted with `pi-git`'s loop and `pi-pfs`'s flat multi-tool.
- `working-with-pi-bfs` — the parallel single-tool, transitional package; both have `plans/` directories for migration work. The `pi-bfs` → `pi-fd` migration is the analog of the `pi-ripgrep` → built-in `grep` migration.
- `pi-extension-utils` — the `spawnStreaming` helper that the `ripgrep` tool depends on.
- `pi-tool-policy-mode-controller` — the `aggregateToolMetadata` that consumes `pi-ripgrep`'s `pi.toolMetadata` block.
- `pi-fs-tools` — the `fs/promises` pattern; not relevant here (this package spawns a process), but the path-validation discipline is similar.
