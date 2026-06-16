---
name: pi-lifecycle-hooks
description: When a pi-* extension hooks lifecycle events instead of registering tools — session_start, resources_discover, before_agent_start, tool_call — follow the three-phase pattern. Use when designing an extension that observes the agent loop, mutates the system prompt, or gates tool calls.
---

You are designing a `pi-*` extension that does not register tools. Instead, it hooks the agent's lifecycle events to observe, mutate, or gate the agent's behavior. The `pi-context-preloader` package is the canonical example; `pi-tool-policy` is another (with a `tool_call` gate).

## The pattern

A lifecycle-only extension is a default export that registers handlers for one or more lifecycle events. There is no `pi.registerTool`. The four useful hook points are:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    // 1. clear any per-session cache, reset state
  })

  pi.on("resources_discover", (event, ctx) => {
    // 2. pre-scan and cache (e.g. AGENTS.md @refs, tool metadata)
  })

  pi.on("before_agent_start", (event) => {
    // 3. mutate the system prompt or context
    return { systemPrompt: event.systemPrompt + injected }
  })

  pi.on("tool_call", (event) => {
    // 4. gate or transform a tool call (return { block, reason } to block)
  })
}
```

The four events form a layered pattern. The same extension can hook one, some, or all of them.

## When to use which event

### `session_start` — fires once at session load

Use for state that must reset across sessions: in-memory caches, in-memory grants, mode state, warnings. **Cache clear is mandatory** for any closure-cached data — stale content leaks across sessions otherwise.

```ts
let cached: SomeData | null = null

pi.on("session_start", () => {
  cached = null
})
```

### `resources_discover` — fires after [Context]/[Skills]/[Extensions] display

Use for pre-scanning work that the per-turn handlers will need. The event is fired right after pi's own startup display, so the result can be displayed alongside or via `ctx.ui.notify`.

This is the "warm the cache" phase. Cheap work goes here; expensive work goes here too, as long as the result is cached and reused.

### `before_agent_start` — fires every agent turn

Use for system prompt injection, context augmentation, or any per-turn work that must happen before the LLM sees the conversation. The handler may return `{ systemPrompt: <new prompt> }` to override the prompt; the LLM sees the new value.

```ts
pi.on("before_agent_start", (event) => {
  if (injectedThisSession) return  // no-op after the first turn
  injectedThisSession = true
  return { systemPrompt: event.systemPrompt + cached }
})
```

**One-shot per session is the common pattern.** The first turn injects, subsequent turns are no-ops. Track this with a closure variable reset on `session_start`.

### `tool_call` — fires before every tool invocation

Use for permission gates, audit logging, or call transformation. Returning `{ block: true, reason: "..." }` blocks the call; returning `undefined` allows it. Returning `{ modifiedArgs: [...] }` rewrites the call.

```ts
pi.on("tool_call", (event) => {
  const verdict = checkRules(event.tool, event.args, currentMode)
  if (verdict === "deny") return { block: true, reason: "denied by policy" }
  // ...
})
```

## The three-phase pattern (load → pre-scan → inject)

For read-mostly extensions that augment the system prompt, the canonical three-phase pattern is:

1. **`session_start`** — clear cache.
2. **`resources_discover`** — pre-scan and cache the data.
3. **`before_agent_start`** — read the cache and return the mutated prompt.

The per-turn cost is just a string concatenation. The expensive work (file reads, parsing) happens once at session start.

## Slash commands for inspection

Lifecycle extensions often register a slash command for ad-hoc inspection of the cached data:

```ts
pi.registerCommand("context-preload", {
  description: "Show dependency tree of preloaded @refs",
  handler: async (_args, ctx) => {
    ctx.ui.notify(`preloaded ${cached.length} files`, "info")
  },
})
```

The command reads the closure cache and displays it via `ctx.ui.notify`.

## Common pitfalls

- **Forgetting to clear the cache on `session_start`** — stale content leaks across sessions. The first symptom is "why is the agent acting on yesterday's data?"
- **Injecting on every turn without the one-shot guard** — the system prompt grows unbounded; the LLM wastes tokens on duplicates.
- **Doing expensive work in `before_agent_start`** — it fires every turn. Pre-scan in `resources_discover` and cache.
- **Holding state across sessions in closure variables without a reset** — see the first pitfall.

## What this skill does not do

- It does not cover tools that register via `pi.registerTool` — see `pi-register-tool`.
- It does not cover the package shell (`package.json`, `tsconfig.json`, etc.) — see `pi-package-scaffold`.

## Related

- @.agents/skills/pi-package-scaffold/SKILL.md
