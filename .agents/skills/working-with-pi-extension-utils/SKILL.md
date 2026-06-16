---
name: working-with-pi-extension-utils
description: Core facts about the pi-extension-utils package — a pure shared library with 3 spawn helpers consumed by 4 other packages, must be published to npm. Use when working on, depending on, or evaluating the pi-extension-utils package.
---

You are working on, depending on, or evaluating the `pi-extension-utils` package. It is a shared library, not an extension — that distinction shapes everything about how it is structured and consumed.

## What the package does

Process-spawning helpers used by tool extensions that wrap CLI tools. Provides streaming output, progressive termination, and deadline enforcement for child processes.

## Core rules

- **It is a library, not an extension.** There is no `pi.extensions` field in `package.json`. The package exports `./src/extension-utils.ts` directly.
- **Must be published to npm as a runtime dep.** Consumers depend on the package name in production. The `workspace:*` symlink is dev-only — it satisfies local dev but does not satisfy a prod install. Every consumer must list `pi-extension-utils` (or `@piotrb/pi-extension-utils`) in their `dependencies`, not just rely on the dev symlink.
- **No tests for `progressiveKill` or `scheduleProcessTimeout` directly.** Both are exercised through consumer tests. Adding direct unit tests is not required and may not match how the helpers are actually invoked.

## Module structure

```
packages/pi-extension-utils/
  src/extension-utils.ts          # 3 exports, 1 file
  src/extension-utils.test.ts     # co-located test (covers spawnStreaming)
```

One source file, three exports. The package is intentionally minimal.

## The three exports

```ts
export async function* spawnStreaming(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
): AsyncGenerator<{ stream: "stdout" | "stderr"; chunk: string }>

export function progressiveKill(child: ChildProcess, graceMs?: number): void

export function scheduleProcessTimeout(child: ChildProcess, ms: number): NodeJS.Timeout
```

Typical call site (from `pi-git`):

```ts
const { stdout } = await spawnStreaming("git", ["status"], { cwd: ctx.cwd })
```

`spawnStreaming` is the workhorse — async generator of stdout/stderr chunks. The other two are auxiliary helpers for the streaming wrapper.

## Dependencies

- **Outbound:** Node stdlib only (`node:child_process`, `node:timers/promises`, `node:os`). No external deps.
- **Inbound (consumers):** 4 of the workspace's tool packages:
  - `pi-bfs`, `pi-git`, `pi-ripgrep`, `pi-task-runner` — wrap external CLIs via `spawnStreaming`.
  - `pi-pfs` does **not** use it (uses `fs/promises` directly for atomic operations).
  - `pi-context-preloader` does not use it (no process spawning).
  - `pi-tool-policy` does not use it (it uses `genericPatternToRegex` from a different path — see the package's own dependency).

## How to extend it

When adding a new spawn helper:

1. Add the function to `src/extension-utils.ts` with a typed signature.
2. Add a unit test in `src/extension-utils.test.ts` (mock `child_process` for unit-level tests).
3. Document the signature in this file (and in the package's README if it's a new public surface).
4. Run `pnpm --filter @piotrb/pi-extension-utils run typecheck test`.
5. Bump the package version and add a changeset (see `pi-npm-publishing` for the release workflow).

## What you do not do

- Do not add a `pi.extensions` field. This is a library, not an extension.
- Do not add a `pi-tool-policy`-style `toolMetadata` block. There are no tools to metadata.
- Do not add direct tests for `progressiveKill` or `scheduleProcessTimeout` unless you are adding a new helper that depends on them.
- Do not change the file structure (the package is intentionally one source file).

## What this skill does not do

- It does not cover the canonical `pi-*` package shape — see `pi-package-scaffold`.
- It does not cover the publishing workflow — see `pi-npm-publishing`.
