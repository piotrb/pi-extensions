Write a skill that **encodes the conventions for managing a project's learning base**, so other skills can reference them in one place instead of restating them.

This is a **meta-skill**: it does not add, update, or remove learnings itself. It documents the rules that learning-management skills (and skill-authoring skills more broadly) are expected to follow.

### What this skill encodes

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

### What this skill does not do

- It does not create, update, or retire learnings.
- It does not edit production code, run tests, or write session reports.
- It does not dispatch to individual learnings — the index file does that.

### Standing guidelines

- Brief, purposeful tone; declarative voice.
- The conventions documented here are the source of truth — learning-management skills reference this skill rather than restating its rules.
