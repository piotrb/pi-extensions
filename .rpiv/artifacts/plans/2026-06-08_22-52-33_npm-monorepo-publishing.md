---
date: 2026-06-08T22:52:33+0000
author: Piotr Banasik
commit: f2c8927
branch: main
repository: pi-extensions
topic: "npm monorepo publishing with changesets + OIDC trusted publishing"
tags: [plan, publishing, changesets, npm, ci, monorepo]
status: ready
parent: ".rpiv/artifacts/designs/2026-06-08_22-27-37_npm-monorepo-publishing.md"
last_updated: 2026-06-08T22:52:33+0000
last_updated_by: Piotr Banasik
last_updated_note: "Regenerated from design after piotr → piotrb fix; CI toolchain pinned via version-file; Phase 4 manual bullet for GitHub Actions repo settings"
---

# npm Monorepo Publishing with Changesets + OIDC Implementation Plan

## Overview

Set up an automated npm publishing pipeline for the `@piotrb/pi-*` monorepo. `@changesets/cli` at the workspace root drives per-package versioning and changelogs; `changesets/action@v1` opens a "Version Packages" PR on each push to main; merging that PR triggers `pnpm changeset publish` via npm Trusted Publishing (OIDC) — no long-lived `NPM_TOKEN` secret.

This plan is the phased decomposition of the design artifact at `.rpiv/artifacts/designs/2026-06-08_22-27-37_npm-monorepo-publishing.md`. Phase boundaries are inherited 1:1 from the design's `## Slices` section.

## Desired End State

A developer lands a PR with code changes plus a `.changeset/<name>.md` describing the change. After PR merge, GitHub Actions opens a "Version Packages" PR with version bumps and CHANGELOG.md updates. The maintainer reviews and merges it. The release workflow publishes to npm via OIDC — no token, no manual step, no surprises. The npm package page shows the author, repository link, and keywords; the changelog is rendered with clickable PR links.

A user installing one of the extensions runs `pi install npm:@piotrb/pi-git` (or `pnpm add @piotrb/pi-git`), gets the published `.ts` source, and pi loads it via jiti — same developer experience as today, sourced from npm rather than the workspace.

## What We're NOT Doing

- A Trusted Publisher onboarding script — the one-time per-package config on npmjs.com is a manual step the developer performs after the artifact lands.
- The actual first manual `pnpm -r publish --access public` — done by the developer after the artifact lands; documented in the updated skill.
- `pnpm pack` artifacts or a `dist/` output — packages continue to ship source, unchanged.
- A "build" script in release.yml — there is no build to run. Source shipping is the design.
- Fixed versioning across all packages — they evolve independently per the locked decision.
- An npm org subscription — `@piotrb` personal scope is free and matches the existing skill.
- Bundle/pre-publish steps (esbuild, etc.) — not needed; the perfectbase pattern's pre-publish `pnpm build` doesn't apply here.

## Phase 1: Changesets scaffold + root config

### Overview

Install `@changesets/cli` and `@changesets/changelog-github` at the workspace root, add the three scripts the action and developer invoke (`changeset`, `version`, `release`), write the changesets config + generated README, and gitignore the transient pre-release file. After this phase, `pnpm changeset` is invokable and the root scripts that downstream phases depend on are wired.

### Changes Required:

#### 1. Root `package.json`

**File**: `package.json`
**Changes**: Add `@changesets/cli` + `@changesets/changelog-github` to devDependencies, add `changeset`/`version`/`release` scripts.

