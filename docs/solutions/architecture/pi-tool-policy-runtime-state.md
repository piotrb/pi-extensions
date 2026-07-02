---
title: pi-tool-policy runtime state consolidation (single RuntimeState class rebuilt from session timeline)
category: architecture
severity: high
tags:
  - pi-tool-policy
  - runtime-state
  - in-memory-state
  - session-timeline
  - event-sourcing
  - mode-controller
  - runtime-grants
  - directory-permissions
  - custom-entries
  - hot-reload
  - session_start
  - extension-state
applies_when:
  - designing or refactoring an extension that holds in-memory state across tool_call invocations
  - deciding whether to use closure variables, the session timeline, or a mix of both
  - refactoring a complex handler that has grown multiple in-memory state classes
  - adding a "let the user grant something for this session" feature (runtime grants, directory grants, etc.)
  - wondering why hot-reload (re-read on every access) breaks when in-memory state is a closure variable
  - debugging a bug where session-scoped state is lost between session_start and the next tool_call
  - planning a refactor that needs to persist user-granted permissions across the session
---

# Problem

`pi-tool-policy` started with three in-memory state classes in the extension's closure: `ModeController` (current mode name), `RuntimeGrants` (allow-for-session grants on tools), and `DirectoryPermissionsState` (path grants from the directory modal). Each had its own shape, lifetime, and read/write API. The user observed that this was hard to test (every test had to thread the closure through the handler) and that some bugs — like the "is this a session grant or a persisted grant?" question — had no clean home.

The deeper issue: each class carried a different _kind_ of state. The mode controller carried a _pointer_ (which mode is active). Runtime grants and directory grants carried _rule-shaped_ state (grants are like `toolRules` or `allowedPaths` entries). Mixing them in three parallel interfaces meant three different read paths, three different write paths, and three different lifecycle questions. The "what's the active mode?" question has no answer outside the handler. The "what runtime grants exist?" question has its own internal store. They don't compose.

# Context

`pi-tool-policy` is a `tool_call` handler in the pi extension loop. The matcher's per-layer most-specific-wins combine needs to know the active mode. The directory modal grants paths. The ask modal grants runtime access. All three pieces of state are session-scoped (cleared on `session_start` and `session_end`).

The hot-reload contract (`no-cache-for-user-mutable-data`) says: re-read the on-disk config on every `tool_call`. But the in-memory state — the mode name, the grants — was held in closure variables. When the session reloads, the closure variables are gone. The user re-grants everything. This was the design's UX bug.

pi's session timeline (`SessionManager.getEntries()`, `appendCustomEntry(...)`) is the standard mechanism for extension state that needs to survive a session reload. The `CustomEntry` shape is `{ type: "custom", customType: "...", data: ... }` — extension-defined, not part of LLM context.

# Solution

Consolidate the in-memory state into a single `RuntimeState` class. Rebuild it from the session timeline at `session_start`. After that, the in-memory state is the source of truth within a session.

## The shape

```ts
class RuntimeState {
  // Factory: rebuild from the timeline. The `config` parameter
  // provides the initial mode name (config.modeOrder[0]) when the
  // timeline is empty — no setMode event has fired yet.
  static fromTimeline(timeline: SessionEvent[], config: Config, cwd: string): RuntimeState

  // Read methods (return the current in-memory state)
  currentModeName(): string
  effectiveTags(): string[]

  // Write methods (append to timeline AND update in-memory)
  setMode(modeName: string): void
  addRuntimeGrant(grant: RuntimeGrant): void
  addSessionAllowedPath(grant: AllowedPath): void
}
```

The timeline carries **session-scoped deltas only** (setMode, addRuntimeGrant, addSessionAllowedPath). The initial mode name is not in the timeline — it comes from the on-disk config.

## The handler's session_start

```ts
pi.on("session_start", async (_event, ctx) => {
  const { config } = await loadConfig(ctx.cwd)
  const entries = ctx.sessionManager.getEntries()
  const customEntries = entries.filter((e) => e.type === "custom" && e.customType === "pi-tool-policy-runtime")
  const events = customEntries.map(parseRuntimeEvent)
  runtimeState = RuntimeState.fromTimeline(events, config, ctx.cwd)
})
```

