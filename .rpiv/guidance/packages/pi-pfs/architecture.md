# pi-pfs

4 filesystem tools (pfs_unlink, pfs_rmdir, pfs_cp, pfs_mv) in one file. **Does not use `pi-extension-utils`** — uses `node:fs/promises` directly because these are atomic operations, not subprocess spawns.

The "no spawn" exception and the path-validation rules are encoded in `pi-fs-tools`. This file documents the package-specific internals.

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

## Error handling

Unlike `pi-git` (where errors are exit codes captured in stdout), `pfs_*` tools **let `fs/promises` errors throw** — `ENOENT`, `EEXIST`, `EACCES` propagate to pi's tool result as thrown errors.

## Hard rules

- **All paths must be relative to the project root** — absolute paths and `..` escapes are rejected at the boundary.
- **Use `pfs_*` tools from the agent loop**, never `rm`/`mv`/`cp` via bash.
