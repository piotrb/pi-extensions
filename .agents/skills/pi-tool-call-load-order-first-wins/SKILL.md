---
name: pi-tool-call-load-order-first-wins
description: When two or more pi extensions register a `tool_call` handler, the FIRST one to return `{ block: true }` wins — the runner short-circuits and never invokes the others. Use when designing, installing, or debugging gates that share the tool_call surface (e.g. do-it-right + pi-tool-policy).
---

# pi-tool-call load order: first block wins

When a project has two or more extensions whose `tool_call` handler can return `{ block: true }`, the **first one to block wins**. The runner walks handlers in extension-load order; once one returns a block, the rest are not invoked.

This is a pi-platform constraint, not a bug. The extension API does not expose a priority field for `tool_call` handlers. The order is determined by:

- Fileystem order within a scope.
- Scope order across scopes (project > user > global).

## When to Use

Lead with the symptom: "I installed two gate extensions and only one fires." Use this skill when:

- Combining `@piotrb/pi-do-it-right` (LLM-based verdict) with `@piotrb/pi-tool-policy` (default-deny rules) — or any two `tool_call` gates.
- Deciding where to install a new gate in `.pi/extensions/` vs `~/.pi/extensions/`.
- Debugging "my custom gate never seems to run."
- Picking the explicit `pi.extensions` array order in a consuming `package.json`.

## Key Facts

- **First-block-wins is a runner-level decision.** Not a bug in any individual extension. No extension can opt out of "running first" or "always last" from inside the extension.
- **Default install order: project scope loads after user scope.** Project-scoped extensions see tool calls AFTER user-scoped ones. If you want project-scope to win, that's automatic. If you want project-scope to NOT win against an upstream default-deny, you need to live with it.
- **The blocked command may have been allowed by the LLM gate**, but the upstream regex/pattern gate blocked it first. The user sees the upstream block, not the LLM's reasoning. This is a real UX gap — the more permissive gate never gets a vote.
- **Two extensions, opposite default postures** is the configuration that surfaces this. Default-deny (pi-tool-policy) + LLM-aware allow (do-it-right) is the canonical example.

## Steps

When you need a specific extension to fire first:

1. **Project scope vs user scope.** Install the extension that should run first in the **lower-priority** scope. Lower scope = loads first. If `do-it-right` should run before `pi-tool-policy`, install `do-it-right` in user scope and `pi-tool-policy` in project scope.
2. **Explicit `pi.extensions` array.** In the consuming project's `package.json`, list the desired extension first:
   ```json
   "pi": {
     "extensions": [
       "@piotrb/pi-do-it-right",
       "@piotrb/pi-tool-policy"
     ]
   }
   ```
3. **Test in the live session.** Extensions configured this way still need a session restart to take effect; order changes do not apply mid-session.

When you cannot control the order (e.g. the upstream default-deny is user-scoped and your custom gate is project-scoped), accept the limitation. The user is informed in the README; do not invent workarounds.

## Notes

- This skill is one-directional: it tells you how to influence load order. It does not tell you whether two gates SHOULD coexist — that's a design call.
- `pi-tool-policy`'s default-deny is generally stricter than an LLM-aware gate's verdict, so the practical impact is small: commands denied upstream would usually be denied downstream too. The visible difference is the user does not see the LLM's reasoning when the upstream fires first.
- Related: `pi-lifecycle-hooks` covers the general `tool_call` handler shape. The hook is the same; this skill is about the runner's dispatch order between hooks.
- Surfaced in the implementation of `pi-do-it-right` — see `packages/pi-do-it-right/README.md` "Load-order caveat" for the live example.
