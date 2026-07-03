import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui"

import { dumpTools, openDumpModal } from "./dump-modal.ts"

/**
 * Build the SelectItem[] for the Tools sub-menu. One entry per tool,
 * sorted by name. Tools that are NOT in `activeTools` get " (disabled)"
 * appended to the label so the user can tell at a glance which tools
 * are currently inactive (separate from policy — see /tools for
 * interactive enable/disable).
 *
 * The list is the navigable form of what `dumpTools` used to dump in
 * full: just `name` + an `enabled` hint, sorted, so a 30-tool registry
 * becomes a 30-line scannable list rather than a 200-line JSON blob.
 */
export function buildToolsList(tools: readonly ToolInfo[], activeTools: readonly string[]): SelectItem[] {
  const activeSet = new Set(activeTools)
  return [...tools]
    .map((t) => ({ tool: t, enabled: activeSet.has(t.name) }))
    .sort((a, b) => a.tool.name.localeCompare(b.tool.name))
    .map(({ tool, enabled }) => ({
      value: tool.name,
      label: enabled ? tool.name : `${tool.name} (disabled)`,
    }))
}

/**
 * Format the popover content for a single tool. The shape depends on
 * `sourceInfo`:
 *   - built-in (source === "builtin" && origin === "top-level"):
 *       two short lines identifying it as a built-in and its enabled state.
 *   - package (origin === "package"):
 *       five short lines naming the package and its install location.
 *   - else:
 *       a pretty-printed JSON dump of `{ name, enabled, sourceInfo }`.
 *       Used for any tool that doesn't match the two common shapes —
 *       in practice this catches malformed `sourceInfo`, but the JSON
 *       still answers "where did this tool come from?" via the same
 *       projection `dumpTools` always used.
 *
 * The structured short forms cut out the typebox parameter schema and
 * other noise — the user came here to see provenance, not internals.
 * For `baseDir` (the only optional SourceInfo field), we print the raw
 * value; if it's missing, JavaScript renders it as `undefined`, which
 * is honest debug output rather than a silently-omitted field.
 */
export function formatToolDetail(tool: ToolInfo, enabled: boolean): string {
  const si = tool.sourceInfo
  if (si.source === "builtin" && si.origin === "top-level") {
    return ["built-in", `enabled: ${enabled}`].join("\n")
  }
  if (si.origin === "package") {
    return [
      `package: ${si.source}`,
      `enabled: ${enabled}`,
      `baseDir: ${si.baseDir}`,
      `path: ${si.path}`,
      `scope: ${si.scope}`,
    ].join("\n")
  }
  return dumpTools([tool], enabled ? [tool.name] : [])
}

/**
 * Open the Tools sub-modal. Renders one entry per tool (sorted by name).
 * Selecting a tool opens a popover (via the dump-modal scroller) with
 * the structured detail for that tool; the user dismisses the popover
 * to return to the list and inspect another tool. Esc on the list
 * dismisses back to the caller (the parent debug sub-modal).
 *
 * Same two-level pattern as `openDebugModal`: the list stays alive
 * across popover opens so the user's selected/scroll position is
 * preserved while they inspect multiple tools in a row.
 */
export async function openToolsListModal(
  ctx: ExtensionContext,
  tools: readonly ToolInfo[],
  activeTools: readonly string[],
): Promise<null> {
  const options = buildToolsList(tools, activeTools)
  const activeSet = new Set(activeTools)

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
        const tool = tools.find((t) => t.name === item.value)
        if (!tool) return
        const content = formatToolDetail(tool, activeSet.has(tool.name))
        void openDumpModal(ctx, tool.name, content).then(() => {
          // Re-render the parent so the footer/selected-prefix state stays
          // consistent with the underlying SelectList after the overlay
          // closes. We don't `done()` here — staying on the Tools sub-menu
          // lets the user inspect multiple tools in a row.
          tui.requestRender()
        })
      }
      list.onCancel = () => {
        done(null)
      }
      const container = new Container()
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
      container.addChild(new Text("Tools", 1, 0))
      container.addChild(new Text("Pick a tool to inspect", 1, 0))
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
