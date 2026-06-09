---
name: skill-index-maintenance
description: Mandatory rule — every create/edit/delete of a .ai/*.md skill file must update the Skills section in AGENTS.md in the same change. Defines core vs secondary skill conventions.
---

# Skill Index Maintenance

## When to Use

Always, whenever any `.ai/*.md` skill file is created, edited, renamed, or deleted — including via `/learn`. Non-optional.

## Key Facts

### Skill storage location

Skills live in `.ai/` at the project root — **not** `.hax/skills/`. The `.ai/` directory is the canonical location for all **task-keyed** project knowledge (knowledge the agent loads when doing a specific task).

### Layer-keyed knowledge: `.rpiv/guidance/`

A second knowledge system lives at `.rpiv/guidance/`. It is **layer-keyed**, not task-keyed — it documents what the code looks like in each layer of the project. The root `.rpiv/guidance/architecture.md` is auto-loaded via `@` (same syntax as a core skill). Per-folder `architecture.md` files are listed in the root and read on demand when the agent enters that folder.

The two systems do not overlap:

- `.ai/*.md` is for "load this when doing X" (task-keyed, named, with `name`/`description` frontmatter).
- `.rpiv/guidance/*.md` is for "read this when working in folder Y" (location-keyed, no frontmatter).

The `.rpiv/guidance/` tree is **not** indexed in the Skills section and is **not** maintained by the steps below. It is maintained by the `annotate-guidance` skill workflow (Pass 1: map, Pass 2: analyze, Step 6: developer checkpoint, Step 7: draft, Step 9: write). Re-run that skill when architecture changes; do not edit `.rpiv/guidance/architecture.md` files ad-hoc — they are synthesized from codebase analysis plus developer input.

### Core vs secondary skills

**Core skills** are loaded automatically on every session via the `@` file-reference syntax that pi's context-preloader expands. List them in AGENTS.md as bare `@` references:

```markdown
@.ai/pi-extension-toolchain.md
@.rpiv/guidance/architecture.md
```

The `@` syntax works for any path to a file with an extension — `.ai/*.md` skills, `.rpiv/guidance/*.md` guidance, or any other markdown file. The preloader resolves paths relative to AGENTS.md's directory and recursively follows `@refs` in loaded files up to `MAX_DEPTH=5`.

**Secondary skills** are listed with a description of when to load them. They are NOT prefixed with `@` — agents read them on demand with the `read` tool when the described situation applies:

```markdown
- `.ai/pi-npm-publishing.md` — load when preparing packages for npm publication
- `.rpiv/guidance/` — read on demand when entering a package or layer; the root file lists what's available
```

Use core for knowledge that applies to almost every session. Use secondary for knowledge that's only relevant in specific circumstances (publishing, migrations, etc.).

### AGENTS.md Skills section format

```markdown
## Skills

**Core (always loaded):**

@.ai/<skill-a>.md
@.ai/<skill-b>.md
@.rpiv/guidance/architecture.md

**Secondary (load when relevant):**

- `.ai/<skill-c>.md` — load when [specific situation]
- `.rpiv/guidance/` — read on demand when [specific situation]
```

## Steps

1. After writing/editing/deleting any `.ai/*.md` skill, list all current `.ai/*.md` files.
2. Decide core vs secondary for any new skill.
3. Open `AGENTS.md` and replace the `## Skills` section with an updated list in the format above.
4. Keep core skills alphabetical. Keep secondary skills alphabetical.
5. Commit the skill file and `AGENTS.md` together — never one without the other.
6. **Do not edit `.rpiv/guidance/` files as part of this rule.** The guidance tree has its own maintenance workflow (annotate-guidance skill). If you need to update guidance, run that skill.

## Notes

- The `.hax/skills/` directory is the old location. Skills there are stale — do not read or update them; they will be deleted.
- Never prefix a secondary skill with `@` in AGENTS.md — the context-preloader would auto-load it, defeating the purpose of the secondary/on-demand distinction.
- Skill filenames: lowercase, hyphens only, 1-64 chars, match the `name` frontmatter field.
- The `@` reference regex in the context-preloader is `@[\w./\\-]+\.\w+` — it matches any path-like string with a file extension. It works for `.ai/*.md`, `.rpiv/guidance/*.md`, and any other markdown file path.
