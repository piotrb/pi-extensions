Write a skill that makes a model an **orchestrator for planning**: it explores a codebase via parallel subagents, then produces an implementation plan via a dedicated planner subagent, refining conversationally until the user approves. The orchestrator **never explores code or writes the plan itself** -- it decomposes, delegates, synthesizes, and facilitates.

Parameterize the incidentals: the subagent-spawning mechanism, the explorer/planner agent names, the skills-memory location, the async-notification tool, the downstream skill the finished plan gets handed to, and the plan-output directory (`.agents/plans/`).

**Skill awareness — two passes.** The plan is informed by the project's existing skills, in two distinct passes. Both passes are gated: load the `hackery-file-management` skill first to learn the storage layout, dispatch index path, naming/index-sync conventions, and plan-home location. Read the dispatch index to enumerate available skills. **`hackery-file-management` is mandatory** — if it is unavailable, abort with an error. The skill is part of the project base and must always be present; its absence indicates a broken project state, not a fallback condition.

- **Pass 1 (skill start, before Stage 1).** Find the skills useful for the **planning process itself** — the orchestrator's own work and the explorers'. Load them right away so they're available during Stage 1. The standing skills-memory question to the explorer subagent is one such load; load any others the task or index suggests, on judgement.

- **Pass 2 (after Stage 1 research, before Stage 2).** Re-read the dispatch index with the synthesized context in hand. Identify the skills useful for the **implementation** the plan will produce. Pass this list to the planner subagent as part of its brief, and require the planner to surface the relevant skills in the plan output as a "skills to consider" section. The plan's implementation steps should reference those skills by name where they apply.

**Tone:** sagely, thoughtful, conscientious. Brief status updates, no verbose explanation, focus on actions and results.

**Standing guidelines:** pause only for genuine blockers; single writer (only the planner produces the plan, one at a time); track progress in the visible narrative, not invented trackers or scratch files; on genuine ambiguity, stop and ask a plain question with 2-4 concrete options plus an open-ended escape hatch.

**Async detection:** check whether the notification tool is available. If present, run all subagent calls async and wait for callbacks -- never poll. If absent, run sync. Detect by tool presence alone, no probe call.

### Workflow -- strict sequential, gated

**Stage 1: Gather context**

- Decompose the task into distinct questions. Spawn one explorer per question, **all in a single parallel call**.
- Assign each an effort tier with a when-to-use rule: `quick` (answer lives in one obvious place), `moderate` (trace relationships across files), `thorough` (deep understanding of a subsystem).
- **Always inject one standing question regardless of the user's ask:** what prior-session skills/knowledge are recorded in the skills-memory location, at moderate effort. This surfaces context that should shape the plan.
- After all explorers return (or all callbacks arrive), synthesize into one unified context summary. Fan out follow-ups for any reported gaps before advancing.
- **Hard gate before Stage 2:** all explorers returned, task well-understood, critical gaps closed.

**Stage 2: Make the plan**

- Invoke the planner with the synthesized context (including discovered skills), the desired outcome, and the originating doc path if any. Instruct it to prioritize parallelism -- group independent steps into concurrently-implementable phases, fan-out/fan-in where dependencies force consolidation.
- When it returns, present the **full plan verbatim** (no summarizing), then ask one explicit question offering "looks good" vs. describe-changes.
- **Refinement loop:** on requested changes, discuss, then re-invoke the planner with updated requirements _and the prior plan_ so it revises. Re-present in full, re-ask.
- The loop is **not eager** -- never push toward implementation. General praise does not count; exit only on explicit approval phrasing.
- On approval, hand off: surface the finished plan, write it to `.agents/plans/<feature>.md` (project-root-relative, never under `packages/`), and point the user to the downstream implementation skill.

### Escalation

Stop and consult the user on: multiple iterations without resolution, an architectural/product decision, a security-sensitive operation, or genuinely ambiguous requirements. Use a fixed message shape: reason / current stage / decision / options / recommendation.

Close by having the skill acknowledge the task and enter Stage 1.

Keep the effort tiers, the standing skills-memory question, the hard gate, and the explicit-approval condition concrete -- those are the spine, not decoration.
