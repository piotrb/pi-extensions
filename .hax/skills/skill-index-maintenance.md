---
name: skill-index-maintenance
description: Mandatory rule — every create/edit/delete of a .hax/skills/*.md file must update the Skills Index in AGENTS.md in the same commit. Non-optional.
user-invocable: false
---

# Skill Index Maintenance

## When to Use

ALWAYS, whenever any file in `.hax/skills/` is created, edited, renamed, or deleted — including via `/learn`. This is a non-optional discipline tied to skill mutations.

## Steps

1. After writing/editing/deleting any `.hax/skills/*.md` file, list current skills.
2. For each skill, extract the one-line description from its frontmatter `description:` field.
3. Open `AGENTS.md` at the project root and replace the `## Skills Index` section with an alphabetized list of all current skills in this exact format:

   ```markdown
   ## Skills Index

   - @.hax/skills/<filename>.md — <one-line description>
   ```

4. If `## Skills Index` does not exist yet in `AGENTS.md`, append it as a new top-level section after the existing content.
5. Stage `AGENTS.md` together with the skill change in the same commit. Never commit a skill change without the index update.

## Notes

- The `@` prefix is intentional — it's the pi/Claude file-reference syntax that auto-loads the file when AGENTS.md is read.
- The index must reflect actual filesystem state, not a curated subset.
- Alphabetical order is enforced for deterministic diffs.
- If a skill file lacks a frontmatter `description`, add one rather than synthesizing an index line.
