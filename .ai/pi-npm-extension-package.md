---
name: pi-npm-extension-package
description: How to structure a pi coding-agent extension as a publishable npm package in this monorepo — directory layout, package.json shape, pi manifest field, workspace dependencies, and import conventions.
---

# Pi Extension npm Package Structure

## When to Use

When adding a new extension package to this workspace, or auditing an existing one.

## Key Facts

### Monorepo layout

Every extension lives at `packages/pi-<name>/`, following the `pi-` prefix convention:

```
packages/pi-<name>/
  src/
    extensions/
      <name>.ts      ← extension entry point
    lib/             ← internal helpers (only if needed; don't create preemptively)
  plans/             ← future plans / migration notes (markdown, not shipped)
  package.json
  tsconfig.json
  README.md
```

Extension files export `default function (pi: ExtensionAPI): void`.
There is no barrel/index file — extension entry points are listed directly in `pi.extensions`.

### package.json shape

```json
{
  "name": "pi-<name>",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22 <25" },
  "files": ["src/**/*.ts", "!src/**/*.test.ts", "README.md"],
  "pi": { "extensions": ["./src/extensions/<name>.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "dependencies": {
    "pi-extension-utils": "workspace:*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --max-warnings=0",
    "test": "vitest run"
  },
  "devDependencies": { ... }
}
```

- Trim `peerDependencies` to only what the source actually imports — `context-preloader` doesn't need `@earendil-works/pi-tui`, for example.
- Only add `"pi-extension-utils": "workspace:*"` to `dependencies` if the extension imports from it.
- Self-contained extensions (no spawn/process utilities) need no `dependencies` at all.

### Shared utilities

Import spawn utilities via the package specifier, not a relative path:

```ts
import { spawnStreaming, progressiveKill } from "pi-extension-utils"
```

The workspace symlinks `pi-extension-utils` so this resolves at development time.
At publish time, `pi-extension-utils` must also be published to npm (it's a runtime dependency).

### tsconfig.json

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*"] }
```

Never duplicate `compilerOptions` — everything lives in `tsconfig.base.json` at the workspace root.

### Local relative imports

Keep `.ts` extensions on all local relative imports:

```ts
import { checkRules } from "../lib/permissions.ts"
```

pi's jiti runtime handles `.ts` resolution; `allowImportingTsExtensions: true` in tsconfig makes tsc accept them too.

### pi.extensions vs tool name

The `pi.extensions` path is how pi _loads_ the file. The tool _name_ registered inside (via `pi.registerTool({ name: "..." })`) is what the agent calls. These can differ — `pi-ripgrep` loads `ripgrep.ts` but registers as `name: "ripgrep"`. Packages that replace built-in tools register under the built-in's name (e.g., `name: "grep"`).

## Notes

- `plans/` folder is for internal planning docs — not shipped (excluded from `files`). Add a `plans/` entry to `files` exclusions or just don't include it: since `files` is an allowlist (`src/**/*.ts` + `README.md`), `plans/` is automatically excluded.
- `packages/pi-bfs` is `"private": true` pending migration to `pi-fd`. Don't publish it.
- The workspace root (`pi-extensions`) is always `"private": true`.
