import type { ToolInfo } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

import type { DirectoryPromptArgs } from "../directory-permissions.ts"
import type { AggregateResult } from "../tool-metadata.ts"
import type { ResolvedToolMetadata } from "../types.ts"
import type { Config } from "../types.ts"
import {
  buildDebugOptions,
  dumpConfig,
  dumpConfigLayers,
  dumpDirectoryPermissions,
  dumpToolMetadata,
  dumpTools,
} from "./debug-modal.ts"
import { buildDirectoryOptions, buildDirectoryTitle } from "./directory-permissions-modal.ts"
import {
  buildPolicyAskTitle,
  buildRuleTypeOptions,
  buildTopLevelOptions,
  pickRuleTypeReducer,
} from "./policy-ask-modal.ts"
import { buildToolPolicyOptions } from "./tool-policy-modal.ts"

function makeDirectoryArgs(args: Omit<DirectoryPromptArgs, "cwd">): DirectoryPromptArgs {
  return { cwd: "/project", ...args }
}

describe("buildDirectoryTitle", () => {
  it("renders the inline prompt title with relative and absolute paths", () => {
    const title = buildDirectoryTitle(
      makeDirectoryArgs({
        path: "/parent",
        effectiveTags: ["readonly"],
        grantedTags: [],
      }),
    )
    expect(title).toBe(
      "Tool is trying to access a path outside the project.\n" +
        "Path: `../parent` (`/parent`)\n" +
        "Tool tags: readonly\n\n" +
        "Pick an action:",
    )
  })

  it("renders '(none)' when the tool has no effective tags", () => {
    const title = buildDirectoryTitle(makeDirectoryArgs({ path: "/parent", effectiveTags: [], grantedTags: [] }))
    expect(title).toContain("Tool tags: (none)")
  })
})

describe("buildDirectoryOptions", () => {
  it("produces one option per ungranted tag", () => {
    const args = makeDirectoryArgs({
      path: "/etc/hosts",
      effectiveTags: ["readonly", "mutating"],
      grantedTags: [],
    })
    const options = buildDirectoryOptions(args)
    expect(options).toHaveLength(5) // 2 tags + union + custom + deny
    expect(options[0]).toEqual({ value: "tag:readonly", label: "Allow readonly on `../etc/hosts` (`/etc/hosts`)" })
    expect(options[1]).toEqual({ value: "tag:mutating", label: "Allow mutating on `../etc/hosts` (`/etc/hosts`)" })
  })

  it("omits granted tags from the option list", () => {
    const args = makeDirectoryArgs({
      path: "/etc/hosts",
      effectiveTags: ["readonly", "mutating"],
      grantedTags: ["readonly"],
    })
    const options = buildDirectoryOptions(args)
    // Only "mutating" is ungranted; no union (only one ungranted tag).
    expect(options).toHaveLength(3) // mutating + custom + deny
    expect(options[0]).toEqual({ value: "tag:mutating", label: "Allow mutating on `../etc/hosts` (`/etc/hosts`)" })
  })

  it("includes the union option only when more than one tag is ungranted", () => {
    const oneTag = makeDirectoryArgs({
      path: "/foo",
      effectiveTags: ["readonly"],
      grantedTags: [],
    })
    expect(buildDirectoryOptions(oneTag).some((o) => o.value === "union")).toBe(false)

    const twoTags = makeDirectoryArgs({
      path: "/foo",
      effectiveTags: ["readonly", "mutating"],
      grantedTags: [],
    })
    expect(buildDirectoryOptions(twoTags).some((o) => o.value === "union")).toBe(true)
    const union = buildDirectoryOptions(twoTags).find((o) => o.value === "union")
    expect(union?.label).toBe("Allow [readonly, mutating] on `../foo` (`/foo`)")
  })

  it("always includes the custom + deny options", () => {
    const args = makeDirectoryArgs({
      path: "/foo",
      effectiveTags: ["readonly"],
      grantedTags: ["readonly"],
    })
    const options = buildDirectoryOptions(args)
    expect(options.some((o) => o.value === "custom")).toBe(true)
    expect(options.some((o) => o.value === "deny")).toBe(true)
  })

  it("handles the empty effectiveTags case (just custom + deny)", () => {
    const args = makeDirectoryArgs({
      path: "/foo",
      effectiveTags: [],
      grantedTags: [],
    })
    const options = buildDirectoryOptions(args)
    expect(options).toHaveLength(2) // custom + deny
    expect(options.some((o) => o.value === "custom")).toBe(true)
    expect(options.some((o) => o.value === "deny")).toBe(true)
  })
})

