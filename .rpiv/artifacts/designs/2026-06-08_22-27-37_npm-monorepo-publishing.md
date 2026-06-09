---
date: 2026-06-08T22:27:37+0000
author: Piotr Banasik
commit: f2c8927
branch: main
repository: pi-extensions
topic: "npm monorepo publishing with changesets + OIDC trusted publishing"
tags: [design, publishing, changesets, npm, ci, monorepo]
status: ready
parent: ""
last_updated: 2026-06-08T22:52:33+0000
last_updated_by: Piotr Banasik
last_updated_note: "Fix piotr → piotrb typo in 5 sites and add @piotrb/ scope to 6 package names"
---

# Design: npm Monorepo Publishing with Changesets + OIDC

## Summary

Set up an automated npm publishing pipeline for the `@piotrb/pi-*` monorepo. `@changesets/cli` at the workspace root drives per-package versioning and changelogs; `changesets/action@v1` opens a "Version Packages" PR on each push to main; merging that PR triggers `pnpm changeset publish` via npm Trusted Publishing (OIDC) — no long-lived `NPM_TOKEN` secret.

## Requirements

- Each publishable package ends up on npm under the `@piotrb` personal scope, with `access: "public"`.
- Releases go through a reviewable "Version Packages" PR — version bumps and changelogs visible before publish.
- GitHub Actions publishes via OIDC. No token rotation, no GitHub secret leak.
- `pi-bfs` stays `private: true` (deferred migration to `pi-fd`).
- `pi-extension-utils` ships to npm as a real package — required for the 4 extensions that depend on it.
- `pi install npm:@piotrb/pi-git` works end-to-end after the artifact lands.

## Current State Analysis

- **Workspace layout**: pnpm workspace, 7 packages under `packages/`, all hardcoded at `0.1.0`.
- **Source shipping**: every package ships `.ts` source via `"files": ["src/**/*.ts", "!src/**/*.test.ts", "README.md"]`; no build step. Pi loads extensions via jiti at runtime.
- **Internal dep graph**: `pi-extension-utils` is a runtime dep of `pi-bfs`, `pi-git`, `pi-ripgrep`, `pi-task-runner`. When a user installs `@piotrb/pi-git` from npm, npm needs to resolve `pi-extension-utils` from the registry — it must be published.
- **Metadata gaps**: no `publishConfig`, `repository`, `bugs`, `homepage`, or `keywords` in any of the 7 package.json files. Scoped packages default to private; `pnpm publish` will fail without `publishConfig.access: "public"`.
- **No automation**: no `.changeset/`, no `.github/workflows/`, no `.npmrc`. Existing `.gitignore` is minimal (just `node_modules/` + a pi-task-list state file).
- **Pre-existing skill** at `.ai/pi-npm-publishing.md` documents the `@piotrb` scope and `publishConfig.access: "public"` intent, but explicitly says _"No changesets or release automation is configured yet. Versioning is manual for now."_ — that text needs to be replaced.

### Key Discoveries

- **`pnpm-workspace.yaml`** — `packages: ["packages/*"]`. Single root, no further subdivision.
- **Root `package.json`** — `"packageManager": "pnpm@10.33.4"`, scripts include `typecheck`, `lint`, `format`, `format:check`, `test`, and an aggregate `check`. No `changeset`/`version`/`release` scripts yet.
- **`pi-bfs`** — `"private": true`, full `pi.extensions` registration, but description says "pending migration to pi-fd". The remaining 6 packages have no `private` flag and are the publishable set.
- **`tsconfig.base.json`** — shared across all packages; not affected by this design.

## Scope

### Building

- `@changesets/cli` + `@changesets/changelog-github` as root devDeps.
- `.changeset/config.json` + `.changeset/README.md` (generated boilerplate).
- Root scripts: `changeset`, `version`, `release`.
- Per-package publish metadata on the 6 publishable packages (pi-extension-utils, pi-context-preloader, pi-git, pi-pfs, pi-ripgrep, pi-task-runner).
- `.github/workflows/ci.yml` — runs `pnpm check` on PRs and pushes to main.
- `.github/workflows/release.yml` — opens/updates the "Version Packages" PR via `changesets/action@v1`; on merge, publishes via OIDC.
- `.gitignore` — add `.changeset/pre.json`.
- Updated skill at `.ai/pi-npm-publishing.md` reflecting the new automation.

### Not Building

- A Trusted Publisher onboarding script — the one-time per-package config on npmjs.com is a manual step the developer performs after the artifact lands.
- The actual first manual `pnpm -r publish --access public` — done by the developer after the artifact lands; documented in the updated skill.
- `pnpm pack` artifacts or a `dist/` output — packages continue to ship source, unchanged.
- A "build" script in release.yml — there is no build to run. Source shipping is the design.
- Fixed versioning across all packages — they evolve independently per the locked decision.
- An npm org subscription — `@piotrb` personal scope is free and matches the existing skill.
- Bundle/pre-publish steps (esbuild, etc.) — not needed; the perfectbase pattern's pre-publish `pnpm build` doesn't apply here.

