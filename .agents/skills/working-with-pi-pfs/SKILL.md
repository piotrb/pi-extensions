---
name: working-with-pi-pfs
description: Core facts about the pi-pfs package — 4 atomic filesystem tools (pfs_unlink, pfs_rmdir, pfs_cp, pfs_mv) using node:fs/promises directly, with path validation that rejects absolute paths and .. escapes at the boundary. Use when working on, depending on, or evaluating the pi-pfs package.
---

You are working on, depending on, or evaluating the `pi-pfs` package. The package is a multi-tool filesystem wrapper with one key design choice: it does **not** use `pi-extension-utils` because its operations are atomic filesystem calls, not subprocess spawns.

## What the package does

Four structured filesystem tools for the agent. Replaces `rm`/`mv`/`cp`/`rmdir` bash invocations with typed, validated, pi-registered tools. Path validation rejects absolute paths and `..` escapes at the boundary.

## Core rules

- **All paths must be relative to the project root.** Absolute paths and `..` escapes are rejected at the boundary. This is non-negotiable — the tools are designed to be project-scoped.
- **Use `pfs_*` tools from the agent loop, never `rm`/`mv`/`cp` via bash.** The shell-form commands do not enforce the project-scope invariant; the structured tools do.
- **Errors are thrown, not captured as exit codes.** Unlike `pi-git` (where errors surface as exit codes in stdout captured by `spawnStreaming`), `pfs_*` tools let `fs/promises` errors propagate. `ENOENT`, `EEXIST`, `EACCES` reach pi's tool result as thrown errors. The path-validation rejection is also thrown.

## Why no `pi-extension-utils`

The package deliberately does **not** use `pi-extension-utils`. `pi-extension-utils` exports `spawnStreaming` and helpers for wrapping subprocess invocations. The `pfs_*` tools use `node:fs/promises` directly because:

- They are atomic filesystem operations, not subprocess spawns.
- There is no streaming output (a one-shot call returns success or throws).
- Adding a subprocess wrapper would add latency and a serialization layer with no benefit.

This is the canonical "fs-tools exception" — see `pi-fs-tools` for the broader pattern.

## Module structure

```
packages/pi-pfs/
  src/extensions/pfs.ts            # 4 registerTool calls
  src/extensions/pfs.test.ts       # co-located test (uses tempdir)
```

There is no `src/lib/`. The package is a thin wrapper, not a complex one.

## Dependencies

- **Outbound:** Node stdlib (`node:fs/promises`, `node:path`). No `pi-extension-utils`, no `minimist`.
- **Inbound:** pi-runtime. No other package in the workspace depends on `pi-pfs`.

## Hard rules

- **All paths must be relative to the project root** — absolute paths and `..` escapes are rejected at the boundary.
- **Use `pfs_*` tools from the agent loop**, never `rm`/`mv`/`cp` via bash.
- **Let `fs/promises` errors throw** — do not catch and return a soft result. The structured throw is the contract.

## How to extend it

When adding a new `pfs_*` tool:

1. Use `fs/promises` directly. Do not add `pi-extension-utils` or any subprocess layer.
2. Validate the path at the boundary: must be relative, must not start with `..`, must resolve within the project root.
3. Let the `fs/promises` call throw on error. Do not catch and return `{ success: false }`.
4. Co-locate the test in `src/extensions/pfs.test.ts`. Use `node:fs/promises.mkdtemp` for a tempdir.

## What you do not do

- Do not add `pi-extension-utils` as a dependency. The package is deliberately subprocess-free.
- Do not catch `fs/promises` errors and return soft results. The throw is the contract.
- Do not add `pfs_*` tools that operate outside the project root (e.g. `pfs_rm` for arbitrary absolute paths). The project-scope invariant is the whole point.
- Do not import shell tools (`rm`, `mv`, `cp`, `rmdir`) into the agent loop. Use the `pfs_*` tools.

## What this skill does not do

- It does not cover the canonical `pi-*` package shape — see `pi-package-scaffold`.
- It does not cover the broader "no spawn" pattern for fs tools — see `pi-fs-tools`.
