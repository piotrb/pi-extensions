---
title: solution reusability test (when to write a new solution vs. retire or skip)
category: workflow
severity: medium
tags:
  - solution
  - 05-learn
  - reusability
  - retirement
  - applies_when
  - grep-discovery
  - yagni
  - workflow
applies_when:
  - finishing a problem-solving session and considering whether to write a new solution at docs/solutions/<category>/<slug>.md
  - writing or updating a solution in the 05-learn workflow
  - deciding whether to retire an existing solution vs. update it
  - auditing the solution body for entries that are no longer load-bearing
  - running a 02-plan or 04-review and seeing too many solutions surface
---

# Problem

The `05-learn` skill says solutions should be **useful to future `02-plan` and `04-review` runs**. Without a concrete test for "is this useful?", the agent writes solutions for every problem it solves — including one-shot cleanup procedures, the agent's own plan execution, and well-documented patterns already covered by another solution. The result: a fat body of solutions where most entries are never grepped. Future `02-plan` runs surface too many candidates; future `04-review` runs treat load-bearing and one-shot solutions as the same kind of evidence.

This solution covers the **decision principle** for whether to write a new solution, retire an existing one, or skip the write. The plan workflow itself is in `docs/plans/`; the `05-learn` skill workflow (read → scan → overlap → pattern → categorize → write) is the meta-skill. This solution sits between them: it tells the agent _when_ to invoke `05-learn`, _what_ counts as a reusable learning, and _when_ to retire.

# Context

A "solution" in this sense is a body of LLM-readable docs that are **discovered at lookup time by grep on the frontmatter fields** (`tags`, `title`, `applies_when`). The grep model is the load-bearing design: a solution that no future `02-plan` or `04-review` run will grep is dead weight. Dead weight in the body has two costs:

1. **Grep surface noise.** A `02-plan` run that searches by `tags` (e.g. `pi-tool-policy`) gets 5 matches; one of them is a one-shot migration log; the agent has to read and discard it.
2. **Maintenance cost.** Every solution has to stay in sync with the source it documents. A solution about a one-shot migration is irrelevant the moment the migration lands, but the cost of updating or removing it doesn't disappear.

The skill encourages writing solutions; this solution pushes back on that default when the work is one-shot or already covered.

# Solution

## The reusability test

Before writing a new solution, the agent runs the **reusability test** on the candidate content:

1. **Will a future `02-plan` or `04-review` run grep for this?**
   - **Yes** if a future task in this project will hit the same problem (a recurring design decision, a load-bearing contract, a non-obvious gotcha).
   - **No** if the work is a one-shot procedure, the agent's own plan execution, a personal workflow, or a problem specific to a single session.
