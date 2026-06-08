# pfs

Pi extension: project filesystem tools for basic file operations.

## Install

```sh
pnpm add pfs
```

Exposes tools: `pfs_unlink`, `pfs_rmdir`, `pfs_cp`, `pfs_mv`. All operations are scoped to the project root — absolute paths are rejected.

## Development

```sh
pnpm install
pnpm run check  # typecheck + lint + test
```
