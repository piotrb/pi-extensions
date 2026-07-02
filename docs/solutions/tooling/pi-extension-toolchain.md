---
title: pi-extensions — toolchain (TypeScript + ESLint + Prettier + Turbo)
category: tooling
severity: high
tags:
  - toolchain
  - typescript
  - eslint
  - prettier
  - turbo
  - pnpm
applies_when:
  - setting up or auditing the build toolchain for any package in this repo
  - chasing a toolchain failure (type error, lint failure, format failure, test failure)
  - adding a new toolchain config to the root configs
  - wondering why a per-package tsconfig is missing compilerOptions
  - deciding whether a script belongs at the root or in a per-package package.json
---

# Problem

The repo's dev environment is a pnpm + turbo + TypeScript + ESLint + Prettier stack. The configurations are root-level and glob to all packages in one process. Without a single reference for what the toolchain looks like and why, every toolchain failure becomes a fresh investigation — and the gotchas (`noUncheckedIndexedAccess` requiring `!` at call sites, `verbatimModuleSyntax` requiring `import type` discipline, `//#` turbo task prefixes) recur.

# Context

The toolchain is intentional. The configs are root-level to keep the surface small; per-package overrides are avoided unless the package has a hard reason. The cost is that a change to a root config propagates to every package; the benefit is a single place to look. The environment is the development substrate, not the runtime — the runtime (jiti) is separate (see `pi-monorepo-overview` for the runtime side).

# Solution

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

- `"noUncheckedIndexedAccess": true` — `arr[0]` types as `T | undefined`. Use `!` at call sites where the invariant is known.
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

**Performance debugging:** set `TIMING=1` in the env to get a top-10 rule-by-rule time report. First-run time is dominated by the type-checked rules (`no-unsafe-assignment`, `no-unsafe-return`, `no-floating-promises`, `no-base-to-string`) — these can't be loosened without losing real safety.

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

# Why this works

- **Root-level configs collapse the surface.** One `tsconfig.base.json`, one `eslint.config.mjs`, one `.prettierrc`, one `turbo.json`. Every package inherits the same defaults; the only per-package overrides are `include` (tsconfig) and `typecheck`/`test` scripts (package.json). The flat toolchain means the agent can reason about one config and trust it applies everywhere.
- **Strict TypeScript options catch real bugs.** `noUncheckedIndexedAccess` makes `arr[0]` types as `T | undefined` — the cost is `!` at known-safe call sites; the benefit is that out-of-bounds accesses are caught at compile time. `verbatimModuleSyntax` enforces `import type` discipline — the cost is the discipline; the benefit is that tree-shaking and emit are correct.
- **Turbo's `//#` prefix marks root tasks.** `//#format:check` and `//#lint` run once at the root; `typecheck` and `test` fan out per package. The four tasks together form the canonical "did I break anything" check.
- **ESLint caching + Turbo caching stack.** ESLint's own cache (`--cache`) handles unchanged files; Turbo's task-output cache handles whole-task fingerprints. Together they make repeat invocations near-instant (warm: ~3s for the full `check`).

# Prevention

- **Run the relevant check after every edit. Don't batch.** The default `run` tool timeout (30s) is shorter than a full workspace check, so for single-package edits run the scoped Turbo filter (typically under 30s): `pnpm turbo run typecheck test --filter=<pkg>`. Use the full `pnpm run check` periodically (or before commit) to catch cross-package format/lint issues — pass an explicit timeout on cold caches.
- **`while (true)` loops** trigger `@typescript-eslint/no-unnecessary-condition` — suppress with `// eslint-disable-next-line`.
- **`async` handlers that don't `await`** trigger `require-await` — suppress with a disable comment rather than adding a spurious `await`.
- **Regex replace callbacks** have `any`-typed capture params — annotate them: `(_m: string, branch: string, sha: string) =>`.
- **`noUncheckedIndexedAccess` consequences:** `result.content[0]!` (tool content array is always non-empty), `m[1]!` for regex captures, `entries[i]!` in indexed loops. The `no-non-null-assertion` rule is disabled globally for this reason.
- **`consistent-type-imports` with `fixStyle: "separate-type-imports"`** means `import { type Foo, Bar }` must become two lines: `import type { Foo }` and `import { Bar }`.
- **This solution does not cover the per-package shape** (canonical `package.json`, `tsconfig.json`, etc.) — see `pi-package-scaffold`.
- **This solution does not cover the monorepo overview or the project map** — see `pi-monorepo-overview`.
- **This solution does not cover skill authoring or frontmatter rules** — see `pi-skill-frontmatter-colon-rule`.
