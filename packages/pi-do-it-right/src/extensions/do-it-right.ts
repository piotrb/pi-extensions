/**
 * do-it-right — auto-reject bash tool calls that violate user rules.
 *
 * Architecture:
 *   - In-process LLM call via `completeSimple` from `@earendil-works/pi-ai`.
 *   - Rules sourced from a bundled defaults file + user-supplied
 *     override/standard/project markdown files. See `rules.ts`.
 *   - Model configured via `~/.pi/agent/auto-reject-rules.json`
 *     (falls back to anthropic/claude-haiku-4-5). See `settings.ts`.
 *   - Filter: only `event.toolName === "bash"` is checked.
 *   - On violation: return { block: true, reason: <llm reason> }. The
 *     reason follows a two-section shape (Violated rules with quoted
 *     fragments + Suggested fix). The status bar shows the first line;
 *     the full reason flows to the block message.
 *   - On any error path: return undefined (strict fail-open).
 *
 * User controls:
 *   - `/do-it-right` slash command: open a menu, configure the model.
 *
 * Caching:
 *   - At `session_start`, we resolve and cache the rules promise, the
 *     settings, and the model object. The model is resolved once per
 *     session; if it can't be found, we cache `null` so `tool_call`
 *     short-circuits without retrying the registry lookup.
 *   - The `/do-it-right` command can swap the active settings + model
 *     mid-session; tool_call picks up the new model on the next call.
 */

import type { Api, Model } from "@earendil-works/pi-ai"
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent"
import { Container, Editor, type EditorTheme, SelectList, Text } from "@earendil-works/pi-tui"

import { evaluateStream } from "../lib/evaluate.ts"
import {
  buildRulesList,
  loadRules,
  loadRuleSources,
  type RuleSource,
  saveRulesFile,
  SOURCE_LABELS,
} from "../lib/rules.ts"
import { loadSettings, saveSettings, type Settings } from "../lib/settings.ts"

/** Status-bar key for the current model indicator. */
const STATUS_KEY = "do-it-right-model"

function blocked(command: string, reason: string): void {
  console.warn(`[do-it-right] blocked: ${command.slice(0, 80)} — ${reason}`)
}

function failOpen(msg: string): void {
  console.warn(`[do-it-right] ${msg}`)
}

/** Auth material passed through to pi-ai's `completeSimple`. pi-ai's
 *  simple variants only fall back to env vars — for OAuth or auth-storage
 *  managed keys, the caller MUST resolve via `modelRegistry.getApiKeyAndHeaders`
 *  and pass the result here. */
export interface ResolvedAuth {
  apiKey: string
  headers?: Record<string, string>
}
interface CachedState {
  settings: Settings | null
  model: Model<Api> | null
}

