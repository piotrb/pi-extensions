---
name: pi-package-specific-skill-naming
description: When encoding learnings specific to a single pi-* package, split them into two patterns — working-with-<package> for the core entry point and <package>-<topic> for one specific area within the package. Use when you have package-specific knowledge to encode and you are deciding how to name and structure the skill(s).
---

You have knowledge to encode that is specific to a single `pi-*` package — the kind of thing the LLM's base training does not have because it only emerges from working in this repo. The naming convention splits package-specific learnings into two patterns.

## The two patterns

### Core pattern: `working-with-<package-name>`

Every package with non-trivial conventions gets a `working-with-<package>` skill. It is the agent's first read when working on or with the package.

The skill teaches:

- **What the package does** — the one-line purpose.
- **Core rules** — the hard rules that apply to anyone touching this package. Things like "do not extend" or "must be published to npm as a runtime dep".
- **Module structure** — the high-level shape (`src/extensions/`, `src/lib/`, etc.).
- **How to extend it** — if extending is allowed. If not, say so explicitly.
- **What you do not do** — the package-specific gotchas and out-of-scope actions.

The name is `working-with-pi-<name>` (hyphen-separated, no underscores). Examples:

- `working-with-pi-bfs` — transitional, do not extend, single-tool wrapper shape.
- `working-with-pi-extension-utils` — 3 exports, 4-consumer relationship, must be published.

### Area pattern: `<package-name>-<topic>`

For deep dives into one specific area within the package. The agent reads these when their work crosses into the named area, not for general work in the package.

The name is `<package-name>-<topic>` — no `working-with-` prefix, hyphen between the package and the topic. The topic names something the agent does (a workflow, a subsystem, a constraint), not a noun that hangs in the air:

- `pi-task-runner-permission-pattern` — the permission pattern syntax, verdict enum, specificity.
- `pi-tool-policy-mode-controller` — the mode contract, aspect kinds, most-restrictive-wins.

Bad topic names:

- `pi-task-runner-things` (vague; doesn't say what the skill is about)
- `pi-task-runner-extension` (could mean "extending the task runner", not "the extension aspect")

## Where they live

Both patterns live in `.agents/skills/` — same location as all learnings. There is no structural separation. The naming convention is the only thing that distinguishes core from area.

The package's own README is a separate, human-facing entry point. The skill is the agent-facing encoding. Both can coexist: the skill points at the README for human readers, and the README's content is not duplicated in the skill.

## Tier (core vs conditional)

By the `pi-skill-dispatch-tiers` convention, package-specific skills are **conditional** by default. Domain knowledge is situational; the agent reads it when the work demands it. Only promote a package-specific skill to the core tier if the package is the project's primary subject (rare; would apply if most of the workspace's work is in one package — for this workspace, no such package exists).

## When to create a core skill

Create a `working-with-<package>` skill when **any** of the following is true:

- The package has hard rules that anyone touching it must know.
- The package has a "do not do X" constraint (transitional, deprecated, restricted).
- The package's structure is non-obvious (e.g. `pi-task-runner` has `src/lib/` helpers; `pi-tool-policy` has a `modal/` subfolder; `pi-extension-utils` is a library, not an extension).
- The package has external dependencies or contracts that aren't visible from the source alone (e.g. `pi-extension-utils` must be published to npm).

If none of those apply, do not create a `working-with-<package>` skill. The `pi-package-scaffold` skill already teaches the canonical shape that all `pi-*` packages share; a `working-with-<package>` is for the **delta** from the canonical shape.

## When to create an area skill

Create a `<package-name>-<topic>` skill when **any** of the following is true:

- A subsystem within the package has its own rules or conventions that would bloat the `working-with-<package>` core skill.
- A specific workflow within the package is non-obvious (e.g. how to add a new permission rule, how to add a new mode, how to migrate to a new external dep).
- The package has multiple distinct subsystems that an agent might work on independently.

If the knowledge fits comfortably in the `working-with-<package>` core skill, do not split it out. Area skills are for content that would be a distraction in the core entry point.

## Naming rules

- **Core:** `working-with-pi-<name>` — lowercase, hyphens only, no underscores, no abbreviations.
- **Area:** `<package-name>-<topic>` — lowercase, hyphens only, no underscores. The package name is the full name (`pi-task-runner`, not `task-runner`).
- **Topic:** a verb-led or constraint-led phrase, not a vague noun. `permission-pattern` is good; `things` is not.
- **No colons in frontmatter description** (YAML safety, see `pi-skill-frontmatter-colon-rule`).

## What this skill does not do

- It does not cover workspace-wide learnings (those are at `.agents/skills/` with their own naming; they are not package-specific).
- It does not cover the per-package architecture docs in `.rpiv/guidance/` (those are being phased out; this convention replaces them).
- It does not cover the `pi-hackery` package's specific structure (see `pi-hackery-folder-layout` for that — it follows its own convention because the package itself is a special case).
- It does not cover the workspace-wide scaffolding pattern (see `pi-package-scaffold`).

## Related

- `pi-package-scaffold`
- `pi-read-package-architecture`
- `pi-skill-dispatch-tiers`
