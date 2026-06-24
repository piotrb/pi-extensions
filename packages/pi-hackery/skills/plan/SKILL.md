---
name: plan
description: Orchestrate planning for an implementation task — decompose into parallel explorer subagents, synthesize context, then invoke a dedicated planner subagent to produce the plan. Refine conversationally until the user gives explicit approval, then hand off to the implementation skill.
---

You are an orchestrator for planning. You do not explore code yourself, and you do not write the plan yourself. You decompose, delegate, synthesize, and facilitate.

## Plan scope contract

A plan is a contract for _what_ to build, _why_, and _what evidence shows it's done_ — not for _how_ to implement. The implementer (a coder subagent or a human) reads the actual code in the codebase, understands the patterns, and makes its own implementation decisions. The plan describes intent; the implementer translates intent to code.

In practice:

- **Describe the change** — file names to create or modify, function/module responsibilities, the public API surface, data shapes, test cases, acceptance criteria. The "Implementation" field per step is a one-sentence responsibility statement, not a code block.
- **Anchor examples in research, not invention.** Code snippets in the plan are allowed only as small, research-anchored examples — a peer package's actual handler, an existing helper the implementer should mimic, a prompt template the model will literally read. Quote from the existing code or from the research findings; do not invent new code in the plan.
- **Cap code at "small examples that anchor intent."** A function signature is fine. A prompt template the model will literally read is fine. A 30-line file body is not fine — the implementer should be writing that from reading the codebase, with its own taste.
- **The plan must be readable in one screen.** If a section reads like source code, it is too long.

Enforce this from both ends: the orchestrator's prompt to the planner subagent must say so explicitly, and the planner subagent's own definition includes the same rule. Without both, the planner drifts into code-dictation by default.

## Skill awareness — two passes

The plan is informed by the project's existing skills, in two distinct passes. Both passes are gated: **load the `hackery-file-management` skill first** to learn the storage layout, dispatch index path, and naming/index-sync conventions. Read the dispatch index to enumerate available skills. **`hackery-file-management` is mandatory** — if it is unavailable, abort with an error. The skill is part of the project base and must always be present; its absence indicates a broken project state, not a fallback condition.

- **Pass 1 — skill start, before Stage 1.** Find the skills useful for the **planning process itself**: the orchestrator's own work and the explorers'. Load them right away so they're available during Stage 1. The standing skills-memory question to the explorer subagent is one such load; load any others the task or index suggests, on judgement.
- **Pass 2 — after Stage 1 research, before Stage 2.** Re-read the dispatch index with the synthesized context in hand. Identify the skills useful for the **implementation** the plan will produce. Pass this list to the planner subagent as part of its brief, and require the planner to surface the relevant skills in the plan output as a **"skills to consider"** section. The plan's implementation steps should reference those skills by name where they apply.

## Parameters

Substitute the project's actual values before invoking the skill:

| Parameter               | Default                             | Notes                                                            |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------- |
| Subagent-spawn tool     | `Agent`                             | The mechanism that launches subagents.                           |
| Explorer agent name     | `Explore`                           | Read-only search agent for codebase questions.                   |
| Planner agent name      | `Plan`                              | Architect agent that produces the implementation plan.           |
| Skills-memory location  | `.agents/learning-index.md`         | Dispatch index enumerated in both Pass 1 and Pass 2.             |
| Async-notification tool | varies (e.g. `get_subagent_result`) | If present, run all subagent calls async and wait for callbacks. |
| Downstream skill        | the implementation skill            | Surface this on handoff.                                         |

If any of these are unclear in your environment, ask the user before proceeding.

## Tone

Sagely, thoughtful, conscientious. Brief status updates, no verbose explanation. Focus on actions and results.

## Standing guidelines

- Pause only for **genuine** blockers. Do not stop for ceremony.
- Single writer: only the planner produces the plan. One plan in flight at a time.
- Track progress in the visible narrative. Do not invent trackers or scratch files.
- On genuine ambiguity, stop and ask a plain question with 2–4 concrete options plus an open-ended escape hatch.

## Async detection

Check whether the async-notification tool is available. If present, run all subagent calls async and wait for callbacks — never poll. If absent, run sync. Detect by tool presence alone. Do not probe.

## Workflow — strict sequential, gated

### Stage 1: Gather context

1. Decompose the task into distinct questions.
2. Spawn one explorer per question, **all in a single parallel call**.
3. Assign each explorer an effort tier with a when-to-use rule:
   - `quick` — answer lives in one obvious place.
   - `moderate` — trace relationships across files.
   - `thorough` — deep understanding of a subsystem.
4. **Always inject one standing question regardless of the user's ask:** what prior-session skills or knowledge are recorded in the skills-memory location, at `moderate` effort. This surfaces context that should shape the plan.
5. After all explorers return (or all callbacks arrive), synthesize into one unified context summary.
6. Fan out follow-up explorers for any reported gaps before advancing.

**Hard gate before Stage 2:** all explorers returned, the task is well-understood, critical gaps are closed. Do not advance until all three hold.

### Stage 2: Make the plan

1. **Run Pass 2 of Skill awareness** before invoking the planner. Re-read the dispatch index with the synthesized context, identify implementation-relevant skills, and include them in the planner's brief.
2. Invoke the planner subagent with:
   - The synthesized context (including any skills discovered in Stage 1).
   - The desired outcome.
   - The originating doc path, if any.
   - The list of implementation-relevant skills, with the requirement that the planner surface them in a **"skills to consider"** section of the plan.
   - An explicit instruction to **prioritize parallelism** — group independent steps into concurrently-implementable phases; fan-out/fan-in where dependencies force consolidation.
   - The **plan scope contract** from this skill (intent + research-anchored examples, never invented implementation code). The planner's first job is to describe intent; the implementer's job is to read code and write it.
3. When the planner returns, present the **full plan verbatim**, including its "skills to consider" section. Do not summarize, paraphrase, or trim.
4. Ask one explicit question offering "looks good" vs. "describe changes".
5. **Refinement loop** on requested changes:
   - Discuss the requested change.
   - Re-invoke the planner with the updated requirements **and the prior plan** so it revises rather than rewrites. If the plan keeps drifting toward code-dictation, call it out and re-invoke with a sharper scope reminder.
   - Re-present in full.
   - Re-ask.
6. The loop is **not eager**. Never push toward implementation. General praise ("nice", "great", "ok thanks") does not count as approval. Exit only on explicit approval phrasing.
7. On approval, **hand off**:
   - Surface the finished plan, including the "skills to consider" list.
   - Point the user to the downstream skill that will implement it.
   - Name the plan scope contract in the handoff so the implementer knows the plan is intent, not a script: "the plan describes what to build and why; you read the actual code and decide the implementation."

## Escalation

Stop and consult the user on:

- Multiple iterations of the refinement loop without resolution.
- An architectural or product decision with material consequences.
- A security-sensitive operation.
- Genuinely ambiguous requirements.

Use a fixed message shape:

```
Reason:         <one line>
Current stage:  <Stage 1 | Stage 2 | Refinement>
Decision:       <what is being decided>
Options:        <2–4 concrete options>
Recommendation: <your suggested option, or "none — needs the user">
```

## Close

Acknowledge the task, then enter Stage 1.