function makeConfig(modeOrder: string[]): Config {
  const modes: Config["modes"] = {}
  for (const name of modeOrder) {
    modes[name] = { description: `${name} desc`, defaultDecision: "ask", tagRules: {}, toolRules: {}, aspectRules: {} }
  }
  return { modeOrder, modes, allowedPaths: [], taggingRules: [], toolMetadata: {} }
}

describe("buildToolPolicyOptions", () => {
  it("renders one option per mode in modeOrder, plus the Debug entry", () => {
    const config = makeConfig(["default", "plan"])
    const options = buildToolPolicyOptions(config, "default", [])
    expect(options).toHaveLength(3) // 2 modes + 1 debug
    expect(options[0]?.value).toBe("default")
    expect(options[1]?.value).toBe("plan")
    expect(options[2]?.value).toBe("debug")
  })

  it("highlights the current mode with ●", () => {
    const config = makeConfig(["default", "plan"])
    const options = buildToolPolicyOptions(config, "plan", [])
    expect(options[0]?.label).toMatch(/^○ default/)
    expect(options[1]?.label).toMatch(/^● plan/)
  })

  it("does NOT show the warnings entry when warnings is empty", () => {
    const config = makeConfig(["default"])
    const options = buildToolPolicyOptions(config, "default", [])
    expect(options.some((o) => o.value === "warnings")).toBe(false)
  })

  it("shows the warnings entry with correct count when warnings exist", () => {
    const config = makeConfig(["default"])
    const options = buildToolPolicyOptions(config, "default", ["w1", "w2", "w3"])
    const w = options.find((o) => o.value === "warnings")
    expect(w?.label).toBe("Show 3 warnings")
  })

  it("singular 'warning' label for a single warning", () => {
    const config = makeConfig(["default"])
    const options = buildToolPolicyOptions(config, "default", ["only-one"])
    const w = options.find((o) => o.value === "warnings")
    expect(w?.label).toBe("Show 1 warning")
  })

  it("includes the mode description in the label", () => {
    const config = makeConfig(["default"])
    const options = buildToolPolicyOptions(config, "default", [])
    expect(options[0]?.label).toContain("default desc")
  })

  it("always shows the Debug entry last, regardless of warnings", () => {
    const noWarnings = buildToolPolicyOptions(makeConfig(["default"]), "default", [])
    expect(noWarnings[noWarnings.length - 1]?.value).toBe("debug")

    const withWarnings = buildToolPolicyOptions(makeConfig(["default"]), "default", ["w1"])
    expect(withWarnings[withWarnings.length - 1]?.value).toBe("debug")
  })

  it("flags the YOLO mode with a warning prefix (⚠) and the EMERGENCY OFF description", () => {
    const config = makeConfig(["default", "plan", "__yolo__"])
    const options = buildToolPolicyOptions(config, "default", [])
    const yolo = options.find((o) => o.value === "__yolo__")
    expect(yolo).toBeDefined()
    expect(yolo?.label).toContain("⚠")
    expect(yolo?.label).toContain("__yolo__")
    expect(yolo?.label).toContain("EMERGENCY OFF")
  })

  it("includes a Config Layers debug entry", () => {
    const config = makeConfig(["default"])
    const options = buildToolPolicyOptions(config, "default", [])
    // No debug sub-options here (this is the /tool_policy menu, not the
    // debug sub-menu). The Debug option in buildToolPolicyOptions opens
    // a sub-menu whose contents are tested via buildDebugOptions.
    expect(options.find((o) => o.value === "debug")).toBeDefined()
  })
})