## Decisions

### 1. Use changesets for per-package versioning

**Decision**: `@changesets/cli` at the workspace root. Developer runs `pnpm changeset` in each PR, picks affected packages + bump type, commits the generated `.changeset/<name>.md`. The action opens a "Version Packages" PR; merging it runs `pnpm changeset version` (bumps + writes CHANGELOG.md) then `pnpm changeset publish` (ships to npm).

**Why**: Each extension evolves at its own cadence — `pi-extension-utils` follows platform/runtime changes, `pi-git`/`pi-task-runner` iterate frequently, `pi-context-preloader` is mostly stable. A shared version would force unnecessary bumps on stable packages. `updateInternalDependencies: "patch"` keeps downstream packages in lockstep when shared infra bumps — critical for `pi-extension-utils`.

### 2. Use npm Trusted Publishing (OIDC), not NPM_TOKEN

**Decision**: Configure a Trusted Publisher on each package at npmjs.com pointing at `piotrb/pi-extensions` + workflow filename `release.yml`. The workflow sets `NPM_TOKEN: ""` to force OIDC. Workflow `permissions` include `id-token: write`.

**Why**: OIDC is generally available on npm since July 2025 (npm CLI 11.5.1+). No long-lived secret in GitHub → no rotation, no leak surface. Matches the `perfectbase/monorepo-package-template` pattern. Provenance is generated automatically by npm when publishing via OIDC — no `--provenance` flag needed.

**Caveat**: requires the developer to enable 2FA on the npm account, and to seed each package manually (one-time `pnpm -r publish --access public`) before the first OIDC publish can succeed.

### 3. Use the `@piotrb` personal scope, no npm org

**Decision**: All packages publish under `@piotrb/pi-*`. No npm org subscription.

**Why**: Free, matches the existing `.ai/pi-npm-publishing.md` skill, fits a solo-maintainer model. If collaborators ever need to publish, the migration path is to move to an org scope.

### 4. Per-package metadata, not a shared template

**Decision**: Each package.json gets its own `publishConfig`, `repository`, `bugs`, `homepage`, `keywords`, `author`. No shared template file (a `package.template.json` would add indirection without benefit for 6 small files).

**Why**: `publishConfig` is a per-package npm field, not a workspace-level construct. pnpm does not propagate it from root. Direct editing keeps the per-package metadata readable in git diffs.

### 5. Use `@changesets/changelog-github` for changelog rendering

**Decision**: Install `@changesets/changelog-github`. Configure `.changeset/config.json` with `changelog: ["@changesets/changelog-github", { "repo": "piotrb/pi-extensions" }]`.

**Why**: Default `@changesets/cli/changelog` produces plain markdown. The github renderer resolves PR numbers and commit SHAs into clickable links in the generated `CHANGELOG.md`, which is the only useful way to navigate a multi-package changelog.

### 6. CI runs `pnpm check`

**Decision**: `.github/workflows/ci.yml` runs on PR + push to main: checkout → `pnpm/action-setup` → `actions/setup-node` (node 24, pnpm cache) → `pnpm install --frozen-lockfile` → `pnpm check`.

**Why**: `pnpm check` is the project-defined aggregate (typecheck + format + lint + test). One command, all gates.

### 7. Release workflow uses `changesets/action@v1`

**Decision**: `.github/workflows/release.yml` runs on push to main with `concurrency: release-${{ github.ref }}, cancel-in-progress: false`. Steps: checkout → pnpm/node setup → `pnpm install --frozen-lockfile` → `changesets/action@v1` with `version: pnpm -s run version` and `publish: pnpm run release`. Permissions: `contents: write`, `pull-requests: write`, `id-token: write`. Env: `GITHUB_TOKEN` (auto) + `NPM_TOKEN: ""`.

**Why**: The official action handles both halves of the loop — opening/updating the "Version Packages" PR on changesets PR merges, then publishing on the version PR merge. `cancel-in-progress: false` is intentional: an in-flight release should finish, not get cancelled by a follow-up push. `setup-node` `registry-url: https://registry.npmjs.org` is required so the action writes auth to the correct registry.

## Architecture

### `package.json` (root) — MODIFY

**Purpose**: install changesets, add the three scripts the action and developer invoke.

```json
{
  "name": "pi-extensions",
  "version": "0.1.0",
  "description": "Pi extensions: bfs, ripgrep, git, task-runner, context-preloader, pfs.",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": {
    "node": ">=22 <25"
  },
  "packageManager": "pnpm@10.33.4",
  "scripts": {
    "changeset": "pnpm changeset",
    "version": "pnpm changeset version",
    "release": "pnpm changeset publish",
    "typecheck": "pnpm -r run typecheck",
    "lint": "eslint . --max-warnings=0",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "pnpm -r run test",
    "check": "pnpm run typecheck && pnpm run format:check && pnpm run lint && pnpm run test"
  },
  "devDependencies": {
    "@changesets/changelog-github": "^0.5.0",
    "@changesets/cli": "^2.27.0",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@types/minimist": "^1.2.5",
    "@types/node": "^22",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^9.0.0",
    "eslint-plugin-simple-import-sort": "^12.0.0",
    "prettier": "^3.0.0",
    "typebox": "^1.1.38",
    "typescript": "5.9.3",
    "typescript-eslint": "^8.0.0",
    "vitest": "^4.1.7"
  }
}
```

