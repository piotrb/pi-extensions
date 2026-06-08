# pi-extensions

A pnpm workspace of pi coding-agent extensions. Each extension is its own publishable npm package.

## Packages

| Package                                                             | Description                                                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [`pi-bfs`](./packages/pi-bfs/README.md)                             | Breadth-first file finder (`bfs`) wrapper                                                                                         |
| [`pi-context-preloader`](./packages/pi-context-preloader/README.md) | Auto-preload `@refs` from `AGENTS.md` into system prompt                                                                          |
| [`pi-extension-utils`](./packages/pi-extension-utils/README.md)     | Shared utilities: `spawnStreaming`, `progressiveKill`, `scheduleProcessTimeout`                                                   |
| [`pi-git`](./packages/pi-git/README.md)                             | Structured git tools: `git_status`, `git_add`, `git_rm`, `git_mv`, `git_diff`, `git_restore`, `git_commit`, `git_log`, `git_push` |
| [`pi-pfs`](./packages/pi-pfs/README.md)                             | Project filesystem tools: `pfs_unlink`, `pfs_rmdir`, `pfs_cp`, `pfs_mv`                                                           |
| [`pi-ripgrep`](./packages/pi-ripgrep/README.md)                     | ripgrep (`rg`) file content search wrapper                                                                                        |
| [`pi-task-runner`](./packages/pi-task-runner/README.md)             | Safer `run` tool with configurable permission rules                                                                               |

## Development

```sh
pnpm install                        # install all workspace packages
pnpm run check                      # typecheck + format + lint + test across all packages
pnpm -r run typecheck               # tsc --noEmit in every package
pnpm -r run test                    # vitest run in every package
pnpm --filter pi-bfs run check      # single-package check
```

## Adding a new extension

1. Create `packages/pi-<name>/src/extensions/<name>.ts` exporting `default function (pi: ExtensionAPI): void`
2. Create `packages/pi-<name>/package.json` with:
   - `"name": "pi-<name>"`
   - `"pi": { "extensions": ["./src/extensions/<name>.ts"] }`
   - `"peerDependencies"`: only what the extension actually imports
   - `"dependencies": { "pi-extension-utils": "workspace:*" }` if the extension uses spawn utilities
3. Create `packages/pi-<name>/tsconfig.json` extending `../../tsconfig.base.json`
4. Run `pnpm install` then `pnpm --filter pi-<name> run check`

See [AGENTS.md](./AGENTS.md) for full guidelines.
