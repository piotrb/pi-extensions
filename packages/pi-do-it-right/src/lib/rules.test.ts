/**
 * tests for src/lib/rules.ts
 *
 * Uses the `paths` injection seam so all four sources (bundled, global
 * override, global, project) can be hermeticized as fixture files in a
 * temp dir. Cleanup via fs.rm(..., { recursive, force }).
 */

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  buildRulesList,
  globalOverrideRulesPath,
  globalRulesPath,
  loadRules,
  loadRuleSources,
  projectRulesPath,
  type RuleSource,
  type RulesPaths,
  saveRulesFile,
} from "./rules.ts"

let tmpHome: string
let tmpProject: string
let tmpBundled: string
let paths: RulesPaths

beforeEach(async () => {
  tmpHome = await realpath(await mkdtemp(join(tmpdir(), "doit-rules-home-")))
  tmpProject = await realpath(await mkdtemp(join(tmpdir(), "doit-rules-cwd-")))
  tmpBundled = join(tmpProject, "bundled.md")
  paths = {
    bundled: tmpBundled,
    globalOverride: globalOverrideRulesPath(tmpHome),
    global: globalRulesPath(tmpHome),
    project: projectRulesPath(tmpProject),
  }
})

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true })
  await rm(tmpProject, { recursive: true, force: true })
})

async function writeFileAt(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, content, "utf8")
}

async function writeBundled(content: string): Promise<void> {
  await writeFile(tmpBundled, content, "utf8")
}

async function writeGlobalOverride(content: string): Promise<void> {
  await writeFileAt(paths.globalOverride, content)
}

async function writeGlobal(content: string): Promise<void> {
  await writeFileAt(paths.global, content)
}

async function writeProject(content: string): Promise<void> {
  await writeFileAt(paths.project, content)
}

const cwd = "/work/proj"

describe("loadRules — empty paths", () => {
  it("returns empty string when no rule file contributes", async () => {
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("")
  })
})

describe("loadRules — bundled only", () => {
  it("returns bundled content when only the bundled file exists", async () => {
    await writeBundled("# bundled rules")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("# bundled rules")
  })
})

describe("loadRules — global only", () => {
  it("returns global content when only the global file exists", async () => {
    await writeGlobal("# global rules")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("# global rules")
  })
})

describe("loadRules — project only", () => {
  it("returns project content when only the project file exists", async () => {
    await writeProject("# project rules")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("# project rules")
  })
})

describe("loadRules — bundling + override", () => {
  it("concatenates bundled + global + project with blank-line separators", async () => {
    await writeBundled("B")
    await writeGlobal("G")
    await writeProject("P")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("B\n\nG\n\nP")
  })

  it("skips empty halves: bundled + project, no global", async () => {
    await writeBundled("B")
    await writeProject("P")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("B\n\nP")
  })

  it("skips empty halves: bundled + global, no project", async () => {
    await writeBundled("B")
    await writeGlobal("G")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("B\n\nG")
  })

  it("skips empty halves: global + project, no bundled", async () => {
    await writeGlobal("G")
    await writeProject("P")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("G\n\nP")
  })

  it("returns bundled only when global and project are both absent", async () => {
    await writeBundled("B")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("B")
  })

  it("returns global only when bundled and project are both absent", async () => {
    await writeGlobal("G")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("G")
  })

  it("returns project only when bundled and global are both absent", async () => {
    await writeProject("P")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("P")
  })
})

describe("loadRules — override replaces bundled", () => {
  it("override replaces bundled, keeps global + project", async () => {
    await writeBundled("B")
    await writeGlobalOverride("O")
    await writeGlobal("G")
    await writeProject("P")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("O\n\nG\n\nP")
  })

  it("override + global (no project)", async () => {
    await writeBundled("B")
    await writeGlobalOverride("O")
    await writeGlobal("G")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("O\n\nG")
  })

  it("override + project (no global)", async () => {
    await writeBundled("B")
    await writeGlobalOverride("O")
    await writeProject("P")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("O\n\nP")
  })

  it("override alone (no bundled, global, or project)", async () => {
    await writeGlobalOverride("O")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("O")
  })

  it("override with no other files still returns override content", async () => {
    await writeBundled("B")
    await writeGlobalOverride("O")
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("O")
  })
})

