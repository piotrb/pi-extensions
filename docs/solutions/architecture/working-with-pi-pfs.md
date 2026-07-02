---
title: working with pi-pfs (4 atomic filesystem tools, fs/promises direct, path validation)
category: architecture
severity: high
tags:
  - pi-pfs
  - pfs_unlink
  - pfs_rmdir
  - pfs_cp
  - pfs_mv
  - atomic
  - fs/promises
  - path-validation
  - assertRelative
  - project-scope
  - flat-structure
  - no-pi-extension-utils
  - errors-throw
applies_when:
  - working on, depending on, or evaluating the pi-pfs package
  - adding a new pfs_* tool (atomic filesystem operation)
  - wondering why pi-pfs doesn't use pi-extension-utils
  - debugging a "path escapes project root" error
  - choosing between pfs_* and git_* (or pfs_* and bash) for a file operation
  - understanding the flat-structure multi-tool pattern
---

# Problem

`pi-pfs` is a multi-tool wrapper around `node:fs/promises` for atomic filesystem operations. Four tools (`pfs_unlink`, `pfs_rmdir`, `pfs_cp`, `pfs_mv`) replace `rm`/`mv`/`cp`/`rmdir` bash invocations with typed, validated, pi-registered tools. Path validation rejects absolute paths and `..` escapes at the boundary. Without a single reference for the package's invariants, the agent adds `pi-extension-utils` (adds subprocess overhead for atomic calls), catches `fs/promises` errors and returns soft results (breaks the throw contract), uses bash `rm`/`mv` instead of `pfs_*` (bypasses path validation), or wraps the 4 tools in a `TOOLS` array loop (the loop pattern doesn't fit — the tools are too different).

This solution covers the package overview. The atomic-filesystem pattern (the `fs/promises` choice, the path validation, the no-spawn rationale) is in `pi-fs-tools`. The multi-tool convention (loop vs. flat) is in `pi-multi-tool-package`. The canonical `pi-*` package shape is in `pi-package-scaffold` and `pi-package-hard-rules`.

# Context

`pi-pfs` exists because freeform `rm`/`mv`/`cp`/`rmdir` bash invocations are a security and DX hazard: no path validation, no type checking, no result-shape contract. Wrapping each operation in a typed, validated tool with project-scope enforcement gives the agent structured access to filesystem mutations and lets the policy engine gate each operation.

The package is the canonical **flat-structure multi-tool** example — 4 related tools in one file, registered as 4 separate `pi.registerTool` calls, no `TOOLS` array loop. See `pi-multi-tool-package` for the loop vs. flat decision.

# Solution

## What the package does

Four structured filesystem tools for the agent. Replaces `rm`/`mv`/`cp`/`rmdir` bash invocations with typed, validated, pi-registered tools. Path validation rejects absolute paths and `..` escapes at the boundary.

## Core rules

- **All paths must be relative to the project root.** Absolute paths and `..` escapes are rejected at the boundary. This is non-negotiable — the tools are designed to be project-scoped.
- **Use `pfs_*` tools from the agent loop, never `rm`/`mv`/`cp` via bash.** The shell-form commands do not enforce the project-scope invariant; the structured tools do.
- **Errors are thrown, not captured as exit codes.** Unlike `pi-git` (where errors surface as exit codes in stdout captured by `spawnStreaming`), `pfs_*` tools let `fs/promises` errors propagate. `ENOENT`, `EEXIST`, `EACCES` reach pi's tool result as thrown errors. The path-validation rejection is also thrown.
- **No subprocess wrapper.** The package does **not** use `pi-extension-utils`. The `pfs_*` tools use `node:fs/promises` directly because they are atomic filesystem calls, not subprocess spawns.
- **Flat structure, not loop.** The 4 tools are registered as 4 separate `pi.registerTool` calls, not a `TOOLS` array loop. The tools' shapes are too different (unlink takes one path, cp takes source + destination, mv takes source + destination, rmdir takes one path) for the loop's uniformity benefit to apply. See `pi-multi-tool-package` for the loop vs. flat decision.

