# pi-context-preloader

The only package that hooks **lifecycle events** instead of registering tools. Auto-preloads `@path` references from `AGENTS.md` into the system prompt. Has a `/context-preload` slash command for inspection.

## Layer responsibility

Scan every `AGENTS.md` file pi loads (cwd + parent dirs + `~/.pi/agent/AGENTS.md`), extract `@path` references, resolve them recursively up to `MAX_DEPTH=5`, and inject the file contents into the system prompt before each agent turn. Deduplicate across the tree.

## Dependencies

- **Outbound**: Node stdlib only (`node:fs`, `node:os`, `node:path`).
- **Inbound**: pi-runtime (the system prompt). No tool calls into this package.
- **Peer deps**: just `@earendil-works/pi-coding-agent` — no `tui`, no `typebox`.

## Module structure

```
src/extensions/context-preloader.ts        # the entire extension (~190 lines)
src/extensions/context-preloader.test.ts   # co-located test
```

## Four lifecycle hook points (UNIQUE)

```ts
// src/extensions/context-preloader.ts
export default function (pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    /* clear cache */
  })
  pi.on("resources_discover", () => {
    /* pre-scan @refs, cache tree */
  })
  pi.on("before_agent_start", (event) => {
    event.systemPrompt += renderSections(cachedSections)
    return { systemPrompt: event.systemPrompt }
  })
  pi.registerCommand("context-preload", {
    description: "Show dependency tree of preloaded @refs",
    handler: () => ctx.ui.notify(renderTree(), "info"),
  })
}
```

`before_agent_start` injection is **one-shot per session** (the `injectedThisSession` flag prevents re-injection). The cache is built during `resources_discover` so the per-turn cost is just string concatenation.

## @path reference resolution

```ts
const REF_RE = /@([\w./\\-]+\.\w+)/g
const MAX_DEPTH = 5

function resolveRefs(content: string, cwd: string, visited: Set<string>, depth: number): RefNode[]
```

- Matches `@` followed by any path-like string with a file extension.
- Resolved relative to the file containing the reference.
- Recursive: a loaded file's own `@refs` are followed up to `MAX_DEPTH` deep.
- Deduplicated via `visited` set across the full resolution tree.

## AGENTS.md discovery

```ts
function findAgentsMd(cwd: string): string[] {
  // walks cwd -> parent -> ... -> /
  // also includes ~/.pi/agent/AGENTS.md (global)
}
```

## Hard rules

- **`session_start` MUST clear the cache** — otherwise stale content leaks across sessions.
- **The `before_agent_start` injection is one-shot per session** — adding more preloaded content means appending to the cached `appended` string.
- **Files that don't exist or are unreadable are silently skipped** (with a log entry at `~/.pi/context-preloader.log`).

<important if="you are adding a new lifecycle hook">
1. Register the hook via `pi.on("event_name", handler)`.
2. Use the same caching pattern as the existing handlers — `session_start` clears, `resources_discover` pre-scans, `before_agent_start` injects.
3. Add a slash command via `pi.registerCommand("name", { description, handler })` if the user should be able to trigger it interactively.
4. Test in `context-preloader.test.ts`.
</important>