2. **Is the principle still load-bearing after the work is done?**
   - **Yes** if a future code change could re-introduce the problem (e.g. a recurring antipattern, a contract that must be respected).
   - **No** if the principle lives elsewhere (in the audit test, in the package's own conventions, in a new convention adopted by adoption) and the solution would just re-state it.
3. **Is the content distinct from existing solutions?**
   - Run the overlap check (per `05-learn`'s `references/overlap-rules.md`). High overlap → update the existing solution; moderate → cross-link; low → create distinct.
   - **Distinct** is required for a new solution. If the content is already in another solution (even implicitly), the new solution is documentation of an already-captured principle.
4. **Will the solution be grep-discoverable?**
   - `tags` should include terms a future `02-plan` would actually search. A solution with `tags: [plan-execution, personal-workflow]` is not grep-discoverable for the actual design decisions in the body.
   - `applies_when` should describe the conditions under which the solution is relevant, in terms future tasks will match.

A candidate that fails any of these is either **retired (don't write it)** or **skipped (the principle is captured elsewhere)**.

## When to write

A new solution is appropriate when:

- A recurring design decision needs a single reference (e.g. `pi-tool-call-load-order-first-wins` — the load-order rule will be needed by every future gate-extension).
- A load-bearing contract must be respected (e.g. `pi-task-runner-permission-pattern` — the verdict enum is part of the security model; future code changes need to see it).
- A non-obvious gotcha has been discovered (e.g. `pi-tool-policy-per-field-aspect-cardinality` — the dispatch-key gotcha is latent; the test suite masks it; the fix is documented as a known issue).
- A pattern recurs across multiple existing solutions and the pattern itself is reusable (e.g. `pi-multi-tool-package` — the `TOOLS` array loop applies to all multi-tool packages).

## When to retire

A solution should be retired when:

- **The work it documents is complete and one-shot** (e.g. a migration that has finished; a cleanup that has finished). The principle lives in the plan document, the audit test, or the package's own conventions.
- **The principle is now enforced by the codebase** (e.g. an audit test that catches the antipattern). The solution is now redundant with the test.
- **The principle was wrong, obsolete, or has been replaced** (e.g. a deprecated convention). Retiring is honest; keeping it is noise.
- **The solution is a duplicate of another solution** (e.g. two solutions that cover the same ground). Consolidate into one and retire the other.

Retiring is not a failure mode; it is a load-bearing outcome. The plan that produces 1 retirement per 10 iterations is well-tuned.

## When to skip

A new solution is **not** appropriate when:

- **The work is the agent's own plan execution.** Plan execution is captured in the plan document, the commit message, and the code itself. A solution would be a re-statement.
- **The content is a personal workflow tip** (e.g. "use `pfs_unlink` instead of `rm`"). This belongs in `AGENTS.md` (the tool surface rules) or in a comment, not in a solution.
- **The principle is captured by an audit test.** The test enforces it; a solution documents it; the test is the source of truth.
- **The content is already in another solution** (even partially). The overlap check is high or moderate; update or cross-link the existing solution.

The 05-learn skill encourages writing solutions. The default is right most of the time, but the default is not the rule.

## The grep test (verifying the solution will be useful)

For an existing solution, run the grep test:

1. Pick a realistic future task that should surface this solution.
2. Compose the search query: `tags` terms, `applies_when` phrases, or `title` keywords.
3. Run the search against the body.
4. If the solution does not surface, the `applies_when` or `tags` is wrong; fix the frontmatter.

Solutions that don't surface in any reasonable grep are dead weight. The frontmatter is the agent's contract with future searches; if it's wrong, the solution is wrong.

## Storage level

Solutions are usually **project-level** (`docs/solutions/<category>/<slug>.md`) because they're specific to this project's code. **Global-level** (`~/.pi/agent/docs/solutions/`) is for principles that apply to any project (e.g. `no-cache-for-user-mutable-data` — the principle of "never cache user-mutable data" applies to any tool that reads user files).

The default is project. Promote to global only when the principle is genuinely project-agnostic AND the user has confirmed. Most solutions are not global.

# Why this works

- **The grep model is the load-bearing design.** Solutions are discovered by grep, not by preloader. A solution that no future run will grep is dead weight. The reusability test asks the question the grep model implies: "will a future task surface this?".
- **Retiring is a feature, not a failure.** The plan that retires 1 solution per 10 iterations is well-tuned; the plan that retires 0 is over-documenting. The retirement rate is a signal of plan health.
- **The audit test is the source of truth for some principles.** A solution that says "don't cache user-mutable data" is documentation; the test that asserts "no caching in `loadRules`" is enforcement. When the test exists, the solution is redundant.
- **Frontmatter is the agent's contract with future searches.** A solution with `applies_when` that no future task matches is broken. The grep test catches this.
- **YAGNI on solutions.** A solution that the agent thinks will be useful but no future task greps is the same YAGNI failure as a library function with no callers. Retire it.

# Prevention

- **Do not write a solution for one-shot work.** The cleanup procedure for a one-time migration is in the plan document. A solution would be a re-statement.
- **Do not write a solution that the audit test already enforces.** The test is the source of truth; the solution is documentation. If the test exists, retire the solution or skip the write.
- **Do not write a solution for a personal workflow tip.** The tool surface rules are in `AGENTS.md`. Adding to a solution is the wrong location.
- **Do not keep a solution that has been superseded by code.** If the codebase has adopted the convention by adoption (e.g. the `pi-tool-call-load-order-first-wins` rule is now documented in the readme, the audit test asserts it), retire the solution.
- **Do not write a solution with vague `applies_when`.** Vague `applies_when` (`general`, `architecture`, `pi`) is not grep-discoverable. The fields must describe specific conditions.
- **Do not write a solution that is a duplicate of another solution.** Run the overlap check; if high or moderate, update or cross-link, don't create.
- **Do not skip the grep test for existing solutions.** A solution that doesn't surface in any reasonable grep is dead weight. Fix the frontmatter or retire.

# Verification

- **Reusability test passes** for the candidate: future `02-plan` / `04-review` will grep for it; principle is still load-bearing; content is distinct; frontmatter is grep-discoverable.
- **Overlap check** is performed against the existing body (per `05-learn`'s `references/overlap-rules.md`).
- **Grep test** is run on the resulting solution: a realistic future task surfaces it.
- **The audit test** (`tests/solutions.test.ts` in this repo) passes for the new solution.
- **`pnpm run check` is all green** after the write.
- **No duplicate solutions** exist for the same principle.

# Related

- `pi-package-specific-skill-naming` — the slug convention; the slug is part of the grep-discoverability surface.
- `pi-monorepo-overview` — the solution body location and the storage level rule (project vs global).
- `turbo-workspace-test-task` — the audit test that enforces frontmatter validity; without the test, malformed solutions would slip in.
- `pi-extension-toolchain` — the `pnpm run check` command that the solution-audit is part of.
- `docs/plans/learning-extraction-and-cleanup.md` — the plan that produced this solution; the cleanup procedure itself is one-shot and lives in the plan, not in a solution.

---

**🧠 Context Status** (for handoff):

- **Health:** good. The plan is complete (29 iterations + post-steps; status: complete).
- **Handoff path:** `docs/plans/learning-extraction-and-cleanup.md` (the plan document).
- **Active files:** the 29 solutions in `docs/solutions/`; `tests/solutions.test.ts`; the `//#test:workspace` turbo task; the `AGENTS.md` Skills section.
- **New-session recommendation:** continue with any remaining `packages/pi-hackery/` edits (out of scope for this plan; the cleanup explicitly excluded them) or run a `02-plan` to identify the next cleanup target.
