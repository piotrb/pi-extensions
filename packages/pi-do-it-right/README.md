# @piotrb/pi-do-it-right

A pi extension that intercepts `bash` tool calls and auto-rejects ones that violate a user-supplied ruleset. The gate is an in-process call to `claude-haiku-4-5` — no socket, no server, no DB.

## Install

```sh
pi install @piotrb/pi-do-it-right
```

## Slash commands

`/do-it-right` opens a menu with two entries:

- **Settings** — opens a sub-menu showing the current evaluation model.
  Picking the row opens a model picker; selecting a model saves the
  choice and refreshes the active gate for subsequent bash calls.
- **Test Evaluation** — prompts for a bash command, runs the gate
  against it, and reports the verdict in a notify:
  - `ok:true` → `do-it-right: would allow — <reason>` (info)
  - `ok:false` → `do-it-right: would block — <reason>` (warning)
  - No rules / no auth / evaluate error → notification with the cause.

## Configuration

The gate reads one user-level config file:

```
~/.pi/agent/auto-reject-rules.json
```

Schema (all fields optional; defaults applied on load):

```json
{
  "model": { "provider": "anthropic", "id": "claude-haiku-4-5" }
}
```

Default behavior — without a config file — uses `anthropic/claude-haiku-4-5`.

You can choose any `{provider, id}` pair that pi's `ModelRegistry` knows about.
The gate reuses pi's own model setup — if you can use a model with pi's main
agent loop, you can use it here. Authentication (env var, OAuth, providers
defined in `models.json`, anything else) is handled by pi, not by this
extension. If the configured model is not found, the gate is silently disabled
at session start (strict fail-open).

## Rules file format

Up to four files are read on session start and concatenated in this order:

1. **Bundled** — always present, ships inside the package:
   `<package>/src/extensions/auto-reject-rules.md`. This is the baseline
   starter ruleset. See that file for the current contents.
2. **Global override** — `~/.pi/agent/auto-reject-rules-override.md`. When
   present, it **replaces** the bundled file entirely (not the global or
   project files). Use this to declare your own baseline without forking
   the package.
3. **Global** — `~/.pi/agent/auto-reject-rules.md`. Appends after the
   active baseline.
4. **Project** — `<project>/.pi/auto-reject-rules.md`. Appends after the
   global file. Per-project rules layer on top of the user's baseline.

Final load order when the override file is present:
`override, global, project`.
When it is absent:
`bundled, global, project`.

The file format is plain markdown — a numbered or bulleted list works well, free-form prose also works. The model is told to evaluate the command against the literal rules in the file; there is no DSL. Example:

```md
# Commands that must always be rejected

1. Any `rm -rf` outside the project directory.
2. Any modification of `~/.ssh/`, `~/.aws/`, or `~/.config/gh/`.
3. `chmod 777` on any path.
4. `curl | sh` style installs.
```

Missing files are silently skipped (so a fresh install with no user files
still has the bundled rules applied).

## Writing rules

Each rule is a sentence the model reads. Two shapes are useful:

**1. A rule with an alternative** — the model surfaces the alternative in
its `reason` field. Use this when you want the agent to know what to do
next:

```md
- do not use `cat` to read file contents, use the `read` tool instead.
- do not use `find` to list files, use the `Glob` tool instead.
- do not use `curl` to fetch remote content, use `WebFetch` instead.
```

**2. A rule that just bans** — the model says what was banned and stops:

```md
- any `rm -rf` outside the project directory.
- any modification of `~/.ssh/`, `~/.aws/`, or `~/.config/gh/`.
```

The model is told: "If a rule text includes an alternative, surface it;
if not, name the rule and stop." That keeps the block reason accurate
to the rule that fired, instead of every block hinting at the same
generic alternative. There is no global suffix added to the reason — the
rule is the source of truth for what to do next.

## Load-order caveat

When `@piotrb/pi-do-it-right` is installed alongside any other extension that registers a `tool_call` handler (notably `@piotrb/pi-tool-policy`), **the order in which the extensions load determines who blocks first**. pi's extension API does not expose a priority field for `tool_call` handlers; the runner walks extensions in filesystem order within a scope and in scope order across scopes. **First-block-wins.**

Concretely: if another extension's handler returns `{ block: true, … }` for a given bash command before `do-it-right`'s handler runs, the LLM verdict is **never evaluated**. The user sees the upstream block — not the LLM's reasoning.

The reliable ways to make `do-it-right` run first:

1. Install it in the **project** scope (`.pi/extensions/`) and the other gate in the **user** scope (`~/.pi/extensions/`). Project scope loads after user scope, so `do-it-right` runs first.
2. Or: list `@piotrb/pi-do-it-right` first in the explicit `pi.extensions` array in the consuming project's `package.json`.
3. Or: live with `pi-tool-policy`'s default-deny rules evaluating first. They are stricter than `do-it-right`'s LLM verdict — a command denied by `pi-tool-policy` would generally be denied by an LLM-aware gate as well.

This is a pi-platform limitation. `do-it-right` cannot opt out of "running first" or "always last" from inside the extension.

## Failure mode

The extension is strictly fail-open. Every error path returns `undefined` (no block):

- Configured model not found in pi's `ModelRegistry`
- `completeSimple` rejects (network error, rate limit, no api key, etc.)
- Malformed model response (missing fields, unparseable JSON)
- Unreadable rules file (ENOENT, EACCES, EISDIR)
- Unreadable settings file (ENOENT, EACCES, EISDIR, malformed JSON)
- Non-bash tool calls (filtered out before evaluation)

Auth setup is whatever pi uses. See pi's docs for how to configure providers.

## Development

```sh
pnpm install
pnpm run check
```

## Architecture

See the plan file at `.agents/plans/pi-do-it-right.md` and the workspace learning index at `.agents/learning-index.md`.