## Module structure

```
packages/pi-pfs/
  src/extensions/pfs.ts            # 4 registerTool calls
  src/extensions/pfs.test.ts       # co-located test (uses tempdir)
```

There is no `src/lib/`. The package is a thin wrapper, not a complex one. The 4 tools share a single file because they share the same `assertRelative` helper and the same import (`node:fs/promises`), but each has its own `pi.registerTool` call.

## The 4 tools

| Tool         | Purpose                            | Schema                                    |
| ------------ | ---------------------------------- | ----------------------------------------- |
| `pfs_unlink` | Delete a file                      | `{ path: string }`                        |
| `pfs_rmdir`  | Remove an empty directory          | `{ path: string }`                        |
| `pfs_cp`     | Copy a file or directory tree      | `{ source: string; destination: string }` |
| `pfs_mv`     | Move or rename a file or directory | `{ source: string; destination: string }` |

All 4 tools accept a path-aspect for both `source` and `destination` (where applicable) for policy engine binding. The path is resolved against `ctx.cwd` and validated at the boundary.

## Path validation (`assertRelative`)

The `assertRelative(path, cwd)` helper is the package's load-bearing contract:

```ts
function assertRelative(path: string, cwd: string): string {
  if (path.startsWith("/") || path.startsWith("~")) {
    throw new Error(`absolute path rejected: ${path}`)
  }
  const abs = path.startsWith(".") ? resolve(cwd, path) : resolve(path)
  const rel = relative(cwd, abs)
  if (rel.startsWith("..") || rel === "..") {
    throw new Error(`path escapes project root: ${path}`)
  }
  return abs
}
```

- **Absolute paths** are rejected (the `path.startsWith("/")` or `path.startsWith("~")` check).
- **`..` escapes** are rejected (the `relative` check after `resolve`).
- **The validated absolute path is returned** for use with `fs/promises`. The agent's relative path is normalized to an absolute path inside the project root.

