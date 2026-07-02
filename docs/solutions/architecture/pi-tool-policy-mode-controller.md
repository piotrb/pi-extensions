---
title: pi-tool-policy mode controller (verdict, matcher, aspects, metadata, mode-controller)
category: architecture
severity: high
tags:
  - pi-tool-policy
  - mode-controller
  - matcher
  - verdict
  - aspect-rules
  - tag-rules
  - tool-rules
  - tool-metadata
  - tagging-rules
  - directory-permissions
  - loadConfig
  - STOCC_CONFIG
  - AspectDeclaration
  - FieldBinding
applies_when:
  - working in src/lib/ of pi-tool-policy (any file)
  - designing a new mode (adding to STOCK_CONFIG or user's config)
  - debugging a matcher decision (verdict, ruleTrail, layer-specificity)
  - adding a new aspect kind to the matchAspect dispatch
  - writing or extending the v2 type contract
  - implementing or extending the per-mode single-pass matcher
  - working on the directory-permissions guardrail
  - working on the mode controller (cycleMode, additionalInstructions, status bar)
  - writing a custom tagger rule
---

# Problem

`pi-tool-policy` is the most complex policy engine in the workspace. Its `src/lib/` has ten files, each with a distinct contract: the type contract (`types.ts`), the matcher (`policy.ts`), the aspect dispatch (`aspects.ts`), the config loader (`permission-config.ts`), the tool-metadata aggregator (`tool-metadata.ts`), the tagger (`tagging-rules.ts`), the directory guardrail (`directory-permissions.ts`), the mode controller (`mode-controller.ts`), and two modals. Without a single reference for the per-file contract, the agent re-implements the matcher, breaks the verdict enum, or collides with the v2 type changes. Each of these breaks the trust model.

This solution covers the area skill for the mode controller subsystem. The package overview (the four event handlers, the lifecycle, the cross-cutting state table) is in `working-with-pi-tool-policy`. The per-field `FieldBinding` shape and the dispatch-key gotcha are in `pi-tool-policy-per-field-aspect-cardinality` (a sibling area skill).

# Context

The mode controller subsystem is the v2 contract. The v1 → v2 refactor removed the `[]` cardinality suffix from aspect names (per-field cardinality is now encoded in `FieldBinding`), changed the verdict enum's handling of `undecided` (collapse to `ask`, not to a fall-through), and made the matcher per-layer most-specific-wins (with `deny` sticky). The v2 contract is the contract; v1 is obsolete.

# Solution

## v2 type contract (`types.ts`)

The v2 types live in `src/lib/types.ts`:

- **`Verdict`** — `"allow" | "ask" | "deny"`. The three matcher outcomes.
- **`AnyVerdict`** — `Verdict | RuleEntry`. The matcher accepts both shapes.
- **`Mode`** — `description`, `extends?`, `defaultDecision`, `tagRules`, `toolRules`, `aspectRules`, `additionalInstructions?`.
- **`Config`** — `modeOrder`, `modes`, `allowedPaths`, `taggingRules`, `toolMetadata`.
- **`AspectDeclaration`** — `{ mode: BaseAspectMode; fields: FieldBinding[] }`. The matcher semantics are per-aspect; cardinality is per-field (see `pi-tool-policy-per-field-aspect-cardinality`).
- **`BaseAspectMode`** — `"path" | "url" | "bash" | "glob" | "regex"`. The 5-value enum. There is no `[]` suffix; per-field cardinality is encoded in the `FieldBinding` shape.
- **`FieldBinding`** — `string | { field: string; mode?: "scalar" | "array" }`. A bare string is shorthand for `{ field: <name>, mode: "scalar" }`. The object form opts in to array-mode per field.
- **`isArrayBinding(binding)`** / **`fieldName(binding)`** — helpers for iterating `AspectDeclaration.fields`. The previous `isArrayMode` / `baseMode` helpers are gone.
- **`ResolvedToolMetadata`** — `{ tags, fields }` for a single tool (post-aggregation). `fields` is `Record<string, AspectDeclaration>` (aspect name → declaration).
- **`RuleResult`** — one rule's contribution to the matcher trail: `{ layer, key, aspect?, pattern?, verdict, reason?, status }`.
- **`PolicyDecision`** — `{ action, reason?, ruleTrail, effectiveTags, directoryGuardrailFired }`. The matcher's final output.

## The verdict enum and combine

The matcher returns one of three values: `allow`, `ask`, `deny`. The combine is `moreRestrictive`:

```
deny > ask > allow
```

`undecided` (a rule that didn't match) collapses to `ask` (fail-closed). The matcher's combine always returns a `Verdict`, never `undecided`. This is **different from `pi-task-runner`'s `"undecided"`** — there, `"undecided"` is a fall-through signal; here, it's a per-layer "didn't match" that the matcher collapses to `ask` (fail-closed) within the combine. The two systems are not interchangeable.

## The single-pass matcher (`policy.ts`)

`evaluate(event, config, currentMode, effectiveTags, toolMetadata, ctx)` — within a single mode, in eval order:

1. **`tagRules`** for each tag in `effectiveTags`.
2. **`aspectRules`** for each declared aspect binding on the tool. For each aspect, iterate `decl.fields` per `FieldBinding`: scalar bindings use `coerceForMatch(value)` and dispatch to `matchAspect`; array-mode bindings iterate `string[]` and dispatch to `matchAspectEach`. Each binding contributes one `applied` / `shadowed` / `noop` entry to the rule trail. The combine is **per-layer most-specific-wins** (not flat most-restrictive): the matcher first computes the most-restrictive verdict within each layer (aspect / tool / tag / default), then picks the most-specific layer's verdict as the global winner. `deny` is sticky — if any layer produces `deny`, the global verdict is `deny`. See `pi-tool-policy-per-field-aspect-cardinality` for the per-field loop and the dispatch-key gotcha.
3. **`toolRules[tool]`** entries (with `fields` clause matching).
4. **`defaultDecision`** as the fall-through.

### ruleTrail

The `ruleTrail` records each rule with status `applied` / `shadowed` / `noop`:

- **`applied`** — the rule is the layer winner AND the global winner.
- **`shadowed`** — the rule is less restrictive than the layer winner; it would have applied but the layer pick was more restrictive.
- **`noop`** — the rule's verdict is the same value as the layer winner; the rule didn't change the outcome.

The trail is in matcher evaluation order (tag → aspect → tool → default). The modal sorts it top-down by priority for display (applied first, then shadowed/noop grouped by layer specificity). The `reason` is the concatenation of applied rules' reasons, with a synthesized `Matched rule: <id>` fallback for the deny path.

### coerceForMatch

`coerceForMatch(value): string | undefined` is the v2 type-driven version: `string` returns as-is; `string[]` is joined with " "; non-primitives throw. It does **not** take an aspect-name parameter (the previous v1 form did).

## Aspect kinds (`aspects.ts`)

`matchAspect(name, value, aspect, cwd)` — the `name` parameter dispatches on aspect kind:

- **`path`** — picomatch against `path.relative(cwd, value)`.
- **`url`** — `new URL()` with https:// fallback.
- **`bash_cmd`** — bash-mode word-boundary patterns, joined `string[]` args.
- **`glob`** — raw picomatch on basename.
- **`regex`** — `new RegExp(pattern).test(value)`.
- **fallback** — `genericPatternToRegex` or `bashPatternToRegex` (per `aspect.mode`).

After the per-field refactor, the `name` parameter should be `AspectDeclaration.mode` (one of the 5 base modes), not the user-defined aspect name from `Object.entries(meta.fields)`. The fallback branch only fires correctly when the user's aspect name happens to be one of the 5 — for any other name, the matcher falls through to generic-regex semantics. See `pi-tool-policy-per-field-aspect-cardinality` for the dispatch-key gotcha.

The `picomatchCache` is module-level to avoid repeated compilation. Do not recreate the cache per call.

## Config loading (`permission-config.ts`)

`loadConfig(cwd): Promise<LoadedConfig>`:

1. Reads `~/.pi/tool-policy.json` (user) and `<cwd>/.pi/tool-policy.json` (project).
2. Shallow-merges per top-level key (project wins).
3. Resolves the `extends` graph with cycle detection (warnings emitted on cycles).
4. Resolves project-relative `allowedPaths` to absolute paths.
5. Returns `{ config, warnings, sources }`.

`STOCK_CONFIG` is the in-source fallback. It contains four stock modes (`readonly`, `default`, `edit`, `plan`) plus the built-in `toolMetadata`. The stock modes form an inheritance chain: `default` extends `readonly` (inherits the readonly+metadata allow base and adds mutating/execution/network asks); `edit` extends `default` (adds `mutating: allow`); `plan` extends `readonly` directly (adds the mutating/execution/network denies plus `defaultDecision: deny`). If the user has no config, the stock config is used.

## Tool metadata aggregation (`tool-metadata.ts`)

`aggregateToolMetadata(tools, configOverrides): Promise<AggregateResult>` — three-layer aggregation, in priority order (lowest to highest):

1. **`STOCK_BUILTIN_TOOL_METADATA`** (in-source) — the built-in tools pi ships. All entries use the scalar form (`fields: ["path"]`); a `string[]` is a valid `FieldBinding[]` because `string` is one of the union members.
2. **Each extension's `package.json` `pi.toolMetadata`** — per-package metadata declared at registration time. Per-field cardinality uses the `{ field, mode: "array" }` object form.
3. **`config.toolMetadata`** (config) — user-supplied overrides.

Config wins on conflict. The aggregator emits warnings for **orphan-aspect references** — overrides that introduce an aspect not in the built-in set. The pre-refactor orphan check normalized `path[]` → `path` to bridge between the v1 cardinality suffix and the aspect name; the post-refactor check compares aspect names as-is (no normalization needed — the `[]` suffix is gone from the type).

## Tagging rules (`tagging-rules.ts`)

`applyTaggerRules(event, rules, toolMetadata, cwd): string[]` — each rule:

- **Tool name:** glob (picomatch).
- **`fields?`:** AND across keys, OR within a key (generic pattern matcher).
- **`aspects?`:** AND across aspects, OR within an aspect (uses `matchAspect` with a degenerate fake aspect).
- **`action`:** `addTags` (the only action type).

`string[]` field values are joined with " " before matching. The output is the augmented tag set that the matcher then consumes.

## Directory permissions (`directory-permissions.ts`)

`DirectoryPermissionsState` — in-memory tag-aware store:

- `reset(cwd)`
- `matches(absPath, effectiveTags)`
- `isGranted(absPath, effectiveTags)`
- `record(absPath, tags, opts)`
- `has(path)`

`checkAndPrompt(state, event, toolMetadata, effectiveTags, allowedPathsConfig, ctx, openModal)` — free function. Loops-internally-to-layer for each ungranted path.

The guardrail iterates over path-aspect-bound fields on the tool. After the per-field refactor, the check is `decl.mode === "path"` only — there is no `path[]` variant to test against. The iteration uses `fieldName(binding)` to extract each field key from the `FieldBinding[]` array. `string[]` field values are iterated as separate paths. The CWD auto-grant is the only persistent grant; everything else is session-scoped.

## The mode controller (`mode-controller.ts`)

`ModeController` — state machine:

- `reset(config)` — clear state, set the default mode.
- `setMode(name, config)` — switch to a named mode.
- `getMode()` — read the current mode name.
- `cycleMode(config)` — advance to the next mode in `modeOrder`.
- `refreshStatusBar(ctx)` — update the TUI status bar.
- `setWarnings(warnings)` / `getWarnings()` — manage the warnings list.
- `buildAdditionalInstructions(config): string` — produce the section appended to the system prompt.

The status bar text is always `mode: <name> (Alt+M)`. `additionalInstructions` returns a wrapped section that's appended to `event.systemPrompt` by the extension entry's `before_agent_start` handler.

## Modals (`src/lib/modal/`)

- **`directory-permissions-modal.ts`** — `openDirectoryPermissionsModal(ctx, args): Promise<GrantResult | null>`. The `buildDirectoryOptions(args)` helper is exported for data-shaping tests.
- **`tool-policy-modal.ts`** — `openToolPolicyModal(ctx, config, currentMode, warnings): Promise<string | null>`. The `buildToolPolicyOptions(config, currentMode, warnings)` helper is exported for tests.
- **`modal.test.ts`** — data-shaping tests for the two `build*Options` helpers. The TUI flow is verified manually.

## When to add a new aspect kind

1. Add the new kind to the `matchAspect` dispatch in `src/lib/aspects.ts`.
2. Update the JSON Schema's `aspect` enum in `schemas/tool-policy.schema.json`.
3. Add unit tests for the new kind in `aspects.test.ts`.
4. Run `pnpm --filter @piotrb/pi-tool-policy run typecheck test`.

# Why this works

- **The v2 type contract is the contract.** `Verdict`, `AnyVerdict`, `Mode`, `Config`, `AspectDeclaration`, `BaseAspectMode`, `FieldBinding` are the v2 types. v1 is obsolete. Code that references v1 types (the `[]` suffix, the `isArrayMode` helper, the `coerceForMatch(value, aspectName)` signature) needs to migrate to v2.
- **The per-mode single-pass matcher is fast.** Within a single mode, the matcher walks tag → aspect → tool → default, computes the per-layer most-restrictive verdict, and picks the most-specific layer's verdict as the global winner. This is **not** a flat `deny > ask > allow` over all rules; the per-layer specificity matters.
- **`undecided` collapses to `ask` (fail-closed).** A rule that didn't match is a fall-through to `ask`, not a deny. The combine is `deny > ask > allow`; `undecided` is not in the combine. The user gets a prompt, not a silent block.
- **`deny` is sticky across layers.** If any layer produces `deny`, the global verdict is `deny`. The aspect layer's deny beats the tool layer's allow. The sticky behavior is the safety net.
- **Config wins on conflict in three layers.** Built-in < per-package `pi.toolMetadata` < user config. The aggregator emits warnings for orphan-aspect references so the user can see when an override introduces an aspect the built-in tools don't use.
- **The mode controller is a per-session state machine.** `currentMode` is a closure variable in the extension entry, reset on `session_start`. The TUI status bar reflects the current mode; the system prompt's `additionalInstructions` is rebuilt on every `before_agent_start`.

# Prevention

- **Do not collapse `undecided` to `deny` at the matcher level.** The combine is `deny > ask > allow`; `undecided` collapses to `ask` (fail-closed at the next layer, not the matcher). A `deny` collapse would make every non-matching rule a block.
- **Do not change the verdict enum.** The three values are part of the contract. Adding `"undecided"` as a fourth value or changing semantics breaks the matcher.
- **Do not cache the `loadConfig` result.** Hot-reload is by design. If a perf problem motivates caching, fix the perf problem; don't add a cache.
- **Do not add globs to tag matching.** Tags match by exact set membership. A tagger rule's `tool` field uses picomatch (for the tool name), but the `effectiveTags` set itself is a `Set<string>` and membership is exact.
- **Do not reference v1 types.** The `[]` suffix, the `isArrayMode` / `baseMode` helpers, and the `coerceForMatch(value, aspectName)` signature are all v1. The v2 contract is the only contract.
- **Do not recreate `picomatchCache` per call.** The module-level cache is shared across all `matchAspect` invocations. Recreating it per call defeats the cache.
- **Do not use the user-defined aspect name as the dispatch key.** The `matchAspect` `name` parameter should be `AspectDeclaration.mode` (one of the 5 base modes), not the user-defined aspect name from `Object.entries(meta.fields)`. Using the user-defined name falls through to the generic-regex branch for any non-base-mode name.
- **Do not persist `deny` verdicts across sessions.** The directory-permissions modal does not record denials. The next request for the same path asks again.

# Verification

- **Verdict enum** is tested with all three values; the combine is tested for the `deny > ask > allow` order.
- **Single-pass matcher** is tested with a multi-layer mode (tag + aspect + tool + default) and the per-layer specificity is asserted.
- **ruleTrail** is tested for `applied` / `shadowed` / `noop` semantics — the trail correctly records less-restrictive rules as `shadowed` rather than `applied`.
- **Aspect kinds** are tested one-by-one in `aspects.test.ts`. The `picomatchCache` is tested for cache hits.
- **Config loading** is tested for project > user precedence, the `extends` cycle detection (warning emitted), and the `STOCK_CONFIG` fallback.
- **Tool metadata aggregation** is tested for three-layer priority; orphan-aspect warnings are asserted.
- **Tagging rules** are tested for AND-across / OR-within semantics, and for the `addTags` action.
- **Directory permissions** are tested for the CWD auto-grant and the session-scoped persistence of user grants.
- **Mode controller** is tested for `cycleMode` order, `additionalInstructions` output, and `session_start` reset.

# Related

- `working-with-pi-tool-policy` — the package overview, including the four event handlers (`session_start`, `resources_discover`, `before_agent_start`, `tool_call`), the cross-cutting state table, and the lifecycle.
- `pi-tool-policy-per-field-aspect-cardinality` — the per-field `FieldBinding` shape, the per-field dispatch loop, and the dispatch-key gotcha.
- `pi-task-runner-permission-pattern` — the `pi-task-runner` permission system, which uses a different verdict enum (`undecided` is a fall-through, not a fail-closed `ask`) and a different matcher (specificity-based, not per-mode). The two systems coexist: `pi-task-runner` gates `cmd: string[]`; `pi-tool-policy` gates other tools.
- `pi-tool-call-load-order-first-wins` — when `pi-do-it-right` and `pi-tool-policy` both register a `tool_call` handler, the order determines which fires first.
- `pi-package-hard-rules` — the cross-cutting invariants for any `pi-*` package; the mode controller subsystem is one of the load-bearing contracts.