### `.changeset/config.json` — NEW

**Purpose**: changesets configuration.

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.2.0/schema.json",
  "changelog": ["@changesets/changelog-github", { "repo": "piotrb/pi-extensions" }],
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

### `.changeset/README.md` — NEW

**Purpose**: Upstream-generated boilerplate that documents the changesets workflow for contributors. Content is the stock `pnpm changeset init` output.

```markdown
# Changesets

Hello and welcome! This folder has been automatically generated by `@changesets/cli`, a build tool that works
with multi-package repos, or single-package repos to help version and publish your code. You can
find the full documentation for it [in our repository](https://github.com/changesets/changesets)

We have a quick list of common questions to get you started engaging with this project in
[our documentation](https://github.com/changesets/changesets/blob/master/docs/common-questions.md)
```

### `.gitignore` — MODIFY

**Purpose**: keep `.changeset/pre.json` (a transient file written when entering changesets pre-release mode) out of git.

```gitignore
node_modules/
.pi/pi-task-list/state.json
.changeset/pre.json
```

### `packages/pi-extension-utils/package.json` — MODIFY

**Purpose**: add the fields npm needs to publish this as `@piotrb/pi-extension-utils` publicly.

```json
{
  "name": "@piotrb/pi-extension-utils",
  "version": "0.1.0",
  "description": "Shared utilities for pi extensions — spawnStreaming, progressiveKill, scheduleProcessTimeout.",
  "type": "module",
  "license": "MIT",
  "author": "Piotr Banasik",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/piotrb/pi-extensions.git"
  },
  "bugs": {
    "url": "https://github.com/piotrb/pi-extensions/issues"
  },
  "homepage": "https://github.com/piotrb/pi-extensions#readme",
  "engines": {
    "node": ">=22 <25"
  },
  "main": "./src/extension-utils.ts",
  "types": "./src/extension-utils.ts",
  "exports": {
    ".": "./src/extension-utils.ts"
  },
  "files": ["src/**/*.ts", "!src/**/*.test.ts", "README.md"],
  "keywords": ["pi-package", "pi", "pi-coding-agent", "extension", "pi-extension-utils"],
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --max-warnings=0",
    "test": "vitest run"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@types/node": "^22",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^9.0.0",
    "eslint-plugin-simple-import-sort": "^12.0.0",
    "prettier": "^3.0.0",
    "typescript": "5.9.3",
    "typescript-eslint": "^8.0.0",
    "vitest": "^4.1.7"
  }
}
```

### `packages/pi-context-preloader/package.json` — MODIFY

**Purpose**: same shape as pi-extension-utils, package-specific keywords.

```json
{
  "name": "@piotrb/pi-context-preloader",
  "version": "0.1.0",
  "description": "Pi extension: auto-preload files referenced with @path syntax in AGENTS.md.",
  "type": "module",
  "license": "MIT",
  "author": "Piotr Banasik",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/piotrb/pi-extensions.git"
  },
  "bugs": {
    "url": "https://github.com/piotrb/pi-extensions/issues"
  },
  "homepage": "https://github.com/piotrb/pi-extensions#readme",
  "engines": {
    "node": ">=22 <25"
  },
  "files": ["src/**/*.ts", "!src/**/*.test.ts", "README.md"],
  "pi": {
    "extensions": ["./src/extensions/context-preloader.ts"]
  },
  "keywords": ["pi-package", "pi", "pi-coding-agent", "extension", "pi-context-preloader"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --max-warnings=0",
    "test": "vitest run"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@types/node": "^22",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^9.0.0",
    "eslint-plugin-simple-import-sort": "^12.0.0",
    "prettier": "^3.0.0",
    "typescript": "5.9.3",
    "typescript-eslint": "^8.0.0",
    "vitest": "^4.1.7"
  }
}
```

### `packages/pi-git/package.json` — MODIFY

**Purpose**: same shape, package-specific keywords.

```json
{
  "name": "@piotrb/pi-git",
  "version": "0.1.0",
  "description": "Pi extension: structured git tools for staging, committing, and history.",
  "type": "module",
  "license": "MIT",
  "author": "Piotr Banasik",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/piotrb/pi-extensions.git"
  },
  "bugs": {
    "url": "https://github.com/piotrb/pi-extensions/issues"
  },
  "homepage": "https://github.com/piotrb/pi-extensions#readme",
  "engines": {
    "node": ">=22 <25"
  },
  "files": ["src/**/*.ts", "!src/**/*.test.ts", "README.md"],
  "pi": {
    "extensions": ["./src/extensions/git.ts"]
  },
  "keywords": ["pi-package", "pi", "pi-coding-agent", "extension", "pi-git"],
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
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@types/node": "^22",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^9.0.0",
    "eslint-plugin-simple-import-sort": "^12.0.0",
    "prettier": "^3.0.0",
    "typebox": "^1.1.38",
    "typescript": "5.9.3",
    "typescript-eslint": "^8.0.0",
    "vitest": "^4.1.7"
  }
}
```

