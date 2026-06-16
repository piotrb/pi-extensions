---
name: pi-hackery-folder-layout
description: The layered folder structure of packages/pi-hackery — bases/, skills/, .agents/, bases/agents/, bases/skills/. Use when working inside pi-hackery, deciding where a new file goes, or onboarding a new agent to this package.
---

The `pi-hackery` package uses a layered folder structure to separate concerns: published skills, the bases that produce them, the framework skills that orchestrate them, and the agents that operate on them. The structure is load-bearing — putting a file in the wrong folder breaks the publishing flow.

## The folder map

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
    skills/                               # skill bases (code, learn, learning-management, plan, …)
  skills/                                 # published snapshots, propagated by hackery-update-skill
    <name>/
      SKILL.md                            # one folder per skill, name matches folder
  .agents/                                # a copy of the workspace's .agents/skills/ tree
    skills/                               # symlink or mirror (this package's own skills)
      hackery-update-skill/SKILL.md
      update-skill/                       # a local utility for maintaining the bases/skills/ tree
  plans/                                  # per-feature plans (NOT shipped)
```

## Where things go

### New skill for the workspace

`packages/pi-hackery/skills/<name>/` is **not** the home for workspace-wide learnings. Workspace learnings live at `.agents/skills/<name>/` (see `learning-management`). The `packages/pi-hackery/skills/` tree is for the package's own published skills, propagated from `bases/skills/` by `hackery-update-skill`.

### New skill for pi-hackery

If the skill is specific to the pi-hackery package (its conventions, its framework, its own agents):

1. Write the base at `packages/pi-hackery/bases/skills/<name>.md` — author-facing, higher-level instructions.
2. Run `hackery-update-skill <name>` to propagate the base to the published snapshot at `packages/pi-hackery/skills/<name>/SKILL.md`.
3. The skill is now visible to the pi runtime as part of the package.

See `base-publisher-hand-off` for the full base/published editing convention.

### New sub-agent base

Sub-agent bases (the prompts that define a sub-agent's role and behavior) live at `packages/pi-hackery/bases/agents/<role>.md`. The current roles are `coder`, `explorer`, `planner`, `reviewer`. Each base describes the agent's mandate, input contract, output schema, and hard rules.

Sub-agent bases are not propagated to a "published" tree — the bases themselves are the source of truth, and the framework skills (`plan`, `design`, etc.) instantiate them.

### New plan

Per-feature plans (the `*.md` files describing a phased implementation) live at `packages/pi-hackery/plans/`. Plans are not shipped (the `files` allowlist in `package.json` excludes them). They are working documents that the `plan` and `blueprint` skills write to and the `implement` skill reads from.

## The two skill trees

There are **two distinct skill trees** in this repo:

1. **Workspace learnings** at `.agents/skills/<name>/SKILL.md`. Discoverable via `.agents/learning-index.md`, which `AGENTS.md` references. The `learning-management` skill owns the conventions for this tree.

2. **pi-hackery's own skills** at `packages/pi-hackery/skills/<name>/SKILL.md`. Discoverable via `hackery-update-skill` and the pi runtime. The `base-publisher-hand-off` skill owns the conventions for this tree.

A skill in the workspace tree is a **learning** — knowledge the LLM does not have. A skill in the pi-hackery tree is a **framework component** — something the pi runtime uses. They serve different purposes; do not mix them.

## The base/published split

Inside `packages/pi-hackery/`, every published skill has a corresponding base. The base is the source of truth; the published is a snapshot. The full convention is in `base-publisher-hand-off`. The short version:

- Edit the base at `packages/pi-hackery/bases/skills/<name>.md`.
- Do not edit the published snapshot at `packages/pi-hackery/skills/<name>/SKILL.md` directly.
- After the base edit, surface a handoff message naming `hackery-update-skill` for propagation. Do not run the publisher yourself.

## What this skill does not do

- It does not cover other packages' layouts — they follow their own conventions (most are flat, no `bases/` or `skills/`).
- It does not cover the workspace-wide `.agents/` tree beyond this one paragraph — the `learning-management` skill owns those conventions.
- It does not cover the `plans/` folder's maintenance workflow — the `plan` and `blueprint` skills own that.

## Related

- @.agents/skills/base-publisher-hand-off/SKILL.md
- @.agents/skills/pi-package-scaffold/SKILL.md
