---
title: pi-task-runner permission pattern (syntax, specificity, scope priority, undecided semantics)
category: architecture
severity: high
tags:
  - pi-task-runner
  - permissions
  - pattern-syntax
  - specificity
  - scope-priority
  - verdict
  - undecided
  - config-merge
  - runner.json
applies_when:
  - adding or debugging a permission rule in .pi/runner.json
  - working in src/lib/permissions.ts (patternToRegex, checkRules)
  - writing a new pattern syntax form (the table has six forms; adding a seventh)
  - debugging a verdict (allow/ask/deny/undecided) and tracing why a specific rule won
  - implementing a custom runner that consumes the same config
  - understanding why one rule beats another (specificity, scope priority)
---

# Problem

`pi-task-runner` has a permission pattern language with six forms, a specificity rule, a scope-priority tie-breaker, and a verdict enum that includes a non-obvious `"undecided"` value (a fall-through, not a deny). Without a single reference for the permission subsystem, the agent invents its own mental model — usually treating `"undecided"` as a deny, miscomputing specificity, or reordering the merge. Each of these breaks the trust model.

This solution covers the area-skill of the permission subsystem. The package overview (the `run` tool, the TUI editor, the layered config) is in `working-with-pi-task-runner`; the `pi-*` package shape (canonical layout, hard rules) is in `pi-package-scaffold` and `pi-package-hard-rules`.

# Context

The permission pattern language is unique to `pi-task-runner`. It is not a regex, glob, or minimatch — it is a small DSL with six forms documented in the table below. The matcher's behavior is fully defined by the combination of pattern form, specificity calculation, scope priority, and the verdict enum's semantics. Changing any of these (the table, the formula, the priority numbers, the enum) breaks the contract.

# Solution

## Pattern syntax (six forms)

The pattern syntax has six forms:

| Form                    | Example         | Specificity (non-wildcard chars)                      |
| ----------------------- | --------------- | ----------------------------------------------------- |
| **Exact**               | `"git status"`  | 10 (the whole string)                                 |
| **Prefix (with space)** | `"git *"`       | 4 (`g`, `i`, `t`, ` `)                                |
| **Prefix (with colon)** | `"git:*"`       | 3 (`g`, `i`, `t`; equivalent to `"git *"`)            |
| **Suffix**              | `"* --version"` | 10 (` `, `-`, `-`, `v`, `e`, `r`, `s`, `i`, `o`, `n`) |
| **Glob**                | `"*test*"`      | 4 (`t`, `e`, `s`, `t`)                                |
| **Standalone wildcard** | `"*"`           | 0                                                     |

Forms at a glance:

- **Exact** — the pattern must match the joined command argv verbatim.
- **Prefix (with space)** — `"git *"` matches any command starting with `git `.
- **Prefix (with colon)** — `"git:*"` is shorthand for `"git *"`. The colon is a separator, not a wildcard.
- **Suffix** — `"* --version"` matches any command ending with ` --version`.
- **Glob** — `"*test*"` matches any command containing `test` anywhere.
- **Standalone wildcard** — `"*"` matches everything.

## Specificity

`Specificity = count of non-wildcard characters. Higher specificity wins.`

The wildcards are `*` and the colon-prefix separator. Everything else counts. When multiple rules match a command, the highest-specificity rule wins.

Examples:

- `"git *"` specificity = 4 (characters: `g`, `i`, `t`, ` `).
- `"git status"` specificity = 10.
- `"*"` specificity = 0.

## Scope priority (tie-breaker)

When specificity is tied, scope priority breaks the tie:

```ts
const SCOPE_PRIORITY = { project: 2, user: 1, global: 0 }
```

The three scopes are:

```
1. <cwd>/.pi/runner.json             (project, scope priority 2)
2. ~/.pi/runner.json                 (user, scope priority 1)
3. ~/.pi/agent/runner.json           (global, scope priority 0)
```

Project rules beat user rules; user rules beat global rules. The numbers are the contract — changing them changes the trust model.

## Verdict enum

```ts
function checkRules(cmd: string[], rules: Rule[]): "allow" | "ask" | "deny" | "undecided"
```

The four values:

- **`"allow"`** — the command is permitted; the runner executes it.
- **`"ask"`** — the runner prompts the user; execution depends on the user's response.
- **`"deny"`** — the command is blocked; the runner returns a denied result.
- **`"undecided"`** — no rule matched; fall through to the next layer or the default policy.

**`"undecided"` is not a deny.** It is a fall-through signal. If all three scope layers return `"undecided"`, the default policy from the config schema applies (typically `"ask"`, not `"deny"`).

## Config merge

The merge logic in `src/lib/runner-config.ts`:

```ts
const project = await readJson(path.join(cwd, ".pi/runner.json"))
const user = await readJson(path.join(os.homedir(), ".pi/runner.json"))
const global = await readJson(path.join(os.homedir(), ".pi/agent/runner.json"))
return mergeRules([global, user, project]) // argument order = precedence (project wins)
```

