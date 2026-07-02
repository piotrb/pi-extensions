---
title: pi-tool-policy per-field aspect cardinality (FieldBinding, dispatch loop, dispatch-key gotcha)
category: architecture
severity: high
tags:
  - pi-tool-policy
  - FieldBinding
  - AspectDeclaration
  - BaseAspectMode
  - isArrayBinding
  - fieldName
  - per-field
  - dispatch-key
  - matchAspect
  - matchAspectEach
  - decl.mode
  - decl.fields
  - latent-bug
applies_when:
  - changing the FieldBinding / AspectDeclaration shape in types.ts
  - iterating decl.fields in the matcher (policy.ts) or coverage (coverage.ts)
  - debugging a matcher decision where aspectName !== "path" and a path-mode aspect is producing surprising results
  - writing or extending a regression test for the per-field cardinality refactor
  - working in any of the 5 consumer files (tagging-rules, directory-permissions, ask-display, suggested-allow, policy-ask-modal)
  - updating the JSON Schema for toolMetadata
  - fixing the dispatch-key gotcha (passing decl.mode instead of aspectName to matchAspect)
---

# Problem

`pi-tool-policy` had a v1 → v2 refactor that moved aspect cardinality from the aspect level (the `mode: "path[]"` suffix) to the field level (`FieldBinding` with `mode: "scalar" | "array"` per binding). The refactor is mostly complete, but it has a **latent bug** in the dispatch-key path: the matcher passes the user-defined aspect name (e.g. `"source"` for `git_mv`'s `source` aspect) to `matchAspect` instead of `decl.mode`. For any aspect whose user-defined name is not one of the 5 base modes, the matcher falls through to the generic-regex fallback instead of the path-glob / URL-host / bash-word branch. The test suite happens to mask the bug because its patterns match in both code paths.

This solution covers the area skill for the per-field refactor. The v2 type contract, the single-pass matcher, the mode controller, and the directory-permissions guardrail are in `pi-tool-policy-mode-controller` (sibling area skill). The package overview is in `working-with-pi-tool-policy`. The canonical `pi-*` package shape is in `pi-package-scaffold`.

# Context

The v1 shape was `AspectDeclaration = { mode: "path" | "path[]" | ... | "regex[]"; fields: string[] }` where the `[]` suffix marked the whole aspect as array-mode. The current v2 shape is per-field: a single aspect can carry fields of mixed cardinality, and the `[]` suffix is gone. The refactor removed the choice between "all array" and "all scalar" — each binding decides for itself.

# Solution

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
        const field = fieldName(binding) // "path" or { field: "x" } → "x"
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

The path-glob branch only fires when `name === "path"`. The per-field loop iterates `meta.fields` and gets the user-defined aspect name (e.g. `"source"` for `git_mv`'s `source` aspect). If the loop passes that aspect name to `matchAspect`, a `source` aspect bound to `mode: "path"` falls through to the fallback generic-regex path, not the path picomatch path.

**A real-world `gitignore`-style pattern (e.g. `**/node_modules/**`) on a non-`"path"` aspectName would not match correctly.** The pattern compiles to a regex in the generic-regex fallback, but the regex form does not handle `**` (which picomatch expands to `.*/.*` with the directory-aware logic). A `git_mv` rule that tries to forbid moves into `**/node_modules/**` would not block the move because the fallback regex does not match the path.

**The correct dispatch key is `decl.mode` (always one of the 5 base modes), not the `aspectName` from `Object.entries`.** Both `policy.ts` and `coverage.ts` must be updated to pass `decl.mode` to `matchAspect` and `matchAspectEach`. The current code in the working tree passes `aspectName` — this is a latent bug, identified by the plan's reviewer (concern #9) and confirmed in the per-field-cardinality test suite.

**The fix is two line changes**: in `policy.ts:144` and `coverage.ts:64`, replace the `aspectName` argument to `matchAspect` / `matchAspectEach` with `decl.mode`. Add a regression test that pins the dispatch key to `decl.mode` (use absolute paths and a pattern that matches in only one of the two branches, e.g. `**/node_modules/**` which only matches in the picomatch branch).

**Why the test suite masks the bug**: the existing per-field-cardinality tests use patterns like `**` and `*.env` that happen to match in both the picomatch branch and the generic-regex fallback. A test that uses a path-glob-only pattern (e.g. `**/node_modules/**`) on a non-`"path"` aspectName would fail before the fix and pass after.

## The mixed-cardinality test pattern

When the same aspect binds both scalar and array-mode fields, the matcher contributes one rule per binding to the running fold, and `most-restrictive wins`. The load-bearing regression test (in `policy.test.ts` under `describe("per-field aspect cardinality (FieldBinding)")`) covers three cases:

1. **Scalar cwd + array paths on a single aspect** — a ripgrep call with one `cwd` and several `paths`. Both fields bind to `path`. The scalar match fires on `cwd`; the array match fires per element of `paths`. The most-restrictive of all contributions wins.
2. **Multi-aspect on a single tool (git_mv shape)** — separate `source` (array-mode) and `destination` (scalar) aspects. Tests the case where `aspectName !== decl.mode` (see dispatch-key gotcha).
3. **Most-restrictive-wins across bindings** — the rule trail records one `applied` aspect-rule per binding, with the deny on `cwd` taking over from the allow on `paths`.

When writing a new mixed-cardinality test, use absolute paths and patterns that match in both the picomatch branch and the generic-regex fallback. A pattern like `**/*.env` works (matches in both); a pattern like `**/node_modules/**` does not (only matches in the picomatch branch). **Tests that exercise the dispatch-key gotcha should pin the dispatch key to `decl.mode`** — write a test that fails on `aspectName` and passes on `decl.mode` to catch the regression.

## Other consumers of the `AspectDeclaration` shape

The `FieldBinding` refactor also touched (verify each when changing the shape):

- `tagging-rules.ts:78` — iterates `decl.fields` to extract the field names for the aspect-clause match. Uses `fieldName(binding)`.
- `directory-permissions.ts:170-180` — collects path-bound fields. Only `decl.mode === "path"` aspects apply. Iterates `decl.fields` via `fieldName(binding)`.
- `modal/ask-display.ts:130-165` (`readAspectValues`) — extracts values for the per-call display. `isArrayBinding` for array-mode, `coerceForMatch` for scalar.
- `modal/suggested-allow.ts:50-95` — builds the suggested allow-rule. `isArrayBinding` for per-element label and joined-value storage; scalar for single-coercion.
- `modal/policy-ask-modal.ts:157-180` (`computeAspectPrefill`) — prefill for the policy-ask modal. Same per-binding pattern.
- `tool-metadata.ts` (orphan check) — no longer normalizes `path[]` → `path`. After the refactor, `[]` is gone from the type, so the normalization is no-op noise. Compare against the built-in set as-is.
- `schemas/tool-policy.schema.json` (the JSON Schema) — `mode` enum is the 5-value `BaseAspectMode`; `fields.items` is `oneOf [string, { field, mode? }]`. The object form has `additionalProperties: false`.

# Why this works

- **Per-field cardinality is the right abstraction.** A single aspect that carries fields of mixed cardinality (e.g. scalar `cwd` + array `paths`) used to force an all-or-nothing choice. The per-field `FieldBinding` removes the choice and makes the matcher's behavior more predictable.
- **The helpers `isArrayBinding` and `fieldName` are the entry points.** The v1 helpers `isArrayMode` and `baseMode` are gone. Code that references v1 helpers needs to migrate.
- **The dispatch loop is per-binding, not per-aspect.** Each binding contributes one rule to the running fold. Most-restrictive wins across all bindings on the aspect. The fold is the load-bearing part.
- **The mixed-cardinality test pattern is the regression contract.** The four test cases (scalar + array, multi-aspect, most-restrictive-wins, brace-expansion dispatch-key) cover the behavior changes from the refactor. Future changes to the dispatcher must keep all four green.
- **The dispatch-key contract is pinned by the brace-expansion regression test.** The matcher dispatches on `decl.mode`, not the user-defined aspect name. The test (`**/{node_modules,.git}/**` bound to a `source` aspect of `mode: "path"`) flips to failing if the dispatch key reverts to `aspectName`.

# Prevention

- **Do not reference v1 types.** The `mode: "X[]"` suffix, the `isArrayMode` / `baseMode` helpers, and the `coerceForMatch(value, aspectName)` signature are all v1. The v2 contract is the only contract.
- **Do not iterate `decl.fields` as a single `string[]`.** The new shape is `FieldBinding[]`, not `string[]`. Use `fieldName(binding)` to extract the field name from each binding.
- **Do not check `Array.isArray(value)` on the wrong side of the loop.** The array-vs-scalar check is per-binding (`isArrayBinding(binding)`), not per-value. The matcher decides per-binding which value shape to expect.
- **Do not use the user-defined aspect name as the dispatch key.** The `matchAspect` `name` parameter should be `AspectDeclaration.mode` (one of the 5 base modes), not the user-defined aspect name from `Object.entries(meta.fields)`. Using the user-defined name falls through to the generic-regex branch for any non-base-mode name. The brace-expansion regression test pins this contract.
- **Do not add `path[]` (or any `[]`) to the JSON Schema enum.** The `mode` enum is the 5-value `BaseAspectMode`. The `[]` suffix is gone.
- **Do not add a normalizer to the orphan check.** Pre-refactor, the orphan check normalized `path[]` → `path` to bridge between the v1 suffix and the aspect name. Post-refactor, the suffix is gone, so the normalization is no-op noise.
- **Do not write a mixed-cardinality test that pins the dispatch key to `aspectName`.** Such a test would mask the dispatch-key contract. Pin to `decl.mode` (or use a pattern that fails in the fallback path, like `**/{node_modules,.git}/**`).
- **Do not skip the multi-aspect test case.** The `git_mv` shape (separate `source` and `destination` aspects) is the case where `aspectName !== decl.mode`. The brace-expansion regression test catches a dispatch-key regression.

# Known issues

_None. The dispatch-key fix has landed in `policy.ts:184,192` and `coverage.ts:64,72`; the brace-expansion regression test pins the contract._

# Related

- `pi-tool-policy-mode-controller` — the v2 type contract, the single-pass matcher, the mode controller, and the directory-permissions guardrail. Sibling area skill.
- `working-with-pi-tool-policy` — the package overview, including the four event handlers, the cross-cutting state table, and the lifecycle.
- `pi-package-scaffold` — the canonical `pi-*` package shape; the JSON Schema is part of the package.
- `pi-package-hard-rules` — the cross-cutting invariants for any `pi-*` package; the `FieldBinding` shape is a load-bearing contract that should be tested.