### `packages/pi-pfs/package.json` — MODIFY

**Purpose**: same shape, package-specific keywords.

```json
{
  "name": "@piotrb/pi-pfs",
  "version": "0.1.0",
  "description": "Pi extension: project filesystem tools for basic file operations.",
  "type": "module",
  "license": "MIT",
  "author": "Piotr Banasik",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/piotrb/pi-extensions.git"
  },
  "bugs": {
    "url": "https://github.com/piotrb/pi-extensions/issues"
  },
  "homepage": "https://github.com/piotrb/pi-extensions#readme",
  "engines": {
    "node": ">=22 <25"
  },
  "files": ["src/**/*.ts", "!src/**/*.test.ts", "README.md"],
  "pi": {
    "extensions": ["./src/extensions/pfs.ts"]
  },
  "keywords": ["pi-package", "pi", "pi-coding-agent", "extension", "pi-pfs"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --max-warnings=0",
    "test": "vitest run"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@types/node": "^22",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^9.0.0",
    "eslint-plugin-simple-import-sort": "^12.0.0",
    "prettier": "^3.0.0",
    "typebox": "^1.1.38",
    "typescript": "5.9.3",
    "typescript-eslint": "^8.0.0",
    "vitest": "^4.1.7"
  }
}
```

### `packages/pi-ripgrep/package.json` — MODIFY

**Purpose**: same shape, package-specific keywords.

```json
{
  "name": "@piotrb/pi-ripgrep",
  "version": "0.1.0",
  "description": "Pi extension: ripgrep wrapper for file content search.",
  "type": "module",
  "license": "MIT",
  "author": "Piotr Banasik",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/piotrb/pi-extensions.git"
  },
  "bugs": {
    "url": "https://github.com/piotrb/pi-extensions/issues"
  },
  "homepage": "https://github.com/piotrb/pi-extensions#readme",
  "engines": {
    "node": ">=22 <25"
  },
  "files": ["src/**/*.ts", "!src/**/*.test.ts", "README.md"],
  "pi": {
    "extensions": ["./src/extensions/ripgrep.ts"]
  },
  "keywords": ["pi-package", "pi", "pi-coding-agent", "extension", "pi-ripgrep"],
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
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@types/node": "^22",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^9.0.0",
    "eslint-plugin-simple-import-sort": "^12.0.0",
    "prettier": "^3.0.0",
    "typebox": "^1.1.38",
    "typescript": "5.9.3",
    "typescript-eslint": "^8.0.0",
    "vitest": "^4.1.7"
  }
}
```

### `packages/pi-task-runner/package.json` — MODIFY

**Purpose**: same shape, package-specific keywords.

```json
{
  "name": "@piotrb/pi-task-runner",
  "version": "0.1.0",
  "description": "Pi extension: safer, structured replacement for the bash tool with permission rules.",
  "type": "module",
  "license": "MIT",
  "author": "Piotr Banasik",
  "publishConfig": { "access": "public" },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/piotrb/pi-extensions.git"
  },
  "bugs": {
    "url": "https://github.com/piotrb/pi-extensions/issues"
  },
  "homepage": "https://github.com/piotrb/pi-extensions#readme",
  "engines": {
    "node": ">=22 <25"
  },
  "files": ["src/**/*.ts", "!src/**/*.test.ts", "README.md"],
  "pi": {
    "extensions": ["./src/extensions/task-runner.ts"]
  },
  "keywords": ["pi-package", "pi", "pi-coding-agent", "extension", "pi-task-runner"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "dependencies": {
    "pi-extension-utils": "workspace:*",
    "minimist": "*"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --max-warnings=0",
    "test": "vitest run"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "@types/minimist": "^1.2.5",
    "@types/node": "^22",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^9.0.0",
    "eslint-plugin-simple-import-sort": "^12.0.0",
    "prettier": "^3.0.0",
    "typebox": "^1.1.38",
    "typescript": "5.9.3",
    "typescript-eslint": "^8.0.0",
    "vitest": "^4.1.7"
  }
}
```

### `.github/workflows/ci.yml` — NEW

**Purpose**: gate PRs and pushes to main with the project's full check suite.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
```

### `.github/workflows/release.yml` — NEW

**Purpose**: changesets/action opens/updates the "Version Packages" PR; on merge, publishes via OIDC.

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          registry-url: https://registry.npmjs.org
      - run: pnpm install --frozen-lockfile
      - name: Create Version PR or Publish
        id: changesets
        uses: changesets/action@v1
        with:
          version: pnpm -s run version
          publish: pnpm run release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ""
```

