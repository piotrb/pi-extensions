# pi-ripgrep

Single-tool wrapper around the `rg` CLI. Registers as `name: "ripgrep"` (not `"grep"` — see `plans/extend-and-replace-grep.md` for the migration plan to register under the built-in name).

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

## The single tool

```ts
// src/extensions/ripgrep.ts
pi.registerTool({
  name: "ripgrep",
  description: "Search file contents using ripgrep",
  parameters: Type.Object({
    pattern: Type.String(),
    path: Type.Optional(Type.String()),
    glob: Type.Optional(Type.String()),
    ignoreCase: Type.Optional(Type.Boolean()),
    maxCount: Type.Optional(Type.Number()),
  }),
  execute: async (_id, p) => {
    const args = [p.ignoreCase ? "-i" : "", p.pattern, p.path ?? "."]
    return streamResult(spawnStreaming("rg", args.filter(Boolean)))
  },
})
```

## Transitional state

`plans/extend-and-replace-grep.md` describes the path to registering as `name: "grep"` (the built-in tool name), which would replace pi's built-in `grep` entirely. Until then, the agent has both `ripgrep` and the built-in `grep` available.

## Hard rules

- **Prefer `ripgrep` over the built-in `grep` for new work** — better flag handling, streaming output.
- **External dependency**: `rg` must be installed on the system (not bundled).

<important if="you are adding a new field to the ripgrep tool">
1. Add the field to the typebox input schema.
2. Update the `execute` function to pass the new flag to `rg`.
3. Add a test in `ripgrep.test.ts` against a tempdir with a fixture file.
4. Run `pnpm --filter @piotrb/pi-ripgrep run typecheck test`.
</important>
