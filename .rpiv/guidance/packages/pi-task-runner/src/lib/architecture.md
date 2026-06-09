# pi-task-runner/src/lib/

Internal helpers for the `run` tool. Pattern matching, config loading, TUI modal. Not exported, not shipped (`pi.extensions` only references `src/extensions/*`).

## Layer responsibility

Three modules supporting the `task-runner.ts` extension entry:

- **`permissions.ts`** — pattern-based rule matching with three verdict levels.
- **`runner-config.ts`** — loads + merges rules from three JSON files (project > user > global).
- **`runner-modal.ts`** — TUI rule editor (uses `@earendil-works/pi-tui`).

## Dependencies

- **Outbound**: `node:os` (homedir), `node:path` (resolve/join/relative), `typebox` (schemas), `@earendil-works/pi-tui` (modal components), `minimist` (arg parsing).
- **Inbound**: only `src/extensions/task-runner.ts`. No other package consumes these.

## Module structure

```
src/lib/permissions.ts            # checkRules, patternToRegex, specificity
src/lib/permissions.test.ts       # co-located test
src/lib/runner-config.ts          # loadRules, writeRuleToFile, removeRuleFromFile
src/lib/runner-modal.ts           # openRunnerModal
```

## Pattern syntax (UNIQUE — exhaustively documented here)

```
"git status"              exact match (no wildcard)
"git *"                   prefix match (with space)
"git:*"                   equivalent to "git *"
"pnpm:*"                  equivalent to "pnpm *"
"* --version"             suffix match
"*test*"                  glob — any chars anywhere
"*"                       standalone — match everything
```

### Specificity & scope priority

- **Specificity** = count of non-wildcard characters. Higher wins.
- **Ties broken by scope**: project > user > global.

```ts
const SCOPE_PRIORITY = { project: 2, user: 1, global: 0 }
```

### Verdict enum

```ts
function checkRules(cmd: string[], rules: Rule[]): "allow" | "ask" | "deny" | "undecided"
// "undecided" means no rule matched — falls through to the next layer / default policy
```

`undecided` is **not a deny** — it's a fall-through signal. If all three layers return `undecided`, the default policy (in the config schema) applies.

## Config loader

```ts
// src/lib/runner-config.ts
const project = await readJson(path.join(cwd, ".pi/runner.json"))
const user = await readJson(path.join(os.homedir(), ".pi/runner.json"))
const global = await readJson(path.join(os.homedir(), ".pi/agent/runner.json"))
return mergeRules([global, user, project]) // argument order = precedence (project wins)
```

The merge order is load-bearing — `mergeRules` is order-sensitive, do not reorder.

## TUI modal

The modal is a `@earendil-works/pi-tui` component, not a standalone screen. It mutates the config file in place on save.

## Hard rules

- **These modules are internal to `pi-task-runner`** — do not import them from other packages.
- **`"undecided"` is not a deny** — it's a fall-through signal to the next rule.
- **Pattern matching is for the `run` tool only** — tool-level permissions (read/write/edit/etc.) are handled by the `pi-permission-system` extension, separate from this rule system.

<important if="you are adding a new pattern syntax">
1. Add the new case to `patternToRegex(pattern)` in `permissions.ts`.
2. Add unit tests to `permissions.test.ts` (verify both the regex and the specificity).
3. Document the new syntax in the table above.
4. Run `pnpm --filter @piotrb/pi-task-runner run typecheck test`.
</important>
