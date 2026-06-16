---
name: pi-task-runner-permission-pattern
description: The permission pattern syntax for the pi-task-runner run tool — pattern shapes, specificity, scope priority, and the undecided verdict semantics. Use when adding or debugging a permission rule in .pi/runner.json, or when working in src/lib/permissions.ts.
---

You are working with the permission rule system inside `pi-task-runner`. This is the area skill for the permission subsystem; read `working-with-pi-task-runner` first for the package overview.

## Pattern syntax

The pattern syntax is unique to `pi-task-runner` and is documented here in full:

```
"git status"              exact match (no wildcard)
"git *"                   prefix match (with space)
"git:*"                   equivalent to "git *"
"pnpm:*"                  equivalent to "pnpm *"
"* --version"             suffix match
"*test*"                  glob — any chars anywhere
"*"                       standalone — match everything
```

Six forms:

- **Exact:** the pattern must match the joined command argv verbatim.
- **Prefix (with space):** `"git *"` matches any command starting with `git `.
- **Prefix (with colon):** `"git:*"` is shorthand for `"git *"`.
- **Suffix:** `"* --version"` matches any command ending with ` --version`.
- **Glob:** `"*test*"` matches any command containing `test` anywhere.
- **Standalone wildcard:** `"*"` matches everything.

## Specificity

Specificity = count of non-wildcard characters. Higher specificity wins.

Examples:

- `"git *"` specificity = 4 (characters: `g`, `i`, `t`, ` `).
- `"git status"` specificity = 10.
- `"*"` specificity = 0.

When multiple rules match a command, the highest-specificity rule wins.

## Scope priority (tie-breaker)

When specificity is tied, scope priority breaks the tie:

```ts
const SCOPE_PRIORITY = { project: 2, user: 1, global: 0 }
```

Project rules beat user rules; user rules beat global rules.

The three scopes are:

```
1. <cwd>/.pi/runner.json             (project, scope priority 2)
2. ~/.pi/runner.json                 (user, scope priority 1)
3. ~/.pi/agent/runner.json           (global, scope priority 0)
```

## Verdict enum

```ts
function checkRules(cmd: string[], rules: Rule[]): "allow" | "ask" | "deny" | "undecided"
```

- **`"allow"`** — the command is permitted; the runner executes it.
- **`"ask"`** — the runner prompts the user; execution depends on the user's response.
- **`"deny"`** — the command is blocked; the runner returns a denied result.
- **`"undecided"`** — no rule matched; fall through to the next layer or the default policy.

**`"undecided"` is not a deny.** It is a fall-through signal. If all three scope layers return `"undecided"`, the default policy from the config schema applies.

## Config merge

The merge logic in `src/lib/runner-config.ts`:

```ts
const project = await readJson(path.join(cwd, ".pi/runner.json"))
const user = await readJson(path.join(os.homedir(), ".pi/runner.json"))
const global = await readJson(path.join(os.homedir(), ".pi/agent/runner.json"))
return mergeRules([global, user, project]) // argument order = precedence (project wins)
```

**The merge order is load-bearing.** `mergeRules` is order-sensitive. Do not reorder the argument list; project precedence depends on the order.

## Pattern matching is for the `run` tool only

The pattern system gates `cmd: string[]` arguments for the `run` tool. It does **not** gate other tools (`read`, `write`, `edit`, `git_*`, `pfs_*`, etc.). Tool-level permissions are handled by the `pi-permission-system` extension, which is a separate runtime. The two coexist: the runner's rules gate command execution; the extension's rules gate tool invocation.

## When to add a new pattern syntax

1. Add the new case to `patternToRegex(pattern)` in `src/lib/permissions.ts`.
2. Add unit tests to `permissions.test.ts` — verify both the regex and the specificity.
3. Document the new syntax in the table above.
4. Run `pnpm --filter @piotrb/pi-task-runner run typecheck test`.

## What you do not do

- Do not change the verdict enum. The four values are part of the contract.
- Do not import the `src/lib/` helpers from another package. They are internal.
- Do not change the merge order. The order is load-bearing.
- Do not add a default-deny fallback at the matcher level. The fall-through is to the config's default policy, not to deny.

## What this skill does not do

- It does not cover the package overview — see `working-with-pi-task-runner`.
- It does not cover the canonical `pi-*` package shape — see `pi-package-scaffold`.
