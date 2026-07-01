---
"@piotrb/pi-do-it-right": minor
---

Initial release. Auto-rejects bash tool calls that violate a user-supplied ruleset, evaluated in-process by `claude-haiku-4-5`. Reads rules from `~/.pi/agent/auto-reject-rules.md` (global) and `<cwd>/.pi/auto-reject-rules.md` (project). Strict fail-open on every error path. First-cut scope: rule evaluation pipeline only.