describe("loadRules — error tolerance", () => {
  it("silently skips an unreadable file (chmod 000)", async () => {
    if (process.platform === "win32") return // chmod unreliable on Windows
    await writeGlobal("G")
    await chmod(paths.global, 0o000)
    try {
      const result = await loadRules(cwd, undefined, undefined, paths)
      expect(typeof result).toBe("string")
    } finally {
      await chmod(paths.global, 0o644) // restore so afterEach rm works
    }
  })

  it("returns '' when global path is a directory (EISDIR swallowed)", async () => {
    await mkdir(paths.global, { recursive: true })
    expect(await loadRules(cwd, undefined, undefined, paths)).toBe("")
  })
})

describe("loadRuleSources", () => {
  it("returns four sources in deterministic order: bundled, override, global, project", async () => {
    const sources = await loadRuleSources(cwd, undefined, undefined, paths)
    expect(sources.map((s) => s.id)).toEqual(["bundled", "globalOverride", "global", "project"])
  })

  it("marks every source as not present when the temp paths are empty", async () => {
    const sources = await loadRuleSources(cwd, undefined, undefined, paths)
    for (const s of sources) {
      expect(s.content).toBe("")
      expect(s.lineCount).toBe(0)
      expect(s.present).toBe(false)
    }
    expect(sources.find((s) => s.id === "bundled")?.suppressed).toBe(false)
  })

  it("reads each present file and reports its line count", async () => {
    await writeFile(paths.bundled, "a\nb\nc")
    await writeFileAt(paths.global, "x")
    await writeFileAt(paths.project, "1\n2\n3\n4\n5")
    const sources = await loadRuleSources(cwd, undefined, undefined, paths)
    expect(sources.find((s) => s.id === "bundled")?.lineCount).toBe(3)
    expect(sources.find((s) => s.id === "global")?.lineCount).toBe(1)
    expect(sources.find((s) => s.id === "project")?.lineCount).toBe(5)
  })

  it("marks the bundled source as suppressed when the global override is present", async () => {
    await writeFile(paths.bundled, "bundled content")
    await writeFileAt(paths.globalOverride, "override content")
    const sources = await loadRuleSources(cwd, undefined, undefined, paths)
    const bundled = sources.find((s) => s.id === "bundled")
    const override = sources.find((s) => s.id === "globalOverride")
    expect(bundled?.suppressed).toBe(true)
    expect(bundled?.present).toBe(false)
    expect(override?.present).toBe(true)
  })

  it("does NOT suppress the bundled source when the override file is missing or empty", async () => {
    await writeFile(paths.bundled, "bundled content")
    // override file is missing entirely
    const sources = await loadRuleSources(cwd, undefined, undefined, paths)
    expect(sources.find((s) => s.id === "bundled")?.suppressed).toBe(false)
    expect(sources.find((s) => s.id === "bundled")?.present).toBe(true)
  })

  it("records the absolute path for each source", async () => {
    const sources = await loadRuleSources(cwd, undefined, undefined, paths)
    expect(sources.find((s) => s.id === "bundled")?.path).toBe(paths.bundled)
    expect(sources.find((s) => s.id === "globalOverride")?.path).toBe(paths.globalOverride)
    expect(sources.find((s) => s.id === "global")?.path).toBe(paths.global)
    expect(sources.find((s) => s.id === "project")?.path).toBe(paths.project)
  })
})

