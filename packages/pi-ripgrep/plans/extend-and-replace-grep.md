# Plan: Replace and extend the built-in `grep` tool

## Goal

Replace pi's built-in `grep` tool entirely rather than adding a parallel `ripgrep` tool.
The merged tool keeps everything the built-in does well, adds everything our extension does well,
and registers under the name `grep` so no user configuration change is required.

## What the built-in `grep` does well (keep)

- Runs `rg` via `ensureTool("rg", true)` — auto-downloads ripgrep if it is not installed.
  We currently require the user to have `rg` in PATH. Adopting `ensureTool` removes that friction.
- Parses `rg --json` output instead of plain text. This gives reliable structured access to
  file path, line number, and match text without any regex fragility on the output side.
- Context lines fetched by reading the source file directly, not by asking rg — this means
  context lines are always correct even when `--json` doesn't include them.
- Match-limit and byte-limit truncation with clear notices ("100 matches limit reached. Use limit=200").
  Our current implementation just cuts at `DEFAULT_VISIBLE_LINES` with less actionable messaging.
- `linesTruncated` notice when individual lines are too long.

## What our extension does well (keep)

- **`type`/`typeNot`** — search only `.ts` files, exclude `.json`, etc. The built-in has no type
  filtering whatsoever. This is the single most-used rg flag in practice.
- **Streaming** — output arrives as rg runs. The built-in collects everything then renders once.
  Streaming matters on large codebases.
- **Additional parameters**: `smartCase`, `wordRegexp`, `invertMatch`, `multiline`,
  `filesWithMatches`, `noLineNumber`, `maxCount`, `sortBy`, `hidden`, `noIgnore`, `followSymlinks`.
- **`beforeContext`/`afterContext`** (asymmetric) in addition to symmetric `context`.
- TUI `renderCall` with humanised rg invocation display.

## Implementation notes

### Registering as `grep`

Register with `name: "grep"` to shadow the built-in. Pi loads extension tools after core tools;
a same-name registration replaces the built-in in the tool list visible to the agent.
Verify this assumption against the pi extension API before finalising — if shadowing is not
supported, use `name: "grep"` with `pi.registerTool` and test whether the built-in is suppressed.

### Output approach: hybrid

Use `rg --json` for the base pass (reliable structured data), but keep our streaming model:
parse JSON lines as they arrive via `onLines`, accumulate `match` events, and call `onUpdate`
progressively. This gives both the reliability of `--json` and the streaming UX.

The current approach (`--color=never`, plain text, manual regex to parse `file:line:content`)
is fragile — in particular the `renderLine` regex can misparse paths containing colons.
Switch to `--json` to fix this entirely.

### Context lines

Adopt the core tool's approach: after collecting match positions from `--json`, read the
source files directly to extract context lines. This separates "finding matches" from
"rendering context" and removes the need to pass `-C/-A/-B` to rg at all (or alternatively,
keep passing them to rg but only for the `--json` context events, which are also structured).

### `ensureTool`

Import `ensureTool` from pi's internals or replicate its logic: check if `rg` is on PATH,
and if not, download a prebuilt binary to a local cache directory. The built-in already does
this — we should too rather than failing with "rg: command not found".

Check whether `ensureTool` is exported from `@earendil-works/pi-coding-agent` before using it.
If not, provide a graceful fallback: try PATH first, then emit a clear install hint.

### Truncation

Adopt the core tool's two-level truncation:

1. Match-count limit (default 100, user-overridable via `limit` param) — stops rg early.
2. Byte limit (~50 KB) — catches pathological cases where each match is large.

Our current `DEFAULT_VISIBLE_LINES = 30` is a presentation limit, not a match limit.
Keep the `ctrl+o to expand` UX but also add the match-count limit so the agent gets a
clear signal when results are incomplete.

### Parameters to add from the built-in

| Built-in param | Notes                                                                 |
| -------------- | --------------------------------------------------------------------- |
| `limit`        | Max matches, default 100. We currently have no hard match limit.      |
| `literal`      | Alias for `fixedStrings` — keep our name, built-in calls it `literal` |

### Parameters to keep from our extension (not in built-in)

`type`, `typeNot`, `smartCase`, `wordRegexp`, `invertMatch`, `multiline`,
`filesWithMatches`, `noLineNumber`, `maxCount`, `sortBy`, `hidden`, `noIgnore`,
`followSymlinks`, `beforeContext`, `afterContext`.

## Checklist

- [ ] Register as `name: "grep"`, verify built-in is replaced not duplicated
- [ ] Switch to `rg --json` output parsing
- [ ] Implement streaming over `--json` events
- [ ] Add `ensureTool` / graceful fallback
- [ ] Add match-count limit (`limit` param, default 100)
- [ ] Add byte-limit truncation
- [ ] Context lines via source file read (remove dependency on rg context flags for rendering)
- [ ] Keep streaming `onUpdate` calls
- [ ] Keep all type/advanced flag parameters
- [ ] Update `renderCall` to show `grep` not `rg` in the TUI
- [ ] Update description to say "replaces the built-in grep"
- [ ] Remove "Requires ripgrep to be installed" from docs (handled by ensureTool)
