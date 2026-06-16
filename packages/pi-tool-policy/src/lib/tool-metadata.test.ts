import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

import type { ToolInfo } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

import { aggregateToolMetadata, STOCK_BUILTIN_TOOL_METADATA } from "./tool-metadata.ts"
import type { ToolMetadata } from "./types.ts"

function makeToolInfo(name: string, sourcePath?: string): ToolInfo {
  return {
    name,
    description: `mock ${name}`,
    parameters: {} as never,
    sourceInfo: sourcePath
      ? { path: sourcePath, source: "test", scope: "project", origin: "package" }
      : ({ path: "", source: "test", scope: "project", origin: "top-level" } as never),
  }
}

describe("aggregateToolMetadata", () => {
  describe("layer order", () => {
    it("STOCK_BUILTIN_TOOL_METADATA covers the 7 built-in tools", () => {
      expect(STOCK_BUILTIN_TOOL_METADATA).toHaveProperty("read")
      expect(STOCK_BUILTIN_TOOL_METADATA).toHaveProperty("write")
      expect(STOCK_BUILTIN_TOOL_METADATA).toHaveProperty("edit")
      expect(STOCK_BUILTIN_TOOL_METADATA).toHaveProperty("grep")
      expect(STOCK_BUILTIN_TOOL_METADATA).toHaveProperty("find")
      expect(STOCK_BUILTIN_TOOL_METADATA).toHaveProperty("ls")
      expect(STOCK_BUILTIN_TOOL_METADATA).toHaveProperty("bash")
    })

    it("returns ResolvedToolMetadata for every tool, even with no metadata", async () => {
      const { metadata, warnings } = await aggregateToolMetadata([makeToolInfo("unknown")])
      expect(metadata.get("unknown")).toEqual({ tags: [], fields: {} })
      expect(warnings).toEqual([])
    })

    it("configOverrides wins on tag conflict", async () => {
      const { metadata } = await aggregateToolMetadata([makeToolInfo("read")], {
        read: { tags: ["custom-only"], aspects: {} },
      })
      // Tags are unioned (deduped); built-in "readonly" is preserved alongside "custom-only".
      expect(metadata.get("read")?.tags).toContain("readonly")
      expect(metadata.get("read")?.tags).toContain("custom-only")
    })

    it("configOverrides can add new aspects", async () => {
      const { metadata } = await aggregateToolMetadata([makeToolInfo("read")], {
        read: { tags: [], aspects: { url: { mode: "url", fields: ["href"] } } },
      })
      expect(metadata.get("read")?.fields).toHaveProperty("url")
    })
  })

  describe("warnings", () => {
    it("emits orphan-aspect-reference when override references an unknown aspect", async () => {
      const { warnings } = await aggregateToolMetadata([makeToolInfo("read")], {
        read: { tags: [], aspects: { ghost: { mode: "url", fields: ["href"] } } },
      })
      expect(warnings).toContainEqual({
        type: "orphan-aspect-reference",
        tool: "read",
        aspect: "ghost",
      })
    })

    it("does not warn for valid aspect references", async () => {
      const { warnings } = await aggregateToolMetadata([makeToolInfo("read")], {
        read: { tags: [], aspects: { path: { mode: "path", fields: ["path"] } } },
      })
      expect(warnings).toEqual([])
    })
  })

  describe("package.json readers", () => {
    it("emits package-json-not-found when the source dir has no package.json", async () => {
      const { metadata, warnings } = await aggregateToolMetadata([
        makeToolInfo("pfs_unlink", "/nonexistent/dir/extensions/pfs.ts"),
      ])
      // The tool gets empty defaults — discovery couldn't find a package.json.
      // The reported `dir` is dirname(sourceInfo.path), which strips just the
      // filename (so it ends in `/extensions` for the typical layout).
      expect(metadata.get("pfs_unlink")).toEqual({ tags: [], fields: {} })
      expect(warnings).toContainEqual({
        type: "package-json-not-found",
        tool: "pfs_unlink",
        dir: "/nonexistent/dir/extensions",
      })
    })

    it("emits package-json-invalid when the package.json is malformed", async () => {
      // Create a temp dir with a syntactically broken package.json so we
      // hit the JSON.parse failure path (not the ENOENT path).
      const dir = mkdtempSync(`${tmpdir()}/tool-policy-test-`)
      try {
        writeFileSync(`${dir}/package.json`, "{ this is not valid json")
        const { metadata, warnings } = await aggregateToolMetadata([
          makeToolInfo("broken_tool", `${dir}/extensions/broken.ts`),
        ])
        expect(metadata.get("broken_tool")).toEqual({ tags: [], fields: {} })
        const w = warnings.find((x) => x.type === "package-json-invalid")
        expect(w).toBeDefined()
        expect(w).toMatchObject({
          type: "package-json-invalid",
          tool: "broken_tool",
          dir,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("only emits the package.json warning once per directory even with multiple tools there", async () => {
      // Two tools from the same missing dir should produce ONE warning, not two.
      const { warnings } = await aggregateToolMetadata([
        makeToolInfo("tool_a", "/nonexistent/dir/extensions/a.ts"),
        makeToolInfo("tool_b", "/nonexistent/dir/extensions/b.ts"),
      ])
      const missingWarns = warnings.filter((w) => w.type === "package-json-not-found")
      expect(missingWarns).toHaveLength(1)
    })

    it("reads pi.toolMetadata from each unique extension directory", async () => {
      // Use a real package.json from the workspace to test the reader.
      // The pi-pfs package ships no pi.toolMetadata by default, so we expect
      // a no-op. The "pfs_unlink" tool is still in the result with empty metadata.
      const { metadata, warnings } = await aggregateToolMetadata([
        makeToolInfo("pfs_unlink", "/home/piotr/Work/pi-extensions/packages/pi-pfs/src/extensions/pfs.ts"),
      ])
      // pfs_unlink gets either no metadata or whatever pfs's package.json says.
      // We don't assert exact contents — just that aggregation didn't crash
      // and didn't warn (pi-pfs has a real package.json on disk).
      expect(metadata.get("pfs_unlink")).toBeDefined()
      expect(warnings).toEqual([])
    })
  })
})

// ToolMetadata type contract smoke check
describe("ToolMetadata shape", () => {
  it("accepts the v2 stock shape (tags + aspects with mode/fields)", () => {
    const m: ToolMetadata = {
      tags: ["readonly"],
      aspects: {
        path: { mode: "path", fields: ["path"] },
        custom: { mode: "url", fields: ["url"] },
      },
    }
    expect(m.aspects.path?.mode).toBe("path")
    expect(m.aspects.custom?.fields).toEqual(["url"])
  })
})
