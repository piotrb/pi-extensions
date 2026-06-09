# pi-pfs

4 filesystem tools (pfs_unlink, pfs_rmdir, pfs_cp, pfs_mv) in one file. **Does not use `pi-extension-utils`** — uses `node:fs/promises` directly because these are atomic operations, not subprocess spawns.

## Layer responsibility

Safe, typed filesystem operations for the agent. Replaces `rm`/`mv`/`cp`/`rmdir` bash invocations with structured tools. Path validation rejects absolute paths and `..` escapes at the boundary.

## Dependencies

- **Outbound**: Node stdlib (`node:fs/promises`, `node:path`). No `pi-extension-utils`, no `minimist`.
- **Inbound**: pi-runtime.

## Module structure

```
src/extensions/pfs.ts            # 4 registerTool calls
src/extensions/pfs.test.ts       # co-located test (uses tempdir)
```

## The "no spawn" exception

```ts
// src/extensions/pfs.ts — uses fs/promises directly
import { unlink, rm, cp, rename } from "node:fs/promises"

// pfs_unlink: await unlink(rel)
// pfs_rmdir:  await rm(rel, { recursive: true })
// pfs_cp:     await cp(src, dst, { recursive: true })
// pfs_mv:     await rename(src, dst)
```

This is the **only** tool package that does not use `pi-extension-utils`. The reason: no child process, no streaming, no signal handling — atomic fs calls.

## Tool input shape

```ts
// pfs_unlink(path: string) — single path
Type.Object({ path: Type.String() })

// pfs_rmdir(path: string, recursive?: boolean)
Type.Object({
  path: Type.String(),
  recursive: Type.Optional(Type.Boolean()),
})

// pfs_cp(src: string, dest: string) and pfs_mv(src: string, dest: string)
Type.Object({ src: Type.String(), dest: Type.String() })
```

## Error handling

Unlike `pi-git` (where errors are exit codes captured in stdout), `pfs_*` tools **let `fs/promises` errors throw** — `ENOENT`, `EEXIST`, `EACCES` propagate to pi's tool result as thrown errors.

## Hard rules

- **All paths must be relative to the project root** — absolute paths and `..` escapes are rejected at the boundary.
- **Use `pfs_*` tools from the agent loop**, never `rm`/`mv`/`cp` via bash.

<important if="you are adding a new filesystem tool">
1. Add a new `pi.registerTool({...})` call in `pfs.ts`.
2. Define the typebox input schema (single path, paired paths, or path + flags).
3. Implement `execute` by awaiting a `fs/promises` function — do not spawn a subprocess.
4. Validate paths are relative to `ctx.cwd` and reject `..` escapes.
5. Add a test using a tempdir (vitest's `beforeEach` / `afterEach`).
6. Run `pnpm --filter @piotrb/pi-pfs run typecheck test`.
</important>
