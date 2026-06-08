# context-preloader

Pi extension: automatically pre-load files referenced with `@path` syntax in `AGENTS.md` into the system prompt.

## Install

```sh
pnpm add context-preloader
```

Recursively resolves `@refs` found inside loaded files up to 5 levels deep. Deduplicates across the full resolution tree — a file is only injected once even if referenced from multiple places.

## Usage

Reference files in `AGENTS.md` using `@path` syntax:

```
@./src/lib/utils.ts
@./docs/api.md
```

Use `/context-preload` to show the dependency tree.

## Development

```sh
pnpm install
pnpm run check  # typecheck + lint + test
```
