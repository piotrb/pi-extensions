# Agent Guidelines — pi-core-tools

## After every edit, run the check command

**No exceptions.** After any change to a `.ts` or config file, run:

```sh
pnpm check
```

This runs `tsc --noEmit`, `prettier --check`, and `eslint` in sequence. Fix all errors before moving on. Do not batch edits and check at the end — run after each individual edit so failures are easy to localise.

If `pnpm check` is not available (e.g. `node_modules` not installed), run:

```sh
pnpm install
pnpm check
```

## Project structure

```
src/
  extensions/
    bfs.ts               — bfs tool extension
    context-preloader.ts — context preloader extension
    git.ts               — git_add / git_rm / git_commit tools
    ripgrep.ts           — ripgrep tool extension
    task-runner.ts       — task-runner tool extension
  lib/
    extension-utils.ts   — shared internal utility (spawnStreaming etc.)
```

Each file in `src/extensions/` exports a `default function (pi: ExtensionAPI): void` and is listed individually under `"pi": { "extensions": [...] }` in `package.json`.

## Key rules

- **Imports**: use `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` — never the old `@mariozechner/*` package names.
- **extension-utils**: import shared utilities with a relative path: `import { spawnStreaming } from "../lib/extension-utils.ts"`.
- **No barrel/index file**: extensions are listed directly in `package.json`, there is no `index.ts`.
- **Module style**: ESM only (`"type": "module"`). NodeNext module resolution — local imports keep `.ts` extensions (pi's runtime handles them via jiti).
- **Skills index**: Any change to `.hax/skills/` MUST update the Skills Index below in the same commit. See @.hax/skills/skill-index-maintenance.md.

## Skills Index

- @.hax/skills/pi-extension-toolchain.md — TypeScript + ESLint + Prettier toolchain setup for a pi extension npm package — tsconfig options, eslint config, check script order, and key gotchas.
- @.hax/skills/pi-npm-extension-package.md — How to structure a pi coding-agent extension as a publishable npm package — directory layout, package.json shape, pi manifest field, peer deps, and import conventions.
- @.hax/skills/skill-index-maintenance.md — Mandatory rule — every create/edit/delete of a .hax/skills/\*.md file must update the Skills Index in AGENTS.md in the same commit. Non-optional.
