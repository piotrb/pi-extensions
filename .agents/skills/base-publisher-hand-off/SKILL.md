---
name: base-publisher-hand-off
description: When editing a skill whose destination is in packages/pi-hackery/skills/, edit the base under packages/pi-hackery/bases/skills/ only — never the published snapshot — and surface a handoff message naming hackery-update-skill. The publisher compares base to published, plans the minimal diff, and propagates on explicit approval.
---

You are about to edit a skill in this project. The skill's destination is under `packages/pi-hackery/skills/`. There is a corresponding base under `packages/pi-hackery/bases/skills/<name>.md` that holds the higher-level instructions for the skill author, and a published snapshot at `packages/pi-hackery/skills/<name>/SKILL.md` that the executor reads.

## The split

- **Base.** `packages/pi-hackery/bases/skills/<name>.md` — author-facing. Holds higher-level instructions. The "what" and "why". Whoever authors the skill reads the base.
- **Published.** `packages/pi-hackery/skills/<name>/SKILL.md` — executor-facing. Second-person imperative. The "how" the agent executes today. Whoever runs the skill reads the published.
- **Publisher.** `hackery-update-skill` — the one-shot flow that compares base to published, plans the minimal diff, and edits the published on explicit approval.

The base is the source of truth. The published is a snapshot the publisher owns.

## The rule

Edit the base only. Do not edit the published snapshot directly.

When the base is updated, surface a handoff message to the user naming the publisher. Do not run the publisher yourself — propagation is approval-gated.

## The handoff

After the base edit lands, end the turn with a one-line message of the form:

```
base updated at packages/pi-hackery/bases/skills/<name>.md — ready to run `hackery-update-skill` for propagation to packages/pi-hackery/skills/<name>/SKILL.md
```

The user reads this, decides whether to run the publisher, and runs it manually. Do not assume implicit approval.

## Why this matters

- **Drift.** Editing the published directly breaks the audit trail. The publisher cannot tell what changed at the base level, so a future base edit may overwrite or fight the change.
- **Approval.** The publisher is the gate. Skipping it means the agent edited a snapshot without asking.
- **Author vs. executor.** The base is what the next skill author needs to read; the published is what the agent needs to read. Conflating them means the next author has to re-derive intent from a concrete imperative.

## When this rule does not apply

- The skill's destination is **not** under `packages/pi-hackery/skills/`. Learnings under `.agents/skills/` have no base — edit the published directly.
- The user has explicitly asked to edit the published anyway, with awareness of the trade-off. Surface the trade-off once, then proceed.

## What you do not do

- Do not run `hackery-update-skill` from this skill. Propagation is the user's call.
- Do not create new bases unprompted. The base exists when the user (or a prior turn) created it.
- Do not edit a base that has no corresponding published snapshot, unless the user has explicitly asked to create a new skill.
