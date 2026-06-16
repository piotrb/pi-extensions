---
name: pi-tool-policy-mode-controller
description: The mode controller, aspect kinds, and matcher internals for the pi-tool-policy package — verdict enum, per-mode single-pass evaluation, tool-metadata aggregation, and tagging-rule semantics. Use when working in src/lib/ of pi-tool-policy, designing a new mode, or debugging a matcher decision.
---

You are working in `src/lib/` of `pi-tool-policy`, designing a new mode, or debugging a matcher decision. This is the area skill for the mode controller subsystem; read `working-with-pi-tool-policy` first for the package overview.

## types.ts — the v2 type contract

All v2 types live in `src/lib/types.ts`:

- **`Verdict`** — `"allow" | "ask" | "deny"`. The three possible matcher outcomes.
- **`AnyVerdict`** — `Verdict | RuleEntry`. The matcher accepts both shapes.
- **`Mode`** — `description`, `extends?`, `defaultDecision`, `tagRules`, `toolRules`, `aspectRules`, `additionalInstructions?`. The shape of a single mode.
- **`Config`** — `modeOrder`, `modes`, `allowedPaths`, `taggingRules`, `toolMetadata`. The top-level config shape.
- **`AspectDeclaration`** — `{ mode: BaseAspectMode; fields: FieldBinding[] }`. The matcher semantics are per-aspect; cardinality is per-field (see `pi-tool-policy-per-field-aspect-cardinality`).
- **`BaseAspectMode`** — `"path" | "url" | "bash" | "glob" | "regex"`. The 5-value enum. There is no `[]` suffix; per-field cardinality is encoded in the `FieldBinding` shape.
- **`FieldBinding`** — `string | { field: string; mode?: "scalar" | "array" }`. A bare string is shorthand for `{ field: <name>, mode: "scalar" }`. The object form opts in to array-mode per field.
- **`isArrayBinding(binding)`** / **`fieldName(binding)`** — helpers for iterating `AspectDeclaration.fields`. The previous `isArrayMode` / `baseMode` helpers are gone.
- **`ResolvedToolMetadata`** — `{ tags, fields }` for a single tool (post-aggregation). `fields` is `Record<string, AspectDeclaration>` (aspect name → declaration).
- **`RuleResult`** — one rule's contribution to the matcher trail: `{ layer, key, aspect?, pattern?, verdict, reason?, status }`.
- **`PolicyDecision`** — `{ action, reason?, ruleTrail, effectiveTags, directoryGuardrailFired }`. The matcher's final output.

## The verdict enum

The matcher returns one of three values: `allow`, `ask`, `deny`. The combine is `moreRestrictive`:

```
deny > ask > allow
```

