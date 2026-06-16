---
name: pi-fs-tools
description: When a pi-* extension wraps atomic filesystem operations, use fs/promises directly — no subprocess spawn, no pi-extension-utils. Validate paths are relative to the project root and reject .. escapes at the boundary. Use when designing pfs-style tools or any extension that does atomic fs work.
---

You are designing a `pi-*` extension that wraps atomic filesystem operations — `unlink`, `rename`, `cp`, `rmdir`. These are not subprocess operations. They do not need streaming, signal handling, or process timeouts. The right tool is `node:fs/promises`.

## The pattern

The `pi-pfs` package is the canonical example. Four tools (`pfs_unlink`, `pfs_rmdir`, `pfs_cp`, `pfs_mv`) registered as separate `pi.registerTool` calls, each awaiting a `fs/promises` function:

```ts
import { unlink, rm, cp, rename } from "node:fs/promises"
import { resolve, relative } from "node:path"
import { Type } from "typebox"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

function assertRelative(path: string, cwd: string): string {
  if (path.startsWith("/") || path.startsWith("~")) {
    throw new Error(`path must be relative: ${path}`)
  }
  const abs = resolve(cwd, path)
  const rel = relative(cwd, abs)
  if (rel.startsWith("..") || rel === "..") {
    throw new Error(`path escapes project root: ${path}`)
  }
  return abs
}

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "pfs_unlink",
    description: "Remove a file from the project",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, p, ctx) => {
      const abs = assertRelative(p.path, ctx.cwd)
      await unlink(abs)
      return { content: [{ type: "text", text: `unlinked ${p.path}` }] }
    },
  })

  // pfs_rmdir, pfs_cp, pfs_mv follow the same shape
}
```

## The no-spawn exception

Most tool extensions wrap an external CLI and use `spawnStreaming` from `pi-extension-utils`. **Filesystem tools do not.** The reasons:

- No child process means no streaming output, no signal handling, no exit codes.
- Atomic fs calls are fast (microseconds for `unlink`); the streaming wrapper is overhead.
- The error mode is different: `fs/promises` throws on failure (`ENOENT`, `EEXIST`, `EACCES`); spawn-based tools capture non-zero exit codes as text in the result.

## Path validation

Path validation is the single most important rule for fs-tools. Reject at the boundary:

- **Absolute paths** — `path.startsWith("/")` or `path.startsWith("~")`. The agent should not be able to escape the project root.
- **`..` escapes** — resolve the path, then take the relative path back to `ctx.cwd`. If the relative path starts with `..` or is exactly `..`, the input escaped the project root. Reject.

The `assertRelative` helper above is the canonical implementation. It throws on failure; the throw propagates as the tool result.

### Why validate, not normalize

Validating rejects malformed input. Normalizing would silently accept and re-interpret. The agent should know when its input is wrong, not have it silently rewritten. **Validate, then pass the absolute path to `fs/promises`.**

## Error handling

Unlike spawn-based tools (where non-zero exit codes are returned as text), `fs/promises` errors **propagate as thrown errors**:

- `ENOENT` — file does not exist; the throw reaches pi's tool result as a thrown error.
- `EEXIST` — destination already exists (for `cp`); same propagation.
- `EACCES` — permission denied; same propagation.

Do not catch these and re-string them. The throw is the signal; the LLM sees the error and can correct course.

## When to use this pattern

Use it for:

- Atomic fs operations: `unlink`, `rmdir`, `rename`, `cp`, `stat`, `readFile`, `writeFile`, `readdir`.
- Single-step file mutations.
- Read-only file inspections.

Do not use it for:

- Tools that wrap an external CLI (`rg`, `git`, `bfs`) — those use `spawnStreaming`.
- Tools that need streaming output (large file reads, tail -f) — those are not atomic.
- Tools that compose multiple fs operations in a transaction — those need their own rollback/error model.

## Common pitfalls

- **Skipping path validation** — the agent can pass `/etc/passwd` or `../../../foo`. Always validate.
- **Normalizing instead of validating** — silently rewriting `~/foo` to `/home/user/foo` is wrong; the agent should know.
- **Catching `fs/promises` errors and re-stringing them** — the throw is the signal. Catch only at the very top of the execute function (and only if you have a reason to).
- **Using `path.join` for security** — `path.join` does not prevent escapes. Use `resolve` + `relative` to detect them.

## What this skill does not do

- It does not cover the canonical `registerTool` shape — see `pi-register-tool`.
- It does not cover the package shell (`package.json`, `tsconfig.json`, etc.) — see `pi-package-scaffold`.

## Related

- `pi-register-tool`
- `pi-package-scaffold`
