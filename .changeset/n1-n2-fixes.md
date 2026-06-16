---
"@piotrb/pi-tool-policy": patch
"@piotrb/pi-bfs": patch
"@piotrb/pi-ripgrep": patch
---

Apply future-tasks findings N-1 and N-2:

- **N-1 — `extractStringFields` per-field cardinality.** The runtime-grant extraction in `pi-tool-policy/src/extensions/tool-policy.ts` now consumes the tool's `ResolvedToolMetadata` and restricts the lock to fields the matcher actually binds. Previously, the function joined every `string[]` in the input, including fields the matcher never sees (e.g. an `unrelated` field); this produced locks that didn't affect any verdict. The new behavior: bound fields are extracted with the same `" "` join the matcher uses; unbound fields are skipped; when metadata is `undefined` (back-compat with tools that haven't migrated to the aspect model), the function falls back to extracting every string / `string[]` field. `extractStringFields` is now exported for direct unit testing.
- **N-2 — `cwd` field shape and resolution tests.** Added execution-path tests for `pi-bfs` and `pi-ripgrep` that spy on `spawnStreaming` via `vi.mock` and assert: the `cwd` field is `Type.Optional(Type.String()))`-shaped (already implicit in the registration tests), and the resolution behavior — relative `cwd` resolves against `ctx.cwd`, absolute `cwd` passes through, omitted `cwd` falls back to `ctx.cwd`. The mock captures the `options.cwd` passed to `spawnStreaming` and compares against the expected resolved path.
