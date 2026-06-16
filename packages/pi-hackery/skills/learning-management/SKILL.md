---
name: learning-management
description: Document the conventions for managing a project's learning base — storage layout, dispatch index format, index-sync procedure, and the AGENTS.md reference convention. Meta-skill, it does not add, update, or remove learnings itself. Reference this from other learning-management and skill-authoring skills instead of restating the rules.
---

You are the reference for the project's learning-base conventions. Other skills load you to learn the rules; you do not act on learnings yourself.

## Storage layout

Store each learning as a skill file at `.agents/skills/<name>/SKILL.md` with proper skill frontmatter (`name` and `description`).

## Naming

The folder name and the `name` frontmatter field are the same string. Name the skill after the **concept**, not the first instance. Ask "would I still pick this name if I'd seen the rule from a different trigger?" If the answer is no, the name leaks scope. For package-specific rules where the package is the concept, naming after the package is correct.

## Dispatch index

Maintain a single index file at `.agents/learning-index.md` listing every learning. Each entry is **slightly more detailed than the skill's own `description`** — one short paragraph explaining what the skill does and under what circumstances to use it, so a reader can route without loading the skill itself.

## Index-sync procedure

After **any** edit to a learning (create, update, or retire), review `.agents/learning-index.md` and update the matching entry — add, modify, or remove as needed. The index is a derived artifact and must never be left inconsistent with the skills it dispatches to.

## AGENTS.md reference

The dispatch index is referenced from `AGENTS.md`'s Skills section as `@.agents/learning-index.md` — a single `@`-reference, no summary, no per-skill list. `AGENTS.md` does not duplicate the index; the `@` reference is the entry point.

## `@`-reference paths are relative to the containing file

`@`-reference paths are always relative to the file containing the reference, not the project root. The context-preloader resolves every `@`-reference against the directory of that file, then recursively into each loaded file (up to `MAX_DEPTH=5`, deduped). There is no global address space; the path is always local to the containing file. The three canonical shapes are:

- From `AGENTS.md` (project root) to the index: `@.agents/learning-index.md`.
- From `.agents/learning-index.md` to a core skill: `@skills/<name>/SKILL.md` (the index lives in `.agents/`, so `skills/...` resolves to `.agents/skills/<name>/SKILL.md`).
- From one skill at `.agents/skills/<this>/SKILL.md` to a sibling skill: `@../<other>/SKILL.md` (climb out of the current skill's folder, then descend into the sibling).

Writing `@.agents/skills/<other>/SKILL.md` inside any skill at `.agents/skills/<this>/SKILL.md` is a bug — the preloader resolves it to `.agents/skills/<this>/.agents/skills/<other>/SKILL.md` and logs it as unreadable. The same doubled-prefix trap applies anywhere a reference is written with a path rooted higher than the containing file.

## `@`-references are for preloading, not for "see also" pointers

The context-preloader follows every `@`-reference it finds. A `@`-reference to a sibling skill pulls that skill's body into the system prompt at session start. That is the wrong tool for "the agent may also want to know about this" — a `Related` section (or any inline "see also" pointer in skill prose) is **not** a preload directive, it is a dispatch hint. Write the pointer as a backtick-quoted skill name (`` `<skill-name>` ``) and let the agent consult the index and load on demand. The index is the only hub; skills do not preload their siblings.

## What you do not do

- Do not create, update, or retire learnings.
- Do not edit production code, run tests, or write session reports.
- Do not dispatch to individual learnings — the index file does that.

## Standing guidelines

- Keep the tone brief and purposeful; use declarative voice.
- The rules here are the source of truth — other learning-management skills reference this skill rather than restating them.
