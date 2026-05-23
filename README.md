# pi-core-tools

A collection of structured tool extensions for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

## Extensions

| Source                     | Tools registered                  | Description                                        |
| -------------------------- | --------------------------------- | -------------------------------------------------- |
| `src/bfs.ts`               | `bfs`                             | Breadth-first file finder (wraps the `bfs` binary) |
| `src/ripgrep.ts`           | `ripgrep`                         | Structured file content search (wraps `rg`)        |
| `src/git.ts`               | `git_add`, `git_rm`, `git_commit` | Typed git staging & commit operations              |
| `src/task-runner.ts`       | `task`                            | Allowlist-based replacement for freeform bash      |
| `src/context-preloader.ts` | —                                 | Preloads context files into the session on startup |
| `src/extension-utils.ts`   | —                                 | Shared internal utility (`spawnStreaming`, etc.)   |

## Usage

### As a pi package (recommended)

Add to your pi `settings.json`:

```json
{
  "packages": ["path:/path/to/pi-core-tools"]
}
```

### System requirements

- `bfs`: `brew install bfs` / `apt install bfs`
- `rg`: `brew install ripgrep` / `apt install ripgrep`

## Development

```sh
pnpm install
pnpm check      # format + lint + typecheck
```