describe("buildTopLevelOptions", () => {
  it("renders five option labels in the canonical order", () => {
    const labels = buildTopLevelOptions()
    expect(labels).toHaveLength(5)
    expect(labels[0]).toBe("Allow once")
    expect(labels[1]).toBe("Allow for this session")
    expect(labels[2]).toBe("Allow & Save")
    expect(labels[3]).toBe("Deny")
    expect(labels[4]).toBe("Deny & Save")
  })
})

describe("buildRuleTypeOptions", () => {
  it("includes one aspect row per declared aspect with a value", () => {
    const meta: ResolvedToolMetadata = {
      tags: ["execution"],
      fields: { command: { mode: "bash", fields: ["cmd"] } },
    }
    const rows = buildRuleTypeOptions("run", { cmd: ["ls"] }, meta, { aspectCovered: false, toolCovered: false })
    expect(rows).toHaveLength(2) // 1 aspect + 1 tool
    expect(rows[0]).toMatchObject({ ruleType: "aspect", aspectName: "command" })
    expect(rows[0]?.aspectPattern).toBe("ls")
    expect(rows[1]?.ruleType).toBe("tool")
  })

  it("hides aspect rules when the tool has no aspect metadata", () => {
    const rows = buildRuleTypeOptions("pfs_unlink", { path: "/etc/hosts" }, undefined, {
      aspectCovered: false,
      toolCovered: false,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ruleType).toBe("tool")
  })

  it("hides aspect rules when the call is already aspect-covered", () => {
    const meta: ResolvedToolMetadata = {
      tags: ["execution"],
      fields: { command: { mode: "bash", fields: ["cmd"] } },
    }
    const rows = buildRuleTypeOptions("run", { cmd: ["ls"] }, meta, { aspectCovered: true, toolCovered: false })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.ruleType).toBe("tool")
  })

  it("hides tool rules when the call is already tool-rule-covered", () => {
    const meta: ResolvedToolMetadata = {
      tags: ["execution"],
      fields: { command: { mode: "bash", fields: ["cmd"] } },
    }
    const rows = buildRuleTypeOptions("run", { cmd: ["ls"] }, meta, { aspectCovered: false, toolCovered: true })
    expect(rows.every((r) => r.ruleType === "aspect")).toBe(true)
  })

  it("hides everything when both layers are covered (caller should fall back to deny)", () => {
    const meta: ResolvedToolMetadata = {
      tags: ["execution"],
      fields: { command: { mode: "bash", fields: ["cmd"] } },
    }
    const rows = buildRuleTypeOptions("run", { cmd: ["ls"] }, meta, { aspectCovered: true, toolCovered: true })
    expect(rows).toHaveLength(0)
  })

  it("emits one aspect row per aspect for multi-aspect tools", () => {
    const meta: ResolvedToolMetadata = {
      tags: ["mutating"],
      fields: {
        source: { mode: "path", fields: ["source"] },
        destination: { mode: "path", fields: ["destination"] },
      },
    }
    const rows = buildRuleTypeOptions("pfs_mv", { source: "/a", destination: "/b" }, meta, {
      aspectCovered: false,
      toolCovered: false,
    })
    const aspectRows = rows.filter((r) => r.ruleType === "aspect")
    expect(aspectRows).toHaveLength(2)
    expect(aspectRows.map((r) => r.aspectName).sort()).toEqual(["destination", "source"])
  })

  it("renders path-mode aspect prefill as cwd-relative in the label and the aspectPattern", () => {
    const meta: ResolvedToolMetadata = {
      tags: ["readonly"],
      fields: { path: { mode: "path", fields: ["path"] } },
    }
    const rows = buildRuleTypeOptions(
      "read",
      { path: "/repo/src/foo.ts" },
      meta,
      {
        aspectCovered: false,
        toolCovered: false,
      },
      "/repo",
    )
    const aspectRow = rows.find((r) => r.ruleType === "aspect")
    expect(aspectRow?.label).toBe("Aspect rule: path = src/foo.ts")
    // The aspectPattern (what the user sees in the input modal and
    // what gets persisted) is also cwd-relative.
    expect(aspectRow?.aspectPattern).toBe("src/foo.ts")
  })
})

