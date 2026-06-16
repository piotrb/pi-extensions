---
"@piotrb/pi-tool-policy": patch
---

Directory guardrail classifies the path-aspect value via `stat` and asks for the **parent directory** when the tool's path is a file (or doesn't exist). Previously, a tool requesting `../../.pi/tool-policy.json` would prompt for the file itself, which is the wrong unit of permission — the file is a member of its parent directory, and creating/modifying it requires write access to the directory.

- `classifyPath(absPath)` returns `"directory" | "file" | "missing"`. `file` and `missing` both map to `dirname(absPath)` because in both cases the user wants to create or modify something at that location, which requires the parent's write permission.
- `absPaths` is deduplicated by container. A tool referencing `/a/x.txt` and `/a/y.txt` now produces one prompt for `/a/`, not two.
- `DirectoryPromptArgs.originalPath` is set whenever the container differs from the raw tool request. The modal's `buildDirectoryTitle` renders an extra `Original: <path>` line so the user sees both the granted path and the path that triggered the request.
- Title wording changed from "access a directory outside the project" to "access a path outside the project" (the prior wording was inaccurate when the path was a file).
- TOCTOU is benign: `stat` only picks which path to prompt for. The parent directory is the correct grant whether the file exists at stat time, at exec time, or only at one of them.
- 5 new tests in `directory-permissions.test.ts` use `mkdtemp` + `writeFile` to exercise real files and cover: file → parent, directory → itself, missing → parent, multi-file dedup, file under pre-granted directory. New `modal/directory-permissions-modal.test.ts` covers `formatDirectoryPath` and the `originalPath` suffix in the title.
