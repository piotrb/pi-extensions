import type { Config } from "./types.ts"
import { HOTKEY_CYCLE_MODE_LABEL, YOLO_MODE } from "./types.ts"

const STATUS_KEY = "tool-policy-mode"

export class ModeController {
  private _currentMode = "default"
  private _warnings: string[] = []

  /** Reset the controller to the first mode in modeOrder. */
  reset(config: Config): void {
    this._currentMode = config.modeOrder[0] ?? "default"
  }

  setWarnings(warnings: string[]): void {
    this._warnings = warnings
  }

  getWarnings(): string[] {
    return this._warnings
  }

  getMode(): string {
    return this._currentMode
  }

  /** Set the current mode. Throws on unknown mode. */
  setMode(name: string, config: Config): void {
    if (!(name in config.modes)) {
      throw new Error(`Unknown mode: ${name}`)
    }
    this._currentMode = name
  }

  /** Cycle to the next mode in modeOrder. Wraps around at the end. */
  cycleMode(config: Config): string {
    const order = config.modeOrder
    if (order.length === 0) return this._currentMode
    const idx = order.indexOf(this._currentMode)
    const next = order[(idx + 1) % order.length]!
    this._currentMode = next
    return next
  }

  /** Update the status bar to show the current mode + hotkey hint. */
  refreshStatusBar(ctx: { ui: { setStatus(key: string, value: string | undefined): void } }): void {
    if (this._currentMode === YOLO_MODE) {
      // Visually distinct status text so the user can tell the extension
      // is fully disabled at a glance (e.g. while dogfooding the
      // extension itself, or recovering from a malformed config).
      ctx.ui.setStatus(STATUS_KEY, `mode: ${YOLO_MODE} (EMERGENCY OFF)  ${HOTKEY_CYCLE_MODE_LABEL} to re-enable`)
      return
    }
    ctx.ui.setStatus(STATUS_KEY, `mode: ${this._currentMode} (${HOTKEY_CYCLE_MODE_LABEL})`)
  }

  /** True when the synthetic YOLO (emergency-off) mode is active. */
  isYolo(): boolean {
    return this._currentMode === YOLO_MODE
  }

  /**
   * Build the additionalInstructions section for the active mode, as a string.
   * Returns an empty string if the active mode has no `additionalInstructions`.
   * The caller (the before_agent_start handler) prepends/appends the result
   * to `event.systemPrompt` per the mode's `mode: "append" | "replace"` flag.
   */
  buildAdditionalInstructions(config: Config): string {
    const mode = config.modes[this._currentMode]
    if (!mode?.additionalInstructions) return ""
    const text = Array.isArray(mode.additionalInstructions.text)
      ? mode.additionalInstructions.text.join("\n")
      : mode.additionalInstructions.text
    return `\n\n[Tool policy mode: ${this._currentMode}]\n${text}\n[/Tool policy mode]`
  }
}
