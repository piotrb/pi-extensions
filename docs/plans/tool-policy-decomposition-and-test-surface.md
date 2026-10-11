---
title: Tool-policy decomposition and high-level test surface
status: draft
created: 2026-07-01
owner: agent
---

# Tool-policy decomposition and high-level test surface

## Problem summary

`packages/pi-tool-policy` is a 4-layer permission policy for pi's
`tool_call` gate. The matcher (`evaluate()`) and the config loader
(`loadConfig()`) are already pure and well-tested at the layer the user
wants, but **the `tool_call` handler in `extensions/tool-policy.ts` is
100+ lines and does 6 things in one function** — load config, apply
tagger rules, run directory guardrail, inject runtime grants, evaluate,
then dispatch on the verdict (with modal side effects for `ask`). The
only way to test the "happy path with effective metadata" surface
end-to-end today is to mock pi's `ExtensionAPI`, which is exactly the
test-bypass the user wants to avoid.

The user proposed three high-level test classes that map naturally to
three extraction points in the code. This plan proposes those
extractions and the test surface that goes with each. It does **not**
add a `enableStockRules` toggle, fix the dispatch-key gotcha, or change
the matcher — see "Out of scope" below for the rationale.

## Relevant learnings

- `docs/solutions/architecture/working-with-pi-tool-policy.md` — the
  package's load-bearing rules, lifecycle, and the **hot-reload contract**
  (re-read `loadConfig` on every `tool_call`; no caching).
- `docs/solutions/architecture/pi-tool-policy-mode-controller.md` —
  the v2 type contract, the per-mode single-pass matcher, the mode
  controller, the directory-permissions guardrail, and the verdict
  combine (`deny > ask > allow`, `undecided` collapses to `ask`).
- `docs/solutions/architecture/pi-tool-policy-per-field-aspect-cardinality.md` —
  the per-field `FieldBinding` shape and the **dispatch-key gotcha**
  (latent bug: `policy.ts:144` and `coverage.ts:64` pass `aspectName`
  to `matchAspect` instead of `decl.mode`; the test suite masks it
  with patterns that match in both branches).
- `docs/solutions/architecture/pi-package-hard-rules.md` — co-located
  tests (`<name>.test.ts` next to source), no `compilerOptions` in
  per-package tsconfig, no `index.ts` barrel.
- `docs/solutions/architecture/pi-monorepo-overview.md` — the canonical
  commands; `pnpm run check` is the full check, scoped filters are for
  iteration.
- `docs/solutions/architecture/no-cache-for-user-mutable-data.md` —
  the principle behind the hot-reload contract.
- `docs/solutions/architecture/pi-task-runner-permission-pattern.md` —
  a comparable matcher architecture; reinforces "test behavior, not
  data shape."
- `@earendil-works/pi-coding-agent/docs/session-format.md` — the
  pi session format. `CustomEntry` (`type: "custom"`,
  `customType: "..."`, `data: ...`) is the extension's
  state-persistence vehicle; `SessionManager.appendCustomEntry(customType, data?)`
  is the write API; `sessionManager.getEntries()` is the read API
  at `session_start`. The runtime does NOT hold a
  `sessionManager` reference; the timeline is read once at
  `session_start` and the in-memory state is the source of
  truth within a session. `CustomMessageEntry` is for messages
  that participate in LLM context — not what we want for state.
- AGENTS.md "Tests assert behavior, not data" — loader/merger tests
  exercise the loader/merger logic, not the data shape it returns.

## Hot-reload contract

