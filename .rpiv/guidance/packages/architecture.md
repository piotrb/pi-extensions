# packages/ — extension monorepo

7 self-contained pi-extensions + 1 shared library. Each package is a publishable npm module under `@piotrb/pi-*` (or `private: true`).

## Per-package shape (canonical)

```
packages/pi-<name>/
  package.json                            # name, pi.extensions, trimmed peerDeps
  tsconfig.json                           # extends ../../tsconfig.base.json
  README.md
  src/extensions/<name>.ts                # the extension entry, default export
  src/extensions/<name>.test.ts           # co-located vitest
```

```jsonc
// packages/pi-git/package.json
{
  "name": "@piotrb/pi-git",
  "type": "module",
  "files": ["src/**/*.ts", "!src/**/*.test.ts", "README.md"],
  "pi": { "extensions": ["./src/extensions/git.ts"] },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*",
  },
}
```

## Tool registration pattern (recurs in 4 of 7 packages)

```ts
// src/extensions/<name>.ts
import { Type } from "typebox"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "tool_name",
    description: "What the LLM needs to know to call this",
    parameters: Type.Object({
      /* typebox schema */
    }),
    execute: async (_id, params, _ctx) => {
      // spawn a process OR call fs/promises, return { content: [{ type: "text", text }] }
    },
  })
}
```

`name` is what the agent calls. The `pi.extensions` path is how pi _loads_ the file. These can differ (`pi-ripgrep` loads `ripgrep.ts` but registers as `name: "ripgrep"`).

## Outliers

| Package                | Why it breaks the shape                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `pi-extension-utils`   | Pure library — no `pi.extensions` field, exports `src/extension-utils.ts` directly  |
| `pi-bfs`               | `private: true`, has a `plans/migrate-to-fd.md` (transitional)                      |
| `pi-task-runner`       | Adds `src/lib/` for internal helpers (permission matcher, config loader, TUI modal) |
| `pi-context-preloader` | Hooks lifecycle events instead of registering tools — see its architecture.md       |
| `pi-ripgrep`           | Has `plans/extend-and-replace-grep.md` (transitional)                               |

## Hard rules

- **Trim `peerDependencies` to actual imports.** `pi-context-preloader` doesn't need `@earendil-works/pi-tui` or `typebox`.
- **`files` allowlist is `["src/**/_.ts", "!src/\*\*/_.test.ts", "README.md"]`** — `plans/` is automatically excluded.
- **Co-located tests.** `<name>.test.ts` next to source, not in `__tests__/`.
- **Internal deps**: `workspace:*` for `pi-extension-utils` consumers.
- **All packages `private: true` or `publishConfig.access: "public"`** for publishing — see `.ai/pi-npm-publishing.md` (out of scope here).

<important if="you are adding a new pi-git-style tool">
1. Add `pi.registerTool({...})` in the appropriate `src/extensions/<name>.ts` file (existing or new package).
2. Define the typebox schema in `Type.Object({...})` — required fields are bare, optional ones use `Type.Optional(...)`.
3. Implement `execute` via `spawnStreaming` (from `pi-extension-utils`) for shell tools, or `fs/promises` for atomic fs ops.
4. Return `{ content: [{ type: "text", text: string }] }` — the pi tool protocol.
5. Add a co-located test in `<name>.test.ts`.
6. Run `pnpm --filter <pkg> run typecheck test`.
</important>
