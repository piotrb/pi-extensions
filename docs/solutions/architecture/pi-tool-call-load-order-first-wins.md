---
title: pi-tool-call load order — first block wins
category: architecture
severity: high
tags:
  - pi-runtime
  - tool-call
  - extension-dispatch
  - gates
  - load-order
applies_when:
  - designing two or more extensions in this repo that both register a tool_call handler
  - installing this repo's gates (pi-do-it-right, pi-tool-policy) alongside another gate
  - debugging "I installed two gate extensions and only one fires"
  - picking the explicit pi.extensions array order in a consuming project's package.json
  - deciding where to install a new gate in .pi/extensions/ vs ~/.pi/extensions/
---

# Problem

When a project in this repo installs two or more extensions whose `tool_call` handler can return `{ block: true }`, the **first one to block wins**. The runner walks handlers in extension-load order; once one returns a block, the rest are not invoked. The other gate never gets a vote — the user sees the upstream block, not the LLM's reasoning from the more permissive gate.

The canonical instance in this repo is `pi-do-it-right` (LLM-aware verdict) combined with `pi-tool-policy` (default-deny regex/pattern rules). When a command is allowed by `pi-do-it-right` but blocked upstream by `pi-tool-policy`, the user sees the upstream block. The LLM's reasoning is hidden. This is a real UX gap — the configuration that surfaces it is exactly the configuration the repo encourages (one default-deny + one LLM-aware allow).

# Context

This repo builds two gate extensions: `pi-do-it-right` (LLM-evaluated rules, user-mutable) and `pi-tool-policy` (default-deny regex/pattern rules, project-config). Both register a `tool_call` handler that can return `{ block: true }`. When both are loaded, the runner's dispatch order determines which one fires first.

This is a pi-platform constraint, not a bug in either extension. The extension API does not expose a priority field for `tool_call` handlers. The order is determined by:

- Filesystem order within a scope.
- Scope order across scopes (project > user > global).

The constraint applies whenever two gates are installed together. The repo's pair is the canonical example; the same constraint binds any combination of `pi-do-it-right` + another gate, or any two extensions in any project.

# Solution

To influence which extension fires first, you have two levers, both in the consumer project's setup:

1. **Project scope vs user scope.** Project-scoped extensions load after user-scoped ones. If you want project-scope to win, that's automatic. If you want project-scope to NOT win against an upstream default-deny (e.g. `pi-do-it-right` is project-scoped but `pi-tool-policy` is upstream), install the one that should run first in the **lower-priority** scope (user-scope for `pi-do-it-right`, project-scope for `pi-tool-policy`).
2. **Explicit `pi.extensions` array.** In the consuming project's `package.json`, list the desired extension first:
   ```json
   "pi": {
     "extensions": [
       "@piotrb/pi-do-it-right",
       "@piotrb/pi-tool-policy"
     ]
   }
   ```

Test in a live session. Extensions configured this way still need a session restart to take effect; order changes do not apply mid-session.

# Why this works

- **First-block-wins is a runner-level decision.** No extension can opt out of "running first" or "always last" from inside the extension. The fix is at the install/config layer, not in extension code.
- **Default install order: project scope loads after user scope.** This is the platform's documented scope order. Project-scoped extensions see tool calls AFTER user-scoped ones. If your project-scoped gate is the one you want to win, that's automatic; if not, the lever is to install it in user scope.
- **The blocked command may have been allowed by the LLM gate**, but the upstream regex/pattern gate blocked it first. The user sees the upstream block, not the LLM's reasoning. This is a real UX gap, not a bug in either extension. Accept the limitation when you cannot control the order.
- **Two extensions with opposite default postures** is the configuration that surfaces this. Default-deny (`pi-tool-policy`) + LLM-aware allow (`pi-do-it-right`) is the canonical example. The visible difference is the user does not see the LLM's reasoning when the upstream fires first.

# Prevention

- **When designing two gates in this repo**, document the load-order behavior in the README. The user should not have to discover the constraint by debugging "my custom gate never seems to run." Surface it in the installation instructions.
- **For the canonical pair (`pi-do-it-right` + `pi-tool-policy`)**: `pi-tool-policy`'s default-deny is generally stricter than `pi-do-it-right`'s LLM verdict. Commands denied upstream would usually be denied downstream too. The practical impact of the order is small — the user doesn't see the LLM's reasoning, but the LLM wouldn't have allowed the command anyway. Document this in the README so users understand why the order matters less than they expect.
- **Reference implementation: `pi-do-it-right`.** See `packages/pi-do-it-right/README.md` "Load-order caveat" for the live example. The convention: surface the constraint in the extension's README, with the install instructions for the canonical pair.
- **Related: `pi-lifecycle-hooks`** covers the general `tool_call` handler shape. The hook is the same; this solution is about the runner's dispatch order between hooks, not the hook contract.
- **When you cannot control the order** (e.g. the upstream default-deny is user-scoped and your custom gate is project-scoped), accept the limitation. Do not invent workarounds. The user is informed; the constraint is documented.
