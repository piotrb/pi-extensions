---
"@piotrb/pi-tool-policy": patch
---

Apply future-tasks finding N-4 — hard-fail on duplicate tool-metadata declarations:

- **`aggregateToolMetadata`** now tracks every source directory that contributes to each tool name. When two `package.json` files declare the same tool, or when a `package.json` shadows a built-in, a `duplicate-tool` warning is emitted identifying all contributing source directories.
- The previous `duplicate-aspect` warning variant (declared in the type union but never emitted) is replaced with `duplicate-tool`, which carries `{ tool, sources: string[] }`. The `sources` array lists the contributing package.json directories (with the built-in STOCK listed as `"<built-in>"` when a package.json shadows it).
- Config overrides (layer 3) still last-write-win against package.json contributions, because the user explicitly wrote the config. Only package.json vs package.json (and package.json vs built-in STOCK) is flagged.
- 4 new tests in `tool-metadata.test.ts` cover: two packages with the same tool name, the same package contributing two tools (no false positive), a config override over a package.json tool (no warning), and a package.json that shadows a built-in.
