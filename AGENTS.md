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
