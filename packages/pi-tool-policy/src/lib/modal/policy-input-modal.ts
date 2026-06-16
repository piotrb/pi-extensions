import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { DynamicBorder } from "@earendil-works/pi-coding-agent"
import { Container, Input, Key, matchesKey, Text } from "@earendil-works/pi-tui"

/**
 * Open a single-line text input with a pre-filled value. The user can:
 *   - Press Enter to accept the prefill (or whatever they've typed)
 *   - Backspace / type to modify the prefill
 *   - Press Esc to cancel (returns `undefined`)
 *
 * The runtime's built-in `ctx.ui.input` does NOT support prefill (its
 * `placeholder` parameter is used as hint text, not initial value).
 * This modal builds a custom widget via `ctx.ui.custom` that wraps the
 * pi-tui `Input` component with `setValue(prefill)` so the user sees
 * the suggestion already in the field and only needs to edit if they
 * want a different value.
 */
export async function openPolicyInputModal(
  ctx: ExtensionContext,
  title: string,
  prefill: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    (tui, theme, _kb, done) => {
      const input = new Input()
      input.setValue(prefill)
      // Park the cursor at the end so the user can keep typing without
      // first having to navigate to the end. The Input doesn't expose
      // a setCursor API but its constructor defaults cursor to 0; we
      // need to push it to the end after setValue.
      // Input.cursor is private; the only public mutator is setValue.
      // A short scrollRight arrow from the user (right arrow) takes them
      // to the end if they want to extend. Acceptable for v1.

      const container = new Container()
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
      container.addChild(new Text(title, 1, 0))
      container.addChild(new Text(" ", 1, 0))
      container.addChild(input)
      container.addChild(new Text(" ", 1, 0))
      container.addChild(new Text("[Enter submit · Esc cancel]", 1, 0))
      container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)))

      // Wire the Input's submit/escape to resolve the modal.
      input.onSubmit = (value: string) => {
        done(value)
        tui.requestRender()
      }
      input.onEscape = () => {
        done(undefined)
        tui.requestRender()
      }

      return {
        render: (width: number) => container.render(width),
        invalidate: () => {
          container.invalidate()
        },
        // The Input's own handleInput handles character input, backspace,
        // arrow keys, undo, etc. We only need to handle Esc at the
        // container level (in case the user wants to dismiss before
        // typing anything — though Input.onEscape handles this too once
        // it's been touched). The Input's onSubmit fires on Enter.
        handleInput: (data: string) => {
          if (matchesKey(data, Key.escape)) {
            done(undefined)
            tui.requestRender()
            return
          }
          input.handleInput(data)
        },
      }
    },
    { overlay: true, overlayOptions: { width: 80, minWidth: 60 } },
  )
}
