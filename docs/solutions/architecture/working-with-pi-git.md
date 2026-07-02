---
title: working with pi-git (9 structured git tools, multi-tool loop pattern, exit-code-as-result)
category: architecture
severity: high
tags:
  - pi-git
  - git
  - multi-tool
  - TOOLS-array
  - loop-pattern
  - exit-code
  - cwd
  - spawnStreaming
  - path-aspect
  - structured-git
  - toolMetadata
applies_when:
  - working on, depending on, or evaluating the pi-git package
  - adding a new flag to an existing git tool
  - considering adding a 10th tool to pi-git
  - debugging a tool that returns a non-zero exit code
  - understanding why pi-git doesn't throw on git errors
  - choosing between pi-git and pfs_mv for a file rename
---

# Problem

`pi-git` is a multi-tool wrapper around the `git` CLI. Nine tools (`git_status`, `git_add`, `git_rm`, `git_mv`, `git_diff`, `git_restore`, `git_commit`, `git_log`, `git_push`) replace freeform `git ...` bash invocations with typed, validated, pi-registered tools. Without a single reference for the package's invariants, the agent uses `child_process.spawn` directly (bypasses the streaming wrapper), throws on non-zero exit codes (breaks the result-shape contract), calls `process.chdir` (mutates process state), or adds a 10th unrelated tool (breaks the multi-tool shape).

This solution covers the package overview. The multi-tool `TOOLS` array pattern is in `pi-multi-tool-package` (which uses `pi-git` as the canonical example). The canonical `registerTool` pattern is in `pi-register-tool`. The path-aspect binding for `git_mv` is in `pi-tool-policy-per-field-aspect-cardinality` (which uses `git_mv` as the test case).

# Context

`pi-git` exists because freeform `git ...` bash invocations are a security and DX hazard: shell parsing, no type checking, no result-shape contract. Wrapping each git subcommand in a typed, validated tool gives the agent structured access to git's surface and lets the policy engine gate each operation.

The package is the **canonical multi-tool example** — 9 related tools in one file, registered via the `TOOLS` array loop pattern. See `pi-multi-tool-package` for the full pattern.

# Solution

## What the package does

Structured git operations for the agent. Nine tools (`git_status`, `git_add`, `git_rm`, `git_mv`, `git_diff`, `git_restore`, `git_commit`, `git_log`, `git_push`) replace freeform `git ...` bash invocations with typed, validated, pi-registered tools. Output is streamed from `git` via `spawnStreaming`.

## Core rules

