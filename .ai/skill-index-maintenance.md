---
name: skill-index-maintenance
description: Mandatory rule — every create/edit/delete of a .ai/*.md skill file must update the Skills section in AGENTS.md in the same change. Defines core vs secondary skill conventions.
---

# Skill Index Maintenance

## When to Use

Always, whenever any `.ai/*.md` skill file is created, edited, renamed, or deleted — including via `/learn`. Non-optional.

## Key Facts

### Skill storage location

Skills live in `.ai/` at the project root — **not** `.hax/skills/`. The `.ai/` directory is the canonical location for all reusable project knowledge.

### Core vs secondary skills

**Core skills** are loaded automatically on every session via the `@` file-reference syntax that pi's context-preloader expands. List them in AGENTS.md as bare `@` references:

```markdown
@.ai/pi-extension-toolchain.md
@.ai/pi-npm-extension-package.md
```

**Secondary skills** are listed with a description of when to load them. They are NOT prefixed with `@` — agents read them on demand with the `read` tool when the described situation applies:

```markdown
- `.ai/pi-npm-publishing.md` — load when preparing packages for npm publication
```

Use core for knowledge that applies to almost every session. Use secondary for knowledge that's only relevant in specific circumstances (publishing, migrations, etc.).

### AGENTS.md Skills section format

```markdown
## Skills

**Core (always loaded):**

@.ai/<skill-a>.md
@.ai/<skill-b>.md

**Secondary (load when relevant):**

- `.ai/<skill-c>.md` — load when [specific situation]
```

## Steps

1. After writing/editing/deleting any `.ai/*.md` skill, list all current `.ai/*.md` files.
2. Decide core vs secondary for any new skill.
3. Open `AGENTS.md` and replace the `## Skills` section with an updated list in the format above.
4. Keep core skills alphabetical. Keep secondary skills alphabetical.
5. Commit the skill file and `AGENTS.md` together — never one without the other.

## Notes

- The `.hax/skills/` directory is the old location. Skills there are stale — do not read or update them; they will be deleted.
- Never prefix a secondary skill with `@` in AGENTS.md — the context-preloader would auto-load it, defeating the purpose of the secondary/on-demand distinction.
- Skill filenames: lowercase, hyphens only, 1-64 chars, match the `name` frontmatter field.
