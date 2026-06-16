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

## What you do not do

- Do not create, update, or retire learnings.
- Do not edit production code, run tests, or write session reports.
- Do not dispatch to individual learnings — the index file does that.

## Standing guidelines

- Keep the tone brief and purposeful; use declarative voice.
- The rules here are the source of truth — other learning-management skills reference this skill rather than restating them.
