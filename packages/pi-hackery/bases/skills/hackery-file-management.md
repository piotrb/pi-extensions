Write a meta-skill that **encodes the conventions for managing the project's shared agent-runtime files** — the workspace-level artifacts that the agent and human both read and write. The skill owns two trees under `.agents/`:

1. **Learnings** (`.agents/skills/<name>/SKILL.md`) — durable knowledge the LLM does not have. Discovered and authored by the `learn` skill. Dispatched via `.agents/learning-index.md`.
2. **Plans** (`.agents/plans/<feature>.md`) — per-feature implementation plans. Produced by the `plan` skill (and `blueprint`, `design`). Read on demand by humans and by downstream implementation skills; not preloaded.

Both trees are **project-root-scoped**, not package-scoped. They live under `.agents/` because they describe workspace-wide concerns, not package-internal ones. Putting them at `packages/<pkg>/plans/` or `packages/<pkg>/skills/` would break that scoping — plans for a `pi-tool-policy` feature are about the **workspace**, not about `pi-hackery`; `pi-hackery`'s own conventions just happen to govern how the plan is produced.

This is a **meta-skill**: it does not add, update, or retire learnings or plans itself. It documents the rules that the `learn`, `plan`, `blueprint`, and other skill-authoring skills are expected to follow.

### What this skill encodes

#### Learnings — `.agents/skills/<name>/SKILL.md`

- **Storage layout.** Each learning lives as a skill file at `.agents/skills/<name>/SKILL.md` with proper skill frontmatter (`name` and `description`).
- **Naming.** The folder name and the `name` frontmatter field are the same string. Name skills after the **concept** they encode, not the first instance where you learned it. Ask "would I still pick this name if I'd seen the rule from a different trigger?" If the answer is no, the name leaks scope. For package-specific rules where the package is the concept, naming after the package is correct.
- **Dispatch index.** A single index file at `.agents/learning-index.md` lists every learning. Each entry is **slightly more detailed than the skill's own `description`** — one short paragraph explaining what the skill does and under what circumstances to use it, so a reader can route without loading the skill itself.
- **Index-sync procedure.** After **any** edit to a learning (create, update, or retire), the author must review `.agents/learning-index.md` and update the matching entry — or add/remove the entry if it no longer applies. The index is a derived artifact and must never be left inconsistent with the skills it dispatches to.
- **AGENTS.md entry point.** The dispatch index is referenced from `AGENTS.md`'s Skills section as a single `@`-reference to `.agents/learning-index.md` — no summary, no per-skill list. `AGENTS.md` does not duplicate the index; the `@` reference is the entry point. Because `AGENTS.md` lives at the project root, this reference is project-root-relative.
- **`@`-reference paths are relative to the file containing them.** The context-preloader resolves every `@`-reference against the directory of the file that contains it, then recursively into each loaded file (up to `MAX_DEPTH=5`, deduped). There is no global address space; the path is always local to the containing file. The three canonical shapes are:
  - From `AGENTS.md` (project root) to the index: `@.agents/learning-index.md`.
  - From `.agents/learning-index.md` to a core skill: `@skills/<name>/SKILL.md` (the index lives in `.agents/`, so `skills/...` resolves to `.agents/skills/<name>/SKILL.md`).
  - From one skill at `.agents/skills/<this>/SKILL.md` to a sibling skill: `@../<other>/SKILL.md` (climb out of the current skill's folder, then descend into the sibling).

  Writing `@.agents/skills/<other>/SKILL.md` inside any skill at `.agents/skills/<this>/SKILL.md` is a bug — the preloader resolves it to `.agents/skills/<this>/.agents/skills/<other>/SKILL.md` and logs it as unreadable. The same doubled-prefix trap applies anywhere a reference is written with a path rooted higher than the containing file.

- **`@`-references are for preloading, not for "see also" pointers.** The preloader follows every `@`-reference it finds, so a `@`-reference to a sibling skill pulls that skill's body into the system prompt at session start. That is the wrong tool for "the agent may also want to know about this". A `Related` section (or any inline "see also" pointer in skill prose) is **not** a preload directive — it is a dispatch hint. Write the pointer as a backtick-quoted skill name (`<skill-name>`) and let the agent consult the index and load on demand. The index is the only hub; skills do not preload their siblings.

#### Plans — `.agents/plans/<feature>.md`

- **Storage layout.** Each plan is a single Markdown file at `.agents/plans/<feature>.md`. The filename is kebab-case and describes the feature, not the date or author. Plans are **not** preloaded — they are working documents read on demand.
- **Project-root scope.** Plans live under `.agents/` because they describe workspace-wide implementations, not package-internal ones. A plan that targets `packages/pi-tool-policy/` is still a workspace concern; it is not a `pi-hackery` artifact.
- **Not shipped.** Plans are not part of any npm package; they are not in the `files` allowlist of any `package.json`. They are local working documents.
- **Authoring skills.** The `plan` skill produces these. `blueprint` and `design` may produce related artifacts that live alongside plans, but the canonical plan format is the `plan` skill's output.
- **Consumers.** Humans read them directly. The downstream implementation skill (`code`, or any skill the `plan` skill hands off to) reads them as its primary input.
- **No dispatch index.** Plans are not in `.agents/learning-index.md`. They are discovered by filesystem lookup, not by dispatch. If a plan is referenced from a skill, the reference is a backtick-quoted relative path (`` `.agents/plans/<feature>.md` ``), not an `@`-preload.

### What this skill does not do

- It does not create, update, or retire learnings or plans.
- It does not edit production code, run tests, or write session reports.
- It does not dispatch to individual learnings — the index file does that.
- It does not cover the contents of a plan (the `plan` skill owns that); it only covers where plans go and how they are referenced.

### Standing guidelines

- Brief, purposeful tone; declarative voice.
- The conventions documented here are the source of truth — the `learn`, `plan`, `blueprint`, and other skill-authoring skills reference this skill rather than restating its rules.
