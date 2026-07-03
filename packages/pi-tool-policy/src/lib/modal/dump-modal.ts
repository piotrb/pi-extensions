import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import { Container, Key, matchesKey, Text } from "@earendil-works/pi-tui"

/**
 * Serialize the live `ToolInfo[]` for the dump-modal. Each entry is
 * projected to `{ name, sourceInfo, enabled }` — the typebox parameter
 * schema is dropped (it bloats the dump and isn't useful for "where did
 * this tool come from?" debugging). The `enabled` flag comes from
 * `pi.getActiveTools()` and reflects the runtime tool-activation state
 * (separate from policy — see /tools for interactive enable/disable).
 */
export function dumpTools(tools: readonly ToolInfo[], activeTools: readonly string[]): string {
  const activeSet = new Set(activeTools)
  const projected = tools.map((t) => ({
    name: t.name,
    enabled: activeSet.has(t.name),
    sourceInfo: t.sourceInfo,
  }))
  return JSON.stringify(projected, null, 2)
}

/**
 * Open a scrollable text-view modal. Renders `content` inside a bordered
 * container; the user can scroll line-by-line with arrow keys or page at a
 * time with Page Up/Page Down. Esc or q dismisses.
 *
 * Pure presentation — the dump-content shape (pretty-printed JSON, etc.) is
 * the caller's responsibility. This modal just shows whatever string is
 * handed to it.
 */
export async function openDumpModal(ctx: ExtensionContext, title: string, content: string): Promise<null> {
  return ctx.ui.custom<null>(
    (tui, theme, _kb, done) => {
      const lines = content.split("\n")
      let scrollOffset = 0

      const container = new Container()
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
      container.addChild(new Text(title, 1, 0))
      const body = new Text("", 1, 0)
      container.addChild(body)
      const footer = new Text("", 1, 0)
      container.addChild(footer)
      container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)))

      const updateFooter = () => {
        const totalLines = lines.length
        const start = scrollOffset + 1
        // The visible window extends to the bottom of the rendered body
        // (we slice from scrollOffset to the end), so report the full
        // remaining range.
        const positionInfo = `Line ${start} of ${totalLines}`
        const hint = "↑/↓ scroll · PgUp/PgDn page · Home/End jump · Esc/q close"
        footer.setText(theme.fg("dim", `${positionInfo}  ·  ${hint}`))
      }

      const renderBody = () => {
        // Render a windowed slice of the lines starting at `scrollOffset`.
        // The overlay's maxHeight clips the visible viewport; the rest of
        // the body is rendered into the (off-screen) text lines the
        // Container stacks.
        const visible = lines.slice(scrollOffset)
        body.setText(visible.join("\n"))
        updateFooter()
      }

      const maxOffset = () => Math.max(0, lines.length - 1)

      return {
        render: (width: number) => {
          renderBody()
          return container.render(width)
        },
        invalidate: () => {
          container.invalidate()
        },
        handleInput: (data: string) => {
          if (matchesKey(data, Key.escape) || data === "q" || data === "Q") {
            done(null)
            tui.requestRender()
            return
          }
          if (matchesKey(data, Key.up)) {
            if (scrollOffset > 0) scrollOffset--
            tui.requestRender()
            return
          }
          if (matchesKey(data, Key.down)) {
            if (scrollOffset < maxOffset()) scrollOffset++
            tui.requestRender()
            return
          }
          if (matchesKey(data, Key.pageUp)) {
            scrollOffset = Math.max(0, scrollOffset - 20)
            tui.requestRender()
            return
          }
          if (matchesKey(data, Key.pageDown)) {
            scrollOffset = Math.min(maxOffset(), scrollOffset + 20)
            tui.requestRender()
            return
          }
          if (matchesKey(data, Key.home)) {
            scrollOffset = 0
            tui.requestRender()
            return
          }
          if (matchesKey(data, Key.end)) {
            scrollOffset = maxOffset()
            tui.requestRender()
          }
        },
      }
    },
    { overlay: true, overlayOptions: { width: "80%", minWidth: 60, maxHeight: "80%" } },
  )
}