describe("buildPolicyAskTitle", () => {
  it("renders the 'Allow tool call: X?' header as the first line", () => {
    const title = buildPolicyAskTitle({
      toolName: "bash",
      effectiveTags: ["execution"],
      currentMode: "plan",
      input: { command: "ls" },
      toolMeta: undefined,
      cwd: "/repo",
    })
    expect(title.startsWith("Allow tool call: bash?")).toBe(true)
    expect(title).toContain("Pick an action")
  })

  it("does NOT include 'Tool policy:' or 'Reason:' (both removed for clarity)", () => {
    const title = buildPolicyAskTitle({
      toolName: "bash",
      effectiveTags: ["execution"],
      currentMode: "default",
      reason: "some reason",
      input: {},
      toolMeta: undefined,
      cwd: "/repo",
    })
    expect(title).not.toContain("Tool policy:")
    expect(title).not.toContain("Reason:")
  })

  it("combines mode + tags on one compact line with '·' separator", () => {
    const title = buildPolicyAskTitle({
      toolName: "bash",
      effectiveTags: ["execution"],
      currentMode: "default",
      input: {},
      toolMeta: undefined,
      cwd: "/repo",
    })
    expect(title).toContain("Mode: default · Tags: execution")
  })

  it("renders '(none)' for an empty tag set", () => {
    const title = buildPolicyAskTitle({
      toolName: "bash",
      effectiveTags: [],
      currentMode: "default",
      input: {},
      toolMeta: undefined,
      cwd: "/repo",
    })
    expect(title).toContain("Tags: (none)")
  })

  it("uses '\n' newlines so the runtime can render each line separately", () => {
    const title = buildPolicyAskTitle({
      toolName: "bash",
      effectiveTags: [],
      currentMode: "default",
      input: {},
      toolMeta: undefined,
      cwd: "/repo",
    })
    expect(title).toContain("\n")
  })

  it("includes aspect-decorated field lines between the header and the mode line", () => {
    const meta: ResolvedToolMetadata = {
      tags: ["execution"],
      fields: { command: { mode: "bash", fields: ["cmd"] } },
    }
    const title = buildPolicyAskTitle({
      toolName: "run",
      effectiveTags: ["execution"],
      currentMode: "default",
      input: { cmd: ["ls"] },
      toolMeta: meta,
      cwd: "/repo",
    })
    const headerIdx = title.indexOf("Allow tool call: run?")
    const fieldIdx = title.indexOf("command: ls")
    const modeIdx = title.indexOf("Mode:")
    expect(headerIdx).toBeGreaterThanOrEqual(0)
    expect(fieldIdx).toBeGreaterThan(headerIdx)
    expect(modeIdx).toBeGreaterThan(fieldIdx)
  })

  it("includes the per-element path lines for an array-mode aspect", () => {
    const meta: ResolvedToolMetadata = {
      tags: ["mutating"],
      fields: { path: { mode: "path", fields: [{ field: "paths", mode: "array" }] } },
    }
    const title = buildPolicyAskTitle({
      toolName: "git_add",
      effectiveTags: ["mutating"],
      currentMode: "default",
      input: { paths: [".env", "src/index.ts"] },
      toolMeta: meta,
      cwd: "/repo",
    })
    expect(title).toContain("path: .env")
    expect(title).toContain("path: src/index.ts")
  })

  it("falls back to dumping input fields when the tool has no aspect metadata", () => {
    const title = buildPolicyAskTitle({
      toolName: "pfs_unlink",
      effectiveTags: ["mutating"],
      currentMode: "default",
      input: { path: "/etc/hosts" },
      toolMeta: undefined,
      cwd: "/etc",
    })
    expect(title).toContain("path: /etc/hosts")
  })

  it("renders path-mode aspect values as cwd-relative in the title", () => {
    const meta: ResolvedToolMetadata = {
      tags: ["readonly"],
      fields: { path: { mode: "path", fields: ["path"] } },
    }
    const title = buildPolicyAskTitle({
      toolName: "read",
      effectiveTags: ["readonly"],
      currentMode: "default",
      input: { path: "/repo/src/foo.ts" },
      toolMeta: meta,
      cwd: "/repo",
    })
    // The absolute path is converted to the cwd-relative form for
    // the user-facing display.
    expect(title).toContain("path: src/foo.ts")
    expect(title).not.toContain("/repo/src/foo.ts")
  })

  it("renders path-mode aspect values that escape cwd as both forms", () => {
    const meta: ResolvedToolMetadata = {
      tags: ["readonly"],
      fields: { path: { mode: "path", fields: ["path"] } },
    }
    const title = buildPolicyAskTitle({
      toolName: "read",
      effectiveTags: ["readonly"],
      currentMode: "default",
      input: { path: "/parent/foo" },
      toolMeta: meta,
      cwd: "/repo",
    })
    // formatValue quotes the both-forms label because it has spaces.
    // path.relative("/repo", "/parent/foo") = "../parent/foo".
    expect(title).toContain('path: "`../parent/foo` (`/parent/foo`)"')
  })
})

