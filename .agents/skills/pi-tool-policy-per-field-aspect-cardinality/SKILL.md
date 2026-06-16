---
name: pi-tool-policy-per-field-aspect-cardinality
description: The per-field `FieldBinding` shape for `AspectDeclaration` in `pi-tool-policy` — the data model, the per-field dispatch loop, and the dispatch-key gotcha. Use when changing the `FieldBinding` shape, when iterating `decl.fields` in the matcher, when an aspectName other than `path` is bound to a path mode and is producing surprising matcher results, or when writing a regression test for the `git_mv` `source` aspect case.
---

You are working in the `pi-tool-policy` matcher or its data model. The pre-2026 shape was `AspectDeclaration = { mode: "path" | "path[]" | ... | "regex[]"; fields: string[] }` where the `[]` suffix marked the whole aspect as array-mode. The current shape is per-field: a single aspect can carry fields of mixed cardinality, and the `[]` suffix is gone.

This skill is the area skill for the per-field aspect cardinality refactor. Read `pi-tool-policy-mode-controller` first for the v2 type contract and the single-pass matcher; read this skill when the field-level dispatch is the topic.

## What the refactor changed

A single `AspectDeclaration` can now bind fields of mixed cardinality:

```ts
// Mode: the matcher semantics (path-glob, URL-host, bash-word, basename-glob, regex).
// Cardinality: per-field, decided by the binding shape.
interface AspectDeclaration {
  mode: "path" | "url" | "bash" | "glob" | "regex" // 5 base modes — no "[]" suffix
  fields: FieldBinding[] // per-field cardinality
}

type FieldBinding =
  | string // shorthand for { field, mode: "scalar" }
  | { field: string; mode?: "scalar" | "array" } // object form opts in to array-mode
```

The base-mode enum and the per-field union are exported from `types.ts` as `BaseAspectMode`, `FieldBinding`, `isArrayBinding`, and `fieldName`. The previous `isArrayMode` / `baseMode` helpers are gone — use `isArrayBinding(binding)` and `fieldName(binding)` instead.

## Why the refactor

The old `mode: "X[]"` suffix forced cardinality decisions at the aspect level. A tool that had both an array-mode `paths` field and a scalar `cwd` field on the same `path` aspect had to choose: either the whole aspect was array-mode (forcing `cwd` into an array) or the whole aspect was scalar (forcing `paths` to be joined with " "). The per-field `FieldBinding` removes the choice — each binding decides for itself.

## The per-field dispatch loop

In `policy.ts:135-170` and `coverage.ts:50-77`, the matcher iterates `decl.fields` once per binding (not once per aspect), and uses `isArrayBinding` / `fieldName` to dispatch each one:

```ts
for (const [aspectName, decl] of Object.entries(meta.fields)) {
  const aspectRule = mode.aspectRules[aspectName]
  if (!aspectRule) continue

  for (const binding of decl.fields) {
    const field = fieldName(binding)        // "path" or { field: "x" } → "x"
    const value = args[field]
    if (value === undefined || value === null) continue

    if (isArrayBinding(binding)) {
      if (!Array.isArray(value)) continue
      const result = matchAspectEach(/* see dispatch-key gotcha below */, value, aspectRule, ctx.cwd)
      if (result === "undecided") continue
      contribute("aspect", field, result.verdict, { aspect: aspectName, pattern: result.pattern })
      continue
    }

    const s = coerceForMatch(value)
    if (!s) continue
    const result = matchAspect(/* see dispatch-key gotcha below */, s, aspectRule, ctx.cwd)
    if (result === "undecided") continue
    contribute("aspect", field, result.verdict, { aspect: aspectName, pattern: result.pattern })
  }
}
```

The scalar and array paths both contribute to the running fold independently. Most-restrictive wins (`deny > ask > allow`) across all bindings on the aspect.

## The dispatch-key gotcha (latent bug in the post-refactor code)

`aspects.ts:36-110` dispatches on its `name` parameter:

- `name === "regex"` → regex patterns.
- `name === "glob"` → picomatch on basename.
- `name === "path"` → picomatch on `path.relative(cwd, value)` (the path-glob semantics).
- Otherwise → `genericPatternToRegex` or `bashPatternToRegex` (the fallback path).

