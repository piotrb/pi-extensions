---
name: pi-npm-publishing
description: npm publishing conventions for @piotrb/pi-* extension packages — scope, access, TypeScript source shipping, publishConfig, and which packages to publish.
---

# Pi Extension npm Publishing

## When to Use

When preparing to publish a package from this workspace to npm, configuring a new package for publishing, or checking whether a package should be published.

## Key Facts

### Scope

All published packages use the `@piotrb` scope: `@piotrb/pi-git`, `@piotrb/pi-ripgrep`, etc.

- `@piotrb` is a personal npm scope automatically associated with the `piotrb` npm account. No separate creation or fee needed.
- Unscoped names like `pi-git` are avoided — they're ambiguous (Raspberry Pi? Python Package Index?) and not namespace-protected.
- The `pi-` prefix is kept even within the scoped name so the package is self-describing without the README: `@piotrb/pi-git` clearly means "pi agent git extension".

### Access — scoped packages are private by default

Add this to every publishable package's `package.json`:

```json
"publishConfig": { "access": "public" }
```

Without it, `pnpm publish` will fail or create a private package (which requires a paid npm org plan). The `publishConfig` field is the right approach — it's explicit and doesn't require remembering a CLI flag.

### Shipping TypeScript source

These packages ship `.ts` source files, not compiled JS. This works because pi loads extensions via jiti, which executes TypeScript directly at runtime. No build step is needed.

```json
"files": ["src/**/*.ts", "!src/**/*.test.ts", "README.md"],
"exports": { ".": "./src/extension-utils.ts" }
```

The `exports` field points at the `.ts` source. Consumers (other packages in the workspace, or pi itself loading the extension) resolve the TypeScript file directly. There is no `dist/` and no `tsconfig.build.json`.

### What to publish

| Package                | Publish?               | Notes                                                            |
| ---------------------- | ---------------------- | ---------------------------------------------------------------- |
| `pi-bfs`               | No — `"private": true` | Pending migration to `pi-fd`                                     |
| `pi-context-preloader` | Yes                    |                                                                  |
| `pi-extension-utils`   | Yes                    | Runtime dependency of all spawn-using extensions; must be on npm |
| `pi-git`               | Yes                    |                                                                  |
| `pi-pfs`               | Yes                    |                                                                  |
| `pi-ripgrep`           | Yes                    |                                                                  |
| `pi-task-runner`       | Yes                    |                                                                  |
| `pi-extensions` (root) | Never                  | Workspace meta-package, always `"private": true`                 |

### pi-extension-utils must be published

Even though `pi-extension-utils` is internal infrastructure, it is listed in the `dependencies` of four extension packages. When a user installs `@piotrb/pi-git`, npm/pnpm installs `pi-extension-utils` as a transitive dependency. If it is not on npm, the install fails.

If you prefer to avoid publishing it, the alternative is to vendor `extension-utils.ts` into each consumer as a local `src/lib/` file and revert to relative imports — but then you lose the single source of truth and need a sync script.

## Notes

- `pnpm publish --access public` is a fallback if `publishConfig` is absent, but relying on the flag is fragile.
- The `@piotrb` scope is tied to a single npm account — only that account can publish. If the project grows and needs team publishing, migrate to an npm Org scope.
- No changesets or release automation is configured yet. Versioning is manual for now.
