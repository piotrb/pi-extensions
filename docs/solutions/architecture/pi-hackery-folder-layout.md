---
title: pi-hackery — folder layout
category: architecture
severity: medium
tags:
  - pi-hackery
  - folder-structure
  - base-published
  - sub-agents
  - skill-trees
applies_when:
  - working inside packages/pi-hackery/ and deciding where a new file goes
  - onboarding a new agent to the pi-hackery package
  - adding a new skill to pi-hackery's own skills tree
  - adding a new sub-agent base to pi-hackery
  - understanding why pi-hackery has both a bases/ tree and a skills/ tree
---

# Problem

`pi-hackery` uses a layered folder structure to separate concerns: published skills, the bases that produce them, the framework skills that orchestrate them, and the agents that operate on them. The structure is load-bearing — putting a file in the wrong folder breaks the publishing flow, confuses the runtime, or both. New contributors to the package need a single map that says "this is what each folder is for and what goes there."

# Context

`pi-hackery` is the one package in this repo with a non-flat layout. Most other `pi-*` packages are flat (`src/extensions/<name>.ts`, co-located test, that's it). `pi-hackery` adds four concerns on top: the base/published split for skills, a mirror of the workspace's `.agents/` tree, bases for sub-agents, and the published skills that the runtime consumes.

# Solution

The folder map:

```
packages/pi-hackery/
  package.json                            # the package shell (see pi-package-scaffold)
  tsconfig.json                           # extends ../../tsconfig.base.json
  README.md                               # the package entry doc
  src/
    extensions/
      hackery.ts                          # the entry, default export
      hackery.test.ts                     # co-located test
  bases/                                  # source of truth for the pi-hackery tree
    agents/                               # sub-agent bases (coder, explorer, planner, reviewer)
    skills/                               # skill bases (code, learn, hackery-file-management, plan, …)
  skills/                                 # published snapshots, propagated by hackery-update-skill
    <name>/
      SKILL.md                            # one folder per skill, name matches folder
  .agents/                                # a copy of the workspace's .agents/skills/ tree
    skills/                               # symlink or mirror (this package's own skills)
      hackery-update-skill/SKILL.md
      update-skill/                       # a local utility for maintaining the bases/skills/ tree
```

Where things go inside `pi-hackery`:

- **New skill for pi-hackery.** Write the base at `packages/pi-hackery/bases/skills/<name>.md` (author-facing, higher-level instructions). Then run `hackery-update-skill <name>` to propagate the base to the published snapshot at `packages/pi-hackery/skills/<name>/SKILL.md`. The skill is now visible to the pi runtime as part of the package. See `pi-hackery-publisher-handoff` for the full edit/handoff/publish workflow.
- **New sub-agent base.** Sub-agent bases (the prompts that define a sub-agent's role and behavior) live at `packages/pi-hackery/bases/agents/<role>.md`. The current roles are `coder`, `explorer`, `planner`, `reviewer`. Each base describes the agent's mandate, input contract, output schema, and hard rules. Sub-agent bases are not propagated to a "published" tree — the bases themselves are the source of truth, and the framework skills (`plan`, `design`, etc.) instantiate them.

# Why this works

- **The two skill trees are distinct.** Workspace learnings live at `docs/solutions/<category>/<slug>.md` and are discoverable by grep on the frontmatter fields (`tags`, `title`, `applies_when`) per the `05-learn` workflow. `pi-hackery`'s own skills at `packages/pi-hackery/skills/<name>/SKILL.md` are framework components the pi runtime uses (discoverable via the package's `pi.skills` declaration). A workspace learning is an LLM-readable solution; a `pi-hackery` skill is a **framework component**. They serve different purposes; do not mix them. (The legacy `.agents/skills/<name>/SKILL.md` tree is now reserved for actual repo skills — see the `hackery-update-skill` example; the broader body of learnings lives in `docs/solutions/`.)
- **The base/published split is internal to pi-hackery.** Inside `packages/pi-hackery/`, every published skill has a corresponding base. The base is the source of truth; the published is a snapshot. The full convention is in `pi-hackery-publisher-handoff`. The short version: edit the base at `packages/pi-hackery/bases/skills/<name>.md`; do not edit the published snapshot directly; surface a handoff message naming `hackery-update-skill` for propagation; do not run the publisher yourself.
- **The `.agents/` sub-tree was a copy of the workspace's `.agents/skills/`.** Earlier versions of `pi-hackery` mirrored the workspace's `.agents/skills/` tree inside `pi-hackery/.agents/`, including skills pi-hackery's own work depends on (`hackery-update-skill`, the `update-skill` utility). After the cleanup, the workspace's `.agents/skills/` only contains `hackery-update-skill` (the only real repo skill); the rest of the workspace's knowledge lives in `docs/solutions/`. The `pi-hackery/.agents/` mirror is no longer needed for skill discovery — `pi.skills` declaration in the package's `package.json` is the source of truth.

# Prevention

- **When working in pi-hackery, default to the folder map above.** If you're adding a new skill, the base goes in `bases/skills/` and the published snapshot is generated by `hackery-update-skill`. If you're adding a new sub-agent, the base goes in `bases/agents/`. Putting files in the wrong folder (e.g. a skill base directly in `skills/`, or a sub-agent base in `bases/skills/`) breaks the publishing flow.
- **Don't confuse the two skill trees.** A workspace learning at `.agents/skills/` is not a `pi-hackery` skill and does not belong in `packages/pi-hackery/skills/`. A `pi-hackery` skill is a framework component, not a workspace learning, and does not belong in `.agents/skills/` (except for the two skills that pi-hackery's own work depends on, which are mirrored).
- **Sub-agent bases are not propagated.** Unlike skill bases, sub-agent bases don't have a "published" tree. The base at `bases/agents/<role>.md` is the source of truth, and the framework skills that instantiate them read the base directly.
- **The `.agents/` mirror follows the workspace tree.** When the workspace's `.agents/skills/` changes, the mirror at `packages/pi-hackery/.agents/skills/` should be updated to match (or re-synced). The workspace tree is the source of truth; the mirror is downstream.
- **This solution does not cover other packages' layouts.** Most are flat, no `bases/` or `skills/`. See `pi-package-scaffold` for the canonical shape that all `pi-*` packages share.
- **This solution does not cover plan storage.** Plans live at `docs/plans/<slug>.md` (per the `02-plan` skill convention adopted by this repo), not under `.agents/`. The `hackery-file-management` skill (when relevant) documents the legacy `.agents/plans/` location.
