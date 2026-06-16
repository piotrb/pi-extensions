---
name: pi-monorepo-overview
description: The pi-extensions monorepo at a glance — flat layout, no build step, plugin ecosystem, project map, and the canonical command set. Use when orienting to the repo, when you need the high-level shape, or when answering questions about what this project is.
---

You are orienting to the `pi-extensions` monorepo or answering a question about its high-level shape. This is the project map, not a workflow guide.

## Architecture

- **Flat monorepo.** Every package lives in `packages/pi-<name>/`. There is no apps/libs split. Workspace resolution is via `pnpm-workspace.yaml` (`packages: ["packages/*"]`).
- **No build step.** `.ts` source is consumed by jiti at runtime. `tsconfig.base.json` declares `noEmit`. The `files` allowlist in each package's `package.json` ships `.ts` directly — there is no `dist/`, no `lib/`, no compiled output.
- **Plugin ecosystem.** Packages register pi tools via the `pi.extensions` field in `package.json`. The runtime loads them. The tool surface is the union of all registered tools across all loaded packages.

## Project map

```
AGENTS.md                                # project entry point
.agents/                                 # workspace learnings + dispatch index
  learning-index.md                      # the dispatch index
  skills/<name>/SKILL.md                 # per-concept skills
.rpiv/                                   # session artifacts
  artifacts/                             # plans, designs, validation, research
tsconfig.base.json, turbo.json,
eslint.config.mjs, .prettierrc           # shared toolchain
packages/                                # the workspace packages (see the per-package working-with skills)
```

## Commands

| Command                                    | When                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `pnpm run check`                           | The canonical "run everything" — turbo `//#format:check //#lint typecheck test` |
| `pnpm --filter <pkg> run typecheck`        | Iteration: typecheck one package                                                |
| `pnpm --filter <pkg> run test`             | Iteration: test one package                                                     |
| `pnpm turbo typecheck test --filter=<pkg>` | Both in parallel (cached)                                                       |
| `pnpm turbo //#lint`                       | Root lint only                                                                  |
| `pnpm install`                             | After `package.json` / `pnpm-lock.yaml` changes                                 |

After every edit, run the scoped filter — `pnpm turbo run typecheck test --filter=<pkg>`. Use the full `pnpm run check` before commit.

## Domain facts

- **Runtime:** Node 22 (engines: `>=22 <25`), ESM (`"type": "module"`), TypeScript strict (`noUncheckedIndexedAccess` + `verbatimModuleSyntax`).
- **Package manager:** pnpm 10.x.
- **Build orchestrator:** turbo 2.x.
- **Lint + format:** ESLint 9.x + Prettier 3.x, single root config.
- **Tests:** vitest 4.x, co-located (`<name>.test.ts` next to source).

## What this skill does not do

- It does not cover the build toolchain specifics (tsconfig hierarchy, ESLint config, etc.) — see `pi-extension-toolchain`.
- It does not cover the canonical per-package shape — see `pi-package-scaffold`.
- It does not cover the hard rules (imports, no `compilerOptions` in per-package tsconfig, etc.) — those are in `pi-package-scaffold`.
- It does not cover the cross-layer reference convention — see `pi-read-package-architecture`.

## Related

- `pi-extension-toolchain`
- `pi-package-scaffold`
