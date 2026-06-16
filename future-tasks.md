# Future Tasks

Code-review findings deferred for later processing. Each entry carries the context, the rationale for deferral, and a concrete fix plan so the work can be picked up without re-deriving the design.

## Index

| ID  | Severity     | Package                                | Title                                                     |
| --- | ------------ | -------------------------------------- | --------------------------------------------------------- |
| B   | 🟡 Important | pi-{pfs,context-preloader,task-runner} | Test coverage gaps on tool extensions                     |
| G   | 🟡 Important | pi-tool-policy                         | `extractStringFields` ignores numbers/booleans (security) |

## B — Test coverage gaps on tool extensions

**Context:** Three extension test files still have the 2-line shape-only smoke test that was identified as "documentation, not verification":

| Package                | Test file                   | Status                                                    |
| ---------------------- | --------------------------- | --------------------------------------------------------- |
| `pi-pfs`               | `pfs.test.ts`               | ❌ 2-line shape smoke test                                |
| `pi-context-preloader` | `context-preloader.test.ts` | ❌ 2-line shape smoke test                                |
| `pi-task-runner`       | `task-runner.test.ts`       | ❌ 2-line shape smoke test                                |
| `pi-git`               | `git.test.ts`               | ✅ Already upgraded (10 new tests for `parsePorcelainV2`) |

The recent refactor upgraded `pi-ripgrep` and `pi-bfs` to real registration tests, and `pi-hackery` to a no-registration placeholder assertion. The 3 remaining files are inconsistent with the new pattern.

**Why deferred:** Each file's upgrade is mechanical but per-package — a single PR that updates all 3 is the right size. The 4th file (`pi-git`) was already upgraded in the review-fixes pass (added `parsePorcelainV2` tests for finding D).

**Fix plan:**

1. **`pi-pfs.test.ts`** — Assert the 4 tools are registered with names `["pfs_unlink", "pfs_rmdir", "pfs_cp", "pfs_mv"]`. Also assert that each tool's `parameters` has the expected top-level keys (`path` for unlink/rmdir, `source` + `destination` for cp/mv). Use a `Map<string, ToolDef>` keyed by tool name in the test so the assertions are order-independent.

2. **`pi-context-preloader.test.ts`** — Different shape: it uses lifecycle hooks (`session_start`, `resources_discover`, `before_agent_start`) and a `registerCommand`, not `registerTool`. Adapt the registration test to capture `pi.on` and `pi.registerCommand` calls, then assert `registerCommand` was called with name `"context-preload"` and the three hooks were registered.

3. **`pi-task-runner.test.ts`** — Assert the `run` tool is registered with name `"run"` and that the `parameters` schema has `cmd` (Type.Array of strings), `env` (optional record), and `cwd` (optional string). Assert that `registerCommand` was called with name `"runner-permission"` and name `"runner"`.

4. **Optional follow-up** — for each tool, also assert the description contains a "Prefer this over …" or similar use-this-not-that phrasing (to lock in the LLM guidance). Skip if too brittle.

## G — `pi-tool-policy` `extractStringFields` ignores numbers/booleans/objects (security-relevant)

**Context:** `packages/pi-tool-policy/src/extensions/tool-policy.ts:24-39` `extractStringFields` is used to **lock a runtime grant** to a specific (mode, tool, args) tuple. The function only captures `string` and `string[]` fields; numeric, boolean, and object fields are silently skipped.

If a tool input has a numeric `count: 5` field, the runtime grant for that tool will silently fail to constrain on `count` and will re-ask on a later call with a different count. A user clicking "Allow for this session" on a tool with a numeric field thinks they've locked the call to specific args but they haven't.

**Why deferred:** Two design questions need to be answered first:

1. **Should runtime grants constrain on non-string fields at all?** Some tools pass large structured objects (e.g. `mcp__tools__call` with an `arguments` object) where string-joining the object makes no sense.
2. **What does "lock" mean for booleans?** `String(true)` is `"true"`; that's well-defined, but is it what the user expects?

This is a security-relevant gap, but the right fix depends on UX decisions that should be made with the policy-ask modal designer (not just the matcher engineer). Defer until the modal design conversation happens.

**Fix plan:**

1. Decide on the contract: "runtime grants constrain on all primitive fields" vs "runtime grants constrain on string and number fields" vs "runtime grants constrain only on string-typed fields, with a modal warning when other fields exist".
2. If (1) is "all primitives" or "string + number", change `extractStringFields` to call `String(v)` for numbers and booleans, with a `JSON.stringify` fallback for objects. Update the modal's "Allow for this session" copy to reflect what the lock actually covers.
3. Add a test in `tool-policy.test.ts` that exercises a tool call with `count: 5` and verifies the runtime grant is granted with `fields: { count: "5" }`.
4. If (1) is "string-only with warning", add the modal warning and document the gap in the inline comments.
