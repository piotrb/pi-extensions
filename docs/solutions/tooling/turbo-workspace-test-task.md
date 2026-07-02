---
title: "turbo workspace test task (//#test:workspace)"
category: tooling
severity: medium
tags:
  - turbo
  - turbo-task
  - vitest
  - workspace
  - test-task
  - root-task
  - cache
applies_when:
  - adding a workspace-level test (e.g. an audit of docs/, a fixture check) that should run with `pnpm run check`
  - wiring a turbo root task that runs a script at the repo root (not per-package)
  - debugging the "recursive turbo invocations" error
  - deciding whether a new test belongs in a workspace package or at the root
---

# Problem

When adding a workspace-level test (e.g. an audit that walks `docs/solutions/`, a fixture consistency check) that should run as part of `pnpm run check`, the agent needs to wire it as a turbo root task — not as a side script. Turbo's task graph gives parallel execution, incremental builds, and cache hits by file inputs. A side script that runs after turbo completes doesn't get any of these benefits and adds an awkward `&&` to the check command.

# Context

Turbo's task model distinguishes root tasks (run once at the repo root) from per-package tasks (run in every workspace package that has the script). Root tasks have the `//#` prefix in their task name; the `//` resolves to "the root package itself" and `#` separates the package identifier from the script name. Per-package tasks have no prefix; they run in every workspace package that has a matching script.

The check command in a pnpm + turbo + vitest workspace is typically `pnpm turbo //#format:check //#lint typecheck test && <other>`. Adding a workspace-level test as a side script after `&&` is fragile and breaks the turbo cache model.

# Solution

## The 3-part shape

A workspace test task has three parts:

### 1. `turbo.json` task definition

```json
"//#test:workspace": {
  "cache": true,
  "inputs": ["tests/**", "tsconfig.json", "tsconfig.base.json", "package.json"]
}
```

The `//#` prefix marks it as a root task. The `inputs` define the cache key — turbo hashes these files; if the hash matches the cached run, the task is skipped.

### 2. `package.json` script

```json
{
  "scripts": {
    "test:workspace": "vitest run tests/"
  }
}
```

The script name (without the `//#` prefix) matches the turbo task name (with the prefix). The script is a **direct command** — it does NOT call turbo. Calling turbo from the script creates a recursive invocation and turbo errors out with "Your `package.json` script looks like it invokes a Root Task".

### 3. `package.json` check command

```json
{
  "scripts": {
    "check": "pnpm turbo //#format:check //#lint //#test:workspace typecheck test"
  }
}
```

The `//#test:workspace` joins the other root tasks (`//#format:check`, `//#lint`) and the per-package tasks (`typecheck`, `test`). Turbo orchestrates all five in parallel, with caching by file inputs.

## The pattern matches the existing root tasks

The existing root tasks follow the same shape:

```json
"//#format:check": {
  "cache": true,
  "inputs": ["**/*.{ts,js,mjs,cjs,jsx,tsx,json,md,yml,yaml}", ".prettierignore", "prettier.config.*", ".prettierrc*"]
},
"//#lint": {
  "cache": true,
  "inputs": ["**/*.{ts,js,mjs,cjs,jsx,tsx}", "eslint.config.*", "eslint.config.mjs", ".eslintignore"]
}
```

The `format:check` and `lint` scripts in `package.json` are direct commands (`prettier --check .` and `eslint . ...` respectively). The turbo tasks invoke the scripts. Same pattern for `//#test:workspace`.

# Why this works

- **Turbo orchestrates all 5 tasks in parallel.** The check command becomes a single turbo invocation that runs format, lint, workspace test, per-package typecheck, and per-package test with dependency tracking. Cache hits make repeat invocations near-instant.
- **The cache key matches the test's inputs.** A no-op iteration reuses the cache; a changed test re-runs. The `inputs` array in `turbo.json` defines what's watched.
- **The script is a direct command.** No recursion. Turbo calls the script; the script runs vitest; vitest runs the test. Three layers, no cycles.

# Prevention

- **Don't make the script call turbo.** `pnpm turbo //#test:workspace` in the script would create a recursive invocation. Use the direct command: `vitest run tests/`.
- **Don't put workspace tests in a workspace package's `test` script.** Per-package `test` scripts run in every workspace package that has them. Workspace tests belong at the root, not in a package.
- **Don't use `dependsOn` for root tasks that don't have a real dependency.** The root tasks are independent (format, lint, workspace test) and can run in parallel. `dependsOn` adds latency without value.
- **Don't include files outside the test's scope in `inputs`.** The cache key is the hash of all input files. Extra files in `inputs` invalidate the cache when those files change, even if the test doesn't depend on them. Keep `inputs` minimal and accurate.
- **Don't forget to add the task to the `check` command.** A `//#test:workspace` task that isn't in `check` won't run. The full check is the contract.
- **Don't run the audit test as a per-package test.** Per-package tests run in each workspace package; the workspace test runs at the root. The shape of the test (workspace-level vs. package-level) determines the location.

# Verification

After adding a workspace test:

1. `pnpm test:workspace` runs the test directly (cache-warm ~300ms for a small test suite).
2. `pnpm run check` runs the full turbo check, including the new task.
3. `pnpm turbo //#test:workspace` runs just the new task (useful for debugging).
4. `git status` shows the new `tests/` directory, the new `tsconfig.json` if any, the new script in `package.json`, and the new task in `turbo.json`.

# Related

- `pi-extension-toolchain` covers the broader toolchain (TypeScript, ESLint, Prettier, Turbo). This solution is a focused extension: the workspace-test pattern within the turbo task graph.
- `pi-monorepo-overview` covers the project map. The workspace test is one tool in the verification set.
- `pi-package-hard-rules` covers per-package invariants. The workspace test complements these by checking cross-cutting concerns that don't fit in any single package.
