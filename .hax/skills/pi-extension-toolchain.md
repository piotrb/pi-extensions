---
name: pi-extension-toolchain
description: TypeScript + ESLint + Prettier toolchain setup for a pi extension npm package — tsconfig options, eslint config, check script order, and key gotchas.
---

# Pi Extension Toolchain

## When to Use

When setting up or auditing the build toolchain for a pi extension package.

## Key Facts

**tsconfig.json essentials:**

- `"module": "NodeNext"`, `"moduleResolution": "NodeNext"` — required for proper ESM resolution.
- `"verbatimModuleSyntax": true` — enforces `import type` discipline.
- `"allowImportingTsExtensions": true` — lets tsc accept `.ts` suffixes in local imports (required because pi uses jiti, not tsc, to run extensions).
- `"noEmit": true` — tsc is type-check only; no `tsconfig.build.json` needed.
- `"include": ["src/**/*"]` — no `index.ts` since there is none.

**eslint.config.mjs:**

- `typescript-eslint` with `strictTypeChecked` + `stylisticTypeChecked`.
- `eslint-plugin-simple-import-sort` for import ordering.
- `eslint-config-prettier` last to suppress style conflicts.
- `no-unused-vars`: set `argsIgnorePattern: "^_"` and `varsIgnorePattern: "^_"` so `_pi`-style params are allowed.

**check script order — severity first:**

```json
"check": "pnpm typecheck && pnpm format && pnpm lint"
```

Type errors are most severe; fail fast before spending time on style.

**Individual scripts:**

```json
"typecheck":     "tsc --noEmit",
"lint":          "eslint .",
"lint:fix":      "eslint . --fix",
"format":        "prettier --check .",
"format:write":  "prettier --write ."
```

## Notes

- Run `pnpm run check` after **every** edit. Don't batch edits and check at the end — run after each change so failures are easy to localise.
- `while (true)` loops trigger `@typescript-eslint/no-unnecessary-condition` — suppress with `// eslint-disable-next-line`.
- `async` handlers that don't `await` trigger `require-await` — if the API requires `Promise<void>`, suppress with disable comment rather than adding a spurious `await Promise.resolve()`.
- Regex replace callbacks have `any`-typed capture params — annotate them explicitly: `(_m: string, branch: string, sha: string) =>`.
- Optional chaining on values that TypeScript considers non-nullish (e.g. `content?.type` where `content` is `T` not `T | undefined`) triggers `no-unnecessary-condition` — remove the `?`.
