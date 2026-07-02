---
title: pi-package-specific skill naming convention
category: architecture
severity: medium
tags:
  - naming
  - slug
  - solution
  - pi-package
  - frontmatter
applies_when:
  - writing a new package-specific solution under docs/solutions/
  - deciding whether to name it working-with-<package> or <package>-<topic>
  - picking a slug for a new solution in the grep-discoverable system
  - reviewing a slug for clarity, verb-led topic naming, or other convention violations
---

# Problem

When writing a new package-specific solution, the agent needs a naming convention for the slug. The slug is part of the grep-discoverability surface (the agent greps by `tags` and `applies_when`, but a meaningful slug also surfaces in the path and in cross-links). A bad slug (`pi-task-runner-things`) is vague; a good slug (`pi-task-runner-permission-pattern`) tells the agent what the solution is about without reading it.

# Context

The convention was originally written for `.agents/skills/<name>/SKILL.md` slugs (the legacy skill primitive). The substance is still useful for solutions at `docs/solutions/<category>/<slug>.md`: the slug is the first thing the agent sees in a path or a grep result, and a meaningful slug improves discoverability. The convention's role has shifted from "what the agent reads first" (preloader era) to "what gets grepped" (current era), but the slug rules apply the same way.

# Solution

## The two patterns

### Core pattern: `working-with-<package-name>`

Every package with non-trivial conventions gets a `working-with-<package>` solution. It is the agent's first read when working on or with the package.

The solution teaches:

- **What the package does** — the one-line purpose.
- **Core rules** — the hard rules that apply to anyone touching this package. Things like "do not extend" or "must be published to npm as a runtime dep".
- **Module structure** — the high-level shape (`src/extensions/`, `src/lib/`, etc.).
- **How to extend it** — if extending is allowed. If not, say so explicitly.
- **What you do not do** — the package-specific gotchas and out-of-scope actions.

The name is `working-with-pi-<name>` (hyphen-separated, no underscores). Examples:

- `working-with-pi-bfs` — transitional, do not extend, single-tool wrapper shape.
- `working-with-pi-extension-utils` — 3 exports, 4-consumer relationship, must be published.

### Area pattern: `<package-name>-<topic>`

For deep dives into one specific area within the package. The agent greps for these when their work crosses into the named area, not for general work in the package.

The name is `<package-name>-<topic>` — no `working-with-` prefix, hyphen between the package and the topic. The topic names something the agent does (a workflow, a subsystem, a constraint), not a noun that hangs in the air:

- `pi-task-runner-permission-pattern` — the permission pattern syntax, verdict enum, specificity.
- `pi-tool-policy-mode-controller` — the mode contract, aspect kinds, most-restrictive-wins.

Bad topic names:

- `pi-task-runner-things` (vague; doesn't say what the solution is about)
- `pi-task-runner-extension` (could mean "extending the task runner", not "the extension aspect")

## When to create a core solution

Create a `working-with-<package>` solution when **any** of the following is true:

- The package has hard rules that anyone touching it must know.
- The package has a "do not do X" constraint (transitional, deprecated, restricted).
- The package's structure is non-obvious (e.g. `pi-task-runner` has `src/lib/` helpers; `pi-tool-policy` has a `modal/` subfolder; `pi-extension-utils` is a library, not an extension).
- The package has external dependencies or contracts that aren't visible from the source alone (e.g. `pi-extension-utils` must be published to npm).

If none of those apply, do not create a `working-with-<package>` solution. The `pi-package-hard-rules` solution already teaches the canonical invariants that all `pi-*` packages share; a `working-with-<package>` is for the **delta** from the canonical invariants.

## When to create an area solution

Create a `<package-name>-<topic>` solution when **any** of the following is true:

- A subsystem within the package has its own rules or conventions that would bloat the `working-with-<package>` core solution.
- A specific workflow within the package is non-obvious (e.g. how to add a new permission rule, how to add a new mode, how to migrate to a new external dep).
- The package has multiple distinct subsystems that an agent might work on independently.

If the knowledge fits comfortably in the `working-with-<package>` core solution, do not split it out. Area solutions are for content that would be a distraction in the core entry point.

## Naming rules

- **Core:** `working-with-pi-<name>` — lowercase, hyphens only, no underscores, no abbreviations.
- **Area:** `<package-name>-<topic>` — lowercase, hyphens only, no underscores. The package name is the full name (`pi-task-runner`, not `task-runner`).
- **Topic:** a verb-led or constraint-led phrase, not a vague noun. `permission-pattern` is good; `things` is not.
- **No colons in frontmatter description** (YAML safety, see `pi-skill-frontmatter-colon-rule`).

# Why this works

- **The slug is part of discoverability.** The agent greps by `tags` and `applies_when`, but the slug also appears in paths, cross-links, and grep result lines. A meaningful slug (`pi-task-runner-permission-pattern`) tells the agent what the solution is about without reading the file; a vague slug (`pi-task-runner-things`) does not.
- **The two patterns communicate scope.** `working-with-<package>` is a package overview (delta from canonical). `<package-name>-<topic>` is a deep dive into a specific area. The prefix signals which one the agent is looking at.
- **The criteria prevent over-scaffolding.** A `working-with-<package>` is for the delta from the canonical package shape, not for every package. Most packages don't need one; the criteria say when it's appropriate.

# Prevention

- **Default to area pattern for new solutions.** Most new package-specific knowledge is a deep dive into a specific area, not a package overview. The area pattern is the right default; promote to `working-with-<package>` only when the package is non-trivially different from the canonical shape.
- **Don't create a `working-with-<package>` for a package that follows the canonical shape.** If the package has no hard rules, no "do not do X" constraint, no non-obvious structure, and no external contracts — the canonical shape is enough. The `working-with-<package>` would be empty or redundant.
- **Don't propagate `working-with-<package>` for every package in the workspace.** The convention says it's for the delta, not for every package. A workspace with 8 `working-with-pi-*` solutions, one per package, is over-scaffolded.
- **Topic names are verb-led or constraint-led.** `permission-pattern` is good (constraint-led). `mode-controller` is good (constraint-led). `things` is not (vague noun). `extension` is not (ambiguous — could mean "extending" or "the extension aspect").
- **No colons in frontmatter description** — see `pi-skill-frontmatter-colon-rule` for the YAML safety rule. Same rule applies to solution frontmatter.
- **This solution does not cover workspace-wide learnings** — those use a different naming convention (e.g. `pi-<concept>` for cross-cutting concerns). The `pi-package-specific` convention is for package-scoped knowledge only.
- **This solution does not cover the `pi-hackery` package's specific structure** — see `pi-hackery-folder-layout` for that.
