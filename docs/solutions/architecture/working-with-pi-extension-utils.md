---
title: working with pi-extension-utils (shared library, spawn helpers, must publish to npm)
category: architecture
severity: high
tags:
  - pi-extension-utils
  - extension-utils
  - shared-library
  - library-not-extension
  - spawnStreaming
  - progressiveKill
  - scheduleProcessTimeout
  - workspace-symlink
  - must-publish
  - no-pi-extensions
  - consumers
applies_when:
  - working on, depending on, or evaluating the pi-extension-utils package
  - adding a new spawn helper to extension-utils.ts
  - choosing between fs/promises and spawnStreaming for a new tool
  - understanding why pi-extension-utils is published while other internal packages are not
  - understanding the 4-consumer relationship
  - debugging a "module not found" error from a missing pi-extension-utils publish
---

# Problem

`pi-extension-utils` is a pure shared library — 3 spawn helpers consumed by 4 other packages — that must be published to npm. The package has no `pi.extensions` field; it exports helpers directly. Without a single reference for the library's invariants, the agent adds a `pi.extensions` field (turns it into an extension), skips the publish step (breaks consumer installs), or adds direct unit tests for `progressiveKill` / `scheduleProcessTimeout` (duplicates consumer test coverage).

This solution covers the package overview. The canonical `pi-*` package shape is in `pi-package-scaffold` and `pi-package-hard-rules`. The publishing workflow (the `private: true` exceptions, the `updateInternalDependencies: "patch"` rule) is in `pi-npm-publishing`. The `spawnStreaming` pattern is in `pi-register-tool` and `pi-fs-tools`.

# Context

`pi-extension-utils` exists because 4 tool packages (`pi-bfs`, `pi-git`, `pi-ripgrep`, `pi-task-runner`) all need to spawn a child process, stream stdout/stderr, and apply timeouts. Lifting the helpers into a shared library removes 4 copies of the same code and gives the consumers a single, tested surface for process lifecycle.

The library is **published to npm** (unlike the workspace-internal packages) because the workspace symlink is dev-only. A consumer that depends on `pi-extension-utils` via `workspace:*` and then gets published to npm itself is broken at install time — the prod install resolves `pi-extension-utils` to a real npm package, not the workspace symlink.

# Solution

## What the package does

Process-spawning helpers used by tool extensions that wrap CLI tools. Provides streaming output, progressive termination, and deadline enforcement for child processes.

## Core rules

- **It is a library, not an extension.** There is no `pi.extensions` field in `package.json`. The package exports `./src/extension-utils.ts` directly.
- **Must be published to npm as a runtime dep.** Consumers depend on the package name in production. The `workspace:*` symlink is dev-only — it satisfies local dev but does not satisfy a prod install. Every consumer must list `pi-extension-utils` (or `@piotrb/pi-extension-utils`) in their `dependencies`, not just rely on the dev symlink.
- **No tests for `progressiveKill` or `scheduleProcessTimeout` directly.** Both are exercised through consumer tests. Adding direct unit tests is not required and may not match how the helpers are actually invoked.
- **One source file, three exports.** The package is intentionally minimal. Adding a `src/lib/` subfolder or splitting into multiple files is a structural change the package is not designed to absorb.

## Module structure

```
packages/pi-extension-utils/
  src/extension-utils.ts          # 3 exports, 1 file
  src/extension-utils.test.ts     # co-located test (covers spawnStreaming)
```

One source file, three exports. The package is intentionally minimal. There is no `src/lib/`, no `src/extensions/`, no test fixtures folder.

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

`spawnStreaming` is the workhorse — async generator of stdout/stderr chunks. The other two are auxiliary helpers for the streaming wrapper: `progressiveKill` sends `SIGTERM` then `SIGKILL` after a grace period; `scheduleProcessTimeout` returns a `NodeJS.Timeout` for manual deadline enforcement.

## The 4-consumer relationship

`pi-extension-utils` is consumed by 4 of the workspace's tool packages:

- **`pi-bfs`** — wraps the `bfs` CLI. Uses `spawnStreaming`.
- **`pi-git`** — wraps 9 git subcommands. Uses `spawnStreaming`.
- **`pi-ripgrep`** — wraps the `rg` CLI. Uses `spawnStreaming`.
- **`pi-task-runner`** — wraps the `run` tool's command execution. Uses `spawnStreaming`, `progressiveKill`.

The following packages do **not** use `pi-extension-utils`:

- **`pi-pfs`** — uses `fs/promises` directly for atomic filesystem operations. No process spawning.
- **`pi-context-preloader`** — no process spawning; it just reads files.
- **`pi-tool-policy`** — uses `picomatch` and `genericPatternToRegex` from a different path (not from `pi-extension-utils`).
- **`pi-bfs`** does not use `progressiveKill` or `scheduleProcessTimeout` (only `spawnStreaming`).
- **`pi-extension-utils` is the only workspace-internal package that is also published to npm.** Every other package is either `private: true` (e.g. `pi-bfs`) or scoped-public but workspace-only.

## Dependencies

- **Outbound:** Node stdlib only (`node:child_process`, `node:timers/promises`, `node:os`). No external deps. The library's only deps are the Node stdlib.
- **Inbound (consumers):** the 4 packages above.
- **Peer deps:** none. The library does not depend on `@earendil-works/pi-coding-agent` or any other pi-runtime package. It is pure Node stdlib.

