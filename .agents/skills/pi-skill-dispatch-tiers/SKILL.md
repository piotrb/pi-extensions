---
name: pi-skill-dispatch-tiers
description: Skills in this project are dispatched in two tiers — core (preloaded unconditionally via @-reference) and conditional (loaded on demand by description). The dispatch index at .agents/learning-index.md is the source of truth for which is which. Use when deciding where a new skill goes, or when auditing the AGENTS.md core list.
---

You are deciding where a new skill belongs, or auditing an existing one's tier assignment. The dispatch system has two tiers and a single source of truth.

## The two tiers

### Core (preloaded unconditionally)

The agent always sees these. They are preloaded by `pi-context-preloader`, which follows `@`-references in `AGENTS.md` core list, then in the loaded files (recursively up to `MAX_DEPTH=5`).

A core skill's entry in `.agents/learning-index.md` carries an `@`-reference on its own line. The preloader pattern matches `@` plus a path with a file extension, and resolves it relative to the file containing the reference. Inside the index (which lives in `.agents/`) the canonical shape is `@` followed by `skills/<name>/SKILL.md`. For example, the `pi-package-scaffold` core entry has the heading followed by a line that starts with `@` and the path `skills/pi-package-scaffold/SKILL.md`. See `learning-management` for the resolution rule and the trap of writing the path project-root-relative (which would resolve to `.agents/.agents/skills/...` and miss).

The `@`-reference is the signal. The preloader follows it; the skill is loaded.

### Conditional (loaded on demand)

The agent sees these by name (via the index entry) and decides whether to load based on the description. If relevant, the agent uses the `read` tool to load from the path derived from the name.

A conditional skill's entry has **no** `@`-reference:

```markdown
### `pi-register-tool`

The canonical `registerTool` pattern for `pi-*` extension packages. Typebox schema
for the input, execute function returning the pi tool protocol. Use when adding
a new tool to a `pi-*` package, or when reviewing a tool's input or output shape.
```

No `@`-reference → not preloaded. The description is the routing signal; the agent reads it and decides.

## The source of truth: `.agents/learning-index.md`

The index is the single place where tier assignments live. The preloader reads the index; the `@`-references it sees tell the preloader what to preload.

`AGENTS.md` core list has just one entry: a single `@`-reference to `.agents/learning-index.md` (project-root-relative, since `AGENTS.md` lives at the root). The transitive `@`-references in the index do the rest. The preloader follows them.

## Criteria

### When a skill is core

- The skill encodes **project-wide hard rules** the agent must always know.
- The skill documents **the build toolchain** that runs every package.
- The skill gives the **monorepo overview** that every agent needs to orient.

### When a skill is conditional (the default)

- The skill is **domain knowledge** (specific to a package or area).
- The skill is **situational** (relevant only in specific scenarios).
- The skill describes a **workflow or pattern** the agent reaches for when needed.
- The skill is **work-in-progress** (not yet stable enough to be core).

**Default to conditional.** Promote to core only when the rule is project-wide and the agent must always know it.

## Promoting a skill to core

Move the `@`-reference into the index entry:

1. Open `.agents/learning-index.md`.
2. Find the skill's `### \`<name>\`` entry.
3. Add `@skills/<name>/SKILL.md` on the line after the heading (the path is relative to the index file itself, which lives in `.agents/`).
4. Verify the `@`-reference resolves to an existing file.

## Demoting a skill to conditional

Remove the `@`-reference from the index entry. The skill remains in the index, with its name and description, but is no longer preloaded.

## What this skill does not do

- It does not own the preloader — that is `pi-context-preloader`'s job. This skill teaches the convention; the preloader enforces it.
- It does not enumerate which skills are core — that is a separate audit. The current assignment is in `.agents/learning-index.md`.
- It does not override the `learning-management` skill's storage and dispatch rules — those are the framework; this skill is project-specific.
