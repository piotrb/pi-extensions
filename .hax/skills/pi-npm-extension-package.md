---
name: pi-npm-extension-package
description: How to structure a pi coding-agent extension as a publishable npm package — directory layout, package.json shape, pi manifest field, peer deps, and import conventions.
---

# Pi Extension npm Package Structure

## When to Use

When setting up a new pi extension project or converting loose `.ts` extension files into a proper package.

## Key Facts

- Pi discovers extensions via `"pi": { "extensions": [...] }` in `package.json` — each entry is a path to a `.ts` file that exports `default function (pi: ExtensionAPI): void`.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are **peer deps** (and also devDeps for local type-checking). Never use the old `@mariozechner/*` package names.
- `typebox` (the unscoped package, not `@sinclair/typebox`) is what pi bundles. Declare it as both a peer dep and a devDep.
- There is **no barrel/index file** — extension files are listed directly in `pi.extensions`. This avoids an unnecessary aggregation layer.
- Shared internal utilities go in `src/lib/`; actual extension entry points go in `src/extensions/`.
- Local relative imports keep the `.ts` extension — pi's jiti runtime handles them. With `allowImportingTsExtensions: true` in tsconfig, tsc accepts them too.

## Steps

1. Create `package.json` with `"type": "module"` and list each extension under `"pi": { "extensions": [...] }`.
2. Put extension files in `src/extensions/`, shared utilities in `src/lib/`.
3. Declare `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` as peer deps + devDeps.
4. Import shared utilities with relative `.ts` paths: `import { spawnStreaming } from "../lib/extension-utils.ts"`.
5. Each extension file: `export default function (pi: ExtensionAPI): void { ... }`.

## Notes

- `extension-utils.ts` (or any `src/lib/` file) must still export a default no-op if pi's loader scans all files — but if it's not listed in `pi.extensions`, the default export is not required.
- `files` in `package.json` should include `src/**/*.ts` and exclude `src/**/*.test.ts`.
- Example `pi.extensions` array:
  ```json
  "pi": {
    "extensions": [
      "./src/extensions/bfs.ts",
      "./src/extensions/git.ts"
    ]
  }
  ```
