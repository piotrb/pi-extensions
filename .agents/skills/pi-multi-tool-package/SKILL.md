---
name: pi-multi-tool-package
description: When a pi-* package registers multiple related tools in a single entry file, use the TOOLS array + loop pattern from pi-git. Use when adding a new tool to a package that already has a tools table, or when designing a new multi-tool package.
---

You add a new tool to a `pi-*` extension package that already has multiple tools in one file, or you are designing a new package that will register several related tools.

## The pattern

Multiple related tools in one file use a `TOOLS` table + descriptions + schemas + executor factory. Each tool is registered in a loop. The pattern is from `pi-git` (9 git subcommands in one file) and `pi-pfs` (4 filesystem operations in one file).

```ts
const TOOLS = ["status", "add", "rm", "mv", "diff", "restore", "commit", "log", "push"] as const

for (const t of TOOLS) {
  pi.registerTool({
    name: `git_${t}`,
    description: GIT_DESCRIPTIONS[t],
    parameters: GIT_SCHEMAS[t],
    execute: makeExecutor(t),
  })
}
```

The four supporting tables, all keyed by the same `TOOLS` array (or a related constant):

- `TOOLS` — the list of tool names, typed `as const` for narrow string types.
- `<NAME>_DESCRIPTIONS` — the LLM-facing description for each tool.
- `<NAME>_SCHEMAS` — the typebox input schema for each tool.
- `makeExecutor(tool)` — factory that returns the `execute` function for a given tool.

## When to use this pattern

Use it when:

- The tools are **subcommands of the same underlying CLI** (`git status`, `git add`, `git commit`).
- The tools are **the same kind of operation on different targets** (`pfs_unlink`, `pfs_rmdir`, `pfs_cp`, `pfs_mv`).
- The tools share **input validation, error handling, or output formatting** logic.
- The package's value is in **covering a domain, not in a single tool**.

Do not use it when:

- The tools are **unrelated operations** that happen to live in the same package (use separate `registerTool` calls).
- The tools have **wildly different parameter shapes** (the loop pattern's value is uniformity).

## The shape, in detail

### TOOLS array

```ts
const TOOLS = ["status", "add", "rm", "mv"] as const
type ToolName = (typeof TOOLS)[number]
```

`as const` makes the array's element type `readonly ["status", "add", "rm", "mv"]`, which means `TOOLS[number]` is the union `"status" | "add" | "rm" | "mv"`. The schemas and descriptions tables are then typed as `Record<ToolName, ...>`.

### Schemas table

```ts
const GIT_SCHEMAS: Record<ToolName, TObject> = {
  status: Type.Object({}),
  add: Type.Object({
    paths: Type.Array(Type.String()),
    cwd: Type.Optional(Type.String()),
  }),
  rm: Type.Object({
    paths: Type.Array(Type.String()),
    cwd: Type.Optional(Type.String()),
  }),
  // ...
}
```

### Descriptions table

```ts
const GIT_DESCRIPTIONS: Record<ToolName, string> = {
  status: "Show the working tree status",
  add: "Add file contents to the index",
  rm: "Remove files from the working tree and the index",
  // ...
}
```

The description is the routing signal — the LLM reads it to decide which tool to call.

### Executor factory

```ts
function makeExecutor(tool: ToolName) {
  return async (_id: string, p: Static<(typeof GIT_SCHEMAS)[ToolName]>, _ctx: Context) => {
    // branch on `tool` for subcommand-specific argument handling
    return { content: [{ type: "text", text: stdout }] }
  }
}
```

The factory is a closure over `tool`, so each `execute` function knows which subcommand it implements. For tools with identical shapes, the factory is a thin wrapper; for tools with distinct shapes, the factory branches internally.

## When to use a flat structure (no loop)

`pi-pfs` registers 4 tools with separate `pi.registerTool` calls, no loop. The four tools share little structure beyond input validation. Use the flat structure when the loop's uniformity tax exceeds its DRY value.

## Common pitfalls

- **Forgetting `as const` on the TOOLS array** — without it, the element type widens to `string`, and the schema/description tables lose their `Record<ToolName, ...>` typing.
- **Mismatched keys** — if `TOOLS` has `"mv"` but `SCHEMAS` has `"rename"`, the type system catches it; if you bypass the type system with `as any`, the runtime silently skips the missing tools.
- **One tool that breaks the pattern** — if a new tool has a wildly different shape, the loop pattern forces awkward branching inside `makeExecutor`. Better to extract it as a separate `registerTool` call.

## What this skill does not do

- It does not cover the single-tool case — see `pi-register-tool`.
- It does not cover the package shell (`package.json`, `tsconfig.json`, etc.) — see `pi-package-scaffold`.

## Related

- `pi-register-tool`
- `pi-package-scaffold`
