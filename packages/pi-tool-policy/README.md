# `@piotrb/pi-tool-policy`

A pi extension that gates `tool_call` events against a mode-based permission policy.

## Install

```sh
npm install @piotrb/pi-tool-policy
```

Then add it to your `~/.pi/settings.json` extensions list (or the project's `.pi/settings.json`).

## Configuration

The extension reads two JSON files on every `tool_call`:

- `~/.pi/tool-policy.json` (user-level)
- `<cwd>/.pi/tool-policy.json` (project-level; project wins on key conflict)

See `schemas/tool-policy.schema.json` for the full JSON Schema. The minimum required shape:

```json
{
  "modeOrder": ["default", "plan"],
  "modes": {
    "default": {
      "description": "Permissive baseline",
      "defaultDecision": "ask",
      "tagRules": {},
      "toolRules": {},
      "aspectRules": {}
    }
  }
}
```

### Modes

A mode is a named permission profile. The active mode is the one whose verdict the matcher uses. The extension ships stock modes: `default`, `plan`, `edit`.

A mode has:

- `description: string` — shown in `/tool_policy`.
- `extends?: string[]` — deep-merge parents (cycles rejected at config-load).
- `defaultDecision: AnyVerdict` — fall-through verdict.
- `tagRules: Record<string, AnyVerdict>` — per-tag verdicts.
- `toolRules: Record<string, ToolRuleEntry[]>` — per-tool rule entries.
- `aspectRules: Record<string, AspectRule>` — per-aspect pattern map.
- `additionalInstructions?: { mode, text }` — system-prompt prose for the active mode.

`AnyVerdict` is either a bare `"allow" | "ask" | "deny"` or `{ verdict, reason? }`.

### Tags

Tools carry static tags from `toolMetadata`. Static + dynamic (from `taggingRules`) = the effective tag set. The default per-tool tags:

| Tool  | Tags      |
| ----- | --------- |
| read  | readonly  |
| write | mutating  |
| edit  | mutating  |
| grep  | readonly  |
| find  | readonly  |
| ls    | readonly  |
| bash  | execution |

### Tagger rules

Tagger rules augment the effective tag set at `tool_call` time:

```json
{
  "taggingRules": [
    {
      "tool": "bash",
      "fields": { "command": ["rm *", "chmod *"] },
      "action": { "type": "addTags", "tags": ["destructive"] }
    }
  ]
}
```

### Directory permissions

Top-level `allowedPaths` list. Paths outside `allowedPaths` (matched against the tool's effective tag set) trigger a tag-aware prompt. The user grants per-tag access; the grant lands in the in-memory session state. CWD is auto-added at `session_start` with `tags: []` (matches any tool).

## Usage

### Hotkey: `Alt+M`

Cycles the active mode. The status bar always shows `mode: <name> (Alt+M)`.

### `/tool_policy` slash command

Opens the mode switcher modal. One entry per mode in `modeOrder`; the current mode is highlighted (`●`). If the config produced any warnings (cycle, orphan aspect, etc.), a "Show N warnings" entry appears at the bottom.

### `additionalInstructions` injection

The active mode's `additionalInstructions.text` is appended to the LLM's system prompt on every agent turn (via `before_agent_start`). `mode: "append"` (default) or `mode: "replace"`.

## Development

```sh
pnpm install
pnpm run check
```

The check runs format, lint, typecheck, and test across all workspace packages. The per-package check is `pnpm turbo run typecheck test --filter=@piotrb/pi-tool-policy`.

## Architecture

See `.rpiv/guidance/packages/pi-tool-policy/architecture.md`.
