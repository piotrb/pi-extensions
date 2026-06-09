# pi-bfs (transitional)

Single-tool wrapper around the `bfs` CLI. **Marked `private: true`** with a migration plan in `plans/migrate-to-fd.md`. Pending migration to a future `pi-fd` package.

## Layer responsibility

Wraps the `bfs` (breadth-first file finder) CLI as a structured tool. Will be replaced by a `fd`-wrapping package once the migration lands.

## Dependencies

- **Outbound**: `@piotrb/pi-extension-utils` (`spawnStreaming`).
- **Inbound**: pi-runtime.

## Module structure

```
src/extensions/bfs.ts            # one registerTool call
src/extensions/bfs.test.ts       # co-located test
plans/migrate-to-fd.md           # migration plan (NOT shipped)
```

## The private/transitional shape

```jsonc
// packages/pi-bfs/package.json
{
  "name": "pi-bfs",
  "private": true,
  "pi": { "extensions": ["./src/extensions/bfs.ts"] },
}
```

`private: true` is the signal to npm tooling — this package is workspace-internal and **not published**.

## Migration status

`plans/migrate-to-fd.md` describes the path to a future `pi-fd` package that wraps `fd` instead of `bfs`. Once that lands, `pi-bfs` will be retired.

## Hard rules

- **Do not publish `pi-bfs`** — it's marked `private: true`.
- **Do not add new features** to this package. The migration is in progress.
- **Treat as a temporary dependency.** Use `pi-ripgrep` for content search until the `fd` migration lands.

<important if="you are tempted to extend pi-bfs">
Don't. This package is pending migration. Add the new feature to the `pi-fd` package (or to `pi-ripgrep` if it's a content-search feature) once the migration lands, or to a different existing package.
</important>
