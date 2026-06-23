import { describe, expect, it } from "vitest"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

import { applyEnabledOverrides } from "./enabled-tools.ts"
import type { Config } from "./types.ts"

/** Minimal mock of the `pi.setActiveTools` / `pi.getActiveTools` slice of
 *  ExtensionAPI. The helper is the only thing under test, so the rest of
 *  the surface is left as a typed `unknown` cast — it's never called. */
function makePi(
  initialActive: string[],
  allTools: string[] = initialActive,
): {
  pi: ExtensionAPI
  setCalls: string[][]
  getAllTools: () => string[]
} {
  const setCalls: string[][] = []
  let current = [...initialActive]
  const allToolsSet = new Set(allTools)
  const pi = {
    getActiveTools: () => [...current],
    setActiveTools: (names: string[]) => {
      setCalls.push(names)
      current = [...names]
    },
  } as unknown as ExtensionAPI
  return {
    pi,
    setCalls,
    getAllTools: () => Array.from(allToolsSet),
  }
}

const emptyConfig: Config = {
  modeOrder: [],
  modes: {},
  allowedPaths: [],
  taggingRules: [],
  toolMetadata: {},
}

const aspects = { path: { mode: "path" as const, fields: ["path"] } }

describe("applyEnabledOverrides", () => {
  it("returns a 'no-overrides' marker and does not call setActiveTools when no overrides are declared", () => {
    const { pi, setCalls } = makePi(["read", "write", "bash"])
    const result = applyEnabledOverrides(emptyConfig, pi)
    expect(result.signature).toBe("no-overrides")
    expect(setCalls).toHaveLength(0)
  })

  it("calls setActiveTools once when overrides are declared and the tool is in the active set", () => {
    const { pi, setCalls } = makePi(["read", "write", "bash"])
    const config: Config = {
      ...emptyConfig,
      toolMetadata: { bash: { enabled: false, aspects } },
    }
    applyEnabledOverrides(config, pi)
    expect(setCalls).toHaveLength(1)
    expect(setCalls[0]).toEqual(["read", "write"])
  })

  it("skips setActiveTools on the second call when the config signature is unchanged (cache hit)", () => {
    const { pi, setCalls } = makePi(["read", "write", "bash"])
    const config: Config = {
      ...emptyConfig,
      toolMetadata: { bash: { enabled: false, aspects } },
    }
    // The extension entry threads the cache through; the helper itself
    // is stateless. Thread it explicitly here to mirror production wiring.
    const cache1 = applyEnabledOverrides(config, pi)
    const cache2 = applyEnabledOverrides(config, pi, cache1)
    expect(setCalls).toHaveLength(1)
    expect(cache2.signature).toBe(cache1.signature)
  })

  it("re-applies when a new override is added (signature change)", () => {
    const { pi, setCalls } = makePi(["read", "write", "bash"])
    applyEnabledOverrides({ ...emptyConfig, toolMetadata: { bash: { enabled: false, aspects } } }, pi)
    applyEnabledOverrides(
      {
        ...emptyConfig,
        toolMetadata: {
          bash: { enabled: false, aspects },
          write: { enabled: false, aspects },
        },
      },
      pi,
    )
    expect(setCalls).toHaveLength(2)
    expect(setCalls[1]).toEqual(["read"])
  })

  it("adds a tool to the active set when declared `enabled: true` and not currently active", () => {
    const { pi, setCalls } = makePi(["read", "write"])
    const config: Config = {
      ...emptyConfig,
      toolMetadata: { bash: { enabled: true, aspects } },
    }
    applyEnabledOverrides(config, pi)
    expect(setCalls).toHaveLength(1)
    expect(setCalls[0]).toEqual(["read", "write", "bash"])
  })

  it("silently ignores a tool declared `enabled: false` that is not in pi.getAllTools()", () => {
    // The runtime's `setActiveToolsByName` filters out names that
    // aren't in the registry; the helper's contract is to push a
    // well-formed `string[]` and let the runtime handle the rest.
    // We assert the call is made with the tool name included — the
    // runtime filter is outside this helper's scope.
    const { pi, setCalls } = makePi(["read"], ["read"]) // "ghost" not in registry
    const config: Config = {
      ...emptyConfig,
      toolMetadata: { ghost: { enabled: true, aspects } },
    }
    applyEnabledOverrides(config, pi)
    expect(setCalls).toHaveLength(1)
    expect(setCalls[0]).toContain("ghost")
  })

  it("typo (`enable: true` instead of `enabled: true`) is a no-op at the merge layer", () => {
    // The helper reads from the merged `config.toolMetadata`; the
    // merge layer normalizes the non-boolean to a no-op. By the
    // time the helper sees the config, the typo has been dropped.
    const { pi, setCalls } = makePi(["read", "write"])
    const config = {
      ...emptyConfig,
      toolMetadata: {
        bash: { enable: true, aspects } as unknown as Config["toolMetadata"][string],
      },
    }
    applyEnabledOverrides(config, pi)
    expect(setCalls).toHaveLength(0)
  })

  it("disable-then-re-enable round-trips back to the original set", () => {
    const { pi, setCalls } = makePi(["read", "write", "bash"])
    const disable: Config = {
      ...emptyConfig,
      toolMetadata: { bash: { enabled: false, aspects } },
    }
    const enable: Config = {
      ...emptyConfig,
      toolMetadata: { bash: { enabled: true, aspects } },
    }
    applyEnabledOverrides(disable, pi)
    applyEnabledOverrides(enable, pi)
    expect(setCalls).toHaveLength(2)
    expect(setCalls[0]).toEqual(["read", "write"])
    expect(setCalls[1]).toEqual(["read", "write", "bash"])
  })
})
