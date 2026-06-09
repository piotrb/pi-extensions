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