describe("buildDebugOptions", () => {
  it("renders five options including config_layers", () => {
    const options = buildDebugOptions()
    expect(options).toHaveLength(5)
    expect(options.map((o) => o.value)).toEqual([
      "stock_config",
      "tool_metadata",
      "tools",
      "directory_permissions",
      "config_layers",
    ])
  })

  it("labels explain what each source is", () => {
    const options = buildDebugOptions()
    const stock = options.find((o) => o.value === "stock_config")
    const metadata = options.find((o) => o.value === "tool_metadata")
    const tools = options.find((o) => o.value === "tools")
    const directoryPermissions = options.find((o) => o.value === "directory_permissions")
    const configLayers = options.find((o) => o.value === "config_layers")
    expect(stock?.label).toContain("Stock")
    expect(stock?.label).toContain("config")
    expect(metadata?.label).toContain("Tool Metadata")
    // The metadata label must make it clear this is the pre-merge view
    // (extensions' raw contributions, NOT the final aggregated result).
    expect(metadata?.label.toLowerCase()).toContain("pre-merge")
    // The tools label must mention sourceInfo — that's the whole point
    // of the dump (where did each tool come from?).
    expect(tools?.label).toContain("sourceInfo")
    expect(directoryPermissions?.label).toContain("allowed paths")
    expect(directoryPermissions?.label).toContain("tags")
    expect(configLayers?.label).toContain("stock")
    expect(configLayers?.label).toContain("user")
    expect(configLayers?.label).toContain("project")
    expect(configLayers?.label).toContain("merged")
  })
})

describe("dumpConfig", () => {
  it("serializes a Config to pretty-printed JSON", () => {
    const config = makeConfig(["default"])
    const out = dumpConfig(config)
    // Pretty-print uses 2-space indent and emits newlines between keys.
    expect(out).toContain("\n")
    expect(out).toContain('"modeOrder"')
    expect(out).toContain('"modes"')
    // Should round-trip back to the same object shape.
    const parsed = JSON.parse(out) as Config
    expect(parsed.modeOrder).toEqual(["default"])
    expect(parsed.modes.default?.description).toBe("default desc")
  })
})

