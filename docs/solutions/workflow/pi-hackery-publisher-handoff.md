---
title: pi-hackery — base/published publisher handoff
category: workflow
severity: high
tags:
  - pi-hackery
  - base-published
  - skill-authoring
  - handoff
  - approval-gate
applies_when:
  - editing a skill whose destination is in packages/pi-hackery/skills/
  - the skill has a base at packages/pi-hackery/bases/skills/<name>.md
  - the published snapshot exists at packages/pi-hackery/skills/<name>/SKILL.md
  - the user has asked to update, create, or revise a pi-hackery skill
---

# Problem

When editing a skill whose destination is `packages/pi-hackery/skills/`, the natural temptation is to edit the published snapshot directly — it's the file the agent reads, the changes are immediately visible, and the edit is fast. But `pi-hackery` runs a base/published split: the **base** at `packages/pi-hackery/bases/skills/<name>.md` is the source of truth (author-facing, higher-level instructions), and the **published** at `packages/pi-hackery/skills/<name>/SKILL.md` is a snapshot (executor-facing, second-person imperative) that the publisher (`hackery-update-skill`) owns.

Editing the published directly breaks the audit trail. The publisher cannot tell what changed at the base level, so a future base edit may overwrite or fight the change. The agent edits a snapshot without going through the approval gate. The next skill author has to re-derive intent from a concrete imperative.

# Context

`pi-hackery` is the one package in this repo that has its own skills tree with a base/published split. The split has three parts:

- **Base.** `packages/pi-hackery/bases/skills/<name>.md` — author-facing. Holds higher-level instructions. The "what" and "why". Whoever authors the skill reads the base.
- **Published.** `packages/pi-hackery/skills/<name>/SKILL.md` — executor-facing. Second-person imperative. The "how" the agent executes today. Whoever runs the skill reads the published.
- **Publisher.** `hackery-update-skill` — the one-shot flow that compares base to published, plans the minimal diff, and edits the published on explicit approval.

The base is the source of truth. The published is a snapshot the publisher owns. This is a `pi-hackery`-internal convention; other destinations (notably `.agents/skills/`) don't have a base — edit the published directly there.

# Solution

When the destination is `packages/pi-hackery/skills/`:

1. **Edit the base** at `packages/pi-hackery/bases/skills/<name>.md`. Do not edit the published snapshot directly.
2. **Surface a handoff message** to the user at the end of the turn, in this exact form:
   ```
   base updated at packages/pi-hackery/bases/skills/<name>.md — ready to run `hackery-update-skill` for propagation to packages/pi-hackery/skills/<name>/SKILL.md
   ```
3. **Wait for the user to run the publisher.** Do not run `hackery-update-skill` yourself. Propagation is approval-gated. The user reads the handoff, decides whether to run the publisher, and runs it manually.

# Why this works

- **Drift.** Editing the published directly breaks the audit trail. The publisher cannot tell what changed at the base level, so a future base edit may overwrite or fight the change. The base is the only place the next author can read intent from.
- **Approval.** The publisher is the gate. Skipping it means the agent edited a snapshot without asking. The user should always be the one to run the publisher; the agent's job is to prepare the base and surface the handoff.
- **Author vs. executor.** The base is what the next skill author needs to read; the published is what the agent needs to read. Conflating them means the next author has to re-derive intent from a concrete imperative, which is the worst kind of reverse-engineering.

# Prevention

- **Default to editing the base.** If the destination is `packages/pi-hackery/skills/`, the edit goes in `packages/pi-hackery/bases/skills/<name>.md`. Anything else is a violation.
- **Always surface the handoff message in the exact form.** A drift in the message format breaks any downstream tooling that pattern-matches on it. The format above is the contract.
- **Do not run `hackery-update-skill` from this workflow.** Propagation is the user's call. Even if the base edit looks obviously correct, the user reads the handoff, decides, and runs the publisher. Do not assume implicit approval.
- **Do not create new bases unprompted.** The base exists when the user (or a prior turn) created it. If no base exists, the user has not asked to create a new skill.
- **Do not edit a base that has no corresponding published snapshot**, unless the user has explicitly asked to create a new skill. A base without a published snapshot is half a workflow; the user needs to know.
- **The rule does not apply outside `packages/pi-hackery/skills/`.** Learnings under `.agents/skills/` have no base — edit the published directly there. The split is `pi-hackery`-internal.
- **If the user has explicitly asked to edit the published anyway**, surface the trade-off once (drift, approval, author vs. executor) and proceed. The user has the authority; the workflow serves the user.