`undecided` (a rule that didn't match) collapses to `ask` (fail-closed). The matcher's combine always returns a `Verdict`, never `undecided`.

## The single-pass matcher

`policy.ts` exports `evaluate(event, config, currentMode, effectiveTags, toolMetadata, ctx)`. Within a single mode, in eval order:

1. **`tagRules`** for each tag in `effectiveTags`.
2. **`aspectRules`** for each declared aspect binding on the tool. For each aspect, iterate `decl.fields` per `FieldBinding`: scalar bindings use `coerceForMatch(value)` and dispatch to `matchAspect`; array-mode bindings iterate `string[]` and dispatch to `matchAspectEach`. Each binding contributes one `applied` / `suppressed` / `noop` entry to the rule trail; most-restrictive wins across all bindings on the aspect. See `pi-tool-policy-per-field-aspect-cardinality` for the per-field loop and the dispatch-key gotcha.
3. **`toolRules[tool]`** entries (with `fields` clause matching).
4. **`defaultDecision`** as the fall-through.

The `ruleTrail` records each rule with status `applied` / `suppressed` / `noop`. The reason is the concatenation of applied rules' reasons, with a synthesized `Rejected by rule: <layer>:<key>` fallback.

`coerceForMatch(value): string | undefined` is the v2 type-driven version: string / string[] joined with " " / throw on non-primitive. It does not take an aspect-name parameter.

## Aspect kinds

`aspects.ts` exports `matchAspect(name, value, aspect, cwd)`. The `name` parameter dispatches on aspect kind:

- **`path`** — picomatch against `path.relative(cwd, value)`.
- **`url`** — `new URL()` with https:// fallback.
- **`bash_cmd`** — bash-mode word-boundary patterns, joined string[] args.
- **`glob`** — raw picomatch on basename.
- **`regex`** — `new RegExp(pattern).test(value)`.
- **fallback** — `genericPatternToRegex` or `bashPatternToRegex` (per `aspect.mode`).

After the per-field refactor, the `name` parameter should be `AspectDeclaration.mode` (one of the 5 base modes), not the user-defined aspect name from `Object.entries(meta.fields)`. The fallback branch only fires correctly when the user's aspect name happens to be one of the 5 — for any other name, the matcher falls through to generic-regex semantics. See `pi-tool-policy-per-field-aspect-cardinality` for the dispatch-key gotcha.

The `picomatchCache` is module-level to avoid repeated compilation. Do not recreate the cache per call.

## Config loading

`permission-config.ts` exports `loadConfig(cwd): Promise<LoadedConfig>`. It:

1. Reads `~/.pi/tool-policy.json` (user) and `<cwd>/.pi/tool-policy.json` (project).
2. Shallow-merges per top-level key (project wins).
3. Resolves the `extends` graph with cycle detection (warnings emitted on cycles).
4. Resolves project-relative `allowedPaths` to absolute paths.
5. Returns `{ config, warnings, sources }`.

`STOCK_CONFIG` is the in-source fallback. It contains the three default modes (`default`, `plan`, `edit`) plus the built-in `toolMetadata`. If the user has no config, the stock config is used.

## Tool metadata aggregation

`tool-metadata.ts` exports `aggregateToolMetadata(tools, configOverrides): Promise<AggregateResult>`. Three-layer aggregation, in priority order (lowest to highest):

1. **`STOCK_BUILTIN_TOOL_METADATA`** (in-source) — the built-in tools pi ships. All entries use the scalar form (`fields: ["path"]`); a `string[]` is a valid `FieldBinding[]` because `string` is one of the union members.
2. **Each extension's `package.json` `pi.toolMetadata`** — per-package metadata declared at registration time. Per-field cardinality uses the `{ field, mode: "array" }` object form.
3. **`config.toolMetadata`** (config) — user-supplied overrides.

Config wins on conflict. The aggregator emits warnings for **orphan-aspect references** — overrides that introduce an aspect not in the built-in set. The pre-refactor orphan check normalized `path[]` → `path` to bridge between the v1 cardinality suffix and the aspect name; the post-refactor check compares aspect names as-is (no normalization needed — the `[]` suffix is gone from the type).

## Tagging rules

`tagging-rules.ts` exports `applyTaggerRules(event, rules, toolMetadata, cwd): string[]`. Each rule:

- **Tool name:** glob (picomatch).
- **`fields?`:** AND across keys, OR within a key (generic pattern matcher).
- **`aspects?`:** AND across aspects, OR within an aspect (uses `matchAspect` with a degenerate fake aspect).
- **`action`:** `addTags` (the only action type).

`string[]` field values are joined with " " before matching. The output is the augmented tag set that the matcher then consumes.

## Directory permissions

`directory-permissions.ts` exports:

- **`DirectoryPermissionsState`** — in-memory tag-aware store. Methods: `reset(cwd)`, `matches(absPath, effectiveTags)`, `isGranted(absPath, effectiveTags)`, `record(absPath, tags, opts)`, `has(path)`.
- **`checkAndPrompt(state, event, toolMetadata, effectiveTags, allowedPathsConfig, ctx, openModal)`** — free function. Loops-internally-to-layer for each ungranted path.

The guardrail iterates over path-aspect-bound fields on the tool. After the per-field refactor, the check is `decl.mode === "path"` only — there is no `path[]` variant to test against. The iteration uses `fieldName(binding)` to extract each field key from the `FieldBinding[]` array. `string[]` field values are iterated as separate paths. The CWD auto-grant is the only persistent grant; everything else is session-scoped.

## The mode controller

`mode-controller.ts` exports `ModeController`. State machine. Methods:

- `reset(config)` — clear state, set the default mode.
- `setMode(name, config)` — switch to a named mode.
- `getMode()` — read the current mode name.
- `cycleMode(config)` — advance to the next mode in `modeOrder`.
- `refreshStatusBar(ctx)` — update the TUI status bar.
- `setWarnings(warnings)` / `getWarnings()` — manage the warnings list.
- `buildAdditionalInstructions(config): string` — produce the section appended to the system prompt.

The status bar text is always `mode: <name> (Alt+M)`. `additionalInstructions` returns a wrapped section that's appended to `event.systemPrompt` by the extension entry's `before_agent_start` handler.

## Modals

`src/lib/modal/`:

- **`directory-permissions-modal.ts`** — `openDirectoryPermissionsModal(ctx, args): Promise<GrantResult | null>`. The `buildDirectoryOptions(args)` helper is exported for data-shaping tests.
- **`tool-policy-modal.ts`** — `openToolPolicyModal(ctx, config, currentMode, warnings): Promise<string | null>`. The `buildToolPolicyOptions(config, currentMode, warnings)` helper is exported for tests.
- **`modal.test.ts`** — data-shaping tests for the two `build*Options` helpers. The TUI flow is verified manually.

## When to add a new aspect kind

1. Add the new kind to the `matchAspect` dispatch in `src/lib/aspects.ts`.
2. Update the JSON Schema's `aspect` enum in `schemas/tool-policy.schema.json`.
3. Add unit tests for the new kind in `aspects.test.ts`.
4. Run `pnpm --filter @piotrb/pi-tool-policy run typecheck test`.

## What you do not do

- Do not collapse `undecided` to `deny` at the matcher level. The combine is `deny > ask > allow`; `undecided` collapses to `ask` (fail-closed at the next layer, not the matcher).
- Do not change the verdict enum. The three values are part of the contract.
- Do not cache the `loadConfig` result. Hot-reload is by design.
- Do not add globs to tag matching. Tags match by exact set membership.

## What this skill does not do

- It does not cover the package overview — see `working-with-pi-tool-policy`.
- It does not cover the canonical `pi-*` package shape — see `pi-package-scaffold`.
- It does not cover the per-field `FieldBinding` shape, the per-field dispatch loop, or the dispatch-key gotcha — see `pi-tool-policy-per-field-aspect-cardinality`.
