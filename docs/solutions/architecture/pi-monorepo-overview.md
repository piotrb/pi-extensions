---
title: pi-extensions — monorepo overview
category: architecture
severity: medium
tags:
  - monorepo
  - project-map
  - workspace
  - pnpm
  - turbo
applies_when:
  - orienting to the pi-extensions monorepo
  - answering questions about the high-level shape of this project
  - deciding where a new file or package goes
  - looking up the canonical command set
  - onboarding a new agent to this project
---

# Problem

When orienting to the `pi-extensions` monorepo — or answering a question about its high-level shape — the agent needs a single map of the project: the folder layout, the canonical command set, the runtime/toolchain facts, and the cross-references to deeper docs. Without that map, every orientation question becomes a fresh exploration.

# Context

`pi-extensions` is a pnpm workspace of `pi-*` extension packages. Most packages are flat (a single `src/extensions/<name>.ts` plus a co-located test); `pi-hackery` is the one exception with a layered internal structure. The repo's source is consumed by jiti at runtime — there is no build step. Each package registers pi tools via the `pi.extensions` field in `package.json`; the runtime loads them and the tool surface is the union across loaded packages.

# Solution

## Project map

```
AGENTS.md                                # project entry point
.agents/                                 # workspace skills (legacy; hackery-update-skill is the only entry after the learn/cleanup pass)
  skills/<name>/SKILL.md                 # per-concept skills
docs/                                    # plans and solutions (per the 02-plan and 05-learn file-location conventions)
  plans/<slug>.md                        # feature plans
  solutions/<category>/<slug>.md         # learnings, organized by category
.changeset/                              # changesets for the workspace
.pi/                                     # per-project runtime config
packages/                                # the workspace packages (see the per-package working-with skills)
  pi-<name>/                             # each pi-* package
tsconfig.base.json                       # shared TypeScript config
turbo.json                               # task graph (format:check, lint, typecheck, test)
eslint.config.mjs                        # single root ESLint config
.prettierrc                              # single root Prettier config
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

After every edit, run the scoped filter — `pnpm turbo run typecheck test --filter=<pkg>`. Use the full `pnpm run check` before commit (it can exceed the default 30s timeout on a cold cache; pass an explicit timeout).

## Architecture decisions

- **Flat monorepo.** Every package lives in `packages/pi-<name>/`. There is no apps/libs split. Workspace resolution is via `pnpm-workspace.yaml` (`packages: ["packages/*"]`).
- **No build step.** `.ts` source is consumed by jiti at runtime. `tsconfig.base.json` declares `noEmit`. The `files` allowlist in each package's `package.json` ships `.ts` directly — there is no `dist/`, no `lib/`, no compiled output.
- **Plugin ecosystem.** Packages register pi tools via the `pi.extensions` field in `package.json`. The runtime loads them. The tool surface is the union of all registered tools across all loaded packages.

## Domain facts

- **Runtime:** Node 22 (engines: `>=22 <25`), ESM (`"type": "module"`), TypeScript strict (`noUncheckedIndexedAccess` + `verbatimModuleSyntax`).
- **Package manager:** pnpm 10.x.
- **Build orchestrator:** turbo 2.x.
- **Lint + format:** ESLint 9.x + Prettier 3.x, single root config.
- **Tests:** vitest 4.x, co-located (`<name>.test.ts` next to source).

# Why this works

- **The flat layout keeps the surface small.** Every `pi-*` package follows the same canonical shape (per `pi-package-scaffold`). New packages mirror the most similar existing peer; they are not written from a template. The flat structure means the agent can reason about the workspace by pattern-matching against one of a handful of peer shapes.
- **No build step removes a class of failure.** The `.ts` source is what ships. There is no `dist/` to forget to rebuild, no `lib/` to keep in sync, no version skew between source and build artifacts. The cost is a runtime dependency on jiti; the benefit is a single source of truth.
- **The plugin ecosystem composes.** Each package's `pi.extensions` is one entry point; the runtime loads all of them and the tool surface is the union. New tools don't require changes to a central registry.

# Prevention

- **Don't add a build step.** The no-build decision is load-bearing for the flat layout and the source-as-shipped invariant. Adding `tsc` to a per-package script would break the source/build parity the repo depends on.
- **Don't introduce an apps/libs split.** The flat layout is intentional. Sub-categorizing `packages/` would break the "every package follows the same canonical shape" invariant.
- **Don't centralize the tool registry.** The plugin ecosystem is decentralized by design; each package declares its own tools via `pi.extensions`. A central registry would be a single point of failure and a coordination bottleneck.
- **This solution does not cover the build toolchain specifics** (tsconfig hierarchy, ESLint config, etc.) — see `pi-extension-toolchain`.
- **This solution does not cover the canonical per-package shape** — see `pi-package-scaffold`.
- **This solution does not cover the hard rules** (imports, no `compilerOptions` in per-package tsconfig, etc.) — those are in `pi-package-scaffold`.
- **This solution does not cover the cross-layer reference convention** — see `pi-read-package-architecture`.
