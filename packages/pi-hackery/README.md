# @piotrb/pi-hackery

Sandbox package for experimental pi tooling, utilities, and skills.

## Status

Empty — no source code, no `pi.extensions` registered. This package exists as a
scaffolding for upcoming work and as a home for skills/agents/bases that don't
yet ship with a real extension.

## Skills location

Skills for this package live in [`./skills/`](./skills), not in `.agents/skills/`.
The `pi.skills` field in `package.json` declares that path:

```jsonc
"pi": {
  "skills": "./skills"
}
```

A sub-directory per skill follows the canonical `.ai/<name>/SKILL.md` shape
(see `AGENTS.md` at the repo root for the rules around `.ai/` skills — the
`./skills/` tree here uses the same `SKILL.md` frontmatter, just under a
package-local root).

## What goes here

- Experimental tools that aren't yet ready for a dedicated `pi-<name>` package.
- Skills, agent personas (`./bases/agents/`), and skill bases (`./bases/skills/`)
  shared across the workspace.
- Shared `.agents/skills/` utilities (e.g. `update-skill/`) used to maintain the
  skills tree.

## Scripts

```sh
pnpm --filter @piotrb/pi-hackery run typecheck
pnpm --filter @piotrb/pi-hackery run test
```
