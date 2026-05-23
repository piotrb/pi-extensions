# pi-extensions-wip

Staging ground for pi coding-agent extensions.

## Extensions

| File | Description |
|------|-------------|
| `bfs.ts` | Structured wrapper around the `bfs` breadth-first file finder |
| `context-preloader.ts` | Preloads context files into the session |
| `extension-utils.ts` | Shared utilities (spawnStreaming, etc.) — imported by other extensions |
| `git.ts` | Structured tools for git staging and commit operations (`git_add`, `git_rm`, `git_commit`) |
| `ripgrep.ts` | Structured wrapper around `rg` for file content search |
| `task-runner.ts` | Safer structured replacement for the bash tool (allowlist-based) |

Extensions live in `.pi/extensions/` and are auto-discovered by pi when this is the project root.

## Dependencies

- `bfs`, `git`, `ripgrep` all import from `./extension-utils.ts`
- Install `bfs`: `brew install bfs`
- Install `rg`: `brew install ripgrep`