### `.ai/pi-npm-publishing.md` — MODIFY

**Purpose**: replace the "no changesets yet" footer with the actual developer flow + OIDC setup instructions.

````markdown
---
name: pi-npm-publishing
description: npm publishing conventions and release workflow for @piotrb/pi-* extension packages — scope, access, versioning with changesets, OIDC trusted publishing, and developer release flow.
---

# Pi Extension npm Publishing

## When to Use

When preparing a release, declaring a changeset, configuring npm Trusted Publishing for a new package, or checking whether a package should be published.

## Key Facts

### Scope

All published packages use the `@piotrb` scope: `@piotrb/pi-git`, `@piotrb/pi-ripgrep`, etc.

- `@piotrb` is a personal npm scope automatically associated with the `piotrb` npm account. No separate creation or fee needed.
- The `pi-` prefix is kept even within the scoped name so the package is self-describing without the README: `@piotrb/pi-git` clearly means "pi agent git extension".

### Access — scoped packages are private by default

Add this to every publishable package's `package.json`:

```json
"publishConfig": { "access": "public" }
```
````

Without it, `pnpm publish` will fail or create a private package (which requires a paid npm org plan). The `publishConfig` field is the right approach — it's explicit and doesn't require remembering a CLI flag.

### Shipping TypeScript source

These packages ship `.ts` source files, not compiled JS. Pi loads extensions via jiti, which executes TypeScript directly at runtime. No build step is needed.

```json
"files": ["src/**/*.ts", "!src/**/*.test.ts", "README.md"],
"exports": { ".": "./src/extension-utils.ts" }
```

### What to publish

| Package                | Publish?               | Notes                                              |
| ---------------------- | ---------------------- | -------------------------------------------------- |
| `pi-bfs`               | No — `"private": true` | Pending migration to `pi-fd`                       |
| `pi-context-preloader` | Yes                    |                                                    |
| `pi-extension-utils`   | Yes                    | Runtime dependency of 4 extensions; must be on npm |
| `pi-git`               | Yes                    |                                                    |
| `pi-pfs`               | Yes                    |                                                    |
| `pi-ripgrep`           | Yes                    |                                                    |
| `pi-task-runner`       | Yes                    |                                                    |
| `pi-extensions` (root) | Never                  | Workspace meta-package, always `"private": true`   |

## Versioning — changesets

Per-package versions are managed by `@changesets/cli`. Independent versioning — each package evolves on its own. Internal dep bumps (`pi-extension-utils` changing) patch-bump downstream consumers via `updateInternalDependencies: "patch"` in `.changeset/config.json`.

### Declaring a change in a PR

```sh
pnpm changeset
```

Picks the affected packages, the bump type (patch / minor / major), and a one-line summary. The CLI writes a `.changeset/<random-name>.md` file — commit it with the PR.

Format of a changeset file:

```markdown
---
"@piotrb/pi-git": patch
"@piotrb/pi-task-runner": minor
---

short summary of the change, ends up in CHANGELOG.md
```

### The release loop

1. Developer opens a PR with code changes + `.changeset/*.md`.
2. PR merged to `main`.
3. `release.yml` workflow runs `changesets/action@v1`:
   - If changesets are present, opens (or updates) a "Version Packages" PR with version bumps and `CHANGELOG.md` updates.
4. Maintainer reviews the "Version Packages" PR, merges it.
5. `changesets/action@v1` runs `pnpm run release` → `pnpm changeset publish` → packages land on npm.
6. Git tags are created automatically by the action.

## Authentication — npm Trusted Publishing (OIDC)

No long-lived `NPM_TOKEN` secret. GitHub Actions requests a short-lived token from npm at publish time via OIDC.

- Requires npm CLI 11.5.1+ and 2FA enabled on the npm account.
- Workflow `permissions: id-token: write` is required.
- Workflow sets `NPM_TOKEN: ""` to force OIDC (the empty string is load-bearing — do not remove).
- Each published package needs a Trusted Publisher entry on npmjs.com (one-time setup, see below).

### One-time setup per package

After the first manual `pnpm -r publish --access public` seeds each package on npmjs.com, configure a Trusted Publisher:

1. npmjs.com → the package → **Settings** → **Trusted Publishers** → **Add GitHub Actions**.
2. Fill in:

   | Field             | Value           |
   | ----------------- | --------------- |
   | Repository owner  | `piotrb`        |
   | Repository name   | `pi-extensions` |
   | Workflow filename | `release.yml`   |
   | Environment       | (leave empty)   |

### GitHub repo settings required

- **Settings → Actions → General → Workflow permissions**: **"Read and write permissions"**.
- **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**: enabled.

## First-time publish checklist

