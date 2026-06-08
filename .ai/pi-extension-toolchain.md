---
name: pi-extension-toolchain
description: TypeScript + ESLint + Prettier toolchain for this pnpm workspace — tsconfig hierarchy, ESLint config, script naming conventions, and key gotchas.
---

# Pi Extension Toolchain

## When to Use

When setting up or auditing the build toolchain for any package in this workspace.

## Key Facts

### tsconfig hierarchy

`tsconfig.base.json` at the repo root holds all shared `compilerOptions`. Each package's `tsconfig.json` extends it and adds only its own `include`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*"] }
```

Never put `compilerOptions` in a per-package tsconfig — put them in the base.

**Required options in the base:**

- `"module": "NodeNext"`, `"moduleResolution": "NodeNext"` — ESM with proper resolution.
- `"verbatimModuleSyntax": true` — enforces `import type` discipline.
- `"allowImportingTsExtensions": true` — lets tsc accept `.ts` suffixes in local imports (required because pi uses jiti, not tsc, to run extensions).
- `"noEmit": true` — tsc is type-check only; no build step.

**Strict options also in the base:**

- `"noUncheckedIndexedAccess": true` — `arr[0]` types as `T | undefined`. Use `!` at call sites where the invariant is known (array index into a non-empty result, regex captures after a successful match, etc.).
- `"noUnusedLocals": true`, `"noUnusedParameters": true` — compiler-level unused checks on top of ESLint.
- `"noFallthroughCasesInSwitch": true`
- `"forceConsistentCasingInFileNames": true`

### ESLint (`eslint.config.mjs`)

Single root config; globs `**/*.ts` so it covers all packages in one process.

Key settings:

```js
languageOptions: {
  parserOptions: {
    projectService: true,           // auto-finds each file's nearest tsconfig.json
    tsconfigRootDir: import.meta.dirname,
  },
},
rules: {
  "@typescript-eslint/no-unused-vars": ["error", {
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    caughtErrorsIgnorePattern: "^_",  // allows catch (_e) {}
  }],
  "@typescript-eslint/consistent-type-imports": ["error", {
    prefer: "type-imports", fixStyle: "separate-type-imports",
  }],
  "@typescript-eslint/no-non-null-assertion": "off",  // needed alongside noUncheckedIndexedAccess
}
```

Test file block (applied to `**/*.test.ts`): also disables `no-unsafe-assignment`, `no-unnecessary-type-assertion`, `unbound-method`.

Run with `--max-warnings=0` so warnings fail CI.

### Script naming conventions

| Script         | What it does                                                 |
| -------------- | ------------------------------------------------------------ |
| `typecheck`    | `tsc --noEmit`                                               |
| `lint`         | `eslint . --max-warnings=0`                                  |
| `format:check` | `prettier --check .` (readonly)                              |
| `format`       | `prettier --write .` (writes)                                |
| `test`         | `vitest run`                                                 |
| `check`        | `typecheck && format:check && lint && test` (root aggregate) |

Root `lint` runs `eslint . --max-warnings=0` directly — one process for the whole workspace, not `pnpm -r`. Per-package `lint` scripts still exist for scoped use.

`check` order: typecheck first (most severe), then format, lint, tests.

## Notes

- Run `pnpm run check` after **every** edit. Don't batch.
- `while (true)` loops trigger `@typescript-eslint/no-unnecessary-condition` — suppress with `// eslint-disable-next-line`.
- `async` handlers that don't `await` trigger `require-await` — suppress with a disable comment rather than adding a spurious `await`.
- Regex replace callbacks have `any`-typed capture params — annotate them: `(_m: string, branch: string, sha: string) =>`.
- `noUncheckedIndexedAccess` consequences: `result.content[0]!` (tool content array is always non-empty), `m[1]!` for regex captures, `entries[i]!` in indexed loops. The `no-non-null-assertion` rule is disabled globally for this reason.
- `consistent-type-imports` with `fixStyle: "separate-type-imports"` means `import { type Foo, Bar }` must become two lines: `import type { Foo }` and `import { Bar }`.
