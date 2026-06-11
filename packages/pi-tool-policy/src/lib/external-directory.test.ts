import { describe, expect, it } from "vitest"

import { ExternalDirectoryState } from "./external-directory.ts"

describe("ExternalDirectoryState", () => {
  const cwd = "/repo"

  it("does NOT prompt for paths inside cwd", () => {
    const state = new ExternalDirectoryState()
    expect(state.shouldPrompt("/repo/src/foo.ts", cwd)).toBe(false)
  })

  it("does NOT prompt for the cwd itself", () => {
    const state = new ExternalDirectoryState()
    // Edge case: path === cwd. relative("/repo", "/repo") === "" which
    // does not start with ".." and is not absolute — so isInside is true.
    expect(state.shouldPrompt("/repo", cwd)).toBe(false)
  })

  it("does NOT prompt for a nested child of cwd", () => {
    const state = new ExternalDirectoryState()
    expect(state.shouldPrompt("/repo/a/b/c", cwd)).toBe(false)
  })

  it("prompts for paths outside cwd", () => {
    const state = new ExternalDirectoryState()
    expect(state.shouldPrompt("/etc/passwd", cwd)).toBe(true)
  })

  it("prompts for a sibling directory of cwd", () => {
    const state = new ExternalDirectoryState()
    // /other is a sibling of /repo — rel is "../other" which starts with ".."
    expect(state.shouldPrompt("/other/file.ts", cwd)).toBe(true)
  })

  it("prompts for the parent of cwd", () => {
    const state = new ExternalDirectoryState()
    // rel of "/" against "/repo" is "../" — outside.
    expect(state.shouldPrompt("/", cwd)).toBe(true)
  })

  it("record + get: pre-approved paths skip the prompt", () => {
    const state = new ExternalDirectoryState()
    state.record("/etc/passwd", "allow")
    expect(state.shouldPrompt("/etc/passwd", cwd)).toBe(false)
    expect(state.get("/etc/passwd")).toEqual({ decision: "allow" })
  })

  it("record + get: pre-approved deny is also retrievable", () => {
    const state = new ExternalDirectoryState()
    state.record("/etc/passwd", "deny")
    expect(state.get("/etc/passwd")).toEqual({ decision: "deny" })
    // The decision is recorded but shouldPrompt still returns false
    // (no re-prompt for an already-decided path) — the engine will read
    // the decision via get() and apply it.
    expect(state.shouldPrompt("/etc/passwd", cwd)).toBe(false)
  })

  it("stores normalizedPath for the 'customize the path' feature", () => {
    const state = new ExternalDirectoryState()
    state.record("/etc/passwd", "allow", "/repo/etc/passwd")
    expect(state.get("/etc/passwd")?.normalizedPath).toBe("/repo/etc/passwd")
  })

  it("does NOT prompt a different path that was NOT pre-approved", () => {
    const state = new ExternalDirectoryState()
    state.record("/etc/passwd", "allow")
    expect(state.shouldPrompt("/etc/shadow", cwd)).toBe(true)
  })

  it("reset clears all state", () => {
    const state = new ExternalDirectoryState()
    state.record("/etc/passwd", "allow")
    state.reset()
    expect(state.shouldPrompt("/etc/passwd", cwd)).toBe(true)
    expect(state.get("/etc/passwd")).toBeUndefined()
  })

  it("get returns undefined for un-recorded paths", () => {
    const state = new ExternalDirectoryState()
    expect(state.get("/etc/passwd")).toBeUndefined()
  })

  it("is a no-op for inside-cwd paths even with an empty store", () => {
    // Symmetric to the "no false-positive on record": a path that
    // resolves inside cwd must NEVER trigger a prompt regardless of
    // the store's state. This protects against accidentally-prompting
    // the user for paths they consider "their" tree.
    const state = new ExternalDirectoryState()
    state.reset() // ensure empty
    expect(state.shouldPrompt("/repo/anything", cwd)).toBe(false)
  })
})