1. Create the npm account at npmjs.com (or sign in). Enable 2FA under account settings.
2. `pnpm install` to fetch the new devDeps (`@changesets/cli`, `@changesets/changelog-github`).
3. `pnpm -r publish --access public --dry-run` to preview the publish manifest for all 6 packages.
4. `pnpm -r publish --access public` to create each package on npmjs.com.
5. For each of the 6 packages, configure the Trusted Publisher on npmjs.com (table above).
6. Configure GitHub repo settings (also above).
7. Commit + push everything to `main`. The release workflow will run but should not publish (no changesets present).
8. Optional smoke test: add a sample `.changeset/test.md` with a `patch` bump, push, and verify a "Version Packages" PR is opened. Close the PR without merging.
9. From here on, every PR that lands on `main` with a `.changeset/*.md` will eventually publish through the action.

## Notes

- `pnpm publish --access public` is a fallback if `publishConfig` is absent, but relying on the flag is fragile.
- The `@piotrb` scope is tied to a single npm account — only that account can publish. If the project grows and needs team publishing, migrate to an npm Org scope.
- A package version is immutable on npm. "Rollback" means publishing a new version with a fix — changesets handles this naturally.
- A pre-release channel (`canary` / `alpha` / `beta`) is available via `pnpm changeset pre enter <tag>` and `pnpm changeset pre exit`. The release workflow publishes to the matching non-`latest` npm dist-tag.
- The release workflow's `cancel-in-progress: false` is intentional — a release in flight should finish even if a follow-up push lands.

```

## Slices

### Slice 1: Changesets scaffold + root config

**Files**: `package.json` (root), `.changeset/config.json`, `.changeset/README.md`, `.gitignore`

#### Automated Verification:
- [ ] `pnpm install` succeeds with the new devDeps (`@changesets/cli`, `@changesets/changelog-github`)
- [ ] `pnpm changeset --help` runs without error
- [ ] `pnpm changeset status` runs without error
- [ ] `.changeset/config.json` parses against `$schema` (vscode or `ajv` validate)
- [ ] `pnpm check` passes (no source files changed, but root package.json scripts were added)
- [ ] `pnpm changeset version` runs without error (no changesets present, should be a no-op)

#### Manual Verification:
- [ ] Running `pnpm changeset` interactively prompts the developer to select packages and bump type
- [ ] The generated `.changeset/<random-name>.md` is a valid changeset file with the expected frontmatter
- [ ] `.changeset/pre.json` is git-ignored (touch the file, run `git status` — should be untracked)

### Slice 2: Per-package publish metadata

**Files**: `packages/pi-extension-utils/package.json`, `packages/pi-context-preloader/package.json`, `packages/pi-git/package.json`, `packages/pi-pfs/package.json`, `packages/pi-ripgrep/package.json`, `packages/pi-task-runner/package.json`

#### Automated Verification:
- [ ] All 6 publishable package.jsons have `"name": "@piotrb/pi-*"` and `"publishConfig": { "access": "public" }`
- [ ] All 6 have `"repository": { "type": "git", "url": "git+https://github.com/piotrb/pi-extensions.git" }`
- [ ] All 6 have `"bugs": { "url": "https://github.com/piotrb/pi-extensions/issues" }`
- [ ] All 6 have `"homepage": "https://github.com/piotrb/pi-extensions#readme"`
- [ ] All 6 have `"author": "Piotr Banasik"`
- [ ] All 6 have a non-empty `"keywords"` array containing `"pi-package"`
- [ ] `pi-bfs/package.json` is unchanged from current state (still `"private": true`, no publish metadata)
- [ ] `pnpm -r run typecheck` still passes
- [ ] `pnpm -r run test` still passes
- [ ] `pnpm -r run lint` still passes

#### Manual Verification:
- [ ] `pnpm --filter @piotrb/pi-git pack --pack-destination /tmp/pkg-meta-check` (after the next publish) — extracted tarball has the expected `package.json` fields

### Slice 3: GitHub Actions workflows

**Files**: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

#### Automated Verification:
- [ ] Both files are valid YAML (parses with `js-yaml` or `python -c "import yaml; yaml.safe_load(open('...'))"`)
- [ ] `ci.yml` references `actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4`, runs `pnpm install --frozen-lockfile` and `pnpm check`
- [ ] `ci.yml` triggers on `push` and `pull_request` to `main`
- [ ] `release.yml` has `permissions` block with `contents: write`, `pull-requests: write`, `id-token: write`
- [ ] `release.yml` references `changesets/action@v1` with `version: pnpm -s run version` and `publish: pnpm run release`
- [ ] `release.yml` env has `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and `NPM_TOKEN: ""`
- [ ] `release.yml` does NOT reference any `NPM_TOKEN` secret (grep for `secrets.NPM_TOKEN` returns nothing)
- [ ] `release.yml` `setup-node` has `registry-url: https://registry.npmjs.org`
- [ ] `release.yml` `concurrency` is `cancel-in-progress: false`
- [ ] `release.yml` triggers on `push` to `main`

#### Manual Verification:
- [ ] Pushing to a test branch with no changesets does NOT publish (release workflow runs but `changesets/action@v1` finds no changesets)
- [ ] Adding a sample `.changeset/test.md` with a `patch` bump and pushing opens a "Version Packages" PR

