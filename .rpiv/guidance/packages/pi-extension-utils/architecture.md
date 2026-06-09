# pi-extension-utils

Shared library — `spawnStreaming`, `progressiveKill`, `scheduleProcessTimeout`. Pure library: no `pi.extensions` field, exports `./src/extension-utils.ts` directly.

## Layer responsibility

Process-spawning helpers used by tool extensions that wrap CLI tools (`pi-git`, `pi-ripgrep`, `pi-task-runner`, `pi-bfs`). Provides streaming output, progressive termination, and deadline enforcement.

## Dependencies

- **Outbound**: Node stdlib only (`node:child_process`, `node:timers/promises`, `node:os`).
- **Inbound**: 4 of 7 packages consume it via `workspace:*`:
  - `pi-bfs`, `pi-git`, `pi-ripgrep`, `pi-task-runner`.
  - `pi-pfs` does **not** use it (uses `fs/promises` directly).
  - `pi-context-preloader` does not use it (no process spawning).

## Module structure

```
src/extension-utils.ts          # 3 exports, 1 file
src/extension-utils.test.ts     # co-located test
```

## Three exports

```ts
// src/extension-utils.ts
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

## Hard rules

- **Must be published to npm** as a runtime dep. Consumers depend on the package name in prod; the `workspace:*` symlink is dev-only.
- **No `pi.extensions` field** — this is a library, not an extension.
- **No tests for `progressiveKill`/`scheduleProcessTimeout` directly** — exercised via consumer tests.

<important if="you are adding a new spawn helper">
1. Add the function to `src/extension-utils.ts` with a typed signature.
2. Add a unit test in `src/extension-utils.test.ts` (mock `child_process` for unit-level tests).
3. Document the signature in this file.
4. Run `pnpm --filter @piotrb/pi-extension-utils run typecheck test`.
</important>
