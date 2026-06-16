---
name: pi-register-tool
description: The canonical registerTool pattern for pi-* extension packages — typebox schema for the input, execute function returning the pi tool protocol. Use when adding a new tool to a pi-* package, or when reviewing a tool's input/output shape.
---

You add a new tool to a `pi-*` extension package. The tool is a structured operation the agent invokes by name, with typed input and streaming or batched output.

## The shape

Every tool follows this canonical pattern. The five elements are non-negotiable.

### 1. Name

The `name` is what the agent calls. Choose a verb-led name that disambiguates from related tools — `git_status`, `pfs_unlink`, `bfs`. Tool names within a package are unique.

### 2. Description

The `description` is what the LLM reads to decide whether to call the tool. Write it from the LLM's perspective — what does the tool do, when should the agent reach for it, what does the output look like. The description is the routing signal; the parameters schema is the contract.

### 3. Parameters

The `parameters` is a typebox `Type.Object({...})`. Required fields are bare, optional ones use `Type.Optional(...)`. Use `Type.Array(Type.String())` for path lists, `Type.Boolean()` for flags, `Type.Number()` for counts.

```ts
import { Type } from "typebox"

parameters: Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  glob: Type.Optional(Type.String()),
  ignoreCase: Type.Optional(Type.Boolean()),
  maxCount: Type.Optional(Type.Number()),
})
```

### 4. Execute

The `execute` function is the work. Three implementations patterns, in order of preference:

- **Spawn a process** via `spawnStreaming` from `@piotrb/pi-extension-utils` — for tools that wrap an external CLI (`rg`, `git`, `bfs`). Returns an async generator of `{ stream, chunk }`; collect stdout for the result.
- **Call `fs/promises`** directly — for atomic filesystem operations (`unlink`, `rename`, `cp`). For this pattern, see `pi-fs-tools`.
- **Compute in-process** — for tools that don't touch the filesystem or spawn anything (rare; usually lifecycle hooks are a better fit, see `pi-lifecycle-hooks`).

### 5. Return the pi tool protocol

The execute function returns the shape pi expects:

```ts
return {
  content: [{ type: "text", text: stdoutOrErrorString }],
}
```

- `content` is an array; multiple items are valid but the common case is one.
- `text` is a string. Streaming tools return the collected stdout; non-streaming tools return the formatted result.
- Errors are **strings in the result**, not thrown — unless the failure is structural (input validation, `ENOENT` for `fs/promises` tools, which propagate). For spawn-based tools, the streaming wrapper captures the exit code and the agent sees non-zero exit as a non-zero result.

## The wrapper

The canonical entry file:

```ts
import { Type } from "typebox"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "tool_name",
    description: "What the LLM needs to know to call this",
    parameters: Type.Object({
      /* typebox schema */
    }),
    execute: async (_id, params, _ctx) => {
      // spawn a process OR call fs/promises, return { content: [{ type: "text", text }] }
    },
  })
}
```

`name` is what the agent calls. The `pi.extensions` path is how pi _loads_ the file. These can differ (`pi-ripgrep` loads `ripgrep.ts` but registers as `name: "ripgrep"`).

## Multiple tools in one file

When a package registers more than one tool in a single entry file, the loop pattern applies — see `pi-multi-tool-package`.

## Common pitfalls

- **Bare fields in typebox** — required is bare, optional is `Type.Optional(...)`. A bare required field that should be optional is a common bug.
- **`content` is an array, not a string** — easy to forget the array wrap; the runtime expects `content: [{...}]`.
- **Errors as strings, not thrown** — for spawn-based tools. Throwing interrupts the agent's turn unexpectedly; a non-zero result string is the protocol.
- **`ctx.cwd` is the session's working directory** — most tools take an optional `cwd: Type.Optional(Type.String())` that defaults to `ctx.cwd` if absent.
- **No native bindings** — all process work goes through `spawnStreaming` or `fs/promises`. Do not use `child_process.spawn` directly; do not use `shelljs` or `execa`.

## What this skill does not do

- It does not cover tools that hook lifecycle events — see `pi-lifecycle-hooks`.
- It does not cover atomic filesystem tools that use `fs/promises` directly — see `pi-fs-tools`.
- It does not cover the package shell (`package.json`, `tsconfig.json`, etc.) — see `pi-package-scaffold`.
