# pi-task-runner

The `run` tool — replaces bash inside pi's agent loop. Takes a `cmd: string[]` array (not a freeform shell string), validates against a permission rule system loaded from JSON config, streams output with default truncation. The most complex package — has internal `src/lib/` helpers.

**Note on permissions:** The `run` tool's rule system is deep and pnpm-specific. For the broader tool-level permission system (covering `read`, `write`, `edit`, `git_*`, `pfs_*`, etc.), a third-party `pi-permission-system` extension is also loaded. The two coexist: the runner's rules gate command execution; the extension's rules gate tool invocation. They serve different layers.

## Layer responsibility

Replace bash with a structured `cmd` array. Apply a layered permission rule system. Stream output. Expose a `/runner` slash command for a TUI rule editor.

## Dependencies

- **Outbound**: `@piotrb/pi-extension-utils` (`spawnStreaming`, `progressiveKill`), `minimist`, `typebox`.
- **Inbound**: pi-runtime. The `run` tool is the only sanctioned way the agent executes commands — bash is disabled.

## Module structure

```
src/extensions/task-runner.ts        # run tool entry + slash command registration
src/extensions/task-runner.test.ts   # co-located test
src/lib/permissions.ts               # checkRules, pattern matching
src/lib/permissions.test.ts          # co-located test
src/lib/runner-config.ts             # config loading + merging
src/lib/runner-modal.ts              # TUI rule editor
```

The only package in the workspace with `src/lib/`. See `src/lib/architecture.md` for the internal helpers.

## The `run` tool

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

The merge + precedence logic lives in `src/lib/runner-config.ts`.

## TUI editor via slash command

```ts
pi.registerCommand("runner", {
  description: "Edit permission rules interactively",
  handler: () => openRunnerModal(pi), // modal in src/lib/runner-modal.ts
})
```

Uses `@earendil-works/pi-tui` components: `Container`, `SelectList`, `Text`, `DynamicBorder`.

## Hard rules

- **The `run` tool is the ONLY way the agent should execute commands.** Bash is disabled.
- **`cmd` is an array, not a freeform string.** No shell parsing, no glob expansion by the shell — the runner invokes the first element as the binary.
- **Permission verdict enum**: `"allow" | "ask" | "deny" | "undecided"`. `undecided` falls through to the next rule layer.

<important if="you are adding a new permission rule">
1. Edit `.pi/runner.json` (or the appropriate scope) directly:
   ```json
   { "rules": { "pnpm run *": "allow", "git *": "ask", "rm -rf *": "deny" } }
   ```
2. Or use the `/runner` slash command to add it interactively.
3. Pattern syntax is documented in `src/lib/architecture.md`.
4. Run `pnpm run check` to confirm nothing else broke.
</important>