describe("dumpToolMetadata", () => {
  it("serializes the pre-merge `discovered` blob (per-extension package.json contributions)", () => {
    const result: AggregateResult = {
      metadata: new Map<string, ResolvedToolMetadata>(),
      discovered: {
        bash: { tags: ["execution"], aspects: { bash_cmd: { mode: "bash", fields: ["command"] } } },
        ripgrep: { tags: ["readonly"], aspects: { path: { mode: "path", fields: ["paths"] } } },
      },
      warnings: [],
    }
    const out = dumpToolMetadata(result)
    const parsed = JSON.parse(out) as Record<string, { tags: string[] }>
    expect(parsed.bash?.tags).toEqual(["execution"])
    expect(parsed.ripgrep?.tags).toEqual(["readonly"])
    // Does NOT include the merged `metadata` map or the warnings array.
    expect(out).not.toContain('"metadata"')
    expect(out).not.toContain('"warnings"')
  })

  it("returns an empty object when no extension declared any metadata", () => {
    const result: AggregateResult = {
      metadata: new Map<string, ResolvedToolMetadata>(),
      discovered: {},
      warnings: [],
    }
    expect(dumpToolMetadata(result)).toBe("{}")
  })
})

describe("dumpDirectoryPermissions", () => {
  it("serializes current path grants and tags", () => {
    const out = dumpDirectoryPermissions([
      { path: "/repo", tags: [], isCwd: true, persistent: true },
      { path: "/tmp", tags: ["readonly"], isCwd: false, persistent: false },
    ])
    const parsed = JSON.parse(out) as { path: string; tags: string[]; isCwd: boolean; persistent: boolean }[]
    expect(parsed).toEqual([
      { path: "/repo", tags: [], isCwd: true, persistent: true },
      { path: "/tmp", tags: ["readonly"], isCwd: false, persistent: false },
    ])
  })
})

describe("dumpConfigLayers", () => {
  it("serializes the four modes layers (stock / user / project / merged) plus modeOrder", () => {
    const stock = makeConfig(["default"]).modes
    const user: Record<string, Config["modes"][string]> = {
      default: {
        description: "user",
        defaultDecision: "deny",
        tagRules: {},
        toolRules: {},
        aspectRules: {},
      },
    }
    const project: Record<string, Config["modes"][string]> = {
      default: {
        description: "project",
        defaultDecision: "ask",
        tagRules: {},
        toolRules: {},
        aspectRules: {},
      },
    }
    const merged = makeConfig(["default", "__yolo__"]).modes
    const out = dumpConfigLayers({ stock, user, project, merged, modeOrder: ["default", "__yolo__"] })
    const parsed = JSON.parse(out) as {
      stock: Record<string, unknown>
      user: Record<string, unknown>
      project: Record<string, unknown>
      merged: Record<string, unknown>
      modeOrder: string[]
    }
    expect(parsed.stock.default).toBeDefined()
    expect(parsed.user.default).toMatchObject({ description: "user" })
    expect(parsed.project.default).toMatchObject({ description: "project" })
    expect(parsed.merged.__yolo__).toBeDefined()
    expect(parsed.modeOrder).toEqual(["default", "__yolo__"])
  })
})