```{json}
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

#### 2. `.changeset/config.json`

**File**: `.changeset/config.json`
**Changes**: NEW — changesets configuration with GitHub changelog renderer, public access, `updateInternalDependencies: "patch"`.

```{json}
{
  "$schema": "https://unpkg.com/@changesets/config@3.2.0/schema.json",
  "changelog": [
    "@changesets/changelog-github",
    { "repo": "piotrb/pi-extensions" }
  ],
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

#### 3. `.changeset/README.md`

**File**: `.changeset/README.md`
**Changes**: NEW — upstream-generated boilerplate documenting the changesets workflow for contributors.

```{markdown}
# Changesets

Hello and welcome! This folder has been automatically generated by `@changesets/cli`, a build tool that works
with multi-package repos, or single-package repos to help version and publish your code. You can
find the full documentation for it [in our repository](https://github.com/changesets/changesets)

We have a quick list of common questions to get you started engaging with this project in
[our documentation](https://github.com/changesets/changesets/blob/master/docs/common-questions.md)
```

#### 4. `.gitignore`

**File**: `.gitignore`
**Changes**: Add `.changeset/pre.json` (transient file written when entering pre-release mode).

```gitignore
node_modules/
.pi/pi-task-list/state.json
.changeset/pre.json
```

### Success Criteria:

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

---

## Phase 2: Per-package publish metadata

### Overview

Add `publishConfig/repository/bugs/homepage/author/keywords` and the `@piotrb/` scope to the 6 publishable package.jsons (pi-extension-utils, pi-context-preloader, pi-git, pi-pfs, pi-ripgrep, pi-task-runner). `pi-bfs` is unchanged — it stays `private: true`. After this phase, `pnpm -r publish --access public --dry-run` should produce a valid manifest for the 6 publishable packages and skip `pi-bfs`.

Parallelism: this phase is independent of Phase 3 and can run in a separate worktree. Both phases depend only on Phase 1 having landed.

### Changes Required:

#### 1. `packages/pi-extension-utils/package.json`

**File**: `packages/pi-extension-utils/package.json`
**Changes**: Rename to `@piotrb/pi-extension-utils`; add `publishConfig/repository/bugs/homepage/author/keywords`; retain source-shipping `main/types/exports/files`.

```{json}
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
  "files": [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "README.md"
  ],
  "keywords": [
    "pi-package",
    "pi",
    "pi-coding-agent",
    "extension",
    "pi-extension-utils"
  ],
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

#### 2. `packages/pi-context-preloader/package.json`

**File**: `packages/pi-context-preloader/package.json`
**Changes**: Rename to `@piotrb/pi-context-preloader`; add `publishConfig/repository/bugs/homepage/author/keywords`; keep `pi.extensions` registration.

```{json}
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
  "files": [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "README.md"
  ],
  "pi": {
    "extensions": [
      "./src/extensions/context-preloader.ts"
    ]
  },
  "keywords": [
    "pi-package",
    "pi",
    "pi-coding-agent",
    "extension",
    "pi-context-preloader"
  ],
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

#### 3. `packages/pi-git/package.json`

**File**: `packages/pi-git/package.json`
**Changes**: Rename to `@piotrb/pi-git`; add `publishConfig/repository/bugs/homepage/author/keywords`; keep `pi-extension-utils: workspace:*` runtime dep.

```{json}
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
  "files": [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "README.md"
  ],
  "pi": {
    "extensions": [
      "./src/extensions/git.ts"
    ]
  },
  "keywords": [
    "pi-package",
    "pi",
    "pi-coding-agent",
    "extension",
    "pi-git"
  ],
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

#### 4. `packages/pi-pfs/package.json`

**File**: `packages/pi-pfs/package.json`
**Changes**: Rename to `@piotrb/pi-pfs`; add `publishConfig/repository/bugs/homepage/author/keywords`; no runtime deps on pi-extension-utils.

```{json}
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
  "files": [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "README.md"
  ],
  "pi": {
    "extensions": [
      "./src/extensions/pfs.ts"
    ]
  },
  "keywords": [
    "pi-package",
    "pi",
    "pi-coding-agent",
    "extension",
    "pi-pfs"
  ],
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

#### 5. `packages/pi-ripgrep/package.json`

**File**: `packages/pi-ripgrep/package.json`
**Changes**: Rename to `@piotrb/pi-ripgrep`; add `publishConfig/repository/bugs/homepage/author/keywords`; keep `pi-extension-utils: workspace:*` runtime dep.

```{json}
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
  "files": [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "README.md"
  ],
  "pi": {
    "extensions": [
      "./src/extensions/ripgrep.ts"
    ]
  },
  "keywords": [
    "pi-package",
    "pi",
    "pi-coding-agent",
    "extension",
    "pi-ripgrep"
  ],
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

#### 6. `packages/pi-task-runner/package.json`

**File**: `packages/pi-task-runner/package.json`
**Changes**: Rename to `@piotrb/pi-task-runner`; add `publishConfig/repository/bugs/homepage/author/keywords`; keep `pi-extension-utils: workspace:*` + `minimist` runtime deps.

```{json}
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
  "files": [
    "src/**/*.ts",
    "!src/**/*.test.ts",
    "README.md"
  ],
  "pi": {
    "extensions": [
      "./src/extensions/task-runner.ts"
    ]
  },
  "keywords": [
    "pi-package",
    "pi",
    "pi-coding-agent",
    "extension",
    "pi-task-runner"
  ],
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

### Success Criteria:

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

---

## Phase 3: GitHub Actions workflows

### Overview

Add two workflow files: `ci.yml` runs `pnpm check` on every PR and push to main; `release.yml` uses `changesets/action@v1` to open/update the "Version Packages" PR, and on merge publishes via npm OIDC. After this phase, pushing a changeset to `main` will open a real "Version Packages" PR.

Parallelism: this phase is independent of Phase 2 and can run in a separate worktree. Both phases depend only on Phase 1 having landed.

### Changes Required:

#### 1. `.github/workflows/ci.yml`

**File**: `.github/workflows/ci.yml`
**Changes**: NEW — gate PRs and pushes to main with the project's full check suite.

```{yaml}
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
          node-version-file: .tool-versions
          cache: pnpm
      - uses: pnpm/action-setup@v4
        with:
          version-file: package.json
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
```

#### 2. `.github/workflows/release.yml`

**File**: `.github/workflows/release.yml`
**Changes**: NEW — changesets/action opens/updates the "Version Packages" PR; on merge, publishes via OIDC.

```{yaml}
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
          node-version-file: .tool-versions
          cache: pnpm
          registry-url: https://registry.npmjs.org
      - uses: pnpm/action-setup@v4
        with:
          version-file: package.json
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

### Success Criteria:

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

---

## Phase 4: Updated skill

### Overview

Replace the "no changesets yet" footer in `.ai/pi-npm-publishing.md` with the actual developer flow: changesets declaration, the release loop, OIDC setup instructions, and the one-time Trusted Publisher / GitHub settings configuration. This phase runs last because the skill must describe the final state of the automation.

### Changes Required:

#### 1. `.ai/pi-npm-publishing.md`

**File**: `.ai/pi-npm-publishing.md`
**Changes**: Replace obsolete "no changesets" footer; add changesets flow, OIDC setup, GitHub settings, first-time publish checklist.

````{markdown}
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

### Success Criteria:

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
- [ ] Visit https://github.com/piotrb/pi-extensions/settings/actions and confirm "Read and write permissions" + "Allow GitHub Actions to create and approve pull requests" are enabled — record evidence in the PR description

---

## Testing Strategy

### Automated:
- `pnpm check` (per-phase: Phase 1 explicitly, Phase 2 implicit via `pnpm -r run typecheck`/`test`/`lint`).
- YAML lint of `.github/workflows/*.yml` (Phase 3).
- Schema validation of `.changeset/config.json` against `$schema` (Phase 1).
- Grep checks for `secrets.NPM_TOKEN` absence in `release.yml` (Phase 3).

### Manual Testing Steps:
1. `pnpm install` after Phase 1 — verify the new devDeps resolve.
2. `pnpm changeset` interactively — verify the dev flow prompts and writes a valid changeset file (Phase 1).
3. Touch `.changeset/pre.json` and run `git status` — verify it is untracked (Phase 1).
4. `pnpm -r publish --access public --dry-run` (after Phase 2) — preview the publish manifest for all 6 packages, confirm `pi-bfs` is skipped.
5. Push to a test branch with no changesets after Phase 3 — confirm release workflow runs but does not publish.
6. Add a sample `.changeset/test.md` with a `patch` bump, push, and verify a "Version Packages" PR is opened (Phase 3).
7. Read `.ai/pi-npm-publishing.md` in full after Phase 4 — confirm a developer has enough context to land a changeset and run the release end-to-end.

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

## Developer Context

## Plan Review (Step 4)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. First review pass surfaced 4 blockers + 1 concern from 5 root-cause sites (the `piotr` → `piotrb` typo + missing `@piotrb/` scope across the design's Architecture); the developer resolved them by editing the design artifact first and regenerating the plan. The current review pass re-verifies the corrected plan. All previous blockers confirmed resolved. New findings: 1 coverage blocker (carried from first pass, unaddressed), 2 code concerns (CI toolchain pinning)._

| source   | plan-loc                          | codebase-loc        | severity   | dimension               | finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | recommendation                                                                                                                                                                                                                                                                                                                                                                                                                | resolution         |
| -------- | --------------------------------- | ------------------- | ---------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| coverage | ## Verification Notes §6           | <n/a>               | blocker    | verification-coverage   | Note "Repo's Actions settings must allow the action to create PRs: Settings → Actions → General → Workflow permissions: 'Read and write permissions' + 'Allow GitHub Actions to create and approve pull requests'" — no Success Criteria bullet exercises the actual GitHub repo setting, and there is no in-repo code mirror (settings live at the GitHub repo level). Phase 4's "Skill documents the GitHub repo settings required" bullet only verifies the skill text mentions it, not that the setting is actually enabled. Carried from the first review pass — unaddressed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Add a manual verification bullet that fails the phase if the developer cannot confirm both repo settings are enabled (e.g. Phase 4 Manual Verification: "Visit https://github.com/piotrb/pi-extensions/settings/actions and confirm 'Read and write permissions' + 'Allow GitHub Actions to create and approve pull requests' are enabled — record evidence in the PR description"). Place the bullet in Phase 4 (where the developer runs the first-time publish checklist) since Phase 3's automated checks cannot reach the GitHub UI. | applied: added Phase 4 Manual Verification bullet pointing to settings/actions URL with the two required settings and 'record evidence in PR description' |
| code     | Phase 3 §1 (ci.yml)               | .tool-versions:1    | concern    | codebase-fit            | CI pins `node-version: 24` but the repo's `.tool-versions` is `node 22` and root `engines.node` is `">=22 <25"`; CI will run on a Node version local developers do not have, so a green CI does not validate the developer's environment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Replace `node-version: 24` with `node-version-file: .tool-versions` (setup-node v4 supports it) so CI and local dev test the same toolchain                                                                                                                                                                                                                                                                                  | applied: replaced `node-version: 24` with `node-version-file: .tool-versions` in both ci.yml and release.yml |
| code     | Phase 3 §1 (ci.yml)               | package.json:11     | concern    | codebase-fit            | `pnpm/action-setup@v4 with: version: 10` resolves to the latest 10.x at run time, drifting from the locked `packageManager: pnpm@10.33.4` in the root `package.json`; `--frozen-lockfile` keeps the lockfile consistent but pnpm CLI behavior can differ across patch versions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Pin to `version: 10.33.4` (or use `version-file: package.json` to read the `packageManager` field) so CI uses the same pnpm build that was used to author the lockfile                                                                                                                                                                                                                                                          | applied: added `pnpm/action-setup@v4 with: version-file: package.json` step in both ci.yml and release.yml (CI and release now read pnpm from the `packageManager` field) |

## References

- Design: `.rpiv/artifacts/designs/2026-06-08_22-27-37_npm-monorepo-publishing.md`
- Skill: `.ai/pi-npm-publishing.md` (replaced in Phase 4)
- Reference template: https://github.com/perfectbase/monorepo-package-template
- Changesets + pnpm docs: https://pnpm.io/using-changesets
- Changesets GitHub Action: https://github.com/changesets/action
- npm Trusted Publishing: https://docs.npmjs.com/trusted-publishers/
- OIDC GA announcement: https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/
```