### Slice 4: Updated skill

**Files**: `.ai/pi-npm-publishing.md`

#### Automated Verification:
- [ ] Skill mentions `pnpm changeset` developer flow
- [ ] Skill mentions OIDC / Trusted Publishing
- [ ] Skill mentions `changesets/action@v1` and `release.yml` workflow filename
- [ ] Skill references `piotrb/pi-extensions` repo
- [ ] Skill documents the one-time npmjs.com Trusted Publisher setup table
- [ ] Skill documents the GitHub repo settings required
- [ ] Skill does NOT contain the obsolete "No changesets or release automation is configured yet" line
- [ ] Skill description (frontmatter `description:`) reflects the new automation scope

#### Manual Verification:
- [ ] Reading the skill in full gives a developer enough context to land a changeset, run the release, and troubleshoot a publish failure

## Desired End State

A developer lands a PR with code changes plus a `.changeset/<name>.md` describing the change. After PR merge, GitHub Actions opens a "Version Packages" PR with version bumps and CHANGELOG.md updates. The maintainer reviews and merges it. The release workflow publishes to npm via OIDC — no token, no manual step, no surprises. The npm package page shows the author, repository link, and keywords; the changelog is rendered with clickable PR links.

A user installing one of the extensions runs `pi install npm:@piotrb/pi-git` (or `pnpm add @piotrb/pi-git`), gets the published `.ts` source, and pi loads it via jiti — same developer experience as today, sourced from npm rather than the workspace.

## File Map

```

package.json # MODIFY — add @changesets/cli devDep, scripts
.changeset/config.json # NEW — changesets configuration
.changeset/README.md # NEW — generated boilerplate
.gitignore # MODIFY — add .changeset/pre.json
packages/pi-extension-utils/package.json # MODIFY — publish metadata
packages/pi-context-preloader/package.json # MODIFY — publish metadata
packages/pi-git/package.json # MODIFY — publish metadata
packages/pi-pfs/package.json # MODIFY — publish metadata
packages/pi-ripgrep/package.json # MODIFY — publish metadata
packages/pi-task-runner/package.json # MODIFY — publish metadata
.github/workflows/ci.yml # NEW — PR check workflow
.github/workflows/release.yml # NEW — release + publish workflow
.ai/pi-npm-publishing.md # MODIFY — update skill

```

## Ordering Constraints

- **Slice 1 must precede Slice 2**: Slice 1 installs the changesets CLI; Slice 2 doesn't depend on it at runtime but the configuration the developer trusts is set up first. More importantly, Slice 1's scripts (`pnpm run version`, `pnpm run release`) are what Slice 3 invokes.
- **Slice 1 must precede Slice 3**: `release.yml` calls `pnpm run version` and `pnpm run release`, which depend on Slice 1's root scripts.
- **Slices 2 and 3 are independent after Slice 1**: they touch disjoint files (package.json fields vs YAML workflows). Could be implemented in either order or in parallel worktrees.
- **Slice 4 should run last**: the skill should reflect the actual final state of the automation. If Slice 4 lands before the others, the skill will describe capabilities the repo doesn't yet have.
- **First manual publish is out of scope for implementation**: after all four slices land, the developer runs the "First-time publish checklist" from the updated skill. That's a manual one-time step, not a code change.

## Verification Notes

- **`pnpm pack --pack-destination`** is the lightest way to verify `publishConfig` and metadata are wired correctly without hitting the registry. The tarball's `package/package.json` is what npm will eventually see.
- **`.gitignore` for `.changeset/pre.json`** — this file is generated by `pnpm changeset pre enter` and should not be committed. The file is created in the workspace root, not inside `.changeset/` as the name might suggest, so the gitignore pattern `.changeset/pre.json` is correct (gitignore patterns match anywhere).
- **`NPM_TOKEN: ""`** in `release.yml` is intentional and load-bearing. Do not remove. It's the documented way to force OIDC. With a real value, the action would use the token; with an empty string, npm falls back to OIDC.
- **`id-token: write`** permission is required for GitHub to mint an OIDC token at runtime. Without it, the publish step fails with `npm ERR! code ENEEDAUTH`.
- **`GITHUB_TOKEN` write permission** is required for the action to push commits to the version PR. The default token has read-only; the workflow must request `contents: write` and `pull-requests: write` explicitly.
- **Repo's Actions settings** must allow the action to create PRs: Settings → Actions → General → Workflow permissions: "Read and write permissions" + "Allow GitHub Actions to create and approve pull requests".
- **`registry-url: https://registry.npmjs.org`** on the `setup-node` step is required for changesets/action to write the auth token to the right registry.
- **`cancel-in-progress: false`** on the release workflow is intentional: an in-flight release should finish, not get cancelled by a follow-up push. CI uses the opposite (`cancel-in-progress: true`) because there's no harm in re-running checks.
- **The `version` and `publish` scripts in the action** resolve `pnpm -s run version` and `pnpm run release` against the root `package.json`. The `-s` (silent) flag suppresses pnpm's chatter.
- **`pnpm changeset publish` skips private packages** (checks `private: true` in package.json), so `pi-bfs` is correctly excluded from automated publishing.

