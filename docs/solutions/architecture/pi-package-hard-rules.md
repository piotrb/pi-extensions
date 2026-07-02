---
title: pi-* package hard rules
category: architecture
severity: high
tags:
  - pi-package
  - hard-rules
  - conventions
  - invariants
applies_when:
  - scaffolding a new pi-* package (read this before mirroring a peer)
  - auditing an existing pi-* package for convention violations
  - wondering why a per-package tsconfig doesn't have compilerOptions
  - debugging a workspace symlink that should be a real dep
  - deciding whether a pi-* package can be safely published
---

# Problem

Every `pi-*` package in this workspace must follow a set of non-negotiable rules — the invariants that keep the toolchain, the publishing flow, and the runtime consistent. These rules apply regardless of whether you're scaffolding a new package, auditing an existing one, or just touching a file. Without a single reference for what the rules are and why, every package-level decision becomes a fresh investigation.

# Context

The rules exist because the workspace has invariants the runtime and the toolchain depend on: the toolchain assumes `compilerOptions` live in the base, the publishing flow assumes no `index.ts` re-exports, the runtime assumes imports use the right package names, the workspace symlink assumes `pi-extension-utils` is also published. Violating any of these rules breaks something downstream — sometimes silently, sometimes with a hard failure that's hard to diagnose.

# Solution

These rules apply to every `pi-*` package in this workspace. They are non-negotiable; do not deviate even if the peer package you are mirroring appears to.

- **Imports.** Use `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` — never the old `@mariozechner/*`.
- **No `compilerOptions` in per-package tsconfig.** The base is the canonical home; adding `compilerOptions` to a per-package tsconfig silently shadows the base. See `pi-extension-toolchain` for the toolchain side.
- **No barrel/index.ts.** Extensions are listed in `package.json`'s `pi.extensions` directly. Do not create an `index.ts` re-export.
- **Internal cross-package deps use `workspace:*`.** E.g. `pi-extension-utils: "workspace:*"` in a consumer's `dependencies`. The `workspace:*` symlink is dev-only — see the next rule.
- **`pi-extension-utils` must be published to npm as a runtime dep.** If a package consumes `pi-extension-utils` via `workspace:*`, that package must also be published to npm. The dev symlink does not satisfy a prod install.
- **`.ts` keeps its extension on local imports.** pi's jiti handles resolution; `allowImportingTsExtensions` makes tsc accept them. Do not strip `.ts` in imports.
- **Trim `peerDependencies` to actual imports.** `pi-context-preloader` does not need `@earendil-works/pi-tui` or `typebox`. A package with no source has no runtime peerDeps; devDeps can be `@types/node`, `typescript`, `vitest` only.
- **Co-located tests.** `<name>.test.ts` next to source, not in `__tests__/` or a separate `tests/` directory.
- **`files` allowlist.** `["src/**/*.ts", "!src/**/*.test.ts", "README.md"]`. The `plans/` directory is automatically excluded. `pi-tool-policy` adds `schemas/**/*.json` for its JSON Schema; copy that only if your package ships schemas.
- **All packages `private: true` or `publishConfig.access: "public"`** for publishing. The `private: true` flag is the signal that the package is workspace-internal and not published.
- **Use `pfs_*` for filesystem operations from the agent loop.** Prefer `pfs_mv`, `pfs_cp`, `pfs_unlink`, `pfs_rmdir` over bash equivalents. Use `git_mv` only when git must track the rename in the index.

# Why this works

- **The rules cluster around three invariants:**
  1. **Toolchain invariants:** the `tsconfig.base.json` is canonical; the `compilerOptions` belong there. `noEmit` means no build step; the runtime is jiti. The toolchain is one config, not per-package. (See `pi-extension-toolchain` for the toolchain side.)
  2. **Publishing invariants:** `pi-extension-utils` must be published to npm because the workspace symlink is dev-only. A package that depends on `pi-extension-utils` without publishing itself is broken at install time. The `files` allowlist and the `private: true` flag are the publishing-flow invariants.
  3. **Runtime invariants:** imports use the right package names (`@earendil-works/pi-coding-agent`, not `@mariozechner/*`). `pi.extensions` lists tools directly; no `index.ts` re-export. `.ts` keeps its extension on local imports because jiti handles it. These are the runtime-side conventions.
- **Violating a rule breaks something downstream.** A package with `compilerOptions` in its tsconfig shadows the base silently — the workspace check passes locally, fails in CI. A package that depends on `pi-extension-utils` via `workspace:*` but doesn't publish itself is broken at consumer install time. A package with an `index.ts` re-export has its tools registered twice (once via the barrel, once via `pi.extensions`), causing runtime confusion.

# Prevention

- **Audit a package against this list whenever you touch it.** The rules are not optional. If a peer package you are mirroring appears to violate a rule, the peer is wrong, not the rule.
- **When the rules and the peer conflict, the rules win.** If `pi-tool-policy`'s `package.json` has a field the other peers don't, that field is `pi-tool-policy`-specific — do not propagate. If a peer's `tsconfig.json` has `compilerOptions`, the peer is wrong (it should just be `extends` + `include`); the new package should be `extends` + `include` and the peer should be fixed separately.
- **Read the related solutions first** when working in or on a `pi-*` package:
  - `pi-extension-toolchain` for the toolchain side (tsconfig, ESLint, Prettier, Turbo).
  - `pi-monorepo-overview` for the project map and command set.
  - `pi-package-scaffold` for the how-to-scaffold procedure.
  - `pi-hackery-folder-layout` for the one package (`pi-hackery`) with a non-flat layout.
  - `working-with-pi-<name>` for the specific package's working rules.
- **This solution does not cover the how-to-scaffold procedure.** See `pi-package-scaffold` for peer selection, file mirroring, and the empty-package case. The hard rules are the invariants; the scaffold is the procedure.
