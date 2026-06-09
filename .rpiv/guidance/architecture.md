# pi-extensions — root

pnpm + turbo monorepo of 7 pi coding-agent extensions + 1 shared library. Node 22, ESM, TypeScript strict, no build step.

## Architecture

- **Flat monorepo** — every package in `packages/pi-<name>/`. No apps/libs split.
- **No build step** — `.ts` source is consumed by jiti at runtime. `tsconfig.base.json` declares `noEmit`. The `files` allowlist in each package ships `.ts` directly.
- **Plugin ecosystem** — packages register pi tools via the `pi.extensions` field in `package.json`. The runtime loads them.

## Project map

```
AGENTS.md                                # project entry point
.rpiv/guidance/                          # this guidance tree (read on demand)
  packages/architecture.md               # per-package shape, tool registration
  packages/pi-extension-utils/...        # shared spawn helpers
  packages/pi-context-preloader/...      # @path auto-preloader (lifecycle hooks)
  packages/pi-git/...                    # 9 git tools
  packages/pi-pfs/...                    # 4 fs tools
  packages/pi-ripgrep/...                # single rg wrapper
  packages/pi-task-runner/...            # run tool + permission modal
  packages/pi-task-runner/src/lib/...    # pattern matcher, config loader
  packages/pi-bfs/...                    # transitional, pending pi-fd
tsconfig.base.json, turbo.json,
eslint.config.mjs, .prettierrc           # shared toolchain
.ai/                                     # task-keyed skills (auto-loaded)
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

## Hard rules

- **Imports**: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` — never the old `@mariozechner/*`.
- **No `compilerOptions` in per-package tsconfig** — put them in `tsconfig.base.json`.
- **No barrel/index.ts** — extensions are listed in `package.json`'s `pi.extensions`.
- **Internal cross-package deps use `workspace:*`** (e.g. `pi-extension-utils: workspace:*`).
- **`.ts` keeps its extension on local imports** — pi's jiti handles resolution; `allowImportingTsExtensions` makes tsc accept them.

## Cross-layer reference

When working inside `packages/pi-<name>/`, read the package's `architecture.md` first. The `packages/architecture.md` parent covers the generic per-package shape (package.json, tsconfig, tool registration); per-folder files only document what's _unique_ to that package.

<important if="you are adding a new extension package">
1. Create `packages/pi-<name>/` with: `package.json` (see `packages/architecture.md`), `tsconfig.json` extending the base, `README.md`, `src/extensions/<name>.ts`, `src/extensions/<name>.test.ts`.
2. Register the tool in `package.json` under `pi.extensions`.
3. Run `pnpm --filter <pkg> run typecheck test` to confirm it integrates.
4. Add a `pi-<name>/architecture.md` under `packages/` only if the package breaks the canonical shape (e.g. has its own `src/lib/`, registers under a built-in name, or is a pure library).
</important>

<important if="you are changing tsconfig or eslint config">
The root `tsconfig.base.json` and `eslint.config.mjs` are the canonical homes. Per-package `tsconfig.json` files should only contain `extends` + `include`. Adding `compilerOptions` to a per-package tsconfig will silently shadow the base.
</important>
