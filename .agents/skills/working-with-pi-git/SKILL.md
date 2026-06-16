---
name: working-with-pi-git
description: Core facts about the pi-git package — 9 structured git tools (status, add, rm, mv, diff, restore, commit, log, push) in one file, wrapping the `git` CLI via `spawnStreaming`. The canonical "many tools in one file" example. Use when working on, depending on, or evaluating the pi-git package.
---

You are working on, depending on, or evaluating the `pi-git` package. It is a multi-tool wrapper around the `git` CLI, with one key design choice: all tools share a single file, a single set of descriptors, and a single executor factory.

## What the package does

Structured git operations for the agent. Nine tools (`git_status`, `git_add`, `git_rm`, `git_mv`, `git_diff`, `git_restore`, `git_commit`, `git_log`, `git_push`) replace freeform `git ...` bash invocations with typed, validated, pi-registered tools. Output is streamed from `git` via `spawnStreaming`.

## Core rules

- **All git operations go through `spawnStreaming`.** No native bindings, no shell parsing. The wrapper captures exit codes, streams stdout, and surfaces errors via the result's `details.exitCode` field.
- **Errors surface via exit codes, not throws.** Unlike `pi-pfs` (which lets `fs/promises` errors throw), `pi-git` tools never throw. `git` exit codes are captured: 0 = success, non-zero = error rendered as an error result. The agent's error handling reads the result, not a thrown exception.
- **The `cwd` parameter is `ctx.cwd` (the session's working directory) unless overridden.** Most git tools accept an optional `cwd` that, when relative, resolves against `ctx.cwd`. The executor never calls `process.chdir`; the cwd is per-spawn.
- **The package follows the multi-tool `TOOLS` array pattern.** The 9 tools are registered in a loop from a `TOOLS` array; descriptors and schemas are co-located in the same file. See `pi-multi-tool-package` for the broader convention.

## Module structure

```
packages/pi-git/
  src/extensions/git.ts            # 9 registerTool calls, ~1000 lines
  src/extensions/git.test.ts       # co-located test
```

There is no `src/lib/`. All 9 tools and their schemas/descriptors live in `git.ts`.

## Typebox schema shape (representative)

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

The `details` object carries the exit code, the parsed args, and (for streaming) the running line count.

## Dependencies

- **Outbound:** `@piotrb/pi-extension-utils` (`spawnStreaming`), `typebox`.
- **Inbound:** pi-runtime. No other package in the workspace depends on `pi-git`.

## Hard rules

- **All git operations go through `spawnStreaming`** — no native bindings, no shell parsing.
- **Errors surface via exit codes** captured by the streaming wrapper, not thrown.
- **The `cwd` parameter is `ctx.cwd` (the session's working directory)** unless overridden.
- **Do not call `process.chdir`** — pass `cwd` to the spawn, do not mutate process state.
- **Do not add a 10th tool without consulting `pi-multi-tool-package`.** The 9-tool shape is load-bearing for the loop pattern; a 10th tool belongs in a separate package if its domain is distinct.

## How to extend it

When adding a new flag to an existing tool:

1. Add the parameter to the tool's TypeBox schema in `src/extensions/git.ts`.
2. Push the flag to the `args` array in the executor.
3. Add a test case in `src/extensions/git.test.ts`. Use absolute paths in test inputs (e.g. `/repo/.env` with `ctx.cwd = "/repo"`) so the path picomatch matcher can resolve them.
4. Run `pnpm --filter @piotrb/pi-git run typecheck test`.

When adding a brand-new git tool:

1. Add the tool to the `TOOLS` array with its `name`, `label`, `description`, `parameters` (TypeBox schema), and executor.
2. Co-locate the descriptor in the same file. The 9-tool shape is the package's defining feature.
3. Run `pnpm --filter @piotrb/pi-git run typecheck test` to verify the loop pattern holds.

## What you do not do

- Do not use `child_process.spawn` directly. All git operations go through `spawnStreaming` for streaming output and exit-code capture.
- Do not throw on `git` non-zero exit codes. Surface them via the result's `details.exitCode` field and the `isError: true` flag.
- Do not call `process.chdir` in the executor. Pass `cwd` to `spawnStreaming`; let the wrapper handle per-spawn cwd.
- Do not split the 9 tools into separate files. The single-file multi-tool pattern is the package's defining shape; see `pi-multi-tool-package` for why.
- Do not add a 10th tool whose domain is unrelated to git (e.g. an `svn_*` tool). A new tool belongs in a new package via `pi-package-scaffold`.

## What this skill does not do

- It does not cover the canonical `pi-*` package shape — see `pi-package-scaffold`.
- It does not cover the multi-tool `TOOLS` array pattern in detail — see `pi-multi-tool-package`.
- It does not cover the canonical `registerTool` pattern — see `pi-register-tool`.
