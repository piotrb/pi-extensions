import { describe, expect, it } from "vitest"

import type { DirectoryPromptArgs } from "../directory-permissions.ts"
import { buildDirectoryTitle, formatDirectoryPath } from "./directory-permissions-modal.ts"

describe("formatDirectoryPath", () => {
  it("renders cwd-relative and absolute forms together", () => {
    expect(formatDirectoryPath("/repo/src/foo.ts", "/repo")).toBe("`src/foo.ts` (`/repo/src/foo.ts`)")
  })

  it("uses '.' for the cwd itself", () => {
    expect(formatDirectoryPath("/repo", "/repo")).toBe("`.` (`/repo`)")
  })

  it("renders parent paths via '..'", () => {
    expect(formatDirectoryPath("/home", "/repo")).toBe("`../home` (`/home`)")
  })
})

describe("buildDirectoryTitle", () => {
  const baseArgs: DirectoryPromptArgs = {
    path: "/home/piotr/.pi/",
    cwd: "/repo",
    effectiveTags: ["readonly"],
    grantedTags: [],
  }

  it("renders the container path and tags", () => {
    const title = buildDirectoryTitle(baseArgs)
    // CWD is /repo, container is /home/piotr/.pi — the relative form climbs
    // 3 levels: repo → / → /home → /home/piotr.
    expect(title).toContain("Path: `../home/piotr/.pi` (`/home/piotr/.pi/`)")
    expect(title).toContain("Tool tags: readonly")
  })

  it("uses generic 'path' wording — not 'directory'", () => {
    expect(buildDirectoryTitle(baseArgs)).toContain("access a path outside the project")
  })

  it("shows the original path when the container differs from the request", () => {
    const title = buildDirectoryTitle({ ...baseArgs, originalPath: "/home/piotr/.pi/tool-policy.json" })
    expect(title).toContain("Original: `/home/piotr/.pi/tool-policy.json`")
  })

  it("omits the original line when the container IS the original", () => {
    const title = buildDirectoryTitle({ ...baseArgs, originalPath: baseArgs.path })
    expect(title).not.toContain("Original:")
  })

  it("omits the original line when no original is provided", () => {
    const title = buildDirectoryTitle(baseArgs)
    expect(title).not.toContain("Original:")
  })
})