export default function (pi: ExtensionAPI): void {
  let cached: CachedState | null = null

  pi.on("session_start", async (_event, ctx) => {
    cached = {
      settings: null,
      model: null,
    }
    await initializeSettings(ctx, cached)
    refreshStatusBar(ctx, cached)
  })

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
    // ── filter ─────────────────────────────────────────────────────────
    if (event.toolName !== "bash") return undefined

    const command = (event.input as { command: string }).command
    if (typeof command !== "string") return undefined

    // ── cache ──────────────────────────────────────────────────────────
    // session_start pre-loaded, but a tool_call before session_start
    // (or after a cwd change) needs a synchronous load. The model +
    // settings are loaded once and cached for the session.
    if (cached === null) {
      const fresh: CachedState = { settings: null, model: null }
      cached = fresh
      void initializeSettings(ctx, fresh).then(() => {
        refreshStatusBar(ctx, fresh)
      })
    }
    const settings = cached.settings
    const model = cached.model
    if (settings === null || model === null) {
      return undefined
    }

    const rules = await loadRules(ctx.cwd)
    if (rules.trim().length === 0) return undefined

    // ── evaluate ───────────────────────────────────────────────────────
    ctx.ui.setStatus(STATUS_KEY, `gate: querying ${model.provider}/${model.id}…`)
    const auth = await resolveAuth(ctx, model)
    let result: { ok: boolean; reason: string }
    try {
      result = await evaluateStream(rules, command, model, { signal: ctx.signal, ...(auth ?? {}) }, (event) => {
        switch (event.type) {
          case "thinking_start":
          case "thinking_delta":
            ctx.ui.setStatus(STATUS_KEY, `gate: ${model.provider}/${model.id} (thinking)…`)
            break
          case "text_delta":
            ctx.ui.setStatus(STATUS_KEY, `gate: ${model.provider}/${model.id} (responding)…`)
            break
          default:
            break
        }
      })
    } catch (err) {
      failOpen(`evaluate failed (fail-open): ${err instanceof Error ? err.message : String(err)}`)
      refreshStatusBar(ctx, cached)
      return undefined
    }
    if (result.ok) {
      // Briefly show the allow verdict, then revert to the model
      // indicator. Without the brief flash, the user can't tell the
      // gate ran — the bash tool just resumes normally.
      ctx.ui.setStatus(STATUS_KEY, `gate: ${model.provider}/${model.id} — allow`)
      setTimeout(() => {
        refreshStatusBar(ctx, cached)
      }, 1500)
      return undefined
    }
    blocked(command, result.reason)
    // The status bar is single-line. The block reason now spans two
    // sections (Violated rules + Suggested fix) and can be many lines
    // long; collapsing it to the first line keeps the status bar
    // readable while still telling the user WHY the gate tripped.
    ctx.ui.setStatus(STATUS_KEY, `gate: ${model.provider}/${model.id} — block: ${firstLine(result.reason)}`)
    setTimeout(() => {
      refreshStatusBar(ctx, cached)
    }, 4000)
    return { block: true, reason: result.reason }
  })

  pi.registerCommand("do-it-right", {
    description: "Configure @piotrb/pi-do-it-right",
    handler: async (_args, ctx) => openConfigMenu(ctx, cached),
  })
}

/** Resolve settings + model + auth and write them into the cache.
 *
 *  One rule: if the configured model is found in the registry AND its
 *  auth resolves, use it. Otherwise try to recover using `ctx.model`
 *  (pi's currently-active model) and persist the new choice so we don't
 *  re-warn on every session. If no fallback exists, fail open — every
 *  bash call passes through unmodified.
 */
