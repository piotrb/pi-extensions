---
title: working with pi-task-runner
category: architecture
severity: high
tags:
  - pi-task-runner
  - run-tool
  - permissions
  - config-merge
  - tui
  - bash-replacement
applies_when:
  - working on, depending on, or evaluating the pi-task-runner package
  - adding a new permission rule via .pi/runner.json or the /runner slash command
  - debugging a tool_call block or verdict in pi-task-runner
  - reading the package's source to understand a specific behavior
---

# Problem

`pi-task-runner` is the most complex package in the workspace. It replaces bash inside pi's agent loop with a `run` tool that has a layered permission rule system, a JSON config merge, and a TUI editor. Without a single reference for the package's invariants, the agent re-implements the rule matcher, changes the `cmd` parameter shape, or reorders the config merge — each of which breaks a load-bearing contract.

# Context

`pi-task-runner` is the only sanctioned way the agent executes commands. Bash is disabled in the agent loop. The package's design — array `cmd` parameter, layered permission rules, project > user > global config merge — is what makes it the only sanctioned way. Modifying any of these contracts without understanding them breaks the security model.

# Solution

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

# Why this works

- **Array `cmd` removes shell parsing as an attack surface.** The first element is the binary, the rest is argv. No `;`, `&&`, `|`, or backticks can be smuggled in. The permission matcher sees a structured list, not a freeform string.
- **Layered config with project > user > global means the project's rules win.** A team can lock down a project with `.pi/runner.json` and the user's personal config can't override it. The merge order is the trust hierarchy.
- **`undecided` is a fall-through, not a deny.** The matcher walks rules in order; if a rule doesn't apply, the next rule gets a chance. `undecided` collapses at the end of the chain. Treating `undecided` as deny at the matcher level would make every miss a block.
- **TUI editor via `/runner` slash command** lets users add rules interactively without editing JSON by hand. The modal reuses `@earendil-works/pi-tui` components, so the editor is consistent with the rest of pi's TUI.

# Prevention

- **Do not change the `cmd` parameter to a string.** The array form is non-negotiable. The array is what removes shell parsing as an attack surface; a string would put it back.
- **Do not bypass the permission check by going around `checkRules`.** Every command the agent runs must go through the check. The check is the only thing standing between a malicious prompt and `rm -rf /`.
- **Do not import the `src/lib/` helpers from another package.** They are package-internal. The extension entry is the only consumer.
- **Do not reorder the config merge order.** The order is load-bearing. Project > user > global is the trust hierarchy; reordering it changes the trust model.
- **Do not change the verdict enum.** `"undecided"` is a fall-through, not a deny. Adding new values or changing semantics breaks the matcher.
- **When adding a new permission rule**: edit `.pi/runner.json` directly, or use the `/runner` slash command. Pattern syntax is documented in `pi-task-runner-permission-pattern`.
- **When adding a new internal helper**: place it under `src/lib/`. Do not export the helpers.
- **This solution does not cover the permission pattern syntax** — see `pi-task-runner-permission-pattern` (the area skill).
- **This solution does not cover the canonical `pi-*` package shape** — see `pi-package-scaffold` and `pi-package-hard-rules`.