The path-glob branch only fires when `name === "path"`. The per-field loop iterates `meta.fields` and gets the user-defined aspect name (e.g. `"source"` for `git_mv`'s `source` aspect). If the loop passes that aspect name to `matchAspect`, a `source` aspect bound to `mode: "path"` falls through to the fallback generic-regex path, not the path picomatch path. **A real-world `gitignore`-style pattern (e.g. `**/node_modules/**`) on a non-`"path"` aspectName would not match correctly.**

The correct dispatch key is `decl.mode` (always one of the 5 base modes), not the `aspectName` from `Object.entries`. Both `policy.ts` and `coverage.ts` must be updated to pass `decl.mode` to `matchAspect` and `matchAspectEach`. The current code in the working tree passes `aspectName` — this is a latent bug, identified by the plan's own reviewer (concern #9) and confirmed in the per-field-cardinality test suite. The test for `git_mv`'s `source` aspect passes only because the test's `**` / `*.env` patterns happen to match in both code paths.

## The mixed-cardinality test pattern

When the same aspect binds both scalar and array-mode fields, the matcher contributes one rule per binding to the running fold, and `most-restrictive wins`. The load-bearing regression test (in `policy.test.ts` under `describe("per-field aspect cardinality (FieldBinding)")`) covers three cases:

1. **Scalar cwd + array paths on a single aspect** — a ripgrep call with one `cwd` and several `paths`. Both fields bind to `path`. The scalar match fires on `cwd`; the array match fires per element of `paths`. The most-restrictive of all contributions wins.
2. **Multi-aspect on a single tool (git_mv shape)** — separate `source` (array-mode) and `destination` (scalar) aspects. Tests the case where `aspectName !== decl.mode` (see dispatch-key gotcha).
3. **Most-restrictive-wins across bindings** — the rule trail records one `applied` aspect-rule per binding, with the deny on `cwd` taking over from the allow on `paths`.

When writing a new mixed-cardinality test, use absolute paths and patterns that match in both the picomatch branch and the generic-regex fallback. A pattern like `**/*.env` works (matches in both); a pattern like `**/node_modules/**` does not (only matches in the picomatch branch). Tests that exercise the dispatch-key gotcha should pin the dispatch key to `decl.mode`.

## Other consumers of the `AspectDeclaration` shape

The `FieldBinding` refactor also touched (verify each when changing the shape):

- `tagging-rules.ts:78` — iterates `decl.fields` to extract the field names for the aspect-clause match. Uses `fieldName(binding)`.
- `directory-permissions.ts:170-180` — collects path-bound fields. Only `decl.mode === "path"` aspects apply. Iterates `decl.fields` via `fieldName(binding)`.
- `modal/ask-display.ts:130-165` (`readAspectValues`) — extracts values for the per-call display. `isArrayBinding` for array-mode, `coerceForMatch` for scalar.
- `modal/suggested-allow.ts:50-95` — builds the suggested allow-rule. `isArrayBinding` for per-element label and joined-value storage; scalar for single-coercion.
- `modal/policy-ask-modal.ts:157-180` (`computeAspectPrefill`) — prefill for the policy-ask modal. Same per-binding pattern.
- `tool-metadata.ts` (orphan check) — no longer normalizes `path[]` → `path`. After the refactor, `[]` is gone from the type, so the normalization is no-op noise. Compare against the built-in set as-is.
- `schemas/tool-policy.schema.json` (the JSON Schema) — `mode` enum is the 5-value `BaseAspectMode`; `fields.items` is `oneOf [string, { field, mode? }]`. The object form has `additionalProperties: false`.

## What this skill does not do

- It does not cover the v2 type contract, the single-pass matcher, the mode controller, or the directory-permissions guardrail — see `pi-tool-policy-mode-controller`.
- It does not cover the package overview — see `working-with-pi-tool-policy`.
- It does not cover the canonical `pi-*` package shape — see `pi-package-scaffold`.
- The dispatch-key gotcha is a real bug latent in the post-refactor working tree. The plan's reviewer flagged it (concern #9); the test suite does not yet cover the case. A follow-up commit must change `matchAspect` / `matchAspectEach` calls in `policy.ts:144` and `coverage.ts:64` to pass `decl.mode` instead of `aspectName`.
