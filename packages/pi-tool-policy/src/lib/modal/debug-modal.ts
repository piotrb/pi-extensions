import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui"

import type { DirectoryGrantSnapshot } from "../directory-permissions.ts"
import type { AggregateResult } from "../tool-metadata.ts"
import type { Config } from "../types.ts"
import { openDumpModal } from "./dump-modal.ts"
import { openToolsListModal } from "./tools-list-modal.ts"

/**
 * The three raw `modes` blocks that feed into the final merged config:
 *   - stock: the in-source STOCK_CONFIG.modes (the baseline)
 *   - user:  the user's ~/.pi/tool-policy.json `modes` (or {})
 *   - project: the project's <cwd>/.pi/tool-policy.json `modes` (or {})
 *
 * The merge order is stock → user → project (project wins, deep-merged).
 * The debug menu's "config layers" view shows all three side-by-side
 * alongside the merged result, so the user can see exactly which field
 * came from which layer.
 */
export interface ConfigLayers {
  stock: Config["modes"]
  user: Config["modes"]
  project: Config["modes"]
  merged: Config["modes"]
  /** The active modeOrder after merging + YOLO injection. */
  modeOrder: Config["modeOrder"]
}

/** The dump-source values exposed by the debug sub-menu. */
export type DebugSource = "stock_config" | "tool_metadata" | "tools" | "directory_permissions" | "config_layers"

/** Build the SelectItem[] for the debug sub-menu. */
export function buildDebugOptions(): SelectItem[] {
  return [
    { value: "stock_config", label: "Stock Config — the in-source default config" },
    {
      value: "tool_metadata",
      label: "Discovered Tool Metadata — what each extension declared (pre-merge)",
    },
    {
      value: "tools",
      label: "Tools — the live tool registry (name + sourceInfo per tool)",
    },
    {
      value: "directory_permissions",
      label: "Directory Permissions — current allowed paths and required tags",
    },
    {
      value: "config_layers",
      label: "Config Layers — stock / user / project / merged (modes only)",
    },
  ]
}

/**
 * Serialize a `Config` for the dump-modal. The full Config may contain
 * Maps/cycles/circular refs in principle; JSON.stringify with a replacer
 * drops Map entries and undefined values, so the output is a plain object
 * ready for pretty-printing.
 */
export function dumpConfig(config: Config): string {
  return JSON.stringify(config, null, 2)
}

/**
 * Serialize the *pre-merge* per-extension metadata for the dump-modal.
 * Returns just the `pi.toolMetadata` blocks read out of each extension's
 * package.json, BEFORE they get folded together with the built-in
 * `STOCK_BUILTIN_TOOL_METADATA` and the config overrides. This shows
 * "what did each extension actually declare?" without the built-in layer
 * polluting the picture.
 */
export function dumpToolMetadata(result: AggregateResult): string {
  return JSON.stringify(result.discovered, null, 2)
}

/** Serialize the directory-permissions grant store for the dump-modal. */
export function dumpDirectoryPermissions(grants: readonly DirectoryGrantSnapshot[]): string {
  return JSON.stringify(grants, null, 2)
}

/**
 * Serialize the three raw `modes` layers + the final merged `modes`
 * for the dump-modal. Helps the user see exactly which field came from
 * which layer (stock vs. user vs. project) when a partial override
 * produces surprising behavior.
 */
export function dumpConfigLayers(layers: ConfigLayers): string {
  return JSON.stringify(layers, null, 2)
}

/**
 * Open the debug sub-modal. Returns null when the user dismisses it (Esc).
 *
 * Renders one entry per available dump source. Selecting an entry opens a
 * nested dump-modal containing the pretty-printed JSON; on close, this
 * sub-modal stays open so the user can pick another source.
 */
export async function openDebugModal(
  ctx: ExtensionContext,
  stockConfig: Config,
  toolMetadataResult: AggregateResult,
  liveTools: readonly ToolInfo[],
  activeTools: readonly string[],
  directoryGrants: readonly DirectoryGrantSnapshot[],
  configLayers: ConfigLayers,
): Promise<null> {
  const options = buildDebugOptions()

  return ctx.ui.custom<null>(
    (tui, theme, _kb, done) => {
      const list = new SelectList(options, options.length, {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("dim", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      })
      list.onSelect = (item) => {
        const source = item.value as DebugSource
        let content: string
        let title: string
        switch (source) {
          case "stock_config":
            content = dumpConfig(stockConfig)
            title = "Stock Config"
            break
          case "tool_metadata":
            content = dumpToolMetadata(toolMetadataResult)
            title = "Discovered Tool Metadata"
            break
          case "tools":
            // Tools gets its own two-level sub-modal: pick a tool, then
            // see its structured detail in a popover. We `return` (not
            // `break`) so the dump-modal popover machinery doesn't run
            // — openToolsListModal is a sibling of this debug sub-modal,
            // not a child dump.
            void openToolsListModal(ctx, liveTools, activeTools).then(() => {
              tui.requestRender()
            })
            return
          case "directory_permissions":
            content = dumpDirectoryPermissions(directoryGrants)
            title = "Directory Permissions"
            break
          case "config_layers":
            content = dumpConfigLayers(configLayers)
            title = "Config Layers (modes)"
            break
        }
        void openDumpModal(ctx, title, content).then(() => {
          // Re-render the parent so the footer/selected-prefix state stays
          // consistent with the underlying SelectList after the overlay
          // closes. We don't `done()` here — staying on the debug sub-menu
          // lets the user inspect another source.
          tui.requestRender()
        })
      }
      list.onCancel = () => {
        done(null)
      }
      const container = new Container()
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
      container.addChild(new Text("Debug", 1, 0))
      container.addChild(new Text("Pick a source to inspect", 1, 0))
      container.addChild(list)
      container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)))
      return {
        render: (w: number) => container.render(w),
        invalidate: () => {
          container.invalidate()
        },
        handleInput: (data: string) => {
          list.handleInput(data)
          tui.requestRender()
        },
      }
    },
    { overlay: true, overlayOptions: { width: "50%", minWidth: 44 } },
  )
}
