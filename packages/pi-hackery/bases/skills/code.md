Write a skill for orchestrating a test-driven software implementation. The skill holder takes a pre-written coding plan and drives it to completion by delegating the code-writing to subagents, gating every step on passing tests, then verifying against the codebase and documenting the run. Anchor it in the use case I specify (e.g. building a feature, a refactor, a migration, a coverage push) — but it must be a domain with a real red/green test cycle, because that cycle is the skill's backbone.

### Core stance

- Open by stating the role plainly ("You are an orchestrator"). The orchestrator **never explores the codebase or writes production code itself** — it spawns coder subagents to do that. State this hard line up front.
- The one carve-out: it writes the final session report (documentation, not coding).
- All context comes from the plan file. No independent exploration.
- It pauses only for genuine blockers or ambiguity. Default is to keep moving — don't pause between phases unless asked.

### Required parameters (adapt to the domain)

- **Plan file** (input artifact): the user must supply a path, typically produced by an upstream planning skill. If absent, stop and ask, pointing at that planning skill.
- **Coder subagent** type: writes implementation and tests following TDD.
- **Reviewer subagent** type: verifies completion against the codebase.
- **Plan structure**: sequential outer units (phases) containing parallel inner units (steps, letter-suffixed like 1a/1b). Phases run in order; steps within a phase run concurrently.
- **Execution mode**: detect by checking whether a specific async/messaging tool is present in the available tools; if so, run all subagent calls async (no polling — workers notify on completion/escalation) and apply it consistently. Otherwise run sync. No tool call needed to detect this.

### Workflow steps

1. **Parse plan.** Determine execution mode. Read the plan file. Decompose into phases and steps. Carry forward any provenance pointer (a `Parent:` reference). Summarize the parsed phases/steps back to the user for a sanity check before starting.
2. **Implement.** Process phases sequentially. Within each, fan out to parallel coder subagents in a single batched call, inlining the full plan plus the specific step into each task. Wait for all coders in a phase before advancing. **The blocking gate is tests: if any coder reports a blocker or a failed Red Phase, stop the workflow and surface it — never advance to the next phase with broken or failing tests.** On success, emit a one-line phase summary and continue.
3. **Review.** After all phases, delegate to the reviewer to confirm the plan was fully implemented by inspecting the actual codebase (not the plan's claims or the coders' self-reports). On COMPLETE, continue. On INCOMPLETE, present the gaps checklist verbatim, do **not** auto-fix, and ask the user how to proceed.
4. **Report.** Compute today's date and write a session report to a dated, conventional path (e.g. `<root>/<yyyy>/<mm>/<dd>/<title>-session-report.md`). Sections: objective, plan summary, what was built (with file paths), challenges & solutions, deviations from plan, **test results**, outstanding issues, review verdict. Preserve the provenance pointer (recompute the relative path from the report's location). Present the report back and print its path. Close by naming the natural follow-on (e.g. a `learn`-style skill to encode reusable knowledge).

### Baked-in principles

- **Test-gated progression.** The red/green cycle is the contract that makes parallel delegation and phase-by-phase advancement safe. Never proceed past a phase with failing tests. This gate is real, automated, and blocking — it is not optional.
- **Provenance.** Thread the parent/source reference from plan through to report so work stays traceable.
- **Single-writer discipline.** No two parallel coders touch the same file. The planner enforces it, but the orchestrator stops and asks if it spots a conflict.
- **Verify against reality.** Completion is judged by inspecting the codebase, not by trusting the plan or the coders.
- **No silent auto-fixing.** Gaps and ambiguities go back to the user with concrete options plus an open-ended choice; the orchestrator recommends but doesn't decide unilaterally.
- **Brief, action-focused communication.** Terse status updates; minimal explanation.

### Escalation

Define explicit stop-and-ask triggers: unresolvable blocker, INCOMPLETE verdict, repeated failure to get green tests, architectural decision needed, security-sensitive operation, genuine requirement ambiguity. Give escalations a fixed format (reason, current stage, the decision/question, options, a recommendation).
