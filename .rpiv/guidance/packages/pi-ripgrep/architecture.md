# pi-ripgrep

Single-tool wrapper around the `rg` CLI. Registers as `name: "ripgrep"` (not `"grep"` — see `plans/extend-and-replace-grep.md` for the migration plan to register under the built-in name).

The single-tool registration shape is encoded in `pi-register-tool`. This file documents the package-specific internals.

## Layer responsibility

Thin wrapper around `rg` (ripgrep) for file content search. The agent calls this instead of using `rg` via bash.

## Dependencies

- **Outbound**: `@piotrb/pi-extension-utils` (`spawnStreaming`), `typebox`.
- **Inbound**: pi-runtime.

## Module structure

```
src/extensions/ripgrep.ts            # one registerTool call
src/extensions/ripgrep.test.ts       # co-located test
plans/extend-and-replace-grep.md     # migration plan (NOT shipped)
```

## Transitional state

`plans/extend-and-replace-grep.md` describes the path to registering as `name: "grep"` (the built-in tool name), which would replace pi's built-in `grep` entirely. Until then, the agent has both `ripgrep` and the built-in `grep` available.

## Hard rules

- **Prefer `ripgrep` over the built-in `grep` for new work** — better flag handling, streaming output.
- **External dependency**: `rg` must be installed on the system (not bundled).
