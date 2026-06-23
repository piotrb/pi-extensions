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

  /**
   * The inheritance chain for the active mode, ordered from the mode
   * itself down to the root (the mode with no `extends`).
   *
   * Example: if `edit` extends `default` and `default` extends
   * `readonly`, returns `["edit", "default", "readonly"]`. For a
   * standalone mode (no `extends`), returns just `[modeName]`.
   *
   * The chain drives the target-mode picker in the save-rule modal:
   * the user can choose to write a new rule into any mode in the
   * chain. Writing to a parent mode makes the rule apply to every
   * mode that inherits from it.
   *
   * Cycles are short-circuited to the first repetition, so a malformed
   * config (e.g. `a extends b` and `b extends a`) won't infinite-loop.
   * The chain is whatever the config says, in declaration order.
   *
   * Reads from the *raw* (pre-resolve) config so the `extends` field
   * is still present on the mode blocks. The loader's
   * `resolveExtends` strips `extends` from the resolved modes, so
   * calling this on a post-resolve config would always return a
   * 1-element chain.
   */
  getExtendsChain(rawConfig: Config): string[] {
    return computeExtendsChain(rawConfig, this._currentMode)
  }
}

/**
 * Pure helper. Walks the `extends` graph from `modeName` and returns
 * the chain in declaration order (the mode itself, then its parents
 * in the order they appear in `extends`).
 *
 * Exported for tests and for callers that have a raw config but no
 * ModeController (e.g. the save-rule modal computing the picker list
 * for a non-current mode).
 */
export function computeExtendsChain(rawConfig: Config, modeName: string): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let current: string | undefined = modeName
  while (current && !seen.has(current)) {
    if (!(current in rawConfig.modes)) {
      // Unknown mode in the chain — stop here. The loader emits a
      // warning for this; the chain returns whatever we collected
      // before the unknown link.
      break
    }
    seen.add(current)
    chain.push(current)
    const parents: string[] | undefined = rawConfig.modes[current]?.extends
    current = parents?.[0]
  }
  return chain
}