describe("dumpTools", () => {
  const sampleTools: ToolInfo[] = [
    {
      name: "bash",
      description: "shell",
      parameters: { type: "object", properties: { command: { type: "string" } } } as never,
      sourceInfo: { path: "/builtins/bash", source: "builtin", scope: "user", origin: "top-level" },
    },
    {
      name: "ripgrep",
      description: "rg",
      parameters: { type: "object" } as never,
      sourceInfo: {
        path: "/repo/packages/pi-ripgrep/src/extensions/ripgrep.ts",
        source: "ripgrep-pkg",
        scope: "project",
        origin: "package",
      },
    },
  ]

  it("serializes each tool to { name, enabled, sourceInfo } (parameters dropped)", () => {
    const out = dumpTools(sampleTools, ["bash"])
    const parsed = JSON.parse(out) as {
      name: string
      enabled: boolean
      sourceInfo: { path: string; source: string }
    }[]
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.name).toBe("bash")
    expect(parsed[0]?.enabled).toBe(true)
    expect(parsed[0]?.sourceInfo.path).toBe("/builtins/bash")
    expect(parsed[1]?.name).toBe("ripgrep")
    expect(parsed[1]?.enabled).toBe(false)
    expect(parsed[1]?.sourceInfo.source).toBe("ripgrep-pkg")
    // The typebox parameter schema is dropped — not useful for "where
    // did this tool come from?" debugging and bloats the dump.
    expect(out).not.toContain('"parameters"')
    expect(out).not.toContain('"description"')
  })

  it("returns '[]' for an empty tool list", () => {
    expect(dumpTools([], [])).toBe("[]")
  })

  it("marks every tool disabled when activeTools is empty", () => {
    const out = dumpTools(sampleTools, [])
    const parsed = JSON.parse(out) as { enabled: boolean }[]
    expect(parsed.every((t) => !t.enabled)).toBe(true)
  })

  it("marks every tool enabled when activeTools includes all of them", () => {
    const out = dumpTools(sampleTools, ["bash", "ripgrep"])
    const parsed = JSON.parse(out) as { enabled: boolean }[]
    expect(parsed.every((t) => t.enabled)).toBe(true)
  })
})

describe("pickRuleTypeReducer", () => {
  // A synthetic row set — the reducer doesn't care about the row
  // contents, only their labels.
  const aspectRow = {
    value: "aspect:path",
    label: "Aspect rule: path = .env",
    ruleType: "aspect" as const,
    aspectName: "path",
  }
  const toolRow = { value: "tool", label: "Tool rule: read", ruleType: "tool" as const }

  it("returns the chosen row when the label matches", () => {
    const result = pickRuleTypeReducer(
      [aspectRow, toolRow],
      { aspectCovered: false, toolCovered: false },
      toolRow.label,
    )
    expect(result).toEqual({ kind: "row", row: toolRow })
  })

  it("returns 'back' when the user pressed Esc (userChose is undefined)", () => {
    const result = pickRuleTypeReducer([aspectRow, toolRow], { aspectCovered: false, toolCovered: false }, undefined)
    expect(result).toEqual({ kind: "back" })
  })

  it("returns 'back' when userChose doesn't match any row's label (defensive)", () => {
    const result = pickRuleTypeReducer([aspectRow], { aspectCovered: false, toolCovered: false }, "stale label")
    expect(result).toEqual({ kind: "back" })
  })

  it("returns 'fallBackToDeny' when rows are empty and coverage is filtered", () => {
    const result = pickRuleTypeReducer([], { aspectCovered: true, toolCovered: false }, undefined)
    expect(result).toEqual({ kind: "fallBackToDeny" })
  })

  it("returns 'fallBackToDeny' when rows are empty and tool coverage is filtered", () => {
    const result = pickRuleTypeReducer([], { aspectCovered: false, toolCovered: true }, undefined)
    expect(result).toEqual({ kind: "fallBackToDeny" })
  })

  it("returns 'cancel' when rows are empty and no coverage is filtered (programming error)", () => {
    const result = pickRuleTypeReducer([], { aspectCovered: false, toolCovered: false }, undefined)
    expect(result).toEqual({ kind: "cancel" })
  })

  it("prefers 'row' over 'fallBackToDeny' when rows are non-empty", () => {
    // Empty rows + coverage filtered would be 'fallBackToDeny', but
    // non-empty rows means we always go to the row/back/cancel branch.
    const result = pickRuleTypeReducer([toolRow], { aspectCovered: true, toolCovered: true }, toolRow.label)
    expect(result).toEqual({ kind: "row", row: toolRow })
  })
})