The handler reads the timeline once. The `RuntimeState` is the source of truth for the rest of the session. The handler does NOT hold onto `ctx.sessionManager` — only the in-memory state.

## The handler's tool_call

```ts
pi.on("tool_call", async (event, ctx) => {
  const currentMode = runtimeState.currentModeName()
  const effectiveTags = runtimeState.effectiveTags()
  // ... match against the resolved mode ...
})
```

The handler reads from `RuntimeState` directly. No closure variables for the in-memory state.

## The matcher's input is a `DecideContext`

The matcher takes a `DecideContext` — a minimal readonly interface that captures only what the matcher needs:

```ts
interface DecideContext {
  readonly currentModeName: string
  readonly activeMode: Mode // resolved via resolveMode
  readonly taggingRules: TaggerRule[]
  readonly toolMetadata: Map<string, ResolvedToolMetadata>
  readonly cwd: string
}

function decide(event: ToolCallEvent, ctx: DecideContext): PolicyDecision
```

The matcher doesn't see the `Config` directly. The handler builds the context from `RuntimeState` + the merged `Config` + the tool metadata.

## The merge pipeline produces the merged `Config`

`composeConfig(...layers: Array<Config | Partial<Config>>)` takes N layers and produces the merged `Config`. The session layer is one of them:

```ts
const sessionLayer = sessionToConfigLayer(runtimeState.timeline(), config, ctx.cwd)
const merged = composeConfig(STOCK_CONFIG, userConfig, projectConfig, sessionLayer)
```

`sessionToConfigLayer(timeline, config, cwd)` translates the timeline into a `Partial<Config>`:

- `setMode` events → mode-order adjustment.
- `addSessionAllowedPath` events → `allowedPaths` entries.
- `addRuntimeGrant` events → `toolRules` entries on the appropriate mode.

The merged `Config` is the input to `resolveMode` and `evaluate` (the inner matcher).

## Persisted grants stay in the config file

Session grants (one-off and session-level) go through the timeline + `RuntimeState`. **Persisted** grants (the user said "remember across sessions") go through the on-disk config file via `permission-writer`. They never appear in the timeline. The timeline carries only the session-scoped deltas; the on-disk config carries the persisted rules.

# Why this works

- **One merge logic.** All "this is the effective config" goes through `composeConfig`. The matcher doesn't know which layer a rule came from; it sees the merged `Config`. The `RuntimeGrants.applyFor` step, the `DirectoryPermissionsState.matches` step, the mode controller's `getMode` step — all become layer-merges.

- **One in-memory shape.** All in-memory state is held by `RuntimeState`. The mode name is a `currentModeName()` call. The grants are queryable via the merged `Config`'s `toolRules` and `allowedPaths` (after the session-projection). No bespoke interfaces to remember.

- **The timeline is the source of truth across sessions.** The in-memory state is the source of truth within a session. The transition is at `session_start` (rebuild from timeline) and at write time (append to timeline + update in-memory). The user can review their grants in the timeline (visible to the agent); the policy engine reads them via the in-memory state.

- **Hot-reload is preserved uniformly.** The on-disk config is re-read per `tool_call` (existing contract). The session timeline is read fresh at `session_start` (no caching of the read result). After that, the in-memory state is the source of truth within a session. The `no-cache-for-user-mutable-data` principle is upheld: no caching of derived state across calls.

- **The matcher's contract is focused.** `decide(event, ctx)` takes 5 fields. It doesn't see the `Config`, the `ModeController`, the `RuntimeGrants`, or the `DirectoryPermissionsState`. The test surface is small and focused: assert on the `PolicyDecision` given a `DecideContext`.

