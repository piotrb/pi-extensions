---
"@piotrb/pi-context-preloader": patch
"@piotrb/pi-git": patch
"@piotrb/pi-ripgrep": patch
"@piotrb/pi-task-runner": patch
"@piotrb/pi-tool-policy": patch
---

Apply code-review findings (see `./review-findings.md` and `./future-tasks.md`):

- **pi-context-preloader** — gate diagnostic `log()` calls behind `PI_CONTEXT_PRELOADER_DEBUG=1` so production runs are silent by default.
- **pi-git** — prefix `appendResultNote` strings with the tool name (`[git_commit: ...]`, `[git_push: ...]`) for parseability; refactor regex captures to named groups in `branch.ab` parsing; add fixture-driven tests for `parsePorcelainV2` covering paths with spaces and unmerged entries.
- **pi-ripgrep** — update package description to flag the planned `name: "grep"` migration; refactor regex captures to named groups in `renderLine`; export `renderLine` and add fixture-driven tests covering match lines, context lines, the U+2212 MINUS SIGN, the `--` separator, and colon-bearing paths.
- **pi-task-runner** — replace `spawnSync("which", ["rtk"])` with `spawnSync("rtk", ["--version"], { stdio: "ignore" })` for a single-process probe.
- **pi-tool-policy** — validate `regex`-aspect patterns at config-load time and surface invalid ones via the existing warnings pipeline; refactor `winningVerdict` cast in `policy.ts` to drop the `as unknown as Verdict`; extract a pure `pickRuleTypeReducer` from the rule-type submenu and add reducer tests.
