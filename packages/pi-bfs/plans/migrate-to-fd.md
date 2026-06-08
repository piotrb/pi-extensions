# Plan: Migrate pi-bfs → pi-fd (and replace the built-in `find`)

## Goal

Rename this package to `pi-fd`, replace the underlying binary from `bfs` to `fd`,
register as `name: "find"` to replace pi's built-in `find` tool, and expose fd's
rich parameter set that the built-in leaves unexposed.

**Do not publish until this migration is complete.**

## Why fd over bfs

- `fd` is already installed as a hard dependency of pi's built-in `find` tool.
  Users who have pi installed already have `fd` — zero additional install friction.
- `fd` is more widely adopted, better documented, and more actively maintained.
- The built-in `find` uses `ensureTool("fd", true)` — fd can be auto-downloaded if missing.
- `bfs` requires a separate install (`brew install bfs`) that most users won't have.
- fd has feature parity with everything we use bfs for, with cleaner flag names.

## What the built-in `find` does well (keep)

- `ensureTool("fd", true)` — auto-downloads fd if not installed. We currently fail
  hard if `bfs` is not in PATH.
- Smart `--full-path` glob handling: if the pattern contains `/`, fd is invoked with
  `--full-path` and the pattern is prefixed with `**/` as needed. This makes
  `src/**/*.spec.ts` work correctly without the user knowing fd's quirks.
- `--no-require-git` flag: applies .gitignore semantics even outside git repos without
  leaking sibling-directory rules via a global ignore file.
- `--hidden` on by default (fd hides dotfiles by default; the built-in passes `--hidden`
  explicitly so hidden files are always included). Our bfs extension has `noHidden` as an
  opt-in; this inverts the default to match user expectations for a code search tool.
- Relative path output — results are relativised against the search root.

## What our bfs extension does well (keep)

- **Type filtering** — `f`, `d`, `l`, etc. fd supports `--type` with the same values
  (file/f, directory/d, symlink/l, executable/x, empty/e, socket/s, pipe/p).
- **Depth control** — `maxDepth`/`minDepth` → fd `--max-depth`/`--min-depth`.
- **Size filtering** — fd `--size` with identical syntax (`+1M`, `-100k`).
- **Time filtering** — fd `--changed-within`/`--changed-before` replaces bfs `mtime`/`since`/`newer`.
- **Permission filtering** — `executable` → fd `--type x`, `readable`/`writable` have no
  direct fd equivalent (note in docs, fall back to post-filter or drop).
- **Regex matching** — fd `--regex` flag natively supported.
- **Exclude globs** — fd `--exclude`.
- **noHidden** — fd default already hides dotfiles; `noHidden: true` maps to omitting `--hidden`.
- Streaming output via `onUpdate`.
- Rich `renderCall` TUI display.

## bfs → fd parameter mapping

| bfs param                 | fd equivalent                                            | Notes                                        |
| ------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| `paths`                   | positional args                                          | fd accepts multiple search paths             |
| `name`                    | `--glob <name>`                                          | basename glob                                |
| `iname`                   | `--glob <name> --case-insensitive`                       | fd has `--ignore-case`                       |
| `path` / `ipath`          | `--full-path --glob <path>`                              | fd full-path glob                            |
| `regex`                   | `--regex <pattern>`                                      | fd native regex                              |
| `type` f/d/l/s/p/b/c      | `--type file/directory/symlink/socket/pipe`              | b/c (block/char devices) not supported by fd |
| `maxDepth`                | `--max-depth`                                            | identical                                    |
| `minDepth`                | `--min-depth`                                            | identical                                    |
| `noHidden`                | omit `--hidden`                                          | fd hides dotfiles by default                 |
| `followSymlinks` args/all | `--follow`                                               | fd has one follow mode                       |
| `size`                    | `--size`                                                 | identical syntax                             |
| `empty`                   | `--type empty`                                           | fd supports empty files/dirs                 |
| `newer <path>`            | `--newer <path>`                                         | fd `--newer`                                 |
| `since <date>`            | `--changed-after <date>`                                 | fd date format may differ                    |
| `mtime +N`                | `--changed-before <N>d`                                  | fd uses duration strings                     |
| `executable`              | `--type executable` or `--type x`                        | fd built-in                                  |
| `readable`                | no equivalent                                            | drop or document as unsupported              |
| `writable`                | no equivalent                                            | drop or document as unsupported              |
| `sorted`                  | `--color=never` output is unsorted; add client-side sort | fd has no `--sort` flag                      |
| `unique`                  | n/a                                                      | fd doesn't follow symlinks by default        |
| `depthFirst`              | n/a                                                      | fd traversal order is not configurable       |
| `noMountCross`            | `--one-file-system`                                      | fd supports this                             |
| `exclude`                 | `--exclude`                                              | identical; repeat for multiple globs         |

## Rename checklist

- [ ] Rename directory `packages/pi-bfs` → `packages/pi-fd`
- [ ] Update `package.json`: `"name": "pi-fd"`, `"private": true` (do not publish yet)
- [ ] Update `package.json` description
- [ ] Rename `src/extensions/bfs.ts` → `src/extensions/fd.ts`
- [ ] Register as `name: "find"` (replaces built-in)
- [ ] Swap binary from `bfs` to `fd` using `ensureTool("fd", true)`
- [ ] Adopt `--full-path` glob handling from the built-in
- [ ] Adopt `--no-require-git` flag
- [ ] Add `--hidden` by default (invert noHidden logic)
- [ ] Implement fd parameter mapping from the table above
- [ ] Drop `readable`/`writable` (document as unsupported by fd)
- [ ] Drop `depthFirst` / `unique` (no fd equivalent)
- [ ] Keep streaming via `onUpdate`
- [ ] Update `renderCall` to display `fd` not `bfs`
- [ ] Update README
- [ ] Update AGENTS.md and root README references
- [ ] Run `pnpm check`
- [ ] Mark publishable once migration is stable
