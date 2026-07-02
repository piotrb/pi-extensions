---
title: working with pi-tool-policy
category: architecture
severity: high
tags:
  - pi-tool-policy
  - tool-call
  - permissions
  - modes
  - directory-grants
  - tagging
applies_when:
  - working on, depending on, or evaluating the pi-tool-policy package
  - adding a new mode, aspect kind, or rule to pi-tool-policy
  - debugging a tool_call block or mode cycle in pi-tool-policy
  - reading the package's source to understand a specific behavior
---

# Problem

`pi-tool-policy` is the tool-call gate for this workspace. It enforces a mode-based permission policy on every tool invocation, gates paths against a directory-permissions allowlist, and augments the LLM's effective tag set. Without a single reference for the package's invariants, the agent re-implements policies the matcher already enforces, or worse, the agent adds a "small" behavior change that breaks the most-restrictive-wins combine.

# Context

`pi-tool-policy` is the most complex extension in the workspace after `pi-task-runner`. It runs as a `tool_call` handler in the pi extension loop, with mode state, directory-grant state, and tool-metadata registry all held in closure variables for the session. The 4-layer pipeline (tagger → directory-permissions → matcher → mode controller) is the load-bearing shape; modifying it without understanding the combine is how bugs land.

# Solution

## What the package does

A pi extension that gates `tool_call` events against a mode-based permission policy. Every tool invocation passes through:

- **Tagger rules** — augment the effective tag set at `tool_call` time.
- **Directory-permissions guardrail** — prompt the user for any path that escapes `allowedPaths`. In-memory session state.
- **Per-mode single-pass matcher** — fold `tagRules` + `aspectRules` + `toolRules` into a single most-restrictive-wins verdict (`deny > ask > allow`).
- **Mode controller** — cycles modes via hotkey (`Alt+M`) or `/tool_policy` slash command. Injects `additionalInstructions` into the LLM's system prompt.

## Core rules

- **Config is hot-reloaded on every `tool_call`** — no cache, no mtime, no watcher. The reload is cheap (~1ms on SSD); do not add caching layers.
- **Tool metadata is structural** — built once on `session_start` and cached for the session. Do not rebuild per turn.
- **The matcher is a single pass per mode** — there is no layer ordering within a mode. All applicable rules are folded in one pass.
- **Most-restrictive-wins combine** — `deny > ask > allow`. `undecided` collapses to `ask` (fail-closed).
- **Tags match by exact set membership** — no globs for tags. Globs are only for the `tool` field in tagger rules.
- **Directory grants are session-scoped** — the CWD auto-grant is the only persistent grant. After session end, all grants reset.
- **Deny is non-persistent** — the directory-permissions modal does not record denials; the next request for the same path asks again.
- **YOLO mode is an emergency escape** — see `YOLO_MODE` in `src/lib/types.ts`. It is **not user-configurable**; it lives in code as a synthetic mode that bypasses all checks. Use it only when a `pi-tool-policy` bug is blocking the agent.

## Module structure

```
packages/pi-tool-policy/
  src/
    extensions/
      tool-policy.ts                      # hotkey, /tool_policy command, tool_call gate, before_agent_start, session_start
      tool-policy.test.ts                 # smoke test
    lib/
      types.ts                            # all v2 types
      aspects.ts                          # matchAspect() — path/url/bash/glob/regex matchers
      policy.ts                           # single-pass per-mode fold
      permission-config.ts                # loadConfig() with deep-merge + cycle detection
      tool-metadata.ts                    # aggregateToolMetadata() — built-in + package.json + config
      tagging-rules.ts                    # applyTaggerRules() — augments effective tag set
      directory-permissions.ts            # DirectoryPermissionsState + checkAndPrompt()
      mode-controller.ts                  # ModeController — cycle, setMode, additionalInstructions
      modal/
        directory-permissions-modal.ts    # tag-aware prompt + custom-path sub-modal
        tool-policy-modal.ts              # mode switcher + warnings viewer
  schemas/
    tool-policy.schema.json               # JSON Schema 2020-12 for the new config
```

The package has a `src/lib/` sub-tree (like `pi-task-runner`) and a nested `src/lib/modal/` sub-tree. It also ships a JSON Schema for the config format.

