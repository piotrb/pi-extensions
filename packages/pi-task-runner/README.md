# task-runner

Pi extension: safer, structured replacement for the bash tool with permission rules.

## Install

```sh
pnpm add task-runner
```

Commands are validated against an allowlist before execution. Configure rules via `runner.json`:

```json
{
  "rules": {
    "pnpm run *": "allow",
    "git * --dry-run": "allow",
    "rm *": "deny"
  }
}
```

Config files (merged in order, project wins):

- `~/.pi/agent/runner.json`
- `~/.pi/runner.json`
- `<cwd>/.pi/runner.json`

## Commands

- `/runner` — Open the runner settings UI
- `/runner-permission list` — List all permission rules
- `/runner-permission allow [--user|--global] <pattern>` — Add allow rule
- `/runner-permission deny [--user|--global] [--remove] <pattern>` — Manage deny rules

## Development

```sh
pnpm install
pnpm run check  # typecheck + lint + test
```
