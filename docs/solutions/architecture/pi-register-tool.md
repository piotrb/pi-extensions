---
title: pi registerTool pattern
category: architecture
severity: high
tags:
  - pi-runtime
  - extension-api
  - tool-registration
  - typebox
  - tool-protocol
applies_when:
  - adding a new tool to a pi-* extension package
  - reviewing a tool's input/output shape for conformance
  - choosing between registerTool, lifecycle hooks, or fs/promises for a new package
  - debugging why a tool's parameters don't validate or the result is malformed
---

# Problem

When adding a new tool to a `pi-*` extension package, the agent needs the canonical `registerTool` pattern: a typebox schema for the input, an execute function that returns the pi tool protocol, and the conventions that keep the result shape consistent across packages. Without a single reference for what the tool API expects, every new tool reinvents the shape (often with the same bugs — bare fields that should be optional, missing `content` array wrap, errors thrown when they should be returned as strings).

# Context

The `pi.registerTool` API is one of two paths a `pi-*` extension can take; the other is `pi.on(...)` lifecycle hooks. Tools are structured operations the agent invokes by name with typed input and batched or streaming output. Lifecycle hooks observe or mutate the agent's behavior; tools do work. A single package can do both (e.g. `pi-tool-policy` registers tools AND hooks `tool_call`), but each registration follows its own pattern. This solution covers the tool path; the lifecycle path is in `pi-lifecycle-hooks`.

# Solution

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

# Why this works

- **The five elements are a contract.** `name` and `description` are the LLM's view; `parameters` is the typebox schema that pi validates against; `execute` is the work; the return shape is the protocol pi parses. Skipping any element produces a tool the agent can't call, or that returns a shape pi doesn't render.
- **Errors as strings keep the agent in flow.** Throwing interrupts the agent's turn unexpectedly; a non-zero result string is the protocol the agent already knows how to handle. For structural errors (input validation, `ENOENT`), throwing is fine — those are conditions the agent should not be in.
- **`ctx.cwd` is the session's working directory.** Most tools take an optional `cwd: Type.Optional(Type.String())` that defaults to `ctx.cwd` if absent. This is the contract between the tool and the session's filesystem state.
- **No native bindings** — all process work goes through `spawnStreaming` or `fs/promises`. Direct `child_process.spawn`, `shelljs`, or `execa` calls bypass the streaming wrapper and break the result shape.

# Prevention

- **Bare fields in typebox** — required is bare, optional is `Type.Optional(...)`. A bare required field that should be optional is a common bug; the LLM refuses to call the tool without the value, even when the tool would handle the absence correctly.
- **`content` is an array, not a string** — easy to forget the array wrap; the runtime expects `content: [{...}]` and renders the array as the tool's output. A bare string produces a malformed result.
- **Errors as strings, not thrown** — for spawn-based tools. Throwing interrupts the agent's turn unexpectedly; a non-zero result string is the protocol. The LLM knows how to react to a result string; it doesn't know how to react to a thrown error.
- **`ctx.cwd` is the session's working directory** — most tools take an optional `cwd: Type.Optional(Type.String())` that defaults to `ctx.cwd` if absent. Don't hardcode paths.
- **No native bindings** — all process work goes through `spawnStreaming` or `fs/promises`. Do not use `child_process.spawn` directly; do not use `shelljs` or `execa`. The streaming wrapper captures the exit code; bypassing it loses that.
- **This solution does not cover tools that hook lifecycle events** — see `pi-lifecycle-hooks`.
- **This solution does not cover atomic filesystem tools that use `fs/promises` directly** — see `pi-fs-tools`.
- **This solution does not cover the package shell** (`package.json`, `tsconfig.json`, etc.) — see `pi-package-hard-rules` and `pi-package-scaffold`.
