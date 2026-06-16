import { resolve } from "node:path"

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

import {
  checkAndPrompt,
  type CheckResult,
  DirectoryPermissionsState,
  type GrantResult,
  type OpenDirectoryModal,
} from "./directory-permissions.ts"
import type { ResolvedToolMetadata } from "./types.ts"

const cwd = "/repo"
const pathTool: ResolvedToolMetadata = {
  tags: ["readonly"],
  fields: { path: { mode: "path", fields: ["path"] } },
}

function makeEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
  return { type: "tool_call", toolCallId: "t", toolName, input } as unknown as ToolCallEvent
}

describe("DirectoryPermissionsState", () => {
  describe("reset", () => {
    it("adds the CWD auto-grant with tags: []", () => {
      const state = new DirectoryPermissionsState()
      state.reset(cwd)
      expect(state.has(cwd)).toBe(true)
      expect(state.matches(resolve(cwd, "src/foo.ts"), ["readonly"])).toBe(true)
    })

    it("clears pre-existing state and re-adds CWD only", () => {
      const state = new DirectoryPermissionsState()
      state.record("/etc/hosts", [], { allowAny: true, persistent: true })
      expect(state.has("/etc/hosts")).toBe(true)
      state.reset(cwd)
      expect(state.has("/etc/hosts")).toBe(false)
      expect(state.has(cwd)).toBe(true)
    })
  })

  describe("matches", () => {
    it("matches paths inside CWD without any tag check", () => {
      const state = new DirectoryPermissionsState()
      state.reset(cwd)
      expect(state.matches(resolve(cwd, "anywhere"), ["any-tag"])).toBe(true)
    })

    it("matches outside paths with allowAny (tags: [])", () => {
      const state = new DirectoryPermissionsState()
      state.record("/etc", [], { allowAny: true })
      expect(state.matches("/etc/hosts", [])).toBe(true)
      expect(state.matches("/etc/hosts", ["readonly"])).toBe(true)
    })

    it("matches outside paths only when all required tags are present", () => {
      const state = new DirectoryPermissionsState()
      state.record("/etc", ["readonly"])
      expect(state.matches("/etc/hosts", ["readonly"])).toBe(true)
      expect(state.matches("/etc/hosts", ["readonly", "extra"])).toBe(true) // superset covers
      expect(state.matches("/etc/hosts", ["mutating"])).toBe(false) // missing required
    })
  })

  describe("isGranted", () => {
    it("returns granted with no missing tags for full coverage", () => {
      const state = new DirectoryPermissionsState()
      state.record("/etc", ["readonly"])
      const result = state.isGranted("/etc/hosts", ["readonly"])
      expect(result.granted).toBe(true)
      expect(result.missingTags).toEqual([])
    })

    it("returns missing tags when partial coverage", () => {
      const state = new DirectoryPermissionsState()
      state.record("/etc", ["readonly"])
      const result = state.isGranted("/etc/hosts", ["readonly", "mutating"])
      expect(result.granted).toBe(false)
      expect(result.missingTags).toEqual(["mutating"])
    })

    it("returns not-granted when no grant covers the path", () => {
      const state = new DirectoryPermissionsState()
      state.reset(cwd)
      const result = state.isGranted("/etc/hosts", ["readonly"])
      expect(result.granted).toBe(false)
      expect(result.missingTags).toEqual(["readonly"])
    })

    it("allowAny covers all tags", () => {
      const state = new DirectoryPermissionsState()
      state.record("/etc", [], { allowAny: true })
      const result = state.isGranted("/etc/hosts", ["readonly", "mutating"])
      expect(result.granted).toBe(true)
      expect(result.missingTags).toEqual([])
    })
  })

  describe("record + has", () => {
    it("record stores a grant; has checks the path", () => {
      const state = new DirectoryPermissionsState()
      state.record("/etc", ["readonly"])
      expect(state.has("/etc")).toBe(true)
      expect(state.has("/other")).toBe(false)
    })

    it("record with persistent: false can be inspected but flagged for non-persistence", () => {
      const state = new DirectoryPermissionsState()
      state.record("/etc", ["readonly"], { persistent: false })
      expect(state.has("/etc")).toBe(true)
      expect(state.matches("/etc/hosts", ["readonly"])).toBe(true)
    })
  })
})

