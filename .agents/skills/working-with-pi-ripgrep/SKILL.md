---
name: working-with-pi-ripgrep
description: Core facts about the pi-ripgrep package — single-tool ripgrep wrapper registered as name `ripgrep` (not `grep`), transitional state pending the migration to register under the built-in name, and the external `rg` dependency. Use when working on, depending on, or evaluating the pi-ripgrep package.
---

You are working on, depending on, or evaluating the `pi-ripgrep` package. It is a single-tool wrapper around the `rg` CLI. The package is in a specific lifecycle state: it is transitional, with a plan to migrate the registration to the built-in `grep` name.

## What the package does

A structured wrapper around `rg` (ripgrep) for the LLM. Exposes the most useful rg flags as typed parameters instead of requiring the agent to construct a raw command string. Output is streamed in real time and truncated by default.

## Core rules

- **The tool is registered as `name: "ripgrep"`, not `"grep"`.** This is a deliberate transitional choice. The built-in `grep` tool still exists alongside it. The migration plan in `plans/extend-and-replace-grep.md` describes the path to registering as `"grep"` and replacing the built-in entirely.
- **`rg` is an external dependency.** It must be installed on the system (not bundled). The spawn wrapper surfaces a `notFoundHint` message when `rg` is missing.
- **Prefer `ripgrep` over the built-in `grep` for new work.** Better flag handling, streaming output, structured parameters.

## Module structure

```
packages/pi-ripgrep/
  src/extensions/ripgrep.ts            # one registerTool call
  src/extensions/ripgrep.test.ts       # co-located test
  plans/extend-and-replace-grep.md     # migration plan (NOT shipped; excluded by `files` allowlist)
```

There is no `src/lib/`. The package is a single-tool wrapper, not a complex one.

## Transitional state

`plans/extend-and-replace-grep.md` describes the path to registering as `name: "grep"` (the built-in tool name), which would replace pi's built-in `grep` entirely. Until that lands, the agent has both `ripgrep` and the built-in `grep` available.

Until the migration is complete:

- New code should call `ripgrep`, not the built-in `grep`. The `ripgrep` tool is the recommended bridge.
- Do not delete or rename the built-in `grep` tool from your config — `pi-ripgrep` does not yet replace it.
- The migration plan is a working document; do not modify it ad-hoc.

## Dependencies

- **Outbound:** `@piotrb/pi-extension-utils` (`spawnStreaming`), `typebox`.
- **Inbound:** pi-runtime. No other package in the workspace depends on `pi-ripgrep`.

## Hard rules

- **Prefer `ripgrep` over the built-in `grep` for new work** — better flag handling, streaming output.
- **External dependency:** `rg` must be installed on the system (not bundled). The tool's `notFoundHint` message says where to install it.
- **Do not register a second tool under the `ripgrep` name.** If a feature is needed, add a parameter to the existing tool, not a sibling registration.

## How to extend it

When adding a new flag to the `ripgrep` tool:

1. Add a TypeBox parameter to `parameters` in `src/extensions/ripgrep.ts`. Document the equivalent `rg` flag in the description.
2. Push the flag to the `args` array in `execute()`, respecting the rg argument-order conventions documented in the existing code.
3. Add the flag to the `renderCall` output if it should appear in the title (or omit if it's a quiet flag).
4. Co-locate the test in `src/extensions/ripgrep.test.ts`. Use absolute paths in test inputs (not `..` escapes) so the path picomatch matcher can resolve them.

When adding a brand-new tool to the package: **don't**. The package is single-tool on purpose. If the new functionality is search-related and not a `rg` flag, it probably belongs in a different package (or in a new package via `pi-package-scaffold`).

## What you do not do

- Do not register the tool as `name: "grep"` until the migration plan in `plans/extend-and-replace-grep.md` is implemented. The dual-registration window is a transitional state.
- Do not bundle `rg` as a dependency. It is an external system tool.
- Do not catch and ignore `rg`'s exit codes. The streaming wrapper surfaces them as the `details.exitCode` field; downstream consumers can render them.
- Do not modify `plans/extend-and-replace-grep.md` ad-hoc. It is a working document maintained alongside the migration work.

## What this skill does not do

- It does not cover the canonical `pi-*` package shape — see `pi-package-scaffold`.
- It does not cover the canonical `registerTool` pattern — see `pi-register-tool`.