async function initializeSettings(ctx: ExtensionContext, state: CachedState): Promise<void> {
  let settings: Settings
  try {
    settings = await loadSettings()
  } catch (err) {
    failOpen(`settings load failed (fail-open): ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  state.settings = settings

  // We only cache the *model* here, not its auth. Auth is re-resolved
  // fresh on every evaluate() call so OAuth tokens that rotate
  // mid-session are picked up automatically. See `resolveAuth`.
  const configured = ctx.modelRegistry.find(settings.model.provider, settings.model.id)
  if (configured) {
    state.model = configured
    return
  }

  // Configured model not in registry — recover using pi's currently-active model.
  const reason = `${settings.model.provider}/${settings.model.id} not found in registry`
  failOpen(`configured model ${reason}`)

  const fallback = ctx.model
  if (!fallback) {
    failOpen("no model active in pi to fall back to; gate is disabled")
    ctx.ui.notify(`do-it-right: configured model ${reason} and pi has no active model — gate is disabled`, "warning")
    return
  }

  ctx.ui.notify(
    `do-it-right: configured model ${reason} — falling back to ${fallback.provider}/${fallback.id}`,
    "warning",
  )

  const fallbackSettings: Settings = { model: { provider: fallback.provider, id: fallback.id } }
  // Update the in-memory cache regardless of disk-write success — if we
  // can recover in-session, do so even if persisting fails.
  state.settings = fallbackSettings
  state.model = fallback
  try {
    await saveSettings(fallbackSettings)
    ctx.ui.notify(`do-it-right: saved ${fallback.provider}/${fallback.id} as new default`, "info")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    failOpen(`failed to persist fallback settings: ${msg}`)
    ctx.ui.notify(`do-it-right: using ${fallback.provider}/${fallback.id} but failed to save: ${msg}`, "warning")
  }
}

/**
 * Resolve a fresh API key + headers for the given model via the
 * registry's `getApiKeyAndHeaders`. Always re-resolves — never cached —
 * so token rotation (e.g. OAuth refreshes between bash calls) is
 * transparent. Returns null on failure.
 */
export async function resolveAuth(ctx: ExtensionContext, model: Model<Api>): Promise<ResolvedAuth | null> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)
  if (!auth.ok || !auth.apiKey) return null
  return { apiKey: auth.apiKey, headers: auth.headers }
}

/** Update the status bar with the current model. Pass `state = null` to clear. */
function refreshStatusBar(ctx: ExtensionContext, state: CachedState | null): void {
  if (state?.settings === null || state?.settings === undefined) {
    ctx.ui.setStatus(STATUS_KEY, undefined)
    return
  }
  const s = state.settings
  ctx.ui.setStatus(STATUS_KEY, `gate: ${s.model.provider}/${s.model.id}`)
}

/** Outer menu — top-level. Two entries:
 *    - "Settings" → opens the configuration sub-menu.
 *    - "Test Evaluation" → prompts for a command, runs the gate on it,
 *      reports the verdict via notify.
 *  Future top-level entries (view rules, recent blocks, etc.) land here. */
async function openConfigMenu(ctx: ExtensionCommandContext, cached: CachedState | null): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("do-it-right: configuration requires an interactive session", "warning")
    return
  }

  const picked = await ctx.ui.select("do-it-right", ["Settings", "Rules", "Test Evaluation"])
  if (picked === "Settings") {
    await openSettingsMenu(ctx, cached)
  } else if (picked === "Rules") {
    await openRulesMenu(ctx, cached)
  } else if (picked === "Test Evaluation") {
    await runTestEvaluation(ctx, cached)
  }
}

/** Level 2 — "Settings" page. Currently has a single entry pointing
 *  at the active model. Picking it opens the model picker. The model's
 *  current value is embedded in the row label so users see the existing
 *  setting before entering the picker. */
async function openSettingsMenu(ctx: ExtensionCommandContext, cached: CachedState | null): Promise<void> {
  const current = cached?.settings ?? (await loadSettings())
  const label = `Evaluation Model: ${current.model.provider}/${current.model.id}`
  const picked = await ctx.ui.select("Settings", [label])
  if (picked !== label) return

  await pickModel(ctx, cached, current)
}

/** Inner menu — list `getAvailable()` models. Picking one saves to disk,
 *  updates the closure cache, and refreshes the status bar.
 *
 *  `current` is the settings object captured at outer-menu open time so
 *  the arrow on the currently-active row reflects what the user just
 *  saw, not whatever may have flipped during a slow picker load. */
async function pickModel(ctx: ExtensionCommandContext, cached: CachedState | null, current: Settings): Promise<void> {
  const available = ctx.modelRegistry.getAvailable()
  if (available.length === 0) {
    ctx.ui.notify("do-it-right: no models have auth configured", "warning")
    return
  }

  // Stable order, sorted by display string. Disambiguate identical
  // display strings by appending " (2)", " (3)", etc.
  const sorted = [...available].sort((a, b) => {
    const ka = `${a.name} · ${a.provider}`
    const kb = `${b.name} · ${b.provider}`
    return ka.localeCompare(kb)
  })

  const labelToModel = new Map<string, Model<Api>>()
  for (const m of sorted) {
    const base = `${m.name} · ${m.provider}`
    let label = base
    let n = 2
    while (labelToModel.has(label)) {
      label = `${base} (${n++})`
    }
    labelToModel.set(label, m)
  }

  // Append an arrow to the currently-active row rather than relocating it.
  const labels = sorted.map((m) => {
    for (const [label, candidate] of labelToModel) {
      if (candidate === m) {
        const marker =
          candidate.id === current.model.id && candidate.provider === current.model.provider ? " ← current" : ""
        return `${label}${marker}`
      }
    }
    return "" // unreachable
  })

  const title = `pick evaluation model (current: ${current.model.provider}/${current.model.id})`
  const picked = await ctx.ui.select(title, labels)
  if (!picked) return

  // The marker is informational — strip it for the lookup.
  const canonical = picked.replace(/\s*← current$/, "").trim()
  const model = labelToModel.get(canonical)
  if (!model) return

  const newSettings: Settings = { model: { provider: model.provider, id: model.id } }
  try {
    await saveSettings(newSettings)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.ui.notify(`do-it-right: failed to save settings: ${msg}`, "error")
    return
  }

  // Update the closure cache so subsequent tool_calls use the new model
  // without re-reading the file.
  if (cached) {
    cached.settings = newSettings
    cached.model = model
    refreshStatusBar(ctx, cached)
  }
  ctx.ui.notify(`do-it-right: now using ${model.provider}/${model.id}`, "info")
}

/** Level 2 — "Rules" page. Shows the four rule-file sources (built-in,
 *  user override, user standard, project) with their line counts and
 *  presence/suppression state. Picking a source opens a read-only
 *  viewer showing its file path and full content.
 *
 *  pi's `SelectList` doesn't have a disabled-item state, so when the
 *  global override suppresses the built-in we surface that as a
 *  status line above the list rather than as a non-selectable row.
 *  The list itself only contains actionable items. */
async function openRulesMenu(ctx: ExtensionCommandContext, _cached: CachedState | null): Promise<void> {
  const cwd = ctx.cwd
  // Load sources (for the per-file menu rows) and the effective text
  // (for the synthetic "Effective" row at the top). Both are cheap;
  // loadRules reuses the same per-file safeRead pattern internally.
  const [sources, effective] = await Promise.all([loadRuleSources(cwd), loadRules(cwd)])
  const view = buildRulesList(sources)
  const effectiveLineCount = effective.length === 0 ? 0 : effective.split("\n").length

  // The "Effective" row is synthetic — it's not a single source, it's
  // the concatenated text the gate's LLM actually sees. We prepend it
  // so it's the first thing the user sees (most common question is
  // "what is the gate looking at right now?").
  const effectiveItem: { value: string; label: string; description: string } = {
    value: EFFECTIVE_ITEM_VALUE,
    label: `Effective — ${effectiveLineCount} lines (concatenated)`,
    description: "the full text the gate's LLM receives",
  }
  const items = [effectiveItem, ...view.items]

  await ctx.ui.custom<string | null>(
    (tui, theme, _kb, done) => {
      const list = new SelectList(items, items.length, {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("dim", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      })
      list.onSelect = (item) => {
        if (item.value === EFFECTIVE_ITEM_VALUE) {
          // Show the concatenated text the gate sees. The header names
          // the order so the user can map sections back to the
          // individual files in the rows below.
          const header = `Effective — built-in, user, project (override replaces built-in)`
          void openReadOnlyTextViewer(ctx, header, effective).then(() => {
            tui.requestRender()
          })
          return
        }
        const src = view.sources.find((s) => s.id === item.value)
        if (!src) return
        // Open the source-specific viewer, then come back to the rules
        // list when the viewer is dismissed.
        void openRuleSourceViewer(ctx, src).then(() => {
          tui.requestRender()
        })
      }
      list.onCancel = () => {
        done(null)
      }
      const container = new Container()
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
      container.addChild(new Text("Rules", 1, 0))
      if (view.suppressionNote) {
        container.addChild(new Text(view.suppressionNote, 1, 0))
      } else {
        container.addChild(new Text("The gate concatenates files in this order: built-in, user, project.", 1, 0))
      }
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
    { overlay: true, overlayOptions: { width: "60%", minWidth: 60 } },
  )
}

/** Sentinel value for the synthetic "Effective" menu row. Not a
 *  `RuleSource["id"]` — it doesn't correspond to a single file. */
const EFFECTIVE_ITEM_VALUE = "__effective__"

/** Sources the user can edit from the Rules view. The bundled rules
 *  are part of the package, and the override is a deliberate "this
 *  replaces built-in" choice — both stay read-only. */
function isEditableSource(id: RuleSource["id"]): boolean {
  return id === "global" || id === "project"
}

/** Display a single rule source. Read-only for built-in / override;
 *  editable (with save on Ctrl+S, cancel on Esc) for user / project. */
async function openRuleSourceViewer(ctx: ExtensionCommandContext, source: RuleSource): Promise<void> {
  if (isEditableSource(source.id)) {
    await openEditableRulesViewer(ctx, source)
  } else {
    await openReadOnlyRulesViewer(ctx, source)
  }
}

/** Read-only viewer for a single block of text. Used by:
 *  - built-in / override rule sources (one path each)
 *  - the "Effective" view (concatenated text from all sources)
 *
 *  Esc / q / Enter dismisses and returns to the rules list. */
async function openReadOnlyTextViewer(ctx: ExtensionCommandContext, header: string, body: string): Promise<void> {
  const display = body.length > 0 ? body : "(empty)"
  await ctx.ui.custom<null>(
    (tui, theme, _kb, done) => {
      const container = new Container()
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
      container.addChild(new Text(header, 1, 0))
      container.addChild(new Text("(read-only)", 1, 0))
      container.addChild(new Text("", 1, 0))
      container.addChild(new Text(display, 1, 0))
      container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)))
      return {
        render: (w: number) => container.render(w),
        invalidate: () => {
          container.invalidate()
        },
        handleInput: (data: string) => {
          if (data === "\x1b" || data === "\x1b\x1b" || data === "q" || data === "\r") {
            done(null)
            tui.requestRender()
          }
        },
      }
    },
    { overlay: true, overlayOptions: { width: "70%", minWidth: 60 } },
  )
}

/** Read-only viewer for built-in / override sources. Thin wrapper
 *  over `openReadOnlyTextViewer` that builds the header from the
 *  source's id + path. */
async function openReadOnlyRulesViewer(ctx: ExtensionCommandContext, source: RuleSource): Promise<void> {
  const header = `${SOURCE_LABELS[source.id]} — ${source.path}`
  await openReadOnlyTextViewer(ctx, header, source.content)
}

/** Editable viewer for user / project sources. Save on Ctrl+S,
 *  cancel on Esc. Save writes to disk; cancel discards changes. */
async function openEditableRulesViewer(ctx: ExtensionCommandContext, source: RuleSource): Promise<void> {
  const header = `${SOURCE_LABELS[source.id]} — ${source.path}`
  await ctx.ui.custom<null>(
    (tui, theme, _kb, done) => {
      const editorTheme: EditorTheme = {
        borderColor: (s: string) => theme.fg("borderAccent", s),
        selectList: {
          selectedPrefix: (s: string) => theme.fg("accent", s),
          selectedText: (s: string) => theme.fg("accent", s),
          description: (s: string) => theme.fg("dim", s),
          scrollInfo: (s: string) => theme.fg("dim", s),
          noMatch: (s: string) => theme.fg("warning", s),
        },
      }
      const editor = new Editor(tui, editorTheme)
      // Pre-fill with the current file content. Editor normalizes line
      // endings and tab expansion on its own.
      editor.setText(source.content)
      // Submit fires on plain Enter by default — for a multi-line
      // markdown editor that's the wrong trigger. Disable it; the user
      // saves with Ctrl+S and cancels with Esc.
      editor.disableSubmit = true
      // Status line below the header. Updated when the user saves.
      let status = "Ctrl+S to save · Esc to cancel"
      const statusLine = new Text(status, 1, 0)
      const container = new Container()
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
      container.addChild(new Text(header, 1, 0))
      container.addChild(statusLine)
      container.addChild(editor)
      container.addChild(new DynamicBorder((s: string) => theme.fg("muted", s)))
      const render = (): void => {
        // `statusLine` is recreated cheaply; the alternative is to give
        // the Text component a `setText` method (it doesn't have one).
        // Rebuilding keeps the dependency on Text simple.
        const replacement = new Text(status, 1, 0)
        Object.assign(statusLine, replacement)
        container.invalidate()
        tui.requestRender()
      }
      const onKey = (data: string): void => {
        // Ctrl+S — save. We bypass the Editor's own submit signal
        // because we disabled it above; the editor still has the
        // current buffer via `getText()`.
        if (data === "\x13" || data === "\x1b[19;5~" || data === "\x1b[1;5S") {
          void (async () => {
            const content = editor.getText()
            const result = await saveRulesFile(source.path, content)
            if (result.saved) {
              status = `✓ saved ${source.path}`
            } else {
              status = `✗ save failed — check permissions on ${source.path}`
            }
            render()
            setTimeout(() => {
              done(null)
              tui.requestRender()
            }, 800)
          })()
          return
        }
        if (data === "\x1b" || data === "\x1b\x1b") {
          done(null)
          tui.requestRender()
          return
        }
        // Forward all other input to the editor so it can render
        // characters, handle backspace, navigate, etc.
        editor.handleInput(data)
        tui.requestRender()
      }
      return {
        render: (w: number) => container.render(w),
        invalidate: () => {
          container.invalidate()
        },
        handleInput: onKey,
      }
    },
    { overlay: true, overlayOptions: { width: "80%", minWidth: 70 } },
  )
}

/**
 * Test the gate against a user-supplied command.
 *
 *   1. Resolve the cached settings + model. If the model has no auth, fail
 *      with an error notify — same fail-open contract as `tool_call`.
 *   2. Wait for the rules to be ready (cached promise if available,
 *      otherwise a fresh load). Empty rules short-circuits to a warning
 *      — without rules the gate is a no-op and "test" cannot yield a
 *      verdict.
 *   3. Prompt for a command via `ui.input`. Esc cancels.
 *   4. Run `evaluate` exactly as the live `tool_call` gate would.
 *   5. Surface the verdict via notify:
 *        ok:true   → info  "would allow — <reason>"
 *        ok:false  → warning "would block — <reason>"
 *      If `evaluate` throws (network, model error, parse fail), the error
 *      message is shown as an error notify — the test is inconclusive
 *      but the user knows why.
 */
async function runTestEvaluation(ctx: ExtensionCommandContext, cached: CachedState | null): Promise<void> {
  const current = cached?.settings ?? (await loadSettings())
  const model = cached?.model ?? ctx.modelRegistry.find(current.model.provider, current.model.id)
  if (!model) {
    ctx.ui.notify(`do-it-right: model ${current.model.provider}/${current.model.id} not found`, "error")
    return
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    ctx.ui.notify(`do-it-right: model ${current.model.provider}/${current.model.id} has no auth`, "error")
    return
  }

  const rules = await loadRules(ctx.cwd)
  if (rules.trim().length === 0) {
    ctx.ui.notify("do-it-right: no rules configured — gate would let everything through", "warning")
    return
  }

  const command = await ctx.ui.input("Test the gate against a command", "bash command")
  if (!command) return

  // Streaming widget so the user can see what the model is producing.
  // Layout:
  //   $ <command>
  //   (blank)
  //   > <latest thinking text, truncated>
  //   (during a thinking block: the in-progress buffer)
  //   <text deltas, accumulated>
  // When the stream finishes, the verdict is appended and a notify
  // carries the short form.
  const WIDGET_KEY = "do-it-right-eval"

  const THINKING_LIMIT = 1000
  const truncate = (s: string): string => (s.length > THINKING_LIMIT ? `…${s.slice(-THINKING_LIMIT)}` : s)

  let thinkingBuffer = ""
  let completedThinking = ""
  let textBuffer = ""

  const render = (): void => {
    const lines: string[] = [`$ ${command}`, ""]
    if (thinkingBuffer || completedThinking) {
      lines.push(`[thinking] ${truncate(thinkingBuffer || completedThinking)}`)
    }
    // The model streams text as a single string with embedded newlines.
    // Split on every newline so each line becomes its own widget entry
    // — otherwise the verdict (which is two sections separated by blank
    // lines) would render as one mangled block in the widget.
    if (textBuffer) {
      const buffered = textBuffer.split("\n")
      for (const line of buffered) {
        // `split` yields an empty trailing entry when the buffer ends
        // with a newline; drop it so the widget doesn't grow a stray
        // blank line on every render.
        if (line.length === 0 && buffered[buffered.length - 1] === line) continue
        lines.push(line)
      }
    }
    ctx.ui.setWidget(WIDGET_KEY, lines)
  }
  render()

  let result: { ok: boolean; reason: string }
  try {
    const auth = await resolveAuth(ctx, model)
    result = await evaluateStream(rules, command, model, { signal: ctx.signal, ...(auth ?? {}) }, (event) => {
      switch (event.type) {
        case "thinking_start":
          // A new block starts. Clear the in-progress buffer.
          thinkingBuffer = ""
          render()
          break
        case "thinking_delta":
          thinkingBuffer += event.delta
          render()
          break
        case "thinking_end":
          // Block finished — fold into the "completed thinking"
          // display so we keep the most recent reasoning on screen
          // even if more blocks follow.
          completedThinking = thinkingBuffer
          thinkingBuffer = ""
          render()
          break
        case "text_delta":
          textBuffer += event.delta
          render()
          break
        // text_start, text_end, toolcall_*: ignored. The gate doesn't
        // pass tools, so tool_use would be an anomaly.
        default:
          break
      }
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Keep the widget on screen with whatever streamed in so the user
    // can see what the model was doing when the failure happened.
    // Append the failure and re-render; the notify carries the short form.
    textBuffer = (textBuffer ? textBuffer + "\n\n" : "") + `[error] ${msg}`
    render()
    ctx.ui.notify(`do-it-right: evaluation failed — see widget; ${msg}`, "error")
    return
  }

  // Show the verdict in the widget for a beat, then drop it. A notify
  // carries the short form; the widget was for live observation.
  // The verdict marker sits on its own line; the reason (now a two-
  // section shape with blank-line separators) follows on its own lines.
  // Splitting at the boundary keeps the widget readable — a one-line
  // marker followed by the structured reason, each line as its own
  // widget entry.
  const marker = result.ok ? `✓ would allow` : `✗ would block`
  textBuffer = (textBuffer ? textBuffer + "\n\n" : "") + `${marker}\n${result.reason}`
  render()

  if (result.ok) {
    ctx.ui.notify(`do-it-right: would allow — ${result.reason}`, "info")
  } else {
    ctx.ui.notify(`do-it-right: would block — ${result.reason}`, "warning")
  }
}

/** First line of a string. The block reason is now two sections
 *  separated by blank lines; the status bar shows only the headline
 *  (first line) so it stays single-line readable. */
function firstLine(s: string): string {
  const idx = s.indexOf("\n")
  return idx === -1 ? s : s.slice(0, idx)
}