**The merge order is load-bearing.** `mergeRules` is order-sensitive. Do not reorder the argument list; project precedence depends on the order. The argument list is the trust hierarchy: global (lowest), user, project (highest).

## Pattern matching is for the `run` tool only

The pattern system gates `cmd: string[]` arguments for the `run` tool. It does **not** gate other tools (`read`, `write`, `edit`, `git_*`, `pfs_*`, etc.). Tool-level permissions are handled by the `pi-permission-system` extension, which is a separate runtime. The two coexist: the runner's rules gate command execution; the extension's rules gate tool invocation.

The `working-with-pi-tool-policy` solution covers the extension's aspect-rules system. The two systems are not interchangeable — a `"deny"` in `runner.json` does not block a `read` tool call, and a mode-deny in the extension does not block a `run` tool call.

## When to add a new pattern syntax

When the six forms are insufficient (e.g. you need a regex form, a tag form, or a multi-arg form), the workflow is:

1. **Add the new case to `patternToRegex(pattern)` in `src/lib/permissions.ts`.** The function takes a pattern string and returns a `RegExp` that matches a joined `cmd` argv. New forms add a new branch in the `if/else` chain.
2. **Add unit tests to `permissions.test.ts`** — verify both the regex and the specificity. The specificity count is the trickier part; the new form may count wildcards or not, depending on the semantics.
3. **Document the new syntax in the table above.** The table is the source of truth; the test enforces one example per form.
4. **Run `pnpm --filter @piotrb/pi-task-runner run typecheck test`.** The check covers the new code + the new test.
5. **Update the `applies_when` field** on this solution to mention the new form (so future grep matches surface this doc).

# Why this works

- **Specificity is a single integer per rule.** A simple count of non-wildcard characters is enough to disambiguate. The formula is deterministic, testable, and short. The alternative (regex-equivalent specificity) would be undecidable.
- **The verdict enum's `"undecided"` is a fall-through, not a deny.** This is the load-bearing distinction. A user can write `"*"` in global config and `"git *"` in project config; the matcher walks rules and returns `"undecided"` for the global wildcard only when no project rule matches. Treating `"undecided"` as deny at the matcher level would make the global `"*"` block every command that no project rule mentions — the opposite of the intent.
- **The merge order is the trust hierarchy.** Project > user > global means the team can lock down a project with `.pi/runner.json` and the user's personal config cannot override it. The argument order to `mergeRules` is the trust model; reordering changes the trust model.
- **Six forms cover the common cases.** Exact, prefix (with space or colon), suffix, glob, and standalone wildcard. The grammar is small enough to fit in one table; new forms need explicit justification.

# Prevention

- **Do not change the verdict enum.** The four values are part of the contract. `"undecided"` is a fall-through, not a deny. Adding new values or changing semantics breaks the matcher.
- **Do not change the specificity formula.** Non-wildcard character count is the contract. Adding per-form multipliers or making the formula configurable breaks the disambiguation.
- **Do not change the scope priority numbers.** `project: 2, user: 1, global: 0` is the contract. Renaming, reordering, or making the priority configurable breaks the trust model.
- **Do not import the `src/lib/` helpers from another package.** They are internal. The extension entry is the only consumer.
- **Do not change the merge order.** The order is load-bearing. Project > user > global is the trust hierarchy; reordering it changes the trust model.
- **Do not add a default-deny fallback at the matcher level.** The fall-through is to the config's default policy, not to deny. A default-deny at the matcher level would make every non-matching command a block.
- **Do not extend the pattern language to other tools.** The pattern system is for the `run` tool's `cmd: string[]` only. Other tools use the `pi-permission-system` extension's aspect rules (see `working-with-pi-tool-policy`).

# Verification

- **Pattern syntax coverage** is enforced by `permissions.test.ts` — one test per form (exact, prefix-space, prefix-colon, suffix, glob, standalone).
- **Specificity disambiguation** is tested explicitly: a more-specific rule wins over a less-specific rule for the same command.
- **Scope priority** is tested by writing a global `"*"`-allow and a project-specific deny; the project deny wins.
- **Verdict enum** is tested with all four values; the `"undecided"` test asserts it falls through to the next layer, not to a deny.
- **Merge order** is tested by constructing three configs (global, user, project) and asserting that the project's rule wins on conflict.

# Related

- `working-with-pi-task-runner` — package overview, including the `run` tool, the TUI editor, and the high-level merge order.
- `working-with-pi-tool-policy` — the `pi-permission-system` extension's aspect rules, which gate other tools (`read`, `write`, `edit`, `git_*`, `pfs_*`).
- `pi-tool-call-load-order-first-wins` — when `pi-do-it-right` and `pi-tool-policy` both register a `tool_call` handler, the order determines which fires first.
- `pi-package-hard-rules` — the cross-cutting invariants for any `pi-*` package; the permission subsystem is one of the load-bearing contracts.
