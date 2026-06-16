---
name: working-with-pi-task-runner
description: Core facts about the pi-task-runner package — the run tool that replaces bash inside pi's agent loop, with a layered permission rule system. Use when working on, depending on, or evaluating the pi-task-runner package.
---

You are working on, depending on, or evaluating the `pi-task-runner` package. It is the most complex package in the workspace — a tool extension with internal `src/lib/` helpers, a layered permission rule system, and a TUI editor.

## What the package does

Replaces bash inside pi's agent loop. The `run` tool takes a `cmd: string[]` array (not a freeform shell string), validates against a permission rule system loaded from JSON config, streams output with default truncation. The package also exposes a `/runner` slash command for a TUI rule editor.

## Core rules

- **The `run` tool is the only sanctioned way the agent executes commands.** Bash is disabled in the agent loop. Every command the agent runs goes through this tool's permission check first.
- **`cmd` is an array, not a freeform string.** No shell parsing, no glob expansion by the shell — the runner invokes the first element as the binary, the rest as argv.
- **Permission verdict enum:** `"allow" | "ask" | "deny" | "undecided"`. The `undecided` value is **not a deny** — it is a fall-through signal to the next rule layer.
- **Permission layers are merged in this order (last wins):** global < user < project. The merge order is load-bearing; do not reorder the merge.

## Module structure

```
packages/pi-task-runner/
  src/extensions/task-runner.ts        # run tool entry + slash command registration
  src/extensions/task-runner.test.ts   # co-located test
  src/lib/permissions.ts               # checkRules, pattern matching
  src/lib/permissions.test.ts          # co-located test
  src/lib/runner-config.ts             # config loading + merging
  src/lib/runner-modal.ts              # TUI rule editor
```

The only package in the workspace with `src/lib/`. The internal helpers are not exported; only `src/extensions/task-runner.ts` consumes them.

## The `run` tool

The canonical shape (see `pi-register-tool` for the full pattern):

```ts
pi.registerTool({
  name: "run",
  description: "Execute a command with permission checks",
  parameters: Type.Object({
    cmd: Type.Array(Type.String()), // ["pnpm", "run", "test"]
    cwd: Type.Optional(Type.String()),
  }),
  execute: async (_id, p, ctx) => {
    const verdict = checkRules(p.cmd, loadRules()) // see src/lib/
    if (verdict === "deny") return denyResult(p.cmd)
    if (verdict === "ask") return askResult(p.cmd)
    return streamResult(spawnStreaming(p.cmd[0], p.cmd.slice(1), { cwd: p.cwd }))
  },
})
```

Output streams in real time with default truncation (ctrl+o to expand).

## Layered config resolution (project > user > global)

```
1. <cwd>/.pi/runner.json             (project, wins on conflict)
2. ~/.pi/runner.json                 (user)
3. ~/.pi/agent/runner.json           (global, lowest priority)
```

The merge + precedence logic lives in `src/lib/runner-config.ts`. The merge order is the argument order to `mergeRules`; **the order is load-bearing, do not reorder**.

## TUI editor via slash command

```ts
pi.registerCommand("runner", {
  description: "Edit permission rules interactively",
  handler: () => openRunnerModal(pi), // modal in src/lib/runner-modal.ts
})
```

Uses `@earendil-works/pi-tui` components: `Container`, `SelectList`, `Text`, `DynamicBorder`.

## Dependencies

- **Outbound:** `@piotrb/pi-extension-utils` (`spawnStreaming`, `progressiveKill`), `minimist`, `typebox`.
- **Inbound:** pi-runtime. No other workspace package depends on `pi-task-runner` — it is leaf-level in the agent loop.

## How to extend it

When adding a new permission rule, edit `.pi/runner.json` (or the appropriate scope) directly:

```json
{ "rules": { "pnpm run *": "allow", "git *": "ask", "rm -rf *": "deny" } }
```

Or use the `/runner` slash command to add it interactively. Pattern syntax is documented in `pi-task-runner-permission-pattern` (the area skill for the permission subsystem).

When adding a new internal helper, place it under `src/lib/`. Do not export the helpers; they are package-internal. The extension entry is the only consumer.

## What you do not do

- Do not change the `cmd` parameter to a string. The array form is non-negotiable.
- Do not bypass the permission check by going around `checkRules`.
- Do not import the `src/lib/` helpers from another package. They are package-internal.
- Do not reorder the config merge order. The order is load-bearing.
- Do not change the verdict enum. `"undecided"` is a fall-through, not a deny.

## What this skill does not do

- It does not cover the permission pattern syntax — see `pi-task-runner-permission-pattern` (the area skill).
- It does not cover the canonical `pi-*` package shape — see `pi-package-scaffold`.