- **All git operations go through `spawnStreaming`.** No native bindings, no shell parsing. The wrapper captures exit codes, streams stdout, and surfaces errors via the result's `details.exitCode` field.
- **Errors surface via exit codes, not throws.** Unlike `pi-pfs` (which lets `fs/promises` errors throw), `pi-git` tools never throw. `git` exit codes are captured: 0 = success, non-zero = error rendered as an error result. The agent's error handling reads the result, not a thrown exception.
- **The `cwd` parameter is `ctx.cwd` (the session's working directory) unless overridden.** Most git tools accept an optional `cwd` that, when relative, resolves against `ctx.cwd`. The executor never calls `process.chdir`; the cwd is per-spawn.
- **The package follows the multi-tool `TOOLS` array pattern.** The 9 tools are registered in a loop from a `TOOLS` array; descriptors and schemas are co-located in the same file. See `pi-multi-tool-package` for the broader convention.
- **Do not add a 10th tool without consulting `pi-multi-tool-package`.** The 9-tool shape is load-bearing for the loop pattern; a 10th tool belongs in a separate package if its domain is distinct.

## Module structure

```
packages/pi-git/
  src/extensions/git.ts            # 9 registerTool calls, ~1000 lines
  src/extensions/git.test.ts       # co-located test
```

There is no `src/lib/`. All 9 tools and their schemas/descriptors live in `git.ts`. The single-file multi-tool shape is the package's defining feature (see `pi-multi-tool-package` for why).

## The 9 tools

| Tool          | Purpose                            | Schema highlights                                                                                                                                                       |
| ------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git_status`  | Show working tree status           | `cwd?`                                                                                                                                                                  |
| `git_add`     | Stage paths                        | `paths: string[]`, `cwd?`                                                                                                                                               |
| `git_rm`      | Remove from index and working tree | `paths: string[]`, `cwd?`                                                                                                                                               |
| `git_mv`      | Move or rename a tracked file      | `source: string`, `destination: string`, `cwd?` — separate `source` (array-mode) and `destination` (scalar) aspects (see `pi-tool-policy-per-field-aspect-cardinality`) |
| `git_diff`    | Show changes between commits/trees | `paths?: string[]`, `staged?`, `base?`, `target?`, `cwd?`                                                                                                               |
| `git_restore` | Restore working tree files         | `paths: string[]`, `staged?`, `cwd?`                                                                                                                                    |
| `git_commit`  | Record changes to the repository   | `message: string`, `amend?`, `cwd?`                                                                                                                                     |
| `git_log`     | Show commit logs                   | `maxCount?: number`, `since?`, `until?`, `author?`, `paths?`, `cwd?`                                                                                                    |
| `git_push`    | Update remote refs                 | `remote?: string`, `branch?: string`, `setUpstream?`, `forceWithLease?`, `tags?`, `dryRun?`, `cwd?`                                                                     |

## TypeBox schema shape (representative)

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

All 9 tools use TypeBox schemas. The `as const` typing on the `TOOLS` array enforces `Record<ToolName, ...>` on the schemas, descriptions, and executors tables (see `pi-multi-tool-package`).

## Result shape (pi tool protocol)

```ts
return {
  content: [{ type: "text", text: stdout }],
}
```

The `details` object carries the exit code, the parsed args, and (for streaming) the running line count. For non-zero exit codes, the result sets `isError: true` and the content text is the stderr output.

## The `cwd` contract

The `cwd` parameter contract is the same across all 9 tools:

- **Default: `ctx.cwd` (the session's working directory).** The agent operates in the session's cwd; most tools don't need an explicit `cwd`.
- **Override: an optional `cwd` string parameter.** When relative, resolves against `ctx.cwd`. When absolute, used verbatim.
- **Per-spawn, not process-wide.** The executor passes `cwd` to `spawnStreaming`'s `opts.cwd`. It never calls `process.chdir`. The process state is unchanged; the next tool spawn reverts to the default.
- **No cwd-less tool.** Every tool accepts an optional `cwd`. The pattern is uniform across the 9 tools.

## Dependencies

- **Outbound:** `@piotrb/pi-extension-utils` (`spawnStreaming`), `typebox`.
- **Inbound:** pi-runtime. No other package in the workspace depends on `pi-git`.

## Tool metadata

`pi-git` declares a `pi.toolMetadata` block in `package.json` (per `pi-tool-policy`'s `aggregateToolMetadata`). The block binds the `cwd` field of each tool to a `path` aspect (relative path resolution against the session cwd). `git_mv` is the most complex: separate `source` (array-mode) and `destination` (scalar) aspects, which exercises the per-field cardinality refactor. See `pi-tool-policy-per-field-aspect-cardinality` for the dispatch-key gotcha and the regression test.

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

When considering a 10th tool whose domain is **not** git (e.g. an `svn_*` tool): **don't.** A new tool belongs in a new package via `pi-package-scaffold`. The 9-tool shape is load-bearing for the loop pattern; an unrelated tool breaks the uniformity.

# Why this works

- **The `TOOLS` array + `as const` typing enforces consistency.** The schemas, descriptions, and executors tables are typed as `Record<ToolName, ...>`. Adding a tool without a matching entry in all three tables is a compile error. Bypassing the type system with `as any` lets the runtime silently skip missing tools — see `pi-multi-tool-package` for why this is bad.
- **Spawning via `spawnStreaming` gives streaming + exit-code capture for free.** The wrapper handles the exit code, the streaming, and the process lifecycle. The executor just builds the `args` array and returns the result.
- **Errors as results, not throws, integrate with the policy engine.** The matcher sees a `deny` or `ask` result; it doesn't catch a throw. Surfacing errors as results keeps the policy engine in the loop.
- **The `cwd` per-spawn contract is process-state-safe.** `process.chdir` would mutate global state; the next tool spawn would inherit the changed cwd. The per-spawn `opts.cwd` keeps each tool's cwd isolated.
- **The 9-tool shape is a domain, not a count.** 9 git subcommands covers the common surface (status, add, rm, mv, diff, restore, commit, log, push). A 10th git subcommand is welcome; a 10th non-git tool is not.

# Prevention

- **Do not use `child_process.spawn` directly.** All git operations go through `spawnStreaming` for streaming output and exit-code capture.
- **Do not throw on `git` non-zero exit codes.** Surface them via the result's `details.exitCode` field and the `isError: true` flag.
- **Do not call `process.chdir` in the executor.** Pass `cwd` to `spawnStreaming`; let the wrapper handle per-spawn cwd.
- **Do not split the 9 tools into separate files.** The single-file multi-tool pattern is the package's defining shape; see `pi-multi-tool-package` for why.
- **Do not add a 10th tool whose domain is unrelated to git** (e.g. an `svn_*` tool). A new tool belongs in a new package via `pi-package-scaffold`.
- **Do not bypass the `TOOLS` array typing with `as any`.** Bypassing the type system lets the runtime silently skip missing tools; the type safety is the safety net.
- **Do not use `git_*` tools in lieu of `pfs_*` for filesystem operations.** `pfs_mv` is the right tool for a plain filesystem rename; `git_mv` is only needed when git must track the rename in the index. See `pi-package-hard-rules` for the agent-loop file operation rule.

# Verification

- **The 9 tools are registered** is verified by `pnpm test` running `git.test.ts`, which exercises each tool's executor against a real git repo fixture.
- **Exit codes surface as results** is tested with a deliberate `git status` against a non-git directory (exit code 128), asserting the result has `isError: true` and the stderr text in `content[0].text`.
- **The `cwd` per-spawn contract** is tested by spawning two git tools in sequence with different `cwd` values, asserting the second tool's cwd is not affected by the first tool's spawn.
- **The `pi.toolMetadata` block** is in `package.json` and includes the path-aspect binding for `cwd` and the per-field `source` / `destination` aspects for `git_mv`.

# Related

- `pi-multi-tool-package` — the `TOOLS` array loop pattern, with `pi-git` as the canonical example. The 9 tools, the `as const` typing, the supporting tables — all documented in the area skill.
- `pi-register-tool` — the canonical `registerTool` pattern. Each of the 9 tools follows the same pattern, with the loop factory providing the per-tool differentiation.
- `pi-tool-policy-per-field-aspect-cardinality` — the per-field `FieldBinding` shape. `git_mv` is the test case for the multi-aspect refactor and the dispatch-key gotcha.
- `pi-package-scaffold` — the canonical `pi-*` package shape; `pi-git` is the example for the "Publishable, registers tools with path aspects, multi-tool" variant.
- `pi-package-hard-rules` — the cross-cutting invariants, including the "use `pfs_*` for filesystem operations, use `git_*` only when git must track" rule.
- `pi-extension-utils` — the `spawnStreaming` helper that all 9 tools depend on.
- `pi-fs-tools` — the `fs/promises` pattern; `pi-pfs` is the inverse of `pi-git` for plain filesystem operations.