describe("checkAndPrompt (guardrail layer)", () => {
  function makeStubModal(responses: (GrantResult | null)[]): { modal: OpenDirectoryModal; calls: { count: number } } {
    const calls = { count: 0 }
    const modal: OpenDirectoryModal = () => {
      const r = responses[calls.count] ?? null
      calls.count += 1
      return Promise.resolve(r)
    }
    return { modal, calls }
  }

  function makeState() {
    const state = new DirectoryPermissionsState()
    state.reset(cwd)
    return state
  }

  it("allows without prompting when the path is already granted by CWD", async () => {
    const state = makeState()
    const { modal } = makeStubModal([])
    const meta = new Map<string, ResolvedToolMetadata>([["read", pathTool]])
    const result = await checkAndPrompt(
      state,
      makeEvent("read", { path: "/repo/src/foo.ts" }),
      meta,
      ["readonly"],
      [],
      { cwd },
      modal,
    )
    expect(result.allowed).toBe(true)
  })

  it("prompts once when path is outside CWD and not pre-granted", async () => {
    const state = makeState()
    const { modal, calls } = makeStubModal([{ decision: "allow", path: "/etc/hosts", tags: ["readonly"] }])
    const meta = new Map<string, ResolvedToolMetadata>([["read", pathTool]])
    const result = await checkAndPrompt(
      state,
      makeEvent("read", { path: "/etc/hosts" }),
      meta,
      ["readonly"],
      [],
      { cwd },
      modal,
    )
    expect(result.allowed).toBe(true)
    expect(calls.count).toBe(1)
  })

  it("denies when user denies", async () => {
    const state = makeState()
    const { modal } = makeStubModal([{ decision: "deny", path: "/etc/hosts", tags: [] }])
    const meta = new Map<string, ResolvedToolMetadata>([["read", pathTool]])
    const result: CheckResult = await checkAndPrompt(
      state,
      makeEvent("read", { path: "/etc/hosts" }),
      meta,
      ["readonly"],
      [],
      { cwd },
      modal,
    )
    expect(result.allowed).toBe(false)
    expect(result.denialReason).toBeDefined()
  })

  it("denies when user cancels (modal returns null)", async () => {
    const state = makeState()
    const { modal } = makeStubModal([null])
    const meta = new Map<string, ResolvedToolMetadata>([["read", pathTool]])
    const result = await checkAndPrompt(
      state,
      makeEvent("read", { path: "/etc/hosts" }),
      meta,
      ["readonly"],
      [],
      { cwd },
      modal,
    )
    expect(result.allowed).toBe(false)
  })

  it("iterates over multi-path tools", async () => {
    const state = makeState()
    const pfsTool: ResolvedToolMetadata = {
      tags: ["mutating"],
      fields: { source: { mode: "path", fields: ["source"] }, destination: { mode: "path", fields: ["destination"] } },
    }
    const meta = new Map<string, ResolvedToolMetadata>([["pfs_mv", pfsTool]])
    const { modal, calls } = makeStubModal([
      { decision: "allow", path: "/other/a.txt", tags: ["mutating"] },
      { decision: "allow", path: "/other/b.txt", tags: ["mutating"] },
    ])
    const result = await checkAndPrompt(
      state,
      makeEvent("pfs_mv", { source: "/other/a.txt", destination: "/other/b.txt" }),
      meta,
      ["mutating"],
      [],
      { cwd },
      modal,
    )
    expect(result.allowed).toBe(true)
    expect(calls.count).toBe(2)
  })

  it("handles custom path: re-prompts the custom path AND grants the original", async () => {
    const state = makeState()
    const { modal, calls } = makeStubModal([
      { decision: "custom", path: "/etc/hosts", tags: ["readonly"], customPath: "/repo/etc/hosts" },
    ])
    const meta = new Map<string, ResolvedToolMetadata>([["read", pathTool]])
    const result = await checkAndPrompt(
      state,
      makeEvent("read", { path: "/etc/hosts" }),
      meta,
      ["readonly"],
      [],
      { cwd },
      modal,
    )
    expect(result.allowed).toBe(true)
    expect(calls.count).toBe(1) // The custom path is granted on the same call (no re-prompt).
  })

  it("ignores tools without metadata", async () => {
    const state = makeState()
    const { modal, calls } = makeStubModal([])
    const meta = new Map<string, ResolvedToolMetadata>() // no entry
    const result = await checkAndPrompt(
      state,
      makeEvent("unknown", { path: "/etc/hosts" }),
      meta,
      ["readonly"],
      [],
      { cwd },
      modal,
    )
    expect(result.allowed).toBe(true)
    expect(calls.count).toBe(0)
  })

  it("pre-loads allowedPaths from config", async () => {
    const state = makeState()
    const { modal, calls } = makeStubModal([])
    const meta = new Map<string, ResolvedToolMetadata>([["read", pathTool]])
    const result = await checkAndPrompt(
      state,
      makeEvent("read", { path: "/var/log/foo.log" }),
      meta,
      ["readonly"],
      [{ tags: ["readonly"], path: "/var/log" }],
      { cwd },
      modal,
    )
    expect(result.allowed).toBe(true)
    expect(calls.count).toBe(0) // already granted by config
  })

  it("handles string[] path fields (arrays of paths)", async () => {
    const state = makeState()
    const listTool: ResolvedToolMetadata = {
      tags: ["readonly"],
      fields: { paths: { mode: "path", fields: ["paths"] } },
    }
    const meta = new Map<string, ResolvedToolMetadata>([["list", listTool]])
    const { modal, calls } = makeStubModal([
      { decision: "allow", path: "/other/a.txt", tags: ["readonly"] },
      { decision: "allow", path: "/other/b.txt", tags: ["readonly"] },
    ])
    const result = await checkAndPrompt(
      state,
      makeEvent("list", { paths: ["/other/a.txt", "/other/b.txt"] }),
      meta,
      ["readonly"],
      [],
      { cwd },
      modal,
    )
    expect(result.allowed).toBe(true)
    expect(calls.count).toBe(2)
  })
})
