---
"@piotrb/pi-tool-policy": patch
---

- **`/tool_policy` → `Debug` → `Tools`** — the JSON dump is replaced by a navigable per-tool sub-modal. One entry per tool (sorted by name, with `(disabled)` appended when the tool is not in `pi.getActiveTools()`). Pressing Enter opens a popover with the structured detail: a 2-line built-in form (`built-in` / `enabled: …`), a 5-line package form (`package` / `enabled` / `baseDir` / `path` / `scope`), or the JSON dump as a fallback. The old `dumpTools` JSON helper is preserved and used as the fallback path.
- **Drop the `execution` tag entirely.** `bash` no longer carries `tags: ["execution"]`; the `default` mode no longer sets `tagRules.execution = "ask"`; `plan` no longer sets `tagRules.execution = "deny"`; the `STOCK_CONFIG.toolMetadata.bash` entry loses its `execution` tag. Bash is still matched and gated by its `bash_cmd` aspect — the tag was redundant. All test fixtures, JSDoc, and comments referencing `tag:execution` were updated to use the still-in-stock `mutating` tag (or empty `tags: []` for the bash metadata case).
- **Toolchain** — `format` and `format:check` scripts now wrap prettier in `sh -c 'set -x; pnpm exec prettier … "${1:-.}"' --` so they accept an optional path argument (e.g. `pnpm format packages/pi-tool-policy`).
- **Stock inheritance chain test** — `expect(config.modes.readonly?.tagRules).toEqual({...})` relaxed to `toMatchObject({...})` so the assertion pins the stock keys without requiring an exact shape (the merged config now includes the user-config overlay added in `.pi/tool-policy.json`).

Cleanup of the user's `.pi/tool-policy.json` (dropped the `ask_user_question` allow-rule for `readonly` and the `default` bash_cmd aspect overrides — redundant with the stock config) is included.
