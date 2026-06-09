# pi-git

9 git tools (status, add, rm, mv, diff, restore, commit, log, push) in one file. Wraps the `git` CLI via `spawnStreaming`. The canonical "many tools in one file" example.

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

## Tool registration loop

```ts
const TOOLS = ["status", "add", "rm", "mv", "diff", "restore", "commit", "log", "push"] as const

for (const t of TOOLS) {
  pi.registerTool({
    name: `git_${t}`,
    description: GIT_DESCRIPTIONS[t],
    parameters: GIT_SCHEMAS[t],
    execute: makeExecutor(t),
  })
}
```

Each tool's `execute` is a thin wrapper around `spawnStreaming("git", [...args], { cwd, timeoutMs })`.

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

<important if="you are adding a new git tool">
1. Add the tool name to the `TOOLS` array.
2. Add a description to `GIT_DESCRIPTIONS` and a schema to `GIT_SCHEMAS`.
3. Extend `makeExecutor(t)` (or a per-tool override) to handle the new subcommand.
4. Add a test in `git.test.ts` against a tempdir with a real git repo.
5. Run `pnpm --filter @piotrb/pi-git run typecheck test`.
</important>