describe("buildRulesList", () => {
  // Helper to fabricate a RuleSource with sensible defaults.
  function makeSource(overrides: Partial<RuleSource>): RuleSource {
    return {
      id: "bundled",
      path: "/some/path.md",
      content: "",
      lineCount: 0,
      suppressed: false,
      present: false,
      ...overrides,
    }
  }

  it("returns four items when no override is in effect", () => {
    const view = buildRulesList([
      makeSource({ id: "bundled", lineCount: 23, present: true }),
      makeSource({ id: "globalOverride" }),
      makeSource({ id: "global", lineCount: 10, present: true }),
      makeSource({ id: "project", lineCount: 5, present: true }),
    ])
    expect(view.items.map((i) => i.value)).toEqual(["bundled", "globalOverride", "global", "project"])
    expect(view.suppressionNote).toBeNull()
  })

  it("filters the bundled source out when suppressed by the global override", () => {
    const view = buildRulesList([
      makeSource({ id: "bundled", path: "/bundled.md", lineCount: 23, present: true, suppressed: true }),
      makeSource({ id: "globalOverride", path: "/override.md", lineCount: 7, present: true }),
      makeSource({ id: "global", lineCount: 10, present: true }),
      makeSource({ id: "project", lineCount: 5, present: true }),
    ])
    expect(view.items.map((i) => i.value)).toEqual(["globalOverride", "global", "project"])
    expect(view.suppressionNote).toContain("suppressed")
    expect(view.suppressionNote).toContain("/bundled.md")
    expect(view.suppressionNote).toContain("/override.md")
  })

  it("does not generate a suppression note when the bundled source is just absent", () => {
    const view = buildRulesList([
      makeSource({ id: "bundled", present: false, lineCount: 0 }),
      makeSource({ id: "globalOverride" }),
      makeSource({ id: "global" }),
      makeSource({ id: "project" }),
    ])
    expect(view.suppressionNote).toBeNull()
  })

  it("labels missing files as '(missing)'", () => {
    const view = buildRulesList([
      makeSource({ id: "bundled" }),
      makeSource({ id: "globalOverride" }),
      makeSource({ id: "global" }),
      makeSource({ id: "project" }),
    ])
    for (const item of view.items) {
      expect(item.label).toMatch(/\(missing\)$/)
    }
  })

  it("labels empty files as '0 lines (empty)'", () => {
    const view = buildRulesList([
      makeSource({ id: "bundled" }),
      makeSource({ id: "globalOverride" }),
      makeSource({ id: "global", present: true, lineCount: 0 }),
      makeSource({ id: "project" }),
    ])
    const globalItem = view.items.find((i) => i.value === "global")
    expect(globalItem?.label).toBe("user — 0 lines (empty)")
  })

  it("uses the source path as the SelectItem description", () => {
    const view = buildRulesList([
      makeSource({ id: "bundled", path: "/a/b.md" }),
      makeSource({ id: "globalOverride", path: "/c/d.md", present: true, lineCount: 1 }),
      makeSource({ id: "global", path: "/e/f.md" }),
      makeSource({ id: "project", path: "/g/h.md" }),
    ])
    for (const item of view.items) {
      expect(item.description).toMatch(/\.md$/)
    }
  })
})

describe("saveRulesFile", () => {
  it("writes content to disk and creates parent directories as needed", async () => {
    const target = join(tmpProject, ".pi", "rules", "auto-reject-rules.md")
    const result = await saveRulesFile(target, "rule: do not use cat\n")
    expect(result.saved).toBe(true)
    expect(result.path).toBe(target)
    const onDisk = await readFile(target, "utf8")
    expect(onDisk).toBe("rule: do not use cat\n")
  })

  it("returns saved:false on a write error (no exception thrown)", async () => {
    // Point at a path under a non-directory to force ENOTDIR / EEXIST.
    const blocker = join(tmpProject, "blocker")
    await writeFile(blocker, "i am a file")
    const target = join(blocker, "sub", "rules.md")
    const result = await saveRulesFile(target, "ignored")
    expect(result.saved).toBe(false)
    expect(result.path).toBe(target)
  })

  it("overwrites existing content with the new value", async () => {
    const target = join(tmpProject, "rules.md")
    await writeFile(target, "old content", "utf8")
    const result = await saveRulesFile(target, "new content")
    expect(result.saved).toBe(true)
    const onDisk = await readFile(target, "utf8")
    expect(onDisk).toBe("new content")
  })
})
