---
name: pi-extension-toolchain
description: TypeScript + ESLint + Prettier toolchain for this pnpm workspace — tsconfig hierarchy, ESLint config, script naming conventions, and key gotchas. Use when setting up or auditing the build toolchain for any package, or when chasing a toolchain failure.
---

You are setting up or auditing the build toolchain for any package in this workspace. The toolchain is pnpm + turbo on the outside, TypeScript + ESLint + Prettier on the inside. The configurations are root-level and glob to all packages in one process.

## tsconfig hierarchy

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

## ESLint (`eslint.config.mjs`)

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

**Caching:** the root `lint` script uses `--cache --cache-location .eslintcache/`. Repeat invocations on unchanged files complete in ~1.5s vs ~45s on a cold first run. Cache is auto-invalidated on `eslint.config.mjs` changes. The `.eslintcache/` directory is git-ignored. **Above that, Turbo caches the entire `//#lint` and `//#format:check` task outputs by file fingerprint** — see `turbo.json`. On a clean second `pnpm run check`, all 16 tasks replay from cache in ~3s.

**Performance debugging:** set `TIMING=1` in the env to get a top-10 rule-by-rule time report (e.g. `run(cmd: ["pnpm", "run", "lint"], env: { TIMING: "1" })`). First-run time is dominated by the type-checked rules (`no-unsafe-assignment`, `no-unsafe-return`, `no-floating-promises`, `no-base-to-string`) — these can't be loosened without losing real safety.

## Turbo task graph (`turbo.json`)

Single source of truth for the four developer-facing tasks:

| Task in `turbo.json` | Runs in     | Command source                               |
| -------------------- | ----------- | -------------------------------------------- |
| `//#format:check`    | root once   | root `package.json` → `format:check`         |
| `//#lint`            | root once   | root `package.json` → `lint`                 |
| `typecheck`          | per-package | each `packages/*/package.json` → `typecheck` |
| `test`               | per-package | each `packages/*/package.json` → `test`      |

The `//` prefix marks a **root task** — runs once at the repo root, not per package. The `#` separates the package identifier from the script name. `//` resolves to "the root package itself"; no-prefix resolves to "every workspace package that has a matching script".

**Commands live in `package.json`**, not `turbo.json`. To change a command, edit the script in the relevant `package.json`; `turbo.json` is unaffected. `turbo.json` only declares task name, cache config, and inputs (what files, if changed, invalidate the cache).

**Per-package scripts** are intentionally minimal: only `typecheck` and `test` survive in each `packages/*/package.json`. `format`/`format:check`/`lint` are root-only and don't need per-package duplicates.

**Single-package check:** `pnpm turbo run typecheck test --filter=<pkg>`. Format+lint still need the full `pnpm run check` because they're root-globbed.

## Script naming conventions

| Script         | What it does                                              |
| -------------- | --------------------------------------------------------- |
| `typecheck`    | root: `pnpm turbo typecheck`; per-package: `tsc --noEmit` |
| `lint`         | root: `eslint . --max-warnings=0 --cache ...` (root only) |
| `format:check` | root: `prettier --check .` (root only)                    |
| `format`       | root: `prettier --write .` (root only)                    |
| `test`         | root: `pnpm turbo test`; per-package: `vitest run`        |
| `check`        | root: `pnpm turbo //#format:check //#lint typecheck test` |

`check` is the canonical "run everything" command. It invokes all four Turbo tasks; the first two are root-level singletons, the latter two fan out per package. Cache hits make subsequent runs near-instant.

## Notes

- Run the relevant check after **every** edit. Don't batch. The default `run` tool timeout (30s) is shorter than a full workspace check, so for single-package edits run the scoped Turbo filter (typically under 30s): `run(cmd: ["pnpm", "turbo", "run", "typecheck", "test", "--filter", "<pkg>"])`. Use the full `pnpm run check` periodically (or before commit) to catch cross-package format/lint issues — it can exceed 30s on a cold cache, so prefer the scoped approach during iteration.
- `while (true)` loops trigger `@typescript-eslint/no-unnecessary-condition` — suppress with `// eslint-disable-next-line`.
- `async` handlers that don't `await` trigger `require-await` — suppress with a disable comment rather than adding a spurious `await`.
- Regex replace callbacks have `any`-typed capture params — annotate them: `(_m: string, branch: string, sha: string) =>`.
- `noUncheckedIndexedAccess` consequences: `result.content[0]!` (tool content array is always non-empty), `m[1]!` for regex captures, `entries[i]!` in indexed loops. The `no-non-null-assertion` rule is disabled globally for this reason.
- `consistent-type-imports` with `fixStyle: "separate-type-imports"` means `import { type Foo, Bar }` must become two lines: `import type { Foo }` and `import { Bar }`.

## What this skill does not do

- It does not cover the per-package shape (canonical `package.json`, `tsconfig.json`, etc.) — see `pi-package-scaffold`.
- It does not cover the monorepo overview or the project map — see `pi-monorepo-overview`.
- It does not cover skill authoring or frontmatter rules — see `pi-skill-frontmatter-colon-rule` and the `learn` skill.
