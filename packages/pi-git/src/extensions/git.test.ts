import { describe, expect, it } from "vitest"

import defaultExport, { parsePorcelainV2 } from "./git.ts"

describe("git", () => {
  it("is a function", () => {
    expect(typeof defaultExport).toBe("function")
  })

  it("has length 1 (takes pi: ExtensionAPI parameter)", () => {
    expect(defaultExport.length).toBe(1)
  })
})

describe("parsePorcelainV2", () => {
  describe("branch headers", () => {
    it("parses branch.ab with positive ahead/behind (named groups)", () => {
      const status = parsePorcelainV2(["# branch.ab +3 -2"])
      expect(status.branch.ahead).toBe(3)
      expect(status.branch.behind).toBe(2)
    })

    it("parses branch.ab with zero values", () => {
      const status = parsePorcelainV2(["# branch.ab +0 -0"])
      expect(status.branch.ahead).toBe(0)
      expect(status.branch.behind).toBe(0)
    })
  })

  describe("ordinary entries", () => {
    it("parses a simple modified file", () => {
      const status = parsePorcelainV2(["1 .M N... 100644 100644 100644 abc def src/foo.ts"])
      expect(status.entries).toEqual([{ type: "ordinary", indexStatus: ".", worktreeStatus: "M", path: "src/foo.ts" }])
      expect(status.stats).toEqual({ staged: 0, unstaged: 1, untracked: 0, unmerged: 0 })
    })

    it("handles a path containing a space (the space-vs-tab join bug)", () => {
      // Without the test, a future refactor of `parts.slice(8).join(" ")`
      // could silently regress path-with-space handling.
      const status = parsePorcelainV2(["1 .M N... 100644 100644 100644 abc def dir with space/foo.ts"])
      expect(status.entries).toEqual([
        { type: "ordinary", indexStatus: ".", worktreeStatus: "M", path: "dir with space/foo.ts" },
      ])
    })
  })

  describe("renamed entries", () => {
    it("splits path and origPath on the tab separator", () => {
      // Format: 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
      // 5 mode/hash columns + 1 score column = 6 fixed columns between `sub`
      // and the path. The path itself may contain a tab (which separates it
      // from origPath) but is space-joined back from the split.
      // path = the NEW name, origPath = the OLD name.
      const status = parsePorcelainV2(["2 R. N... 100644 100644 100644 abc def R100 new/name.ts\told/name.ts"])
      expect(status.entries).toEqual([
        {
          type: "renamed",
          indexStatus: "R",
          worktreeStatus: ".",
          path: "new/name.ts",
          origPath: "old/name.ts",
          score: 100,
        },
      ])
    })

    it("handles spaces in both path and origPath", () => {
      const status = parsePorcelainV2(["2 R. N... 100644 100644 100644 abc def R100 dir new/name.ts\tdir old/name.ts"])
      expect(status.entries[0]).toMatchObject({ type: "renamed", path: "dir new/name.ts", origPath: "dir old/name.ts" })
    })
  })

  describe("unmerged entries", () => {
    it("parses a u XY unmerged entry", () => {
      // Format: u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      // 4 mode columns + 3 hash columns = 7 fixed columns after `sub`.
      const status = parsePorcelainV2(["u UU N... 100644 100644 100644 100644 abc def ghi conflict.ts"])
      expect(status.entries).toEqual([{ type: "unmerged", indexStatus: "U", worktreeStatus: "U", path: "conflict.ts" }])
      expect(status.stats.unmerged).toBe(1)
    })

    it("handles a path containing a space in unmerged entries", () => {
      const status = parsePorcelainV2(["u UU N... 100644 100644 100644 100644 abc def ghi dir with space/conflict.ts"])
      expect(status.entries[0]).toMatchObject({ type: "unmerged", path: "dir with space/conflict.ts" })
    })
  })

  describe("untracked entries", () => {
    it("parses a ? untracked entry", () => {
      const status = parsePorcelainV2(["? new.ts"])
      expect(status.entries).toEqual([{ type: "untracked", path: "new.ts" }])
      expect(status.stats.untracked).toBe(1)
    })
  })

  describe("stats", () => {
    it("aggregates staged/unstaged/untracked/unmerged across entry types", () => {
      const status = parsePorcelainV2([
        "1 .M N... 100644 100644 100644 abc def modified.ts", // unstaged
        "1 M. N... 100644 100644 100644 abc def staged.ts", // staged
        "? untracked.ts", // untracked
        "u UU N... 100644 100644 100644 100644 100644 100644 abc def conflict.ts", // unmerged
      ])
      expect(status.stats).toEqual({ staged: 1, unstaged: 1, untracked: 1, unmerged: 1 })
    })
  })
})
