# pi-git

9 git tools (status, add, rm, mv, diff, restore, commit, log, push) in one file. Wraps the `git` CLI via `spawnStreaming`. The canonical "many tools in one file" example.

The tool registration loop pattern (the `TOOLS` array + `GIT_DESCRIPTIONS` + `GIT_SCHEMAS` + `makeExecutor` factory) is encoded in `pi-multi-tool-package`. This file documents the package-specific internals.

## Layer responsibility

Structured git operations for the agent. Each tool takes typed input (typebox), runs `git` with subcommand-specific args, streams output, returns a typed result. Replaces freeform `git ...` bash invocations.

## Dependencies

- **Outbound**: `@piotrb/pi-extension-utils` (`spawnStreaming`), `typebox`.
- **Inbound**: pi-runtime.

## Module structure

```
src/extensions/git.ts            # 9 registerTool calls, ~1000 lines
src/extensions/git.test.ts       # co-located test
```

## Typebox schema shape

```ts
// git_add — array of paths, optional cwd
const git_add = Type.Object({
  paths: Type.Array(Type.String()),
  cwd: Type.Optional(Type.String()),
})

// git_commit — message + optional flags
const git_commit = Type.Object({
  message: Type.String(),
  amend: Type.Optional(Type.Boolean()),
})
```

## Result shape (pi tool protocol)

```ts
return {
  content: [{ type: "text", text: stdout }],
}
```

## Hard rules

- **All git operations go through `spawnStreaming`** — no native bindings, no shell parsing.
- **Errors surface via exit codes** captured by the streaming wrapper, not thrown.
- **The `cwd` parameter is `ctx.cwd` (the session's working directory)** unless overridden.