This plan **does not** introduce a cache anywhere. The `decide()`
extraction takes a fresh `Config` as a parameter; it does not call
`loadConfig()` itself. The handler remains the only caller of
`loadConfig()`, and the handler still calls it on every `tool_call`
event (per `working-with-pi-tool-policy`'s "Do not add caching to the
`loadConfig` path"). The cost of re-reading is ~1ms; the cost of
serving stale config is high. No change to this contract.

## Out of scope

- **An `enableStockRules` toggle.** The user originally proposed
  "toggle for enable stock rules" as an input to the composition
  test. Stock is the only source of the `default` / `readonly` /
  `edit` / `plan` modes and the 7 built-in tools' metadata. Disabling
  it would leave the matcher with no modes to operate on — the
  "result" would be a useless `Config`. Adding a toggle purely for
  testability is a feature dressed up as a refactor. The composition
  test takes **the layers as inputs** and asserts on the merge;
  that's the property worth testing.
- **Decomposing the modal flow.** Modal side effects stay in the
  handler. The `decide` extraction stops at the verdict; the
  ask modal and the directory modal are handler-side.
- **Changing the matcher (`evaluate()`).** The matcher is already
  pure and well-tested at the layer the user wants. Unit 7a
  splits it from the outer `decide` (the inner matcher stays
  named `evaluate`; the outer matcher is named `decide`), but
  the matcher's logic is unchanged.

## Architecture decisions

The plan introduces a new architecture for the in-memory state and
the matcher's input. The decisions are ADR-worthy (they cross
multiple files and change the extension's shape); they are
documented here for review.

### A1. The in-memory state is a single `RuntimeState` class

Today, the in-memory state is split across several classes:
`ModeController` (current mode), `RuntimeGrants` (allow-for-session
grants), `DirectoryPermissionsState` (path grants), `enabledCache`
(UI side effect), `liveTools` (tool snapshot), `cachedConfig`
(re-read config). Each has its own shape, its own lifetime, and
its own read/write API.

**Decision:** consolidate into a single `RuntimeState` class. The
class is **the only** in-memory state holder. It is rebuilt from
the timeline at `session_start`; after that, it is the source of
truth within a session. It does NOT hold a `sessionManager` or
timeline reference at runtime — the timeline is read once at
`session_start`, not at runtime. It does NOT cache derived state
(e.g. the resolved mode, the merged config) — every read re-computes
from the in-memory state + the re-read config. This preserves the
hot-reload contract uniformly.

### A2. The matcher's input is a `DecideContext` (focused struct)

The matcher needs: the active mode (resolved), the global tagger
rules, the tool metadata, the cwd, the mode name (for diagnostics).
It does NOT need: the `Config` as a whole, the `ModeController`,
the `RuntimeGrants`, the `DirectoryPermissionsState`. The matcher's
contract is "given a tool call and the active mode's rules, return
a verdict."

**Decision:** the matcher takes a `DecideContext` struct, not a
`Config` + `modeName`. The `DecideContext` is a minimal readonly
interface. The handler constructs the `DecideContext` from
`RuntimeState` and the merged `Config`; the matcher consumes it.

### A3. The "global stuff" is a separate phase (the `ToolCallMetadata` test boundary)

`decide` has two concerns: the **global** (tool metadata, tagger
rules) and the **per-mode** (the mode's rules). These are different
test boundaries.

**Decision:** extract the global-stuff application as a separate
phase producing a `ToolCallMetadata` object. The `ToolCallMetadata`
includes the static tags, the tagger-augmented tags, the effective
tag set, and the resolved tool metadata. The inner matcher
(renamed `evaluate`) takes `ToolCallMetadata` + the resolved mode
and returns the verdict. The outer `decide` does the
`ToolCallMetadata` construction (and the active-mode resolution)
before calling the inner matcher.

This creates a clean test boundary:

- The outer `decide` test: pass a config + an event + a
  `RuntimeState`, assert on the `PolicyDecision`. Exercises the
  orchestration.
- The inner `evaluate` test: pass a `ToolCallMetadata` + a resolved
  mode, assert on the `PolicyDecision`. Exercises the matcher
  logic only.

### A4. The session grants are timeline-driven; the persisted grants are config-driven

Three levels of grants:

1. **One-off** — allow this exact call, no state stored. The handler
   returns `undefined` from the ask modal.
2. **Session** — remember for this session. Stored in the timeline
   via `pi.appendEntry("pi-tool-policy-runtime", { type: "addSessionAllowedPath", ... })`.
   Replayed at `session_start` to rebuild the in-memory state.
3. **Persisted** — save to the config file. Written via
   `permission-writer`; never appears in the timeline.

**Decision:** the timeline carries session-scoped events only.
Persisted grants are config-only. The `addSessionAllowedPath` event
in the timeline is read once at `session_start`; the
`addPersistedAllowedPath` side effect (writing to the config file)
happens at event-creation time, in the modal handler. The runtime
extension does NOT read the timeline — only the `session_start`
handler does. The `RuntimeState` is rebuilt from the timeline at
`session_start`; after that, the in-memory state is the source of
truth within the session.

The same pattern applies to mode changes and runtime grants: the
timeline carries session-scoped events; the runtime extension
mutates the in-memory state via the `RuntimeState` API (which
appends to the timeline AND updates the in-memory state).

### A5. The `composeConfig` accepts N layers, not just 3

The original `composeConfig` took 3 layers (stock, user, project).
With the session-projection, the handler needs to merge 4 (stock,
user, project, session).

**Decision:** `composeConfig` accepts N layers. The merge priority
is the order of arguments (later wins). The session layer is
appended last; the merge priority is `stock < user < project <
session` (most-recent user intent wins).

## Decomposition lines

The decomposition produces six pure functions (or function
clusters) in `packages/pi-tool-policy/src/lib/`, with co-located
tests. Each unit in the implementation section ships a working
product — the extension runs at the end of each unit, with cleaner
internals.

### 1. `isPathAllowed(path, effectiveTags, allowedPaths)` — the directory check

The directory-permissions guardrail today is a single function
`checkAndPrompt` that does the check + opens a modal. The check
itself is pure; the modal is a side effect. The check is separable
into a pure function the handler can call before the modal step.

**Extract:**

```ts
function isPathAllowed(path: string, effectiveTags: string[], allowedPaths: AllowedPath[]): boolean
```

**Test surface:** with this set of allowed paths, this path is
allowed; with that set, this path is not allowed; with empty
allowed paths, no path is allowed; path containment is lexical
(not realpath); required tags must all be present in the
effective tag set.

**Why this is a small, focused unit:** the function has no
dependencies on the `Config`, the matcher, the timeline, or any
in-memory state. It takes three simple types and returns a
boolean. The test surface is small and focused.

### 2. `resolveMode(modeName, rawConfig)` — the inheritance hub

`loadConfig()` calls `resolveExtends` over the whole `modes` map
once, then drops the `extends` field from every resolved mode.
`resolveMode` is the per-mode version of the same operation. It
is the **inheritance hub**: where the `extends` graph is walked,
where deep-merge semantics live, where cycle detection and
warning emission live.

**Extract:**

```ts
function resolveMode(
  modeName: string,
  rawConfig: Config,
): {
  mode: Mode
  warnings: string[]
}
```

**Test surface:** standalone mode resolves to itself; child
overrides parent for the same key while inheriting the rest; cycle
(A → B → A) degrades gracefully with a warning; unknown `extends`
target emits a warning.

**Why this is the inheritance hub:** the function is the only
place in the codebase that knows how `extends` chains work. Every
consumer that needs a resolved mode calls `resolveMode` — the
caller doesn't reach into `config.modes[modeName]` directly. This
is the public, well-defined interface for "give me the active
mode's resolved rules." The caller of `decide` calls
`resolveMode(modeName, config)` and passes the result to
`decide`; the matcher never sees the unresolved `Config`.

### 3. `composeConfig(...layers)` — the merge function

The merge of stock + user + project (and the session layer,
from `sessionToConfigLayer`) is the composition. The merge
function is one pure thing; the session-projection is a
separate concern (Unit 6 produces it). Together they form
the merge pipeline that produces the merged `Config` for the
matcher.

**Extract:**

```ts
function composeConfig(...layers: Array<Config | Partial<Config>>): { config: Config; warnings: string[] }
```

The merge order is the argument order; later layers win. The
session layer is appended last in the handler:
`composeConfig(STOCK_CONFIG, userConfig, projectConfig, sessionLayer)`.

**Test surface:** stock < user < project priority; N-layer
merge (not just 3); the merged config has the right `modes`,
`toolRules`, `allowedPaths`, `taggingRules`, `modeOrder`.

This is its own unit (Unit 7) — separate from the
`sessionToConfigLayer` extraction (which is Unit 6's REFACTOR
step or lands in Unit 6's GREEN step, depending on the
sequencing). The reason they're separate units:
`sessionToConfigLayer` is for session-storage events (Unit 6's
domain), `composeConfig` is for general config-layer merging
(Unit 7's domain). Combining them forces Unit 6 and Unit 7 to
be reviewed together; separating them keeps each unit focused
on one thing.

### 4. `sessionToConfigLayer(timeline, config, cwd)` — the timeline-to-`Partial<Config>` projection

The session-projection translates the timeline (session
events) into a `Partial<Config>` that the merge pipeline can
compose. This is a small, focused function, used by Unit 7's
`composeConfig` in the handler — but it lands earlier (in
Unit 6) because the session-storage work is the natural home
for it. The function takes the `config` because the initial
mode name comes from `config.modeOrder[0]` when the timeline
is empty (no `setMode` event has fired yet).

### 5. `decide(event, ctx)` + `evaluate(metadata, mode)` + `buildToolCallMetadata(event, config, toolMetadata, cwd)` — the matcher

The matcher today is a 100+ line function in the `tool_call`
handler. It does: load config, apply tagger rules, resolve the
active mode, evaluate the rules, format the verdict. The user's
test surface is "given a tool call, what's the verdict?" The
seam is the verdict; the matcher is the function that produces
it.

**Extract:**

```ts
// The global-stuff application. Pure: takes the event, the
// config, the tool metadata, the cwd; returns the tool call
// metadata (static tags, augmented tags, effective tags, resolved
// tool metadata).
function buildToolCallMetadata(
  event: ToolCallEvent,
  config: Config,
  toolMetadata: Map<string, ResolvedToolMetadata>,
  cwd: string,
): ToolCallMetadata

// The inner matcher. Pure: takes the tool call metadata and the
// resolved mode; returns the verdict. Tests the rule combine
// (tag layer, aspect layer, tool layer, default layer) without
// the global-stuff setup.
function evaluate(metadata: ToolCallMetadata, activeModeName: string, activeMode: Mode, cwd: string): PolicyDecision

// The outer matcher. The minimal readonly interface for
// what `decide` needs.
interface DecideContext {
  readonly currentModeName: string
  readonly activeMode: Mode
  readonly taggingRules: TaggerRule[]
  readonly toolMetadata: Map<string, ResolvedToolMetadata>
  readonly cwd: string
}

// The outer matcher. Pure: takes the event and the context;
// returns the verdict. Orchestrates: builds the tool call
// metadata, resolves the active mode (via the caller; the
// handler passes the resolved mode in the context), calls
// `evaluate`.
function decide(event: ToolCallEvent, ctx: DecideContext): PolicyDecision
```

**The two-layer test boundary:**

- The **outer `decide`** is tested with a real `Config`, a real
  event, a real `toolMetadata`, a real cwd. Asserts on the
  `PolicyDecision`'s action and reason. Exercises the orchestration.
- The **inner `evaluate`** is tested with a `ToolCallMetadata` and
  a resolved `Mode`. No config, no event, no tool metadata. Asserts
  on the `PolicyDecision`'s action. Exercises the matcher logic
  (rule combine) without the orchestration.

The "investigate gate" for the user's odd cases can point at:

- The outer `decide` (if the global-stuff application is wrong —
  e.g. the tagger doesn't fire, the effective tags are wrong).
- The inner `evaluate` (if the matcher logic is wrong — e.g. the
  per-layer combine is wrong, the verdict doesn't match the rule
  trail).
- The mode resolution (if the wrong mode's rules are being
  applied).

**Why this is the most user-facing test surface:** the `decide`
function is the surface that the user observes. The
"rm -rf .eslintcache" and "ls" cases the user reported are
`decide` tests. The verdict is what the user sees; the test
asserts on the verdict.

## Where the new functions and types live

All new code goes in `packages/pi-tool-policy/src/lib/` as
siblings of the existing pure functions:

- `runtime-state.ts` — the `RuntimeState` class + the timeline
  write API.
- `decide-context.ts` — the `DecideContext` interface + the
  `ToolCallMetadata` interface.
- `is-path-allowed.ts` — the directory-permissions pure function.
- `resolve-mode.ts` — the per-mode resolver.
- `compose-config.ts` — the merge function.
- `session-to-config-layer.ts` — the timeline-to-`Partial<Config>`
  projection.
- `decide.ts` — the outer matcher.
- `evaluate.ts` — the inner matcher.

Co-located tests per `pi-package-hard-rules` (next to source,
named `<name>.test.ts`).

`extensions/tool-policy.ts` becomes a thin orchestrator that
calls these and handles only the side-effecting paths (modals,
file writes, status bar refresh, `session_start` replay).

**Not** in `pi-extension-utils`. These are tool-policy-specific;
only truly cross-cutting utilities belong in the shared package.

## Test design principles (from AGENTS.md and the relevant solutions)

Every test in this plan follows three rules derived from
AGENTS.md and the `pi-task-runner-permission-pattern` solution
(a comparable matcher architecture):

1. **Assert behavior, not data shape.** A test that compares a
   result to a literal object is documentation, not verification
   — it would pass with `() => undefined` swapped in. The test
   should fail when the function is wrong, not merely record the
   shape of the result. For the composition test, that means
   asserting on "user's value beats stock's value for the same
   key" (behavior), not "`config.modes.default.defaultDecision
=== 'deny'`" (data). For the matcher test, that means
   asserting on "the call lands in `ask` because the tag rule
   says ask" (behavior), not "the rule trail has these three
   entries in this order" (data).
2. **Loader/merger tests exercise the loader/merger logic, not
   the data shape it returns.** The composition test should
   fail if the merge priority is wrong (e.g. user wins over
   stock, project wins over user), not just record the merged
   object. The matcher test should fail if the rule combine is
   wrong, not just record the rule trail.
3. **Test the real deal, not a mock.** The whole point of
   this decomposition is to avoid mocking pi's `ExtensionAPI`
   for these tests. The extracted functions are pure; the
   tests pass real inputs and assert on real outputs. No mocks
   anywhere in the new tests.
   `loadConfig()` per the existing design (it is policy-level, not
   composition-level).

## Implementation units

Eight units (with the last split into two sub-units), each
RED → GREEN → REFACTOR. **Each unit ships a working product** —
the extension runs at the end of every unit, with cleaner
internals. The intermediate states are real; the user can
throw cases at the extension after each unit.

**Order:** Units 1–2 are small refactors (YOLO, dispatch-key
fix) that can land first. Units 3 and 3b are foundational
extractions (`isPathAllowed`, JIT loader-cleanup). Unit 4 is
`resolveMode` extraction. Unit 5 is the
**session-storage switch** (the `RuntimeState` class
consolidated from the existing closure variables, rebuilt
from the timeline at `session_start`). Unit 6 is the
**merge pipeline** (`composeConfig` with N layers, including
the session layer as one of them). Unit 7 is the **matcher
extraction**, split into 7a (the inner matcher and the
global-stuff application) and 7b (the outer matcher with the
`DecideContext` interface and the user's odd-case tests).

| Unit | Scope                                                                                       | Working product at the end                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | YOLO is a stock mode                                                                        | Extension works with YOLO in `STOCK_CONFIG`; `modeOrder` is a stock-first merge.                                                     |
| 2    | Dispatch-key gotcha fix                                                                     | Extension's matcher dispatches on `decl.mode` for tools with custom aspect names.                                                    |
| 3    | `isPathAllowed` extraction                                                                  | Extension's directory check is a pure function; the modal is the only side effect.                                                   |
| 3b   | JIT loader cleanup                                                                          | `loadConfig` returns the merged config with `extends` intact; an `inventoryWarnings` pure walker covers cycle / unknown-extends.     |
| 4    | `resolveMode` extraction                                                                    | Extension's per-mode resolve is a pure function; cycle detection and warning emission co-located.                                    |
| 5    | `RuntimeState` + `sessionToConfigLayer` + `session_start` wiring + delete closure variables | Extension's in-memory state is a single class rebuilt from the timeline at `session_start`; the existing closure variables are gone. |
| 6    | `composeConfig` (N layers)                                                                  | The merge pipeline produces the merged `Config` (with the session layer as one of N layers).                                         |
| 7a   | `evaluate` (inner matcher) + `buildToolCallMetadata` + `ToolCallMetadata`                   | The matcher's rule combine is testable; the global-stuff application is testable.                                                    |
| 7b   | `decide` (outer matcher) + `DecideContext` + headline tests + investigate-then-confirm      | The handler's `tool_call` is a thin orchestrator; the user's odd cases are covered.                                                  |

**Why Unit 6 (session storage) comes before Unit 7 (merge
pipeline):** the user's framing — "the timeline is the
source of truth; the in-memory state is rebuilt from the
timeline at `session_start`" — means the timeline is the
first-class thing. The merge pipeline (Unit 7) is
mechanical once the timeline is in place; it composes layers
into a `Config`. Doing Unit 6 first means Unit 7's
`composeConfig` accepts N layers (including the session
layer) from the start, with no "we'll do it later" for the
session layer.

**Why Unit 7 is split into 7a and 7b:** the matcher
extraction bundles a lot of new surface (the outer
`decide`, the inner `evaluate`, the `DecideContext` and
`ToolCallMetadata` interfaces, the `buildToolCallMetadata`
helper, the headline tests, the investigate-then-confirm
flow). Splitting it lets each sub-unit ship a smaller
working product: 7a delivers the test boundary for the
matcher's rule combine, 7b delivers the test boundary for
the orchestration and the user's odd cases.

**`decide` extraction serves two purposes** (per the user):
the extraction is the deliverable (it makes the verdict
pipeline a stable contract for future handler changes), and
the test surface is the verification (it pins down what
`decide` is supposed to do). The extraction matters more
than the test alone, because the test alone would be brittle
(it would test whatever the in-handler code happens to do
today, including the in-handler wiring, and could diverge
from production if the handler changes). The extraction
gives the test a stable surface. Unit 7b's RED step is
"specify the contract"; GREEN is "extract to that
contract."

## Cross-unit dependencies

This section enumerates the dependencies between units so the
implementation order is unambiguous and so contributors
reviewing one unit can see what's expected to land before
or after.

### Production-code dependencies (what each unit consumes)

| Unit                                     | Consumes                                                                                                          | Source     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------- |
| 1 (YOLO)                                 | —                                                                                                                 | —          |
| 2 (dispatch-key)                         | —                                                                                                                 | —          |
| 3 (`isPathAllowed`)                      | —                                                                                                                 | —          |
| 3b (JIT loader cleanup)                  | —                                                                                                                 | —          |
| 4 (`resolveMode`)                        | —                                                                                                                 | —          |
| 5 (`RuntimeState`)                       | pi's `CustomEntry` API (`sessionManager.getEntries()`, `appendCustomEntry(...)`)                                  | pi-runtime |
| 6 (`composeConfig`)                      | Unit 6's `sessionToConfigLayer`                                                                                   | Unit 6     |
| 7a (`evaluate`, `buildToolCallMetadata`) | Unit 4's `resolveMode` (via the handler), Unit 6's `composeConfig` (via the handler's merged-config construction) | Units 4, 6 |

The dependencies are at the **handler-call level**, not at the
function level. `evaluate` doesn't import `composeConfig`; the
**handler** orchestrates: it calls `composeConfig`, gets the
merged `Config`, passes that to `buildToolCallMetadata`, gets
the metadata, passes that to `evaluate`. The functions are
composable; the handler is the glue.

### API-freezing contract

Each unit's GREEN step produces a public API that downstream
units must use as-is. Subsequent units do NOT redesign the
API; they consume it. If a contributor finds the API needs
to change, that's a new unit (or an amendment to the current
unit before it lands).

- **Unit 4's `resolveMode(modeName, config)` signature** is
  the contract for Unit 7a's handler.
- **Unit 5's `RuntimeState.fromTimeline(timeline, config, cwd)`**
  signature is the contract for Unit 6's handler and
  Unit 7b's handler. The `config` parameter is required
  (the initial mode name comes from `config.modeOrder[0]`
  when the timeline is empty).
- **Unit 5's `sessionToConfigLayer(timeline, config, cwd)`**
  signature is the contract for Unit 6.
- **Unit 6's `composeConfig(...layers)` signature** is the
  contract for Units 7a and 7b's handlers.
- **Unit 7a's `evaluate(metadata, modeName, mode, cwd)` and
  `buildToolCallMetadata(event, config, toolMeta, cwd)`
  signatures** are the contract for Unit 7b's `decide`.
- **Unit 7a's `ToolCallMetadata` interface** is the contract
  for Unit 7b's matcher.

### Green-after-Green ordering check

The plan is correct only if each unit's GREEN step preserves
the previous units' GREEN steps. The implication:

- Unit 6's GREEN rewrites the handler to use
  `runtimeState.currentModeName()` etc. **This must happen in
  Unit 5's GREEN**, not later. Without it, Unit 7a's
  extraction would have to translate the closure-variable
  reads into `RuntimeState` reads inline, which
  defeats the "working product each phase" imperative.
- Unit 7's GREEN wires the handler at `tool_call` to use
  the merged `Config` from `composeConfig`. **This rewrites
  the closure-variable reads into `composeConfig(..., sessionLayer)`
  calls.** Again, must happen in Unit 6, not later.
- Unit 7a's GREEN extracts `evaluate` and `buildToolCallMetadata`
  from a handler that has ALREADY been rewritten by Units 5
  and 6. The handler is RuntimeState-based and
  composeConfig-based by the time Unit 7a lands; Unit 7a's
  extraction is mechanical.
- Unit 7b's GREEN rewrites the handler at `tool_call` to
  construct a `DecideContext` and call `decide`. The
  `DecideContext` is built from `RuntimeState` (current mode
  name) + the merged `Config` (tagger rules) + the tool
  metadata + the cwd. All of these are already wired by
  Units 5 and 6.

### Test infrastructure dependencies

Each unit's tests are independent — they don't share fixtures.
The integration test in `tool-policy.test.ts` exercises the
handler end-to-end. As long as each unit's GREEN preserves
the integration test passing, the cross-unit test surface
is satisfied. The integration test is the regression gate.

### Documentation cross-references

After each unit lands, update the relevant solution
documents if they describe the old shape:

- `docs/solutions/architecture/pi-tool-policy-mode-controller.md` —
  describes the matcher's per-mode combine. Unit 7a's
  `evaluate` is the same logic under a new name and split
  into its own file; the description is mostly correct
  but the type references (e.g. "called from
  `evaluate()` in `policy.ts`") become stale.
- `docs/solutions/architecture/working-with-pi-tool-policy.md` —
  describes the package's lifecycle. Units 5–7 change the
  in-memory state model; the "session lifecycle" section
  needs updates about the `RuntimeState` class.

These updates are editorial, not code; they're in scope for
the unit that introduces the change.

### Unit 1: YOLO is a stock mode

The smallest unit. YOLO is a synthetic post-composition
injection today: `loadConfig()` adds
`merged.modes["__yolo__"] = {...}` and appends `YOLO_MODE` to
`modeOrder` after the merge. Both injections exist to keep YOLO
present and last in the cycle — guarantees that should live in
the data, not in code.

**Refactor:** move both YOLO pieces from `loadConfig()` to
`STOCK_CONFIG`. YOLO becomes a normal stock mode, in the same
position in the cycle as `readonly` / `default` / `edit` /
`plan` — just the last entry in the stock arrays.

**Two changes in `STOCK_CONFIG`:**

1. Add the YOLO mode block to `STOCK_CONFIG.modes` (the same
   block that lives in `loadConfig()` today: empty rules,
   `defaultDecision: "allow"`, the "EMERGENCY OFF" description).
2. Add `YOLO_MODE` as the last entry of `STOCK_CONFIG.modeOrder`.

**Two changes in `loadConfig()`:**

1. Delete the post-composition
   `merged.modes[YOLO_MODE] = {...}` block.
2. Delete the post-composition
   `if (!merged.modeOrder.includes(YOLO_MODE)) { ... }` append.

**One change in `loadConfig()`'s `modeOrder` resolution:** today
it is `project.modeOrder ?? user.modeOrder ?? STOCK_CONFIG.modeOrder`
— **replace, not merge**. A user's custom `modeOrder` completely
replaces the stock array. This is the reason the synthetic YOLO
append was needed: without it, a user setting a custom `modeOrder`
loses YOLO from the cycle. With YOLO moved to stock, the synthetic
append can go — but only if the replace is changed to a
**stock-first merge**:

```ts
const stockOrder = STOCK_CONFIG.modeOrder
const userProject = [...(user.modeOrder ?? []), ...(project.modeOrder ?? [])]
const additions = userProject.filter((name, i, arr) => !stockOrder.includes(name) && arr.indexOf(name) === i)
modeOrder: [...stockOrder, ...additions]
```

Semantic: stock provides the canonical order; user/project entries
not already in stock are appended in the order the user listed
them (user before project, with dedup). A user can add new modes
to the cycle; they cannot remove stock modes (including YOLO).
This matches the existing `modes` merge semantic.

**What stays the same:** the early-return in the `tool_call`
handler (the actual gate; the matcher-bypass is the load-bearing
safety property, not the config placement). The status bar
special text. The modal warning icon. The `YOLO_MODE` constant
in `types.ts` (still used by the handler, status text, and modal).
The JSON Schema is unaffected (YOLO was never in the schema).

**What gets reworded in `permission-config.test.ts`:**

- "injects the YOLO (emergency-off) mode on every load, even
  with stock defaults" → "YOLO is in the stock config." The
  assertion changes from `expect(config.modes).toHaveProperty(YOLO_MODE)`
  (still true) to asserting on the stock membership being visible
  in the merged config.
- "orders stock modes as default, readonly, edit, plan in
  modeOrder" — unchanged in shape, but the trailing
  `expect(config.modeOrder[config.modeOrder.length - 1]).toBe(YOLO_MODE)`
  still holds (YOLO is now in stock at the end).
- "does not duplicate the YOLO mode in modeOrder if it was
  already added by the user" — reworded. The dedup is now in
  the `modeOrder` merge, not a special case in `loadConfig()`. The
  test asserts the new merge behavior: user entries already in
  stock are skipped.
- "re-reads after an external write (hot reload)" — the
  expected value changes from `["only-mode", "__yolo__"]` to
  `[...STOCK_CONFIG.modeOrder, "only-mode"]` (stock-first
  append). The "hot reload" assertion
  (`expect(after.config.modeOrder).not.toEqual(before.config.modeOrder)`)
  still holds.
- "treats malformed JSON in the config file as if the file were
  missing" — the expected value changes from
  `[...STOCK_CONFIG.modeOrder, "__yolo__"]` to `STOCK_CONFIG.modeOrder`
  (YOLO is now in stock, no synthetic append).

**Field overrides on YOLO are silently ignored at runtime.**
With YOLO in stock, a user can override its `defaultDecision` or
`tagRules` in their config. The merge applies the override. The
handler's early-return means the matcher never reads the
overridden fields. The user sees their override in the config but
it has no effect. This is the right trade-off — the handler's
bypass is the safety net; the config fields are documentation.
Unit 7b (`decide`) adds a test for "YOLO mode short-circuits the
matcher regardless of the mode's `defaultDecision`."

**Why this is Unit 1 (lands first):** it's a small change (3
lines added to `STOCK_CONFIG`, ~10 lines deleted in
`loadConfig()`, the `modeOrder` resolution line changes from a
`??` chain to a small filter) plus test rewordings. It is
self-contained: no new function is extracted, no existing
function is replaced, the load-time `Config` shape is the only
thing that changes. Doing it first means Unit 2 (`composeConfig`)
starts from a codebase where YOLO is already a stock mode — no
YOLO special-cases to thread through the extraction.

- **RED.** Reword the four tests in `permission-config.test.ts`
  that assert on the old YOLO-injection / synthetic-append
  shape. Confirm they fail (the synthetic injection is still
  in `loadConfig`; the rewrites expect the new shape).
- **GREEN.** Apply the changes listed above: add YOLO to
  `STOCK_CONFIG.modes` and `STOCK_CONFIG.modeOrder`; delete the
  synthetic injection in `loadConfig`; change the `modeOrder`
  resolution to stock-first merge. Confirm the reworded tests
  pass and the rest of `permission-config.test.ts` still passes.
- **REFACTOR.** Verify the integration test in
  `permission-config.test.ts` still passes; run the full
  `pnpm --filter @piotrb/pi-tool-policy run test` to catch any
  ripple. No new files in this unit; the changes are in
  `permission-config.ts` and `permission-config.test.ts`.

### Unit 2: Dispatch-key gotcha fix

The matcher in `policy.ts:184` and `policy.ts:192` passes
`aspectName` (the user-defined name from `Object.entries(meta.fields)`)
to `matchAspect` / `matchAspectEach` instead of `decl.mode` (one
of the 5 base modes: `path`, `url`, `bash`, `glob`, `regex`).
`matchAspect` dispatches on its first argument — if it isn't
`"path"` / `"url"` / `"bash"` / `"glob"` / `"regex"`, the matcher
falls through to the generic-regex fallback. For built-in tools
the names happen to align, so the bug stays hidden. For tools
with custom aspect names (e.g. `git_mv`'s `source` / `destination`
aspects bound to `mode: "path"`), the matcher falls through to the
wrong branch, and path-glob patterns like `**/node_modules/**`
fail to match.

The bug is documented in
`pi-tool-policy-per-field-aspect-cardinality`'s "Known issues"
section, including the exact two lines to change and the
regression test pattern that catches it.

**The fix:** in `policy.ts:184` and `policy.ts:192`, replace
`aspectName` with `decl.mode` in the `matchAspect` /
`matchAspectEach` calls. Same change in `coverage.ts:64` (the
coverage report builder has the same bug — it iterates the same
`meta.fields` and dispatches the same way).

**The regression test — a pattern that distinguishes the two
branches:** The challenge is to find a pattern that matches in
the picomatch branch (with `decl.mode === "path"`) but does NOT
match in the generic-regex fallback (with the bug dispatching
on `aspectName`). Most simple patterns match in both branches
because the fallback's `*` is `[\s\S]*`, which is greedy and
matches anything. The distinguishing feature is **brace
expansion**: picomatch supports `{a,b}` for alternation; the
fallback does not (it escapes braces as literal characters in
the regex).

**Concrete test pattern: `**/{node_modules,.git}/**`.** Picomatch
expands the braces and matches paths like
`/repo/node_modules/foo` or `/repo/.git/objects/abc`. The
fallback compiles the literal string to a regex that doesn't
match real paths (the value contains `node_modules` or `.git`,
not the literal text `**/{node_modules,.git}/**`).

```ts
it("dispatches aspect rules to picomatch when aspectName !== 'path' (regression)", () => {
  // git_mv-shaped tool: custom aspect name "source" bound to
  // mode: "path". The bug would dispatch on "source", not
  // "path", so the generic-regex fallback would fire. The
  // brace-expansion pattern exposes the bug — the fallback
  // doesn't expand braces, picomatch does.
  const meta: ResolvedToolMetadata = {
    tags: ["mutating"],
    fields: {
      source: { mode: "path", fields: ["source"] },
    },
  }
  const mode: Mode = {
    description: "test",
    defaultDecision: "allow",
    tagRules: {},
    toolRules: {},
    aspectRules: {
      source: {
        patterns: {
          "**/{node_modules,.git}/**": "deny",
        },
      },
    },
  }
  const decision = evaluate(
    makeEvent("git_mv", { source: "/repo/node_modules/foo" }),
    { modeOrder: ["default"], modes: { default: mode }, allowedPaths: [], taggingRules: [], toolMetadata: {} },
    "default",
    [],
    new Map([["git_mv", meta]]),
    ctx,
  )
  // With the fix: the brace-expansion pattern matches
  // /repo/node_modules/foo via picomatch; the rule fires;
  // the verdict is "deny".
  expect(decision.action).toBe("deny")
  // Without the fix: the fallback can't expand braces, the
  // rule doesn't fire, the defaultDecision ("allow") wins.
  // The test would fail on action === "deny" because
  // decision.action would be "allow".
})
```

The test fails on the bug (returns `allow`) and passes on the
fix (returns `deny`).

- **RED.** Add the regression test. Confirm it fails (the
  dispatch key is `aspectName`, not `decl.mode`, so the
  fallback branch fires and the brace pattern doesn't match).
- **GREEN.** Apply the two changes in `policy.ts` (lines 184, 192) and the parallel change in `coverage.ts:64`. Confirm
  the regression test passes and the rest of `policy.test.ts`
  and `coverage.test.ts` (if it exists) still pass.
- **REFACTOR.** Verify the full `pnpm --filter @piotrb/pi-tool-policy run test`
  passes. The unit touches two source files (`policy.ts`,
  `coverage.ts`) and one test file (`policy.test.ts`); no
  new files. The unit is small enough to review in a single
  pass.

**Why this is Unit 2 (lands after YOLO):** it's the smallest
unit (2-line code change + 1 regression test), has no
dependencies, and unblocks the decomposition units that
follow. Units 3–5 (incl. 3b) can now use path-glob-only patterns in
their aspect-rule test scenarios and exercise the actual
dispatch path. The 600+ existing tests stay green throughout
(the fix only changes behavior for tools with custom aspect
names, which no current test or shipping user config
exercises).

### Unit 3: `isPathAllowed` extraction

The directory-permissions guardrail today is a single function
`checkAndPrompt` that does the check + opens a modal. The check
itself is pure; the modal is a side effect. The check is separable
into a pure function the handler can call before the modal step.

**Extract** `isPathAllowed(path, effectiveTags, allowedPaths): boolean`
into `packages/pi-tool-policy/src/lib/is-path-allowed.ts`. The
handler keeps the modal (the side effect); the check is testable.

- **RED.** Write `is-path-allowed.test.ts` with the scenarios
  below, asserting on the **directory-permissions check
  behavior**. Confirm the tests fail (no `isPathAllowed` exported
  yet).
- **GREEN.** Extract `isPathAllowed` from `checkAndPrompt`.
  Re-export from `directory-permissions.ts` (or move to
  `is-path-allowed.ts`). Make `checkAndPrompt` call it. Confirm
  tests pass; existing `directory-permissions.test.ts` still
  passes.
- **REFACTOR.** Co-locate the path-containment check. Run
  `pnpm run check`.

**Test scenarios (assert check behavior):**

1. **Path inside an allowed directory is allowed.** With
   `allowedPaths: [{ tags: [], path: "/repo" }]` and
   `effectiveTags: ["readonly"]`, the path `/repo/foo.ts` is
   allowed. The test fails if the containment check is wrong.
2. **Path outside the allowed directory is denied.** With the
   same `allowedPaths`, the path `/etc/passwd` is denied.
3. **Required tags must all be present.** With
   `allowedPaths: [{ tags: ["readonly", "metadata"], path: "/repo" }]`,
   the path `/repo/foo` is denied if the effective tag set is
   `["readonly"]` (missing `metadata`) and allowed if the
   effective tag set is `["readonly", "metadata"]`.
4. **Empty `allowedPaths` denies everything.** The test fails
   if any path is allowed when the list is empty.

**Working product at the end:** the extension's directory check
is a pure function; the modal is the only side effect. The
test surface is small and focused.

### Unit 3b: JIT loader cleanup (loader stops pre-resolving)

**Principle:** `composeConfig` and `mergeModes` are structurally
pure: they merge fields, they do NOT call `resolveMode` or strip
the `extends` field. Resolution is a consumer-side projection: a
caller that needs a resolved mode calls `resolveMode(name, config)`
themselves. The `extends` field is **information** carried by the
merged config; it survives until a consumer chooses to apply it.

This mini-unit lands the JIT-shape by changing `loadConfig`'s
loader to keep the merged `Config`'s `extends` field intact on
every mode. The per-mode `resolveMode` loop at the end of
`loadConfig` is removed; a separate `inventoryWarnings(config)`
pure walker collects cycle / unknown-extends warnings across
**all** modes (not just the active one) and the loader pushes
those into its returned `warnings` array.

**Why this is its own unit (lands between Unit 3 and Unit 4):**
the loop that pre-resolves in `loadConfig` is the **default
shape** that any "extract `resolveMode`" unit would add: an
extracted resolver is the first place a loader will reach
when it needs mode semantics. Splitting the unit creates
two independently-reviewable commits / test surfaces:

- **Unit 4 lands the function and the per-mode `resolveMode`
  loop in `loadConfig`.** RED writes the skeleton; GREEN
  replaces the body with the real resolver; tests assert
  cycle / unknown-extends / standalone behavior. `loadConfig`
  is updated to call `resolveMode(name, merged)` for every
  mode, replacing the old `resolveExtends` batch walker;
  the resolved modes are stored back into `merged.modes`.
  This is the natural shape: the loader uses the extracted
  function.

- **Unit 3b lands the loader cleanup.** Tests in
  `permission-config.test.ts` are reworded: assertions
  that expected `extends` to be stripped are flipped to
  assert `extends` is preserved, and new tests cover the
  inventory walker. GREEN removes the per-mode
  `resolveMode` loop from `loadConfig`, adds
  `inventoryWarnings`, and pushes its return value into
  `loadConfig`'s `warnings` array.

**Commit order is dependency-respecting**: Unit 4's commit
must include the loader's call to `resolveMode` (because
the loop uses the function that was just extracted); Unit
3b's commit immediately follows to remove that call and
introduce the inventory walker. The two commits are
independently reviewable; each does one thing. The plan
places Unit 3b **before** Unit 4 in numeric order to make
clear that the JIT-cleanup is the intended end state, not
a follow-up that might be forgotten.

**Why this matters beyond the perf argument:**

1. **Save-rule modal picker.** `computeExtendsChain` (in
   `mode-controller.ts`, called from the handler at
   `extensions/tool-policy.ts:254`) reads
   `rawConfig.modes[current]?.extends`. After the loader's
   pre-resolve step, `extends` is stripped — the picker
   always shows a single-entry chain (`[currentMode]`) and
   the user never gets the "save rule to parent mode"
   choice. JIT-cleanup fixes this for free.
2. **Inventory vs. active-mode warnings.** Today, every
   cycle is reported on every `loadConfig` regardless of
   the active mode. The JIT split lets us keep the
   inventory-style warning (every cycle is visible to
   `/tool_policy`) while letting the matcher's per-call
   resolve path see a stripped, ready-to-consume `Mode`.
3. **Hot-reload principle.** The `no-cache-for-user-mutable-data`
   principle says the merged config is the
   user-mutable artifact; resolve is a derived view. The
   loader producing the mutable artifact unchanged (with
   `extends` intact) and the matcher deriving the view at
   consumption time is the load-bearing shape.

**Changes:**

- **RED (`permission-config.test.ts`).** Reword the
  existing tests that assert the loader strips `extends`:
  - "resolves the stock inheritance chain" (line 67) —
    rewrite to assert `extends` is preserved on every mode.
  - "extends deep-merge / No extends is left on the
    resolved mode" (line 206) — rewrite to assert
    `extends` survives the merge.
  - Add: "loadConfig preserves a user override that sets
    `extends: []`" (new test).
  - Add: "inventoryWarnings reports a cycle in a
    non-active mode" (new test, calls `inventoryWarnings`
    directly).
  - Add: "inventoryWarnings does NOT mutate the input
    config" (new test).
- **GREEN.** Delete the per-mode `resolveMode` loop at
  the end of `loadConfig`. Add `inventoryWarnings(config): string[]`
  to `resolve-mode.ts` (pure walker using the same cycle
  detection logic, but per-mode rather than per-resolve).
  Call `inventoryWarnings` from `loadConfig` and push to
  the returned `warnings` array. Confirm cycle / unknown-extends
  tests still pass (warning text comes from the
  inventory pass now; behavior preserved).
- **REFACTOR.** Drop the now-unused `Mode` import from
  `permission-config.ts` if applicable. Run `pnpm run check`.

**Out of scope (deferred):**

- `cross-call cache` of `resolveMode` results. Today the
  same mode is never resolved twice in one call.
- `resolveMode` skip-when-no-extends (a 3-line optimization).
- `extract` mode-as-data investigation prompted by the
  handler's `currentMode = config.modes[currentMode]!`
  null-assertion pattern. Separate plan.

**Working product at the end:** the loader produces a
merged `Config` with `extends` intact. The matcher
consumer (Unit 4's `resolveMode`, plus `computeExtendsChain`)
sees the inheritance graph as-authored. The latent
`computeExtendsChain` bug at the save-rule modal is fixed
indirectly (the picker now shows the full chain). The unit
ships independently — landing it before Unit 4 does not
break anything.

### Unit 4: `resolveMode` extraction

The `extends` graph processing is the inheritance hub. It's
where deep-merge semantics live, where cycle detection lives,
where warning emission lives. `loadConfig()` calls
`resolveExtends` over the whole `modes` map once, then drops
the `extends` field. The per-mode version is what consumers
need.

**Extract** `resolveMode(modeName, rawConfig): { mode, warnings }`
into `packages/pi-tool-policy/src/lib/resolve-mode.ts`. The
caller of `decide` calls `resolveMode(modeName, config)` and
passes the result; the matcher never sees the unresolved
`Config`.

**Unit 4's scope includes the loader's call to the new
function.** `loadConfig` is updated in this unit to call
`resolveMode(name, merged)` for every mode (replacing the
deleted batch walker). The per-mode loop is **intentionally
left in** at the end of Unit 4 so the loader has somewhere
to use the extracted function. **Unit 3b** then removes
that loop and introduces the inventory walker that
preserves the cycle / unknown-extends warnings without
relying on `resolveMode` to mutate the modes.

- **RED.** Write `resolve-mode.test.ts` with the scenarios
  below, asserting on the **inheritance behavior**. Confirm the
  tests fail (no `resolveMode` exported yet). Per the global
  solution on RED-test discipline, write the production file
  as a skeleton first (right export signature, wrong-stub
  return value) — assertions exercise real behavior, not
  import errors.
- **GREEN.** Extract `resolveMode` from `resolveExtends`.
  Update `loadConfig` to use it (a per-mode loop replacing
  the deleted batch walker). Confirm tests pass; existing
  `extends` tests in `permission-config.test.ts` still pass.
- **REFACTOR.** Co-locate cycle detection and warning emission.
  Run `pnpm run check`.

**Test scenarios (assert inheritance behavior):**

1. **Standalone mode resolves to itself.** A mode with no
   `extends` and no parent in the config returns its own
   (sans `extends`) fields.
2. **Child overrides parent for the same key; parent's other
   rules survive.** A child that sets `defaultDecision: "deny"`
   while inheriting from a parent with `tagRules: { x:
"allow" }` produces a mode with `defaultDecision: "deny"`
   AND `tagRules: { x: "allow" }`.
3. **Cycle degrades gracefully with a warning.** A → B → A
   produces a partially-resolved mode and a warning that
   mentions the cycle.
4. **Unknown `extends` target emits a warning.** A child
   that extends `"ghost"` (not in the config) emits a warning
   and the child falls back to being a base mode.

**Working product at the end:** the extension's per-mode resolve
is a pure function; the inheritance semantics are isolated and
testable. The function is the only place that knows how
`extends` chains work.

### Unit 5: `RuntimeState` + `sessionToConfigLayer` + `session_start` wiring + delete closure variables

This is the **session-storage switch**. The extension's
in-memory state is currently spread across several
classes (`ModeController`, `RuntimeGrants`,
`DirectoryPermissionsState`). This unit consolidates them
into a single `RuntimeState` class, rebuilt from the
timeline at `session_start`. The existing closure variables
are deleted; the timeline is the source of truth within a
session.

The merge pipeline (`composeConfig`) is its own unit (Unit
6); this unit focuses on the session-storage switch only.

**Extract** two things:

```ts
// The in-memory state class. Rebuilt from the timeline at
// `session_start`; the source of truth within a session.
// Read methods return the current state; write methods append
// to the timeline AND update the in-memory state.
//
// The factory takes the on-disk `Config` because the initial
// mode name comes from `config.modeOrder[0]` when the
// timeline is empty (no `setMode` event has fired yet). The
// timeline does not carry the initial mode; it only carries
// session deltas. This keeps the timeline clean (only
// session-level events, not the initial state) and is Unit 6's
// contract: `RuntimeState.fromTimeline(timeline, config, cwd)`
// where `config` provides the default for the initial mode.
class RuntimeState {
  static fromTimeline(timeline: SessionEvent[], config: Config, cwd: string): RuntimeState
  // Read methods
  currentModeName(): string
  effectiveTags(): string[]
  // Write methods (append to timeline + update in-memory)
  setMode(modeName: string): void
  addRuntimeGrant(grant: RuntimeGrant): void
  addSessionAllowedPath(grant: AllowedPath): void
}

// The timeline-to-`Partial<Config>` projection. Extracted in
// GREEN (not REFACTOR) so Unit 6 has a stable API from day
// one. Reads session events; produces a `Partial<Config>`
// with the session grants, the session mode, etc.
function sessionToConfigLayer(timeline: SessionEvent[], config: Config, cwd: string): Partial<Config>
```

The handler at `session_start`:

```ts
pi.on("session_start", async (_event, ctx) => {
  const { config } = await loadConfig(ctx.cwd)
  const entries = ctx.sessionManager.getEntries()
  const customEntries = entries.filter((e) => e.type === "custom" && e.customType === "pi-tool-policy-runtime")
  const events = customEntries.map(parseRuntimeEvent)
  runtimeState = RuntimeState.fromTimeline(events, config, ctx.cwd)
})
```

The handler at `tool_call` uses `runtimeState` for in-memory
state and re-reads the on-disk config per the hot-reload
contract. The existing closure variables
(`ModeController`, `RuntimeGrants`, `DirectoryPermissionsState`)
are deleted; `runtimeState` is the only in-memory state. The
in-handler reads (e.g. `modeController.getMode()`,
`runtimeGrants.applyFor(...)`) are rewritten to use the
`RuntimeState` API (`runtimeState.currentModeName()`,
`runtimeState.effectiveTags()`, etc.). This rewrite is part
of Unit 5's GREEN step — without it, Unit 7a's extraction
of `evaluate` / `buildToolCallMetadata` would have to
translate the old closure-variable reads into the new
`RuntimeState` reads inline, defeating the "working product
each phase" imperative.

The modal handlers (ask modal, directory modal) call
`runtimeState.addRuntimeGrant(...)` and
`runtimeState.addSessionAllowedPath(...)` instead of
mutating the old closure variables. The `addX` methods
append to the timeline AND update the in-memory state.

The runtime **does NOT** read the timeline at runtime. The
timeline is read once at `session_start`; the in-memory
state is the source of truth within a session.

- **RED.** Write `runtime-state.test.ts` with the scenarios
  below, asserting on the **state-rebuild and write
  behavior**. Confirm the tests fail (no `RuntimeState` yet).
- **GREEN.** Define the `SessionEvent` types (the timeline
  entry shapes). Implement the `RuntimeState` class with
  `fromTimeline` factory, the read methods, and the write
  methods (each write method appends to the timeline and
  updates the in-memory state). Wire the handler at
  `session_start` to read the timeline and construct the
  `RuntimeState`. Wire the handler at `tool_call` to use
  `runtimeState` for the in-memory state. Wire the modal
  handlers to call `runtimeState.addX(...)`. Delete the
  existing closure variables. Confirm tests pass; the
  existing integration test in `tool-policy.test.ts` still
  passes.
- **REFACTOR.** Co-locate the timeline write API. The
  `RuntimeState` write methods (`setMode`, `addRuntimeGrant`,
  `addSessionAllowedPath`) each append to the timeline AND
  update the in-memory state; the timeline write API is the
  shared concern. Run `pnpm run check`.

**Test scenarios (assert state-rebuild + write behavior):**

1. **`RuntimeState.fromTimeline` rebuilds the in-memory
   state from a `setMode` event.** A timeline with one
   `setMode` event produces a `RuntimeState` whose
   `currentModeName()` returns the mode.
2. **`RuntimeState.fromTimeline` rebuilds the in-memory
   state from an `addSessionAllowedPath` event.** The
   `effectiveTags()` reflects the augmented tags.
3. **`RuntimeState.fromTimeline` rebuilds the in-memory
   state from an `addRuntimeGrant` event.** The grant is
   recorded.
4. **`setMode` appends to the timeline AND updates the
   in-memory state.** A new `setMode` event appears in
   the timeline; `currentModeName()` reflects the new
   mode.
5. **`addSessionAllowedPath` appends to the timeline AND
   updates the in-memory state.** A new event appears;
   `effectiveTags()` reflects the new tag.
6. **The runtime does NOT read the timeline at runtime.**
   The `RuntimeState` is the source of truth within a
   session; the timeline is read once at `session_start`.
7. **`sessionToConfigLayer` translates each event type**
   (`setMode` → mode-order adjustment;
   `addSessionAllowedPath` → `allowedPaths` entry;
   `addRuntimeGrant` → `toolRules` entry).

**Working product at the end:** the extension's in-memory
state is a single `RuntimeState` class, rebuilt from the
timeline at `session_start`. The existing closure variables
are gone. The extension works the same; the in-memory state
is now consolidated.

### Unit 6: `composeConfig` (N layers)

The merge pipeline takes N layers and produces a single
`Config`. With the session layer as one of the layers, the
merged `Config` reflects stock + user + project + the
in-memory state (via `sessionToConfigLayer`).

**Extract** one thing:

```ts
function composeConfig(...layers: Array<Config | Partial<Config>>): { config: Config; warnings: string[] }
```

The merge order is the argument order; later layers win.
The handler at `tool_call`:

```ts
const sessionLayer = sessionToConfigLayer(runtimeState.timeline(), ctx.cwd)
const merged = composeConfig(STOCK_CONFIG, userConfig, projectConfig, sessionLayer)
```

- **RED.** Write `compose-config.test.ts` with the scenarios
  below, asserting on the **merge behavior**. Confirm the
  tests fail (no `composeConfig` yet).
- **GREEN.** Extract `composeConfig` from `loadConfig`
  (where the existing inline merge lives). Update
  `loadConfig` to call it. Wire the handler at `tool_call`
  to use the new pipeline: read the merged `Config` (with
  the session layer as one of N layers). Confirm tests
  pass; the existing integration test still passes.
- **REFACTOR.** Co-locate the warning-emission logic. Run
  `pnpm run check`.

**Test scenarios (assert merge behavior):**

1. **N-layer merge, stock < user < project.** A `tagRules`
   key set in all three layers (stock `allow`, user `ask`,
   project `deny`) produces `deny` in the merged config.
2. **Session layer wins over project.** With project
   `deny` and a session `allow` (via a runtime grant that
   translates to a `toolRules: allow` entry), the merged
   config has the `allow` tool rule.
3. **Empty layers list is an error.** A 0-argument call
   returns an error (or throws); the function requires at
   least one layer.

**Working product at the end:** the merge pipeline produces
the merged `Config` (with the session layer as one of N
layers). The handler at `tool_call` uses the merged
config.

### Unit 7a: `evaluate` (inner matcher) + `buildToolCallMetadata` + `ToolCallMetadata`

The matcher's logic (the rule combine: tag layer, aspect
layer, tool layer, default layer) is the inner matcher.
Today it lives inside the in-handler `evaluate()` function.
The global-stuff application (tagger rules → effective tags)
is also inline. Both are pure functions; both deserve their
own test surface.

**Extract** two things:

```ts
// The tool call metadata: static tags + tagger-augmented +
// effective (deduped) + resolved tool metadata. Produced by
// `buildToolCallMetadata`; consumed by `evaluate`.
interface ToolCallMetadata {
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly staticTags: string[]
  readonly augmentedTags: string[]
  readonly effectiveTags: string[]
  readonly resolvedMetadata: ResolvedToolMetadata
  readonly cwd: string
}

// The global-stuff application. Pure: takes the event, the
// config, the tool metadata, the cwd; returns the tool call
// metadata.
function buildToolCallMetadata(
  event: ToolCallEvent,
  config: Config,
  toolMetadata: Map<string, ResolvedToolMetadata>,
  cwd: string,
): ToolCallMetadata

// The inner matcher. Pure: takes the tool call metadata and
// the resolved mode; returns the verdict. (Note: the
// existing function is named `evaluate`; this unit renames
// it from `evaluate` to `evaluate` and splits it from the
// outer `decide`.)
function evaluate(metadata: ToolCallMetadata, activeModeName: string, activeMode: Mode, cwd: string): PolicyDecision
```

The handler at `tool_call`:

```ts
const mergedConfig = composeConfig(...)
const activeMode = resolveMode(currentModeName, mergedConfig)
const metadata = buildToolCallMetadata(event, mergedConfig, toolMetadata, ctx.cwd)
const decision = evaluate(metadata, currentModeName, activeMode, ctx.cwd)
```

- **RED.** Write `evaluate.test.ts` and
  `build-tool-call-metadata.test.ts` with the scenarios
  below. Confirm the tests fail (neither function is
  extracted yet).
- **GREEN.** Extract `buildToolCallMetadata` from the
  in-handler logic (the tagger-rules application, the
  static-tags + augmented-tags computation). Extract
  `evaluate` from the in-handler matcher. Update the
  handler at `tool_call` to call both. Confirm tests pass;
  the existing integration test still passes.
- **REFACTOR.** Define the `ToolCallMetadata` interface.
  Co-locate the matcher logic. Run `pnpm run check`.

**Test scenarios (assert inner-matcher + global-stuff
behavior):**

1. **Inner matcher with a single tag rule.** Pass a
   `ToolCallMetadata` with `effectiveTags: ["execution"]`
   and a resolved mode with `tagRules: { execution:
"ask" }`; the verdict is `ask`.
2. **Inner matcher with no matching rules.** Pass a
   `ToolCallMetadata` and a resolved mode with
   `defaultDecision: "allow"` and no matching rules; the
   verdict is `allow`.
3. **Inner matcher with a deny at any layer.** A
   `ToolCallMetadata` with `effectiveTags: ["destructive"]`
   and a resolved mode with `tagRules: { destructive:
"deny" }`; the verdict is `deny`.
4. **Inner matcher with a tool rule.** A `ToolCallMetadata`
   for tool `bash` and a resolved mode with
   `toolRules: { bash: [{ verdict: "allow" }] }`; the
   verdict is `allow`.
5. **`buildToolCallMetadata` produces the augmented
   tag set.** An event with `command: ["rm", "-rf",
"foo"]` and tagger rules matching `rm *` produces
   `effectiveTags: ["execution", "mutating"]`.
6. **`buildToolCallMetadata` dedupes the tag set.**
   An event with a tool whose static tag is `mutating` and
   tagger rules that add `mutating` produces
   `effectiveTags: ["mutating"]` (not two `mutating`s).

**Working product at the end:** the matcher's rule combine
is testable via `evaluate`; the global-stuff application
is testable via `buildToolCallMetadata`. The handler at
`tool_call` still has the orchestration logic (it calls
`resolveMode` to get the active mode, then calls
`buildToolCallMetadata` and `evaluate`).

### Unit 7b: `decide` (outer matcher) + `DecideContext` + headline tests + investigate-then-confirm

The outer matcher orchestrates: it doesn't see the
`Config`; it sees a `DecideContext` (the resolved active
mode + the global tagger rules + the tool metadata + the
cwd + the mode name). The matcher's input is focused.

The user's odd cases (`rm -rf`, `ls`) are matcher tests.
This is where the investigate-then-confirm flow runs.

**Extract** one function and one interface:

```ts
interface DecideContext {
  readonly currentModeName: string
  readonly activeMode: Mode
  readonly taggingRules: TaggerRule[]
  readonly toolMetadata: Map<string, ResolvedToolMetadata>
  readonly cwd: string
}

function decide(event: ToolCallEvent, ctx: DecideContext): PolicyDecision
```

The handler at `tool_call`:

```ts
const mergedConfig = composeConfig(...)
const activeMode = resolveMode(currentModeName, mergedConfig)
const ctx: DecideContext = {
    currentModeName,
    activeMode,
    taggingRules: mergedConfig.taggingRules,
    toolMetadata,
    cwd: ctx.cwd,
}
const decision = decide(event, ctx)
```

- **RED.** Write `decide.test.ts` with the user's odd-case
  scenarios as the headline tests, plus the other test
  scenarios below. Confirm the tests fail (no `decide`
  exported yet).
- **GREEN.** Extract `decide` from the in-handler logic.
  Define the `DecideContext` interface. Update the handler
  to construct a `DecideContext` and call `decide`.
  Confirm the new tests pass; the existing integration test
  still passes.
- **REFACTOR.** Document the seam in a comment at the
  handler's call site. Run `pnpm run check`.

**Test scenarios (assert orchestration behavior):**

1. **Headline: `rm -rf .eslintcache` lands in `ask` with
   `mutating` tag.** The user's exact scenario from the
   bug report. The test fails if the tagger doesn't fire,
   the effective tags are wrong, or the verdict is
   anything other than `ask`.
2. **Headline: `ls` in `edit` mode documents the
   per-layer combine behavior.** The user expects
   `readonly: allow` to win; the test asserts the actual
   behavior (`tag:execution = ask` wins, verdict is
   `ask`). The investigate step is where the user
   decides whether the design is correct or whether
   the `removeTags` feature is needed.
3. **YOLO mode short-circuits the matcher.** With
   `currentModeName: "__yolo__"`, the verdict is `allow`
   (the handler's early-return contract).
4. **Unknown mode name returns `deny` with a reason.** The
   test fails if the unknown mode is silently treated as
   `default` or if the reason is missing.
5. **Empty `DecideContext` produces a sensible default.**
   The test fails if the matcher crashes on missing
   fields.

**Investigate step (between RED and GREEN):** same pattern
as the matcher-extraction unit in this plan (Unit 7b; the
insertion of Unit 3b did not renumber downstream units).
After RED (the tests fail), the unit
does NOT immediately move to GREEN. Instead:

1. **Read the test failures** — which assertions broke,
   what messages did vitest produce.
2. **Trace the failures** through the pipeline:
   `effectiveTags` — were the expected tags added?
   (Tagger rule fired?) The matcher's view of the mode
   — does it see the tag rule? The mode's `defaultDecision`
   — is it correct? The matcher's combine — does the tag
   layer beat the default layer?
3. **Identify the root cause** — is it in
   `applyTaggerRules`, in `decide`, in `evaluate`, in the
   combine, in the config shape, or in the handler's
   wiring?
4. **Present findings** — a one-paragraph diagnosis with
   the suspect line(s) and the recommended fix.
5. **Wait for user confirmation** — the user signs off
   on the fix direction before GREEN begins.

If the diagnosis points at a bug outside `decide` (e.g.
in `applyTaggerRules` or in the matcher's combine), the
fix may need a new unit, not a tweak to Unit 7b. The
plan handles this by **pausing the unit** if the
diagnosis crosses a unit boundary; the user decides
whether to expand Unit 7b, add a new unit, or back out
the change.

**Working product at the end:** the handler's `tool_call`
is a thin orchestrator. It builds the `DecideContext`
from `RuntimeState` + the merged `Config` + the tool
metadata, calls `decide`, and dispatches on the verdict
(modal, allow, block). The user's odd cases are covered.

**Per-unit verification gates:** per the verification
strategy section: RED is gated by `pnpm run check`
(workspace clean) + the failing tests. The investigate
step is manual. GREEN is gated by the new tests passing

- `pnpm run check`. REFACTOR is gated by `pnpm run
check`.

The matcher is the most user-facing surface. The user's odd
cases (`rm -rf`, `ls`) are matcher tests. This unit extracts
the matcher with a focused two-layer test boundary: the outer
`decide` orchestrates the global-stuff application and the
mode resolution; the inner `evaluate` does the rule combine.

The unit is also the one where the user has flagged a possible
correctness bug. The flow is different from Units 1–5:
**write the test, see it fail, investigate, present findings,
wait for confirmation, then fix.** No code change is made in
GREEN until the user has reviewed the diagnosis.

#### Test scaffolding (RED: write first, before `decide` exists)

The test files `decide.test.ts` and `evaluate.test.ts` export
a small set of helpers at the top. The helpers are
intentionally minimal — enough to express a scenario, not
enough to abstract the matcher.

```ts
// Event builders: a bash call takes a single string (the
// joined command); the helper builds the array internally.
function bashCall(command: string): ToolCallEvent
function toolCall(toolName: string, input: Record<string, unknown>): ToolCallEvent

// Tool metadata builders: the 7 built-in tools have stable
// aspect bindings. Construct them once, reuse across tests.
// These return the BUILT-IN metadata, adapted to the
// `ResolvedToolMetadata` shape. The aggregation step is out
// of scope for `decide` tests.
function bashToolMeta(): ResolvedToolMetadata
function readToolMeta(): ResolvedToolMetadata
function writeToolMeta(): ResolvedToolMetadata

// Config builder: the most common case is "one mode, with
// tagRules and a defaultDecision".
function configWith(opts: {
  mode?: Partial<Mode>
  modeName?: string
  taggingRules?: TaggerRule[]
  toolMetadata?: Record<string, ToolMetadata>
  otherModes?: Record<string, Partial<Mode>>
}): Config

// DecideContext builder: a one-liner that constructs the
// minimal readonly interface.
function decideContext(opts: {
  currentModeName?: string
  activeMode?: Mode
  taggingRules?: TaggerRule[]
  toolMetadata?: Map<string, ResolvedToolMetadata>
  cwd?: string
}): DecideContext

// ToolCallMetadata builder: for the inner `evaluate` tests.
function toolCallMetadata(opts: {
  toolName: string
  input: Record<string, unknown>
  staticTags?: string[]
  augmentedTags?: string[]
  effectiveTags?: string[]
  resolvedMetadata?: ResolvedToolMetadata
  cwd?: string
}): ToolCallMetadata

// Assertion helper.
function expectDecision(
  decision: PolicyDecision,
  opts: {
    action: "allow" | "ask" | "deny"
    effectiveTags?: string[]
    appliedRule?: { layer: string; key: string }
  },
): void
```

The helpers are pure functions; they don't read from disk or
mutate state. They live in `decide.test.ts` / `evaluate.test.ts`
(co-located per `pi-package-hard-rules`); if a future test
needs the same builders, they move to a shared `test-helpers.ts`
at that point. **Not before.**

#### Headline test — `rm -rf` case (RED: must fail)

This is the user's exact scenario from the bug report:

```ts
it("rm -rf .eslintcache lands in ask with mutating tag (the user's case)", () => {
  const config = configWith({
    mode: {
      tagRules: { mutating: "ask" },
      defaultDecision: "allow",
    },
    taggingRules: [
      {
        tool: "bash",
        fields: { command: ["wc *", "ls", "ls *"] },
        action: { type: "addTags", tags: ["readonly"] },
      },
      {
        tool: "bash",
        fields: { command: ["mkdir *", "rmdir *", "rm *"] },
        action: { type: "addTags", tags: ["mutating"] },
      },
    ],
  })

  const ctx = decideContext({
    activeMode: config.modes.default!,
    taggingRules: config.taggingRules,
    toolMetadata: new Map([["bash", bashToolMeta()]]),
    cwd: "/home/piotr/Work/pi-extensions",
  })

  const decision = decide(bashCall("rm -rf /home/piotr/Work/pi-extensions/.eslintcache"), ctx)

  expectDecision(decision, {
    action: "ask",
    effectiveTags: ["execution", "mutating"],
    appliedRule: { layer: "tag", key: "mutating" },
  })
})
```

**What this test asserts:**

- The tagger fired on the second rule (`"rm *"` matches the
  joined command).
- The augmented tag set is `["execution", "mutating"]`.
- The matcher's most-restrictive verdict in the tag layer is
  `ask`.
- The tag layer wins over the default layer.
- The decision's `effectiveTags` includes `mutating`.

The test fails if any of these steps break.

#### Second headline test — the `ls` case (RED: investigate)

The user reported that `ls` in `edit` mode (with the user's
`taggingRules`) produces effective tags `["execution",
"readonly"]` and the gate asks, even though the user marked
the call as `readonly`. The user expects this to be a bug.

**The plan's job is not to decide whether it is a bug.** The
plan's job is to **test the case** and let the investigate
step tell us:

```ts
it("ls in edit mode: documents the per-layer combine behavior", () => {
  const config = configWith({
    modeName: "edit",
    taggingRules: [
      {
        tool: "bash",
        fields: { command: ["wc *", "ls", "ls *"] },
        action: { type: "addTags", tags: ["readonly"] },
      },
    ],
  })

  const ctx = decideContext({
    currentModeName: "edit",
    activeMode: config.modes.edit!,
    taggingRules: config.taggingRules,
    toolMetadata: new Map([["bash", bashToolMeta()]]),
    cwd: "/home/piotr/Work/pi-extensions",
  })

  const decision = decide(bashCall("ls packages/pi-tool-policy/src/lib/tagging-rules.test.ts"), ctx)

  // Under the current design, the per-layer most-restrictive-wins
  // combine picks `tag:execution = ask` over `tag:readonly = allow`.
  // The test asserts this is the actual behavior. If the user
  // wants a different behavior, that's a separate plan.
  expectDecision(decision, {
    action: "ask",
    effectiveTags: ["execution", "readonly"],
    appliedRule: { layer: "tag", key: "execution" },
  })
})
```

**The two cases test different behaviors of the same gate:**
the `rm -rf` case tests the tagger firing correctly (and the
verdict responding to a tag it added); the `ls` case tests
the matcher's combine (and which tag wins). Both are the
kinds of "odd cases" the user wants covered as the test
surface comes online.

#### Other test scenarios (RED: must also fail)

3. **Allow short-circuit.** A tool with no matching rules in
   a `defaultDecision: "allow"` mode returns `action: "allow"`.
4. **Unknown mode.** `decide` with a mode name not in
   `config.modes` returns `action: "deny"` with a reason
   that mentions the mode name.
5. **YOLO mode short-circuits the matcher.** With
   `currentModeName: "__yolo__"` (regardless of the mode's
   `defaultDecision`), `decide` returns `action: "allow"`.
6. **Inner `evaluate` with a `ToolCallMetadata` + a resolved
   mode.** A test that exercises the matcher logic without
   the orchestration: pass a `ToolCallMetadata` with a
   specific tag set, a resolved mode with `tagRules: { x:
"ask" }`, assert on the verdict. The test fails if the
   rule combine is wrong.

#### Investigate step (between RED and GREEN)

This step is **the difference between Unit 6 and Units 1–5**.
After RED (the tests fail), the unit does **not** immediately
move to GREEN. Instead:

1. **Read the test failures** — which assertions broke, what
   messages did vitest produce.
2. **Trace the failures** through the pipeline:
   - `effectiveTags` — were the expected tags added? (Tagger
     rule fired?)
   - The matcher's view of the mode — does it see the tag
     rule?
   - The mode's `defaultDecision` — is it `ask`, `allow`, or
     `deny`? (Maybe a different mode is selected.)
   - The matcher's combine — does the tag layer beat the
     default layer?
3. **Identify the root cause** — is it in
   `applyTaggerRules`, in `decide` (once extracted), in
   `evaluate`, in the combine, in the config shape, or in
   the handler's wiring?
4. **Present findings** — a one-paragraph diagnosis with the
   suspect line(s) and the recommended fix.
5. **Wait for user confirmation** — the user signs off on
   the fix direction before GREEN begins. The user has
   flagged "too much YOLO decisions have led up to this
   breaking" — the diagnosis is the moment to surface
   whether the accumulated test conventions masked the bug.

If the diagnosis points at a bug outside `decide` (e.g. in
`applyTaggerRules` or in the matcher's combine), the fix
may need a new unit, not a tweak to Unit 6. The plan
handles this by **pausing the unit** if the diagnosis
crosses a unit boundary; the user decides whether to expand
Unit 6, add a new unit, or back out the change.

#### GREEN (after user confirms the diagnosis)

- Extract `decide(event, ctx): PolicyDecision` from the
  `tool_call` handler into
  `packages/pi-tool-policy/src/lib/decide.ts`. Extract
  `evaluate(metadata, activeModeName, activeMode, cwd):
PolicyDecision` into `evaluate.ts`. Extract
  `buildToolCallMetadata(event, config, toolMetadata, cwd):
ToolCallMetadata` into the same file as `decide`.
- Define `DecideContext` and `ToolCallMetadata` interfaces
  in a new `decide-context.ts`.
- The handler's `tool_call` becomes a thin orchestrator:
  build the `DecideContext` from `RuntimeState` + the merged
  `Config`, call `decide`, dispatch on the verdict.
- The headline test passes (the bug, if any, is fixed in
  `decide` or in the code `decide` calls). The four other
  scenarios pass. The existing `tool-policy.test.ts`
  integration test still passes.
- The GREEN change is **conditional on the user's
  confirmation** of the diagnosis from the investigate
  step. If the user says "the bug is elsewhere, not in
  `decide`", the GREEN step is to extract `decide` (and
  the other tests pass) but **not** to fix the bug —
  that's a separate unit, scoped to wherever the diagnosis
  points. The headline test is marked `it.skip(...)` with
  a comment pointing at the separate fix.

#### REFACTOR (after GREEN)

- Document the seam in a comment at the handler's call
  site: "`decide` is the pure verdict pipeline; the
  handler keeps the YOLO early-return, the directory
  guardrail, the ask modal, and the timeline write API."
- Decide whether `rebuildDenyReasonWithUserReason` should
  stay in `tool-policy.ts` (yes — it depends on the modal
  result, which is handler-side).
- Run the full `pnpm run check` before committing.

#### Per-unit verification gates

Per the verification strategy section: RED is gated by
`pnpm run check` (workspace clean) + the failing tests. The
investigate step is manual. GREEN is gated by the new tests
passing + `pnpm run check`. REFACTOR is gated by
`pnpm run check`.

## Pre-flight: workspace is clean

`pnpm run check` is **green on `main` as of the plan write** — 23/23
tasks pass (format:check, lint, typecheck, test across all 8
packages, plus the `//:test:workspace` audit at `tests/solutions.test.ts`).
The decomposition is being planned against a known-good baseline.
The plan's "What this plan does NOT do" list now stands: no
"pre-existing failures" to absorb; if `pnpm run check` fails after
this plan lands, the failure is the plan's responsibility.

variables (hidden)?\*\* Runtime grants and directory grants
are user-granted permissions; they're a form of intent. The
agent's history is also a form of intent (what the agent
did). Mixing them in the timeline means the agent can
review its grants in the same place it reviews its actions.

2. **Shape: should the in-memory state be expressed as
   "config-shaped" objects that merge into the effective
   `Config` via the same `composeConfig` mechanism?** Today,
   `RuntimeGrants.applyFor` produces a modified `Mode`;
   `DirectoryPermissionsState.matches` produces a boolean;
   `ModeController.getMode` produces a string. Three different
   shapes, three different access patterns. If all three were
   "config-shaped" (a `Partial<Config>`), the matcher would
   just see a merged `Config` and the in-memory state would
   disappear into the merge.

## Verification strategy

Per AGENTS.md, `pnpm run check` is the default for end-to-end
validation. The scoped filter is for iteration on a single unit.
**The end-to-end check runs at the boundaries** — before GREEN
starts (baseline), after GREEN (new code in), and after REFACTOR
(cleanup in) — so a regression in any one unit surfaces before
the next unit is written on top of it. The scoped filter alone
isn't enough: a Unit 1 regression wouldn't be caught by
`pnpm --filter @piotrb/pi-tool-policy run test` if it broke
something in another package's downstream consumer.

**Per-unit RED (before any code change):**

- `pnpm run check` — confirm the workspace is clean before the
  unit's failing test is written. If the check fails on the
  baseline, fix the regression first; the unit can't start from
  a broken state.
- `pnpm --filter @piotrb/pi-tool-policy run test` — write the
  failing test. Confirm it fails on the current code.

**Per-unit GREEN (after the minimal change):**

- `pnpm --filter @piotrb/pi-tool-policy run test` — the new
  test passes; existing tests in the same package still pass.
- `pnpm --filter @piotrb/pi-tool-policy run typecheck` — clean.
- `pnpm run check` — end-to-end clean. **This is the gate
  between GREEN and REFACTOR.** If `pnpm run check` fails
  here, the GREEN change has an unintended ripple. Fix the
  ripple before moving to REFACTOR. The end-to-end check is
  what catches the cases the scoped filter misses: a missed
  prettier line in an unrelated file, a lint regression in a
  downstream consumer, a cross-package test that now fails
  because of a changed type.

**Per-unit REFACTOR (after the cleanup pass):**

- `pnpm --filter @piotrb/pi-tool-policy run test` — still
  green. (Shouldn't change in REFACTOR; this is the
  same-suite gate.)
- `pnpm turbo //#lint` — no new lint findings in the changed
  files.
- `pnpm run check` — end-to-end clean. **This is the gate
  between REFACTOR and the next unit.** If `pnpm run check`
  fails here, the refactor changed behavior. Revert the
  refactor, narrow it, and re-run.

**End-to-end (after all five units):**

- `pnpm run check` — the workspace is fully clean. All
  600+ tests across the workspace pass. The existing
  `tool-policy.test.ts` integration test continues to pass
  — it exercises the handler end-to-end with mocked pi, so
  any seam-bleed (e.g. `decide` accidentally taking on a
  responsibility the handler should still own) will surface
  there. The existing `policy.test.ts`,
  `permission-config.test.ts`, `tagging-rules.test.ts`,
  `tool-metadata.test.ts`, `directory-permissions.test.ts`,
  `mode-controller.test.ts` all still pass — they test the
  same logic at a lower level and guard against regressions
  in the pure functions `decide` composes.

**Timing note:** `pnpm run check` on a cold cache takes
~30-60s; on a warm cache (after the first run) it takes
~3-6s. The default 30s timeout is too short for a cold
run; pass an explicit timeout when invoking it.

## What this plan does NOT do

- It does not add a stock-rules toggle.
- It does not refactor the modal flow. The modals stay in the
  handler; the matcher sees a `DecideContext` and returns a
  `PolicyDecision`. The side effects (ask modal, directory
  modal) are handler-side.
- It does not change the matcher logic. The matcher's per-layer
  combine (`deny > ask > allow`, per-layer most-specific-wins,
  `undecided` collapses to `ask`) is preserved exactly. Unit
  6 renames the matcher from `evaluate` to `evaluate` and
  splits it from the outer `decide`, but the rule combine is
  unchanged.
- It does not introduce caching anywhere. The hot-reload
  contract is preserved: the on-disk config is re-read per
  `tool_call`; the session timeline is read once at
  `session_start`; the in-memory state is the source of truth
  within a session. No derived state is cached.
- It does not add a `removeTags` (or any new) tagger action,
  and it does not decide the action-shape question. The user
  reported a case where `ls` in `edit` mode matches the
  `readonly: allow` tag rule, but the matcher's per-layer
  most-restrictive-wins combine picks `execution: ask` over
  `readonly: allow`, so the gate asks. This is **correct under
  the current design** (the combine is `deny > ask > allow` per
  `pi-tool-policy-mode-controller`). The user proposed a new
  `removeTags` action so `execution` could be stripped from the
  effective tag set when the user knows the call is safe (e.g.
  for `ls`, `wc`). That is a **feature, not a refactor**.

  **Action-shape design considerations for the future feature
  plan** (recorded here so the next plan inherits the
  analysis, **and the recommendation**, not just the
  options): today the action is a single discriminated-union
  variant (`{ type: "addTags", tags }`). Adding `removeTags`
  raises the question of how a single rule carries both
  operations. Three shapes are plausible:
  1. **Single struct, both operations optional** —
     `action: { addTags?: string[]; removeTags?: string[] }`.
     One rule, one effect, multiple operations.
     Backward-incompatible with the current `{ type:
"addTags", tags }` shape — existing configs need a
     migration (a 1:1 rewrite of the action field).
  2. **Array of variants** — `action: [{ type: "addTags", tags
}, { type: "removeTags", tags }]`. Backward compatible
     (one-element arrays work). Easy to extend (a future
     `setVerdict` variant is just another entry). The
     discriminated union is preserved. Order within the
     array is a footgun if the operations are not
     commutative; the feature plan must decide whether
     order matters (it does for `setVerdict`, doesn't for
     `addTags` / `removeTags` if the runtime separates the
     add and remove phases).
  3. **Plural `actions` field on the rule** — `actions: [{
type: "addTags", tags }]`. Same semantics as option 2,
     just a different field name. The single-action case
     (`action: ... }`) is the existing backward-compatible
     shape; a future-config could opt into the plural
     `actions` field.

  **Recommended direction (recorded for the future feature
  plan, not decided by this plan): the single struct (option
  1).** Reasons:
  - **One rule, one effect, one shape.** The user reads the
    action and sees the full effect of the rule. No
    iterating variants, no order questions, no "which
    action type wins."
  - **The runtime is simpler.** `applyTaggerRules` doesn't
    dispatch on a discriminated union — it just iterates
    the modifier set. Two phases: collect all `addTags`
    and all `removeTags` across the rule's actions, then
    apply `static ∪ adds − removes` at the end.
  - **Order doesn't matter for `addTags` / `removeTags`**
    (the only two variants). They're commutative, so the
    "order within an action" footgun that the array form
    has doesn't apply. The order **between rules** still
    matters (it does today), but that's not new.
  - **Migration is mechanical.** The current shape is
    `{ type: "addTags", tags: [...] }`. The new shape is
    `{ addTags: [...] }`. A migration script reads the
    old shape, emits the new one, and rewrites the
    action field. The only configs that need it are the
    user's on-disk `~/.pi/tool-policy.json` and any
    project config. One-time, lossy, and the only field
    that changes is `action`.
  - **The JSON Schema is simpler.** No `oneOf`, no `type`
    discriminator. Just an object with two optional
    string-array properties. Easier to read, easier to
    extend (a future `setVerdict` is just another
    optional property).
  - **TypeScript types are simpler.**
    `interface TaggerAction { addTags?: string[];
removeTags?: string[] }` — no discriminated union, no
    exhaustive switch, no exhaustiveness checks needed at
    every call site. The narrowing is just
    `if (action.addTags)`, same expressiveness as the
    union form.
  - **The cost is the migration.** The migration is the
    only reason to consider the array form. The array
    form preserves backward compatibility, but at the
    cost of an order-footgun and a more complex runtime.
    The migration is small enough (one field per action,
    one config file per user) that the simpler shape is
    worth it.

  The feature plan picks the single struct. The
  decomposition plan does not implement it; it records the
  recommendation and the migration path so the next plan
  inherits both.