## Performance Considerations

None — this is publishing plumbing, not runtime code. The CI and release workflows use `--frozen-lockfile` to avoid re-resolution.

## Migration Notes

**First publish (manual, one-time)**:
1. Local: `pnpm install` (to fetch changesets devDeps).
2. Local: `pnpm -r publish --access public --dry-run` to preview the publish manifest for all 6 packages.
3. Local: `pnpm -r publish --access public` — creates each package on npmjs.com.
4. npmjs.com: for each of the 6 packages, Settings → Trusted Publishers → Add GitHub Actions → owner `piotrb`, repo `pi-extensions`, workflow filename `release.yml`.
5. Local: `git add -A && git commit` with the design slices. Push to `main`.
6. Verify the release workflow runs but does not publish (no changesets present).
7. Optional smoke test: add a sample `.changeset/test.md` with `patch` bumps, push, verify a "Version Packages" PR is opened, then close without merging.

**Rollback strategy**: A package version is immutable on npm. "Rollback" means publishing a new version with a fix. Changesets handles this naturally — add a changeset, push, merge the version PR, the workflow publishes a new version.

**Backwards compatibility**: This change only affects publishing. Existing source code, source-shipping strategy, and TypeScript types are unchanged. Consumers installing from npm will see the same `.ts` source files as today; the only difference is they resolve `pi-extension-utils` from the registry instead of a workspace link.

## Pattern References

- **`.changeset/config.json`** — pattern from `perfectbase/monorepo-package-template` `.changeset/config.json`, simplified by removing the `fixed: [["@perfectest/*"]]` group (decision 1: independent versioning).
- **`.github/workflows/release.yml`** — pattern from `perfectbase/monorepo-package-template` `.github/workflows/release.yml`, adapted to pnpm and the `@piotrb` scope.
- **Per-package `publishConfig: { "access": "public" }`** — pattern from pre-existing `.ai/pi-npm-publishing.md` skill.
- **Source shipping via `"files": ["src/**/*.ts", ...]`** — pattern from existing 6 package.json files (unchanged in this design).
- **Per-package metadata fields** (`repository`, `bugs`, `homepage`, `keywords`, `author`) — common npm package metadata shape, present on all four reference repos (context-mode, subagents, mcp-adapter, web-access).

## Developer Context

### Resolved ambiguities (Step 4)

1. **Q: Independent vs fixed versioning?**
   A: Independent. Each package evolves at its own cadence. (Selected in pre-skill conversation; locked into Decision 1.)
   Evidence: A shared version would force unnecessary bumps on stable packages. `updateInternalDependencies: "patch"` already propagates internal-dep changes when desired.

2. **Q: GitHub owner/repo for changelog links?**
   A: `piotrb/pi-extensions`. (Selected in pre-skill conversation; locked into Decision 5 and embedded in every `repository` field.)
   Evidence: User-confirmed. Verified against `.git/config:7` (`url = git@github.com:piotrb/pi-extensions.git`).

3. **Q: OIDC vs NPM_TOKEN?**
   A: OIDC Trusted Publishing. (Selected in pre-skill conversation; locked into Decision 2.)
   Evidence: User-confirmed. Matches the `perfectbase/monorepo-package-template` pattern.

4. **Q: Personal @piotrb scope vs npm org?**
   A: `@piotrb` personal scope. (Selected in pre-skill conversation; locked into Decision 3.)
   Evidence: User-confirmed. Matches the existing `.ai/pi-npm-publishing.md` skill.

5. **Q: Author name for package.json metadata?**
   A: `Piotr Banasik`. (Confirmed in pre-skill conversation; embedded in all 6 package.jsons.)
   Evidence: User-provided value, used consistently.

6. **Q: Default vs GitHub changelog renderer?**
   A: `@changesets/changelog-github` with `repo: "piotrb/pi-extensions"`. (Designer-inferred from the value of clickable PR links in monorepo changelogs.)
   Evidence: Default renderer is plain markdown; github renderer resolves PR numbers and commit SHAs.

### Carried open questions

None. All questions resolved.

## Design History

- Slice 1: changesets scaffold + root config — approved as generated
- Slice 2: per-package publish metadata — approved as generated
- Slice 3: GitHub Actions workflows — approved as generated
- Slice 4: updated skill — approved as generated

## References

- Research: in-context synthesis (prior conversation: four reference repos + changesets + npm Trusted Publishing)
- Skill: `.ai/pi-npm-publishing.md` (pre-existing, replaced in Slice 4)
- Reference template: https://github.com/perfectbase/monorepo-package-template
- Changesets + pnpm docs: https://pnpm.io/using-changesets
- Changesets GitHub Action: https://github.com/changesets/action
- npm Trusted Publishing: https://docs.npmjs.com/trusted-publishers/
- OIDC GA announcement: https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/
```