- **Investigating bugs is local.** If the verdict is wrong, the "investigate gate" can point at the outer `decide` (orchestration), the inner `evaluate` (rule combine), the `buildToolCallMetadata` (global stuff), the `resolveMode` (mode resolution), the `composeConfig` (merge), the `sessionToConfigLayer` (projection), the `RuntimeState` (state), or the `applyTaggerRules` (tagger). Each is a separate file with a separate test surface. No "where do I put the print statement to debug this?" question.

# Prevention

- **Don't hold onto `ctx.sessionManager` at runtime.** The runtime extension reads the timeline once at `session_start`; after that, the in-memory state is the source of truth. Holding a `sessionManager` reference is a recipe for stale state and lifetime bugs.

- **Don't cache derived state across calls.** Every read of the matcher re-computes from the in-memory state + the re-read config. Caching breaks the hot-reload contract and creates "is this cache stale?" bugs. The `RuntimeState` holds in-memory state (the source of truth within a session), not derived state (which is computed per call).

- **Don't put persisted grants in the timeline.** The timeline carries session-scoped events only. Persisted grants are config-level state. Mixing them makes the timeline bigger (load-time cost) and creates "did I save this?" ambiguity. The `permission-writer` is the only path for persisted grants.

- **Don't make `RuntimeState.fromTimeline` parameterless.** The initial mode name comes from `config.modeOrder[0]`, not the timeline. If `fromTimeline` doesn't take `config`, the initial mode is unknown until the first `setMode` event — which is wrong. Pass `config` (or at least the initial mode name).

- **Don't mix pointer-state and rule-state in the same class.** The mode controller is a _pointer_ (which mode is active). Runtime grants and directory grants are _rule-shaped_ (they project into `toolRules` / `allowedPaths`). Putting them in three parallel classes is what created the original problem. Consolidating into a single `RuntimeState` separates the _source of truth_ (the class) from the _projection_ (`sessionToConfigLayer`).

- **Don't add new action types to the timeline that don't need cross-session replay.** The timeline is read at `session_start` to rebuild state. If a "transient overlay" or a "modal-only flag" doesn't need to survive a session reload, it doesn't go in the timeline — it goes in a closure variable. The timeline is for state that must replay.

- **Don't forget the `sessionToConfigLayer` indirection.** The session-projection is a separate pure function, not a method on `RuntimeState`. This keeps the merge logic in `composeConfig` (which takes N layers) and the projection logic in `sessionToConfigLayer` (which knows about timeline events). They compose; they don't entangle.

# Verification

- **The `RuntimeState` class is the only in-memory state.** The old `ModeController`, `RuntimeGrants`, `DirectoryPermissionsState` closure variables are gone. The extension's closure holds one `runtimeState: RuntimeState` variable.
- **The handler at `session_start` reads the timeline once** and constructs `RuntimeState`. The handler does not retain a `sessionManager` reference.
- **The matcher's input is `DecideContext`.** The matcher (`decide(event, ctx)`) takes 5 fields. It does not see the `Config` directly.
- **`composeConfig` accepts N layers.** The session layer is one of them. The merged `Config` reflects stock + user + project + the in-memory state (via `sessionToConfigLayer`).
- **Hot-reload works.** The on-disk config is re-read per `tool_call`; the in-memory state is rebuilt from the timeline at `session_start`; no caching of derived state across calls.

🧠 **Context Status** (for handoff):

- **Health:** good. The plan `docs/plans/tool-policy-decomposition-and-test-surface.md` is in a reviewable state. Workspace 23/23 green.
- **Handoff path:** `docs/plans/tool-policy-decomposition-and-test-surface.md` (the seven-unit decomposition plan).
- **Active files:**
  - `docs/solutions/architecture/pi-tool-policy-runtime-state.md` (this solution).
  - `docs/plans/tool-policy-decomposition-and-test-surface.md` (the plan that motivates the pattern).
  - `packages/pi-tool-policy/src/lib/runtime-state.ts` (the file to extract in Unit 5).
  - `packages/pi-tool-policy/src/lib/session-to-config-layer.ts` (the file to extract in Unit 5).
- **New-session recommendation:** when implementation starts, begin with Unit 1 (YOLO is a stock mode) — it's the smallest, has no dependencies, and unblocks all other units.