## Lifecycle

| Phase                | Trigger               | What                                                                                                                                                           |
| -------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`      | session start/load    | `aggregateToolMetadata()`, `directoryState.reset(ctx.cwd)` (adds CWD auto-grant), `modeController.reset(config)`, `modeController.refreshStatusBar(ctx)`       |
| `before_agent_start` | agent turn            | `modeController.buildAdditionalInstructions(config)` → `{ systemPrompt: base + section }`                                                                      |
| `tool_call`          | every tool invocation | 1. `applyTaggerRules()` augments tags. 2. `checkAndPrompt()` validates paths. 3. `evaluate()` per-mode matcher. 4. Returns `{ block, reason }` or `undefined`. |
| `Alt+M`              | hotkey                | `modeController.cycleMode(config)` + `refreshStatusBar` + notify.                                                                                              |
| `/tool_policy`       | slash command         | Open mode switcher modal; on select, `modeController.setMode()`.                                                                                               |

## State lifetimes

| State                        | Lifetime    | Storage                             | Reset trigger               |
| ---------------------------- | ----------- | ----------------------------------- | --------------------------- |
| `loadConfig` result          | per-call    | re-read on every `tool_call`        | n/a (no cache)              |
| `toolMetadata` registry      | per-session | closure variable in extension entry | `session_start`             |
| `DirectoryPermissionsState`  | per-session | closure variable in extension entry | `session_start` (CWD added) |
| `ModeController.currentMode` | per-session | closure variable in extension entry | `session_start` (default)   |
| `ModeController.warnings`    | per-session | closure variable in extension entry | `session_start`             |

## Dependencies

- **Outbound:** `@piotrb/pi-extension-utils` (`genericPatternToRegex`), `picomatch`.
- **Inbound:** pi-runtime. The `tool_call` handler is the gate; no other package consumes it.
- **Peer deps:** `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.

# Why this works

- **The 4-layer pipeline maps to phases.** Tagger runs first to enrich the tag set; directory-permissions validates paths against the augmented tags; the matcher combines per-mode rules; the mode controller owns the cycle. Each layer has one job; the combine is the only place rules interact.
- **Most-restrictive-wins with fail-closed `undecided`** — `deny > ask > allow` is the order. `undecided` collapses to `ask` (the user gets a prompt) rather than `allow` (the tool runs unchecked). The combine is the safety net.
- **Hot-reload on every `tool_call`** is the right call. Config is small (JSON), reload is ~1ms, and any caching layer introduces a window where a user's edited config doesn't take effect. The cost of "do not add caching" is enforced by the design.

# Prevention

- **Do not add caching to the `loadConfig` path.** Hot-reload is the design. If a perf problem motivates caching, fix the perf problem; don't add a cache.
- **Do not promote `undecided` to a deny at the matcher level.** The combine is `deny > ask > allow`; `undecided` collapses to `ask` (fail-closed at the next layer). The user gets a prompt, not a silent block.
- **Do not add globs to tag matching.** Tags match by exact set membership. Globs are only for the `tool` field in tagger rules.
- **Do not persist `deny` verdicts across sessions.** The directory-permissions modal does not record denials. The next request for the same path asks again.
- **Do not make `YOLO_MODE` user-configurable.** It is a code-level emergency escape. User configuration would defeat the purpose.
- **When adding a new mode**: add to `STOCK_CONFIG` in `src/lib/permission-config.ts` or to the user's `~/.pi/tool-policy.json`; update the JSON Schema; add tests for `defaultDecision`, `tagRules`, `toolRules`, `aspectRules`; run typecheck+test.
- **When adding a new aspect kind** (path/url/bash/glob/regex): add to the `matchAspect` dispatch in `src/lib/aspects.ts`; update the JSON Schema's `aspect` enum; add unit tests in `aspects.test.ts`.
- **The mode controller, the matcher, and the aspect kinds are deep** — see `pi-tool-policy-mode-controller` (the area skill) for the details.
- **This solution does not cover the canonical `pi-*` package shape** — see `pi-package-scaffold` and `pi-package-hard-rules`.
