/**
 * streaming-widget — transient above-editor widget that mirrors a live
 * `evaluateStream` call as it streams.
 *
 * Used from two call sites:
 *   - the live `tool_call` gate, where the widget shows the model
 *     thinking + responding for the duration of one bash call
 *     (auto-clears after the verdict).
 *   - the `/do-it-right` → "Test Evaluation" sub-command, where the
 *     widget is the user's primary observation surface (left up for
 *     the user to inspect or dismiss).
 *
 * Both call sites used to inline their own buffer/render closures; this
 * module is the single place that knows the truncation limit, the buffer
 * layout, and the line-split rules for embedded newlines.
 *
 * The widget is fire-and-forget. `ctx.ui.setWidget(key, lines)` queues a
 * render; the helper makes no assumptions about when (or if) the user
 * sees it. On non-TUI modes (`ctx.hasUI === false`) the helper is a
 * no-op: the underlying `setWidget` calls are dropped.
 */

import type { AssistantMessageEvent } from "@earendil-works/pi-ai"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

/** The pi widget slot key used by `ctx.ui.setWidget`. Stable so the
 *  widget replaces itself in place across consecutive gate calls rather
 *  than stacking up multiple widget rows. */
export const WIDGET_KEY = "do-it-right-eval"

/** Truncate the displayed reasoning tail to `THINKING_LIMIT` chars so a
 *  long thinking block doesn't push the verdict offscreen. The head is
 *  dropped (a leading `…` is rendered) because the model's most recent
 *  reasoning is what matters for understanding the verdict. */
export const THINKING_LIMIT = 1000

/** Single decision point for the future toggle. Today: on. Add a setting
 *  field, e.g. `settings.showStreamingWidget`, and read it here — both
 *  call sites (live gate + Test Evaluation) honor the toggle in one
 *  place. */
export function useStreamingWidget(): boolean {
  return true
}

/** Handle returned from `startStreamingWidget`. The caller hands
 *  `onEvent` to `evaluateStream`'s callback parameter; on verdict the
 *  caller invokes `finish(verdict, reason)` once and is done. */
export interface StreamingWidget {
  /** Filter + buffer the streamed events from `evaluateStream`. */
  onEvent: (event: AssistantMessageEvent) => void
  /** Append the verdict marker + reason, render once, then schedule
   *  `clear()` after `clearAfterMs`. The caller should also fire any
   *  coarse-grained UI it owns (status bar, notify). */
  finish: (verdict: "allow" | "block", reason: string, clearAfterMs: number) => void
  /** Drop the widget immediately (no scheduled timeout). Use after a
   *  thrown error or when the gate fails open. */
  clear: () => void
}

/** Wire up the streaming widget for one gate call.
 *
 *  Returns a handle with `onEvent` for the live stream callback and
 *  `finish` / `clear` for the verdict tail. Calling `start` does not
 *  render anything yet; the first event (or `finish`) triggers the
 *  initial render. If the gate returns no events and no verdict (the
 *  error / fail-open path), the caller should `clear()` to drop any
 *  residual widget surface. */
export function startStreamingWidget(command: string, ctx: Pick<ExtensionContext, "ui">): StreamingWidget {
  // Buffers are closure-private. `render` is the only function that
  // touches `ctx.ui.setWidget` — keeping the side effect in one place
  // is what makes the widget replaceable in place across overlapping
  // gate calls (a second `start` overwrites the first; there is no
  // stale state to clear).
  let thinkingBuffer = ""
  let completedThinking = ""
  let textBuffer = ""

  const render = (): void => {
    const lines: string[] = [`$ ${command}`, ""]
    if (thinkingBuffer || completedThinking) {
      lines.push(`[thinking] ${truncate(thinkingBuffer || completedThinking)}`)
    }
    // The model streams text as one string with embedded newlines.
    // Split on every newline so each line is its own widget entry —
    // otherwise the two-section verdict (blank-line separated) would
    // render as one mangled block in the widget.
    if (textBuffer) {
      const buffered = textBuffer.split("\n")
      for (const line of buffered) {
        // `split` yields a trailing empty entry when the buffer ends
        // with `\n`; drop it so the widget doesn't grow a stray blank
        // line on every render.
        if (line.length === 0 && buffered[buffered.length - 1] === line) continue
        lines.push(line)
      }
    }
    ctx.ui.setWidget(WIDGET_KEY, lines)
  }

  const onEvent = (event: AssistantMessageEvent): void => {
    switch (event.type) {
      case "thinking_start":
        // A new block starts. Reset the in-progress buffer; the prior
        // block (if any) was already folded into `completedThinking`
        // by an earlier `thinking_end`.
        thinkingBuffer = ""
        render()
        break
      case "thinking_delta":
        thinkingBuffer += event.delta
        render()
        break
      case "thinking_end":
        // Block finished. Fold into the "completed thinking" display
        // so we keep the most recent reasoning on screen even if
        // more blocks follow.
        completedThinking = thinkingBuffer
        thinkingBuffer = ""
        render()
        break
      case "text_delta":
        textBuffer += event.delta
        render()
        break
      // `start`, `text_start`, `text_end`, `done`, `error`, `toolcall_*`:
      // ignored. The gate doesn't pass tools, so `tool_use` would be
      // an anomaly worth surfacing; today we silently drop it.
      default:
        break
    }
  }

  const finish = (verdict: "allow" | "block", reason: string, clearAfterMs: number): void => {
    const marker = verdict === "allow" ? "✓ would allow" : "✗ would block"
    // Append the verdict marker on its own line, then the structured
    // reason verbatim. `split("\n")` in `render` will split the reason
    // across widget lines so the two-section shape renders readably.
    textBuffer = (textBuffer ? textBuffer + "\n\n" : "") + `${marker}\n${reason}`
    render()
    setTimeout(() => {
      ctx.ui.setWidget(WIDGET_KEY, undefined)
    }, clearAfterMs)
  }

  const clear = (): void => {
    ctx.ui.setWidget(WIDGET_KEY, undefined)
  }

  return { onEvent, finish, clear }
}

/** Truncate from the head with a leading ellipsis when over the limit.
 *  We keep the tail (most recent reasoning) rather than the head. */
function truncate(s: string): string {
  if (s.length <= THINKING_LIMIT) return s
  return `…${s.slice(-THINKING_LIMIT)}`
}