## How to extend it

When adding a new spawn helper:

1. Add the function to `src/extension-utils.ts` with a typed signature.
2. Add a unit test in `src/extension-utils.test.ts` (mock `child_process` for unit-level tests).
3. Document the signature in this file (and in the package's README if it's a new public surface).
4. Run `pnpm --filter @piotrb/pi-extension-utils run typecheck test`.
5. Bump the package version and add a changeset (see `pi-npm-publishing` for the release workflow).
6. **Internal dep bumps patch-bump downstream consumers** via `updateInternalDependencies: "patch"` in `.changeset/config.json`. A change to `pi-extension-utils` propagates a patch bump to all 4 consumers automatically.

# Why this works

- **One library, four consumers.** The shared surface removes 4 copies of process-lifecycle code. A bug fix in `spawnStreaming` lands once and benefits all consumers; a new helper (e.g. a future `cancelOnParentExit`) is added once and available to all 4.
- **The workspace symlink is dev-only.** A consumer that depends on `pi-extension-utils` via `workspace:*` works locally (pnpm symlinks the workspace package) but fails at consumer install time (the prod install resolves to npm, not the workspace). Publishing `pi-extension-utils` to npm is the fix.
- **The 3 exports are the minimum surface.** `spawnStreaming` is the workhorse; `progressiveKill` and `scheduleProcessTimeout` are the auxiliary helpers. Adding a fourth or fifth helper is a structural decision that should be reviewed.
- **The `updateInternalDependencies: "patch"` rule keeps consumers in sync.** When `pi-extension-utils` changes, all 4 consumers get a patch bump. The maintainer's only manual step is reviewing the "Version Packages" PR.
- **No `pi.extensions` field means no tool registration.** The library is consumed by tool packages, not by the runtime. The runtime doesn't see it; the 4 consumer packages register tools with the runtime and import the helpers from `pi-extension-utils`.

# Prevention

- **Do not add a `pi.extensions` field.** This is a library, not an extension. Adding `pi.extensions` would register a no-op extension with the runtime and confuse the load order.
- **Do not add a `pi-tool-policy`-style `toolMetadata` block.** There are no tools to metadata.
- **Do not add direct tests for `progressiveKill` or `scheduleProcessTimeout`** unless you are adding a new helper that depends on them. The helpers are exercised through consumer tests; direct unit tests may not match how the helpers are actually invoked (e.g. the grace period for `progressiveKill` is timing-dependent).
- **Do not change the file structure.** The package is intentionally one source file. Splitting into `src/lib/` or adding a `src/streaming/` subfolder is a structural change that breaks the minimalism.
- **Do not add external deps.** The library's deps are Node stdlib only. Adding `node-fetch` or `p-limit` or any other dep inflates the surface and creates a per-consumer install burden.
- **Do not skip publishing.** A change to `pi-extension-utils` that is not published to npm is invisible to prod consumers. The release workflow in `pi-npm-publishing` is the only path to npm.
- **Do not depend on `pi-extension-utils` from a `private: true` package** that won't be published. The workspace symlink works for dev, but a published consumer that transitively depends on a private `pi-extension-utils` consumer is broken. (In practice, the only `private: true` package in the workspace is `pi-bfs`, which is a transitional single-tool wrapper that does not depend on `pi-extension-utils`.)

# Verification

- **`spawnStreaming` is tested** in `src/extension-utils.test.ts` with a real subprocess (e.g. `node -e "console.log('hello')"`) and assertions on the stdout chunks.
- **The library is published to npm** is verified by `pnpm view @piotrb/pi-extension-utils` (returns the published version) or by inspecting the npm registry.
- **The 4 consumers are wired** is verified by `grep -r '@piotrb/pi-extension-utils' packages/` — should match `pi-bfs`, `pi-git`, `pi-ripgrep`, `pi-task-runner` in their `package.json` `dependencies`.
- **No `pi.extensions` field** is verified by inspecting `packages/pi-extension-utils/package.json` — the field should be absent.
- **The `files` allowlist excludes `src/`, `tests/`, etc.** and includes only the published surface (typically just the `dist/` build output or the source if exporting directly via the `exports` field).

# Related

- `pi-package-scaffold` — the canonical `pi-*` package shape; `pi-extension-utils` is the example for the "Publishable, library" variant.
- `pi-package-hard-rules` — the cross-cutting invariants, including the `pi-extension-utils` publishing-flow invariant and the `workspace:*` rule.
- `pi-npm-publishing` — the release workflow, including the `private: true` exceptions, the `updateInternalDependencies: "patch"` rule, and the 4-consumer publish table.
- `pi-register-tool` — the `registerTool` pattern; tools that wrap an external CLI use `spawnStreaming` from `pi-extension-utils`.
- `pi-fs-tools` — the `fs/promises` pattern; the inverse of `spawnStreaming` for atomic filesystem operations. `pi-pfs` uses this instead of `pi-extension-utils`.
- `pi-hackery-folder-layout` — the workspace layout; `pi-extension-utils` is the only workspace-internal package that is also published to npm.
