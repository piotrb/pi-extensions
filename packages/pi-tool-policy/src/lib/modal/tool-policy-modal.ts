import type { ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui"

import type { DirectoryGrantSnapshot } from "../directory-permissions.ts"
import type { STOCK_CONFIG } from "../permission-config.ts"
import type { AggregateResult } from "../tool-metadata.ts"
import type { Config } from "../types.ts"
import { YOLO_MODE } from "../types.ts"
import type { ConfigLayers } from "./debug-modal.ts"
import { openDebugModal } from "./debug-modal.ts"

/** Build the SelectItem[] for the /tool_policy mode switcher. */
export function buildToolPolicyOptions(config: Config, currentMode: string, warnings: string[]): SelectItem[] {
  const modeOptions = config.modeOrder.map((name) => {
    // The synthetic YOLO mode is shown in the list but its visual prefix
    // is different so it stands out as the "emergency off" position. The
    // user can still select it intentionally to disable the extension.
    const isYolo = name === YOLO_MODE
    const prefix = name === currentMode ? (isYolo ? "⚠ ● " : "● ") : isYolo ? "⚠ ○ " : "○ "
    const description = isYolo
      ? "EMERGENCY OFF — extension disabled, all calls pass through"
      : (config.modes[name]?.description ?? "")
    return { value: name, label: `${prefix}${name} — ${description}` }
  })
  const warningsOption =
    warnings.length > 0
      ? [
          {
            value: "warnings",
            label: `Show ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
          },
        ]
      : []
  const debugOption = [{ value: "debug", label: "Debug — inspect stock config & tool metadata" }]
  return [...modeOptions, ...warningsOption, ...debugOption]
}

/**
 * Open the /tool_policy modal. Returns the new mode name (or null on cancel).
 *
 * Renders: one entry per mode in `config.modeOrder` (current mode highlighted);
 * if `warnings.length > 0`, a "show N warnings" entry that opens a scrollable
 * warnings sub-modal; a "Debug" entry that opens a sub-modal with one option
 * per dump source (stock config, discovered tool metadata).
 */
export async function openToolPolicyModal(
  ctx: ExtensionContext,
  config: Config,
  currentMode: string,
  warnings: string[],
  stockConfig: typeof STOCK_CONFIG,
  toolMetadata: AggregateResult,
  liveTools: readonly ToolInfo[],
  activeTools: readonly string[],
  directoryGrants: readonly DirectoryGrantSnapshot[],
  configLayers: ConfigLayers,
): Promise<string | null> {
  const options = buildToolPolicyOptions(config, currentMode, warnings)

  return ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) => {
      const list = new SelectList(options, options.length, {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("dim", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      })
      list.onSelect = (item) => {
        if (item.value === "warnings") {
          // Open a nested warnings sub-modal.
          void ctx.ui
            .custom<string | null>(
              (subTui, subTheme, _subKb, doneWarnings) => {
                const subContainer = new Container()
                subContainer.addChild(new DynamicBorder((s: string) => subTheme.fg("accent", s)))
                subContainer.addChild(new Text(`Warnings (${warnings.length})`, 1, 0))
                subContainer.addChild(new Text(warnings.join("\n"), 1, 0))
                subContainer.addChild(new DynamicBorder((s: string) => subTheme.fg("muted", s)))
                return {
                  render: (w: number) => subContainer.render(w),
                  invalidate: () => {
                    subContainer.invalidate()
                  },
                  handleInput: (data: string) => {
                    if (data === "\x1b" || data === "\x1b\x1b" || data === "q") {
                      doneWarnings(null)
                      subTui.requestRender()
                    }
                  },
                }
              },
              { overlay: true, overlayOptions: { width: "60%", minWidth: 50 } },
            )
            .then((result) => {
              // Either the user closed the warnings (null) or selected a mode
              // name from somewhere — the sub-modal is read-only, so always null.
              done(result)
            })
        } else if (item.value === "debug") {
          // Open a nested debug sub-modal. Stays open on dump-close so the
          // user can inspect multiple sources. We only `done(null)` when
          // the user dismisses the debug sub-modal itself.
          void openDebugModal(
            ctx,
            stockConfig,
            toolMetadata,
            liveTools,
            activeTools,
            directoryGrants,
            configLayers,
          ).then(() => {
            tui.requestRender()
          })
        } else {
          done(item.value)
        }
      }
      list.onCancel = () => {
        done(null)
      }
      const container = new Container()
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
      container.addChild(new Text("Tool policy", 1, 0))
      container.addChild(new Text(`Current mode: ${currentMode}`, 1, 0))
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
