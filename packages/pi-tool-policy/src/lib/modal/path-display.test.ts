import { describe, expect, it } from "vitest"

import { formatPathForDisplay } from "./path-display.ts"

describe("formatPathForDisplay", () => {
  describe("absolute input", () => {
    it("renders a path inside cwd as the relative form alone", () => {
      expect(formatPathForDisplay("/repo/src/foo.ts", "/repo")).toBe("src/foo.ts")
    })

    it("renders a path equal to cwd as '.' (never an empty string)", () => {
      // `path.relative` returns "" for cwd, which would render as a
      // blank display line. Render "." instead so the user sees
      // something.
      expect(formatPathForDisplay("/repo", "/repo")).toBe(".")
    })

    it("renders a path that escapes cwd as both forms", () => {
      // The leading ".." signals an escape; show the absolute in
      // parens so the user can tell which path is meant (matches the
      // directory-permissions modal's `formatDirectoryPath`).
      // Note: `path.relative("/repo", "/parent/foo")` is
      // "../parent/foo" — the ".. " is for crossing into the parent,
      // and "parent/foo" is the rest of the path.
      expect(formatPathForDisplay("/parent/foo", "/repo")).toBe("`../parent/foo` (`/parent/foo`)")
    })

    it("handles deeply-nested relative paths", () => {
      expect(formatPathForDisplay("/repo/a/b/c/d.ts", "/repo")).toBe("a/b/c/d.ts")
    })

    it("handles a sibling-directory escape (multiple .. segments)", () => {
      // /repo/sub/deeper is cwd; /other/x is three levels up.
      // path.relative gives "../../../other/x" which still starts
      // with "..", so the both-forms branch fires.
      expect(formatPathForDisplay("/other/x", "/repo/sub/deeper")).toBe("`../../../other/x` (`/other/x`)")
    })
  })

  describe("non-absolute input", () => {
    it("passes through already-relative paths unchanged", () => {
      // Some tools (notably git_add) hand the user a relative path.
      // We must not mangle it into a `../../cwd/...` form.
      expect(formatPathForDisplay("src/foo.ts", "/repo")).toBe("src/foo.ts")
    })

    it("passes through empty strings", () => {
      expect(formatPathForDisplay("", "/repo")).toBe("")
    })

    it("passes through the literal '.' unchanged", () => {
      expect(formatPathForDisplay(".", "/repo")).toBe(".")
    })

    it("passes through parent-relative paths unchanged", () => {
      expect(formatPathForDisplay("../foo", "/repo")).toBe("../foo")
    })
  })
})
