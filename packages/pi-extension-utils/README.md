# extension-utils

Shared utilities for pi extensions.

## Install

```sh
pnpm add extension-utils
```

## Exports

- `spawnStreaming(bin, args, options)` — Spawn a subprocess, stream stdout+stderr as accumulated lines
- `progressiveKill(child, termDelayMs?, killDelayMs?)` — Graceful process termination (SIGINT → SIGTERM → SIGKILL)
- `scheduleProcessTimeout(ms, child, onTimeout)` — Schedule a timeout for a child process

## Usage

```typescript
import { spawnStreaming } from "extension-utils"

const result = await spawnStreaming("rg", ["--color=never", "pattern", "."], {
  cwd: process.cwd(),
  signal: abortController.signal,
  notFoundHint: "brew install ripgrep",
})
```

## Development

```sh
pnpm install
pnpm run check  # typecheck + lint + test
```