The helper throws on failure; the throw propagates as the tool result. See `pi-fs-tools` for the full pattern and the rationale (validate, don't normalize).

## Why no `pi-extension-utils`

The package deliberately does **not** use `pi-extension-utils`. `pi-extension-utils` exports `spawnStreaming` and helpers for wrapping subprocess invocations. The `pfs_*` tools use `node:fs/promises` directly because:

- They are atomic filesystem operations, not subprocess spawns.
- There is no streaming output (a one-shot call returns success or throws).
- Adding a subprocess wrapper would add latency and a serialization layer with no benefit.

This is the canonical "fs-tools exception" — see `pi-fs-tools` for the broader pattern.

## Dependencies

- **Outbound:** Node stdlib (`node:fs/promises`, `node:path`). No `pi-extension-utils`, no `minimist`, no external deps.
- **Inbound:** pi-runtime. No other package in the workspace depends on `pi-pfs`.

## How to extend it

When adding a new `pfs_*` tool:

1. Use `fs/promises` directly. Do not add `pi-extension-utils` or any subprocess layer.
2. Validate the path at the boundary with `assertRelative(path, ctx.cwd)`. The helper throws on absolute paths and `..` escapes.
3. Let the `fs/promises` call throw on error. Do not catch and return `{ success: false }`. The throw is the contract.
4. Co-locate the test in `src/extensions/pfs.test.ts`. Use `node:fs/promises.mkdtemp` for a tempdir.
5. If the tool is a multi-tool candidate (e.g. `pfs_chmod`, `pfs_stat`), decide loop vs. flat per `pi-multi-tool-package`. The default is flat for new pfs\_\* tools unless the shapes are uniform.

# Why this works

- **Path validation at the boundary is the security model.** The agent operates in the project root; absolute paths and `..` escapes are how the agent escapes the project root. `assertRelative` rejects both at the entry point.
- **`fs/promises` directly is faster than a subprocess wrapper.** A one-shot `unlink` call is microseconds; wrapping it in a subprocess adds 10-50ms of process startup. The pattern is justified by latency and complexity, not by lack of `pi-extension-utils` knowledge.
- **Errors thrown is the contract.** Catching and re-stringing `fs/promises` errors would lose the structured signal. The throw is what the agent sees; the agent handles the throw per its standard error handling.
- **Flat structure, not loop, fits the 4 tools.** The 4 tools are too different for the loop's uniformity benefit. `pfs_unlink` and `pfs_rmdir` are single-path; `pfs_cp` and `pfs_mv` are source+destination. The `TOOLS` array would force uniform schemas, which the tools don't share. See `pi-multi-tool-package` for the decision framework.

# Prevention

- **Do not add `pi-extension-utils` as a dependency.** The package is deliberately subprocess-free. Adding `spawnStreaming` or any of the spawn helpers introduces overhead with no benefit.
- **Do not catch `fs/promises` errors and return soft results.** The throw is the contract. Catching and re-stringing loses the structured signal.
- **Do not add `pfs_*` tools that operate outside the project root** (e.g. `pfs_rm` for arbitrary absolute paths). The project-scope invariant is the whole point.
- **Do not import shell tools (`rm`, `mv`, `cp`, `rmdir`) into the agent loop.** Use the `pfs_*` tools. Bash commands bypass the path validation.
- **Do not wrap the 4 tools in a `TOOLS` array loop.** The flat structure fits the tools' shapes; the loop would force uniform schemas that don't apply.
- **Do not normalize paths in `assertRelative`.** Validate, then pass the absolute path to `fs/promises`. Normalization would silently accept and re-interpret; the agent should know when its input is wrong, not have it silently rewritten. See `pi-fs-tools` for the rationale.
- **Do not use `pfs_*` tools for non-atomic operations** (e.g. watching a file, tailing a log). Atomic filesystem operations are the contract; non-atomic operations belong in a different package.

# Verification

- **Path validation** is tested with absolute paths (`/etc/passwd`), `..` escapes (`../../../foo`), and valid relative paths. The first two throw; the third returns the resolved absolute path.
- **Errors throw** is tested by attempting to `pfs_unlink` a non-existent file, asserting the throw propagates with `code: "ENOENT"`.
- **No `pi-extension-utils` dep** is verified by inspecting `package.json` `dependencies` — the field should be absent or only contain other workspace packages.
- **The 4 tools are registered** is verified by `pnpm test` running `pfs.test.ts`, which exercises each tool's executor against a tempdir.
- **Flat structure, not loop** is verified by inspecting `src/extensions/pfs.ts` — there should be 4 separate `pi.registerTool` calls, no `TOOLS` array, no `for` loop registering tools.

# Related

- `pi-fs-tools` — the atomic-filesystem pattern: `fs/promises` directly, `assertRelative` helper, no subprocess layer. `pi-pfs` is the canonical example.
- `pi-multi-tool-package` — the loop vs. flat decision framework. `pi-pfs` is the canonical **flat-structure** example (vs. `pi-git`'s loop pattern).
- `pi-register-tool` — the canonical `registerTool` pattern. The 4 `pfs_*` tools follow the same pattern, with `assertRelative` providing the project-scope enforcement.
- `pi-package-scaffold` — the canonical `pi-*` package shape; `pi-pfs` is the example for the "Publishable, registers atomic filesystem tools" variant.
- `pi-package-hard-rules` — the cross-cutting invariants, including the "use `pfs_*` for filesystem operations, use `git_*` only when git must track" rule.
- `working-with-pi-git` — the inverse package: `pi-git` uses `spawnStreaming` for subprocess-based tools; `pi-pfs` uses `fs/promises` directly for atomic tools. The error mode differs (exit code vs. throw).
