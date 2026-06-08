/**
 * runner-modal — TUI modal for managing runner permissions.
 *
 * Entry point: openRunnerModal(ctx, cwd)
 *
 * Screen flow:
 *   Main Menu → Rules List → action menu → Edit/Add modal
 *                                        → Delete confirm
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent"
import {
  Container,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui"

import type { Rule, RuleLevel } from "./permissions.ts"
import {
  loadRules,
  readRtkEnabled,
  removeRuleFromFile,
  scopeToConfigPath,
  UI_SCOPES,
  writeRtkEnabled,
  writeRuleToFile,
} from "./runner-config.ts"

// ─── constants ────────────────────────────────────────────────────────────────

const ACTIONS: RuleLevel[] = ["allow", "ask", "deny"]
type UiScope = "project" | "user"

// ─── helpers ─────────────────────────────────────────────────────────────────

function actionColor(level: RuleLevel): "success" | "warning" | "error" {
  if (level === "allow") return "success"
  if (level === "ask") return "warning"
  return "error"
}

// ─── main entry point ─────────────────────────────────────────────────────────

export async function openRunnerModal(ctx: ExtensionCommandContext, cwd: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const choice = await showMainMenu(ctx)
    if (choice === null) return
    if (choice === "rules") {
      await showRulesScreen(ctx, cwd)
    } else {
      // "settings"
      await showSettingsScreen(ctx)
    }
  }
}

// ─── screen 1: main menu ─────────────────────────────────────────────────────

async function showMainMenu(ctx: ExtensionCommandContext): Promise<"rules" | "settings" | null> {
  const items: SelectItem[] = [
    { value: "rules", label: "Rules" },
    { value: "settings", label: "Settings" },
  ]

  return ctx.ui.custom<"rules" | "settings" | null>(
    (tui, theme, _kb, done) => {
      const container = new Container()
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
      container.addChild(new Text(theme.fg("accent", theme.bold(" Runner")), 1, 0))

      const list = new SelectList(items, items.length, {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("dim", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      })
      list.onSelect = (item) => {
        done(item.value as "rules" | "settings")
      }
      list.onCancel = () => {
        done(null)
      }
      container.addChild(list)
      container.addChild(new Text(theme.fg("dim", " enter select  •  esc close"), 1, 0))
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

      return {
        render: (w) => container.render(w),
        invalidate: () => {
          container.invalidate()
        },
        handleInput: (data) => {
          list.handleInput(data)
          tui.requestRender()
        },
      }
    },
    { overlay: true, overlayOptions: { width: "50%", minWidth: 44 } },
  )
}

// ─── screen 1b: settings ─────────────────────────────────────────────────────

async function showSettingsScreen(ctx: ExtensionCommandContext): Promise<void> {
  await ctx.ui.custom(
    (tui, theme, _kb, done) => {
      const items: SettingItem[] = [
        {
          id: "rtkEnabled",
          label: "Enable RTK support",
          currentValue: readRtkEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
      ]

      const container = new Container()
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
      container.addChild(new Text(theme.fg("accent", theme.bold(" Settings")), 1, 0))

      const settingsList = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        getSettingsListTheme(),
        (_id, newValue) => {
          writeRtkEnabled(newValue === "on")
        },
        () => {
          done(undefined)
        },
      )
      container.addChild(settingsList)
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

      return {
        render: (w) => container.render(w),
        invalidate: () => {
          container.invalidate()
        },
        handleInput: (data) => {
          settingsList.handleInput(data)
          tui.requestRender()
        },
      }
    },
    { overlay: true, overlayOptions: { width: "50%", minWidth: 44 } },
  )
}

// ─── screen 2: rules screen (loop) ───────────────────────────────────────────

async function showRulesScreen(ctx: ExtensionCommandContext, cwd: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    const result = await showRulesList(ctx, cwd)
    if (result === null) return // esc → back to main menu

    if (result.kind === "add") {
      await showEditModal(ctx, cwd, null)
      continue
    }

    const action = await showActionMenu(ctx, result.rule)
    if (!action) continue

    if (action === "edit") {
      await showEditModal(ctx, cwd, result.rule)
    } else {
      const ok = await showDeleteConfirm(ctx, result.rule)
      if (ok) {
        removeRuleFromFile(scopeToConfigPath(result.rule.scope, cwd), result.rule.pattern)
      }
    }
  }
}

// ─── rules list component ────────────────────────────────────────────────────

type RulesListResult = { kind: "rule"; rule: Rule } | { kind: "add" }

type ListEntry =
  | { kind: "header"; scopeLabel: string; pathHint: string }
  | { kind: "rule"; rule: Rule }
  | { kind: "empty" }
  | { kind: "gap" }
  | { kind: "divider" }
  | { kind: "add" }

function buildEntries(cwd: string): { entries: ListEntry[]; selectableAt: number[] } {
  const { rules } = loadRules(cwd)
  const entries: ListEntry[] = []
  const selectableAt: number[] = []

  const scopeDefs = [
    { scope: "project" as const, label: "PROJECT", pathHint: `.pi/runner.json` },
    { scope: "user" as const, label: "USER", pathHint: `~/.pi/runner.json` },
    { scope: "global" as const, label: "GLOBAL", pathHint: `~/.pi/agent/runner.json` },
  ]

  let firstSection = true
  for (const def of scopeDefs) {
    const scopeRules = rules.filter((r) => r.scope === def.scope)
    if (def.scope === "global" && scopeRules.length === 0) continue

    if (!firstSection) entries.push({ kind: "gap" })
    firstSection = false

    entries.push({ kind: "header", scopeLabel: def.label, pathHint: def.pathHint })
    if (scopeRules.length === 0) {
      entries.push({ kind: "empty" })
    } else {
      for (const rule of scopeRules) {
        selectableAt.push(entries.length)
        entries.push({ kind: "rule", rule })
      }
    }
  }

  entries.push({ kind: "divider" })
  selectableAt.push(entries.length)
  entries.push({ kind: "add" })

  return { entries, selectableAt }
}

async function showRulesList(ctx: ExtensionCommandContext, cwd: string): Promise<RulesListResult | null> {
  return ctx.ui.custom<RulesListResult | null>(
    (tui, theme, _kb, done) => {
      let { entries, selectableAt } = buildEntries(cwd)
      let cursorPos = 0
      let cachedLines: string[] | undefined

      function invalidate() {
        cachedLines = undefined
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines

        const lines: string[] = []
        const add = (s: string) => lines.push(truncateToWidth(s, width))

        add(theme.fg("accent", "─".repeat(width)))
        add(theme.fg("accent", theme.bold(" Rules")))
        add("")

        const selectedEntryIdx = selectableAt[cursorPos]

        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i]!
          const isSelected = i === selectedEntryIdx

          switch (entry.kind) {
            case "header":
              add(" " + theme.fg("muted", entry.scopeLabel) + theme.fg("dim", "  " + entry.pathHint))
              break
            case "rule": {
              const cursor = isSelected ? theme.fg("accent", "> ") : "  "
              const levelCol = actionColor(entry.rule.level)
              const levelStr = entry.rule.level
              const levelWidth = levelStr.length + 2
              const patternWidth = Math.max(width - 4 - levelWidth, 8)
              const pattern = entry.rule.pattern
              const paddedPattern =
                pattern.length > patternWidth
                  ? truncateToWidth(pattern, patternWidth - 1) + "…"
                  : pattern + " ".repeat(patternWidth - visibleWidth(pattern))
              add(" " + cursor + theme.fg("text", paddedPattern) + "  " + theme.fg(levelCol, levelStr))
              break
            }
            case "empty":
              add("   " + theme.fg("dim", "(no rules)"))
              break
            case "gap":
              add("")
              break
            case "divider":
              add(" " + theme.fg("dim", "─".repeat(Math.max(0, width - 2))))
              break
            case "add": {
              const cursor = isSelected ? theme.fg("accent", "> ") : "  "
              add(" " + cursor + theme.fg("accent", "+ Add Rule"))
              break
            }
          }
        }

        add("")
        add(theme.fg("dim", " ↑↓ navigate  •  enter select  •  esc back"))
        add(theme.fg("accent", "─".repeat(width)))

        cachedLines = lines
        return lines
      }

      function handleInput(data: string) {
        if (matchesKey(data, Key.escape)) {
          done(null)
          return
        }
        if (matchesKey(data, Key.up)) {
          cursorPos = Math.max(0, cursorPos - 1)
          invalidate()
          tui.requestRender()
          return
        }
        if (matchesKey(data, Key.down)) {
          cursorPos = Math.min(selectableAt.length - 1, cursorPos + 1)
          invalidate()
          tui.requestRender()
          return
        }
        if (matchesKey(data, Key.enter)) {
          // cursorPos is always in bounds — clamped on up/down

          const entry = entries[selectableAt[cursorPos]!]!
          if (entry.kind === "rule") {
            done({ kind: "rule", rule: entry.rule })
          } else if (entry.kind === "add") {
            done({ kind: "add" })
          }
        }
      }

      // Re-read rules each time this overlay opens so edits/deletes are reflected.
      const rebuilt = buildEntries(cwd)
      entries = rebuilt.entries
      selectableAt = rebuilt.selectableAt

      return { render, invalidate, handleInput }
    },
    { overlay: true, overlayOptions: { width: "70%", minWidth: 60 } },
  )
}

// ─── screen 3: action menu ───────────────────────────────────────────────────

async function showActionMenu(ctx: ExtensionCommandContext, rule: Rule): Promise<"edit" | "delete" | null> {
  const items: SelectItem[] = [
    { value: "edit", label: "Edit" },
    { value: "delete", label: "Delete" },
  ]

  return ctx.ui.custom<"edit" | "delete" | null>(
    (tui, theme, _kb, done) => {
      const levelColor = actionColor(rule.level)
      const container = new Container()
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))
      container.addChild(new Text(" " + theme.fg("text", rule.pattern) + "  " + theme.fg(levelColor, rule.level), 1, 0))

      const list = new SelectList(items, items.length, {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      })
      list.onSelect = (item) => {
        done(item.value as "edit" | "delete")
      }
      list.onCancel = () => {
        done(null)
      }
      container.addChild(list)
      container.addChild(new Text(theme.fg("dim", " enter select  •  esc cancel"), 1, 0))
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)))

      return {
        render: (w) => container.render(w),
        invalidate: () => {
          container.invalidate()
        },
        handleInput: (data) => {
          list.handleInput(data)
          tui.requestRender()
        },
      }
    },
    { overlay: true, overlayOptions: { width: "50%", minWidth: 44 } },
  )
}

// ─── screen 4: add / edit modal ───────────────────────────────────────────────

type FormField = "pattern" | "action" | "scope"
const FORM_FIELDS: FormField[] = ["pattern", "action", "scope"]

async function showEditModal(ctx: ExtensionCommandContext, cwd: string, existing: Rule | null): Promise<void> {
  interface EditResult {
    pattern: string
    level: RuleLevel
    scope: UiScope
  }

  const result = await ctx.ui.custom<EditResult | null>(
    (tui, theme, _kb, done) => {
      const title = existing ? "Edit Rule" : "Add Rule"

      // ── form state ──────────────────────────────────────────────────────────
      let focused: FormField = "pattern"
      let actionIdx = existing ? Math.max(0, ACTIONS.indexOf(existing.level)) : 0
      const initScope: UiScope = existing?.scope === "global" ? "user" : (existing?.scope ?? "project")
      let scopeIdx = Math.max(
        0,
        UI_SCOPES.findIndex((s) => s.scope === initScope),
      )

      const input = new Input()
      input.setValue(existing?.pattern ?? "")

      let cachedLines: string[] | undefined

      function invalidate() {
        input.invalidate()
        cachedLines = undefined
      }

      function moveFocus(delta: 1 | -1) {
        const idx = FORM_FIELDS.indexOf(focused)
        focused = FORM_FIELDS[(idx + delta + FORM_FIELDS.length) % FORM_FIELDS.length] ?? "pattern"
        invalidate()
        tui.requestRender()
      }

      function save() {
        const pattern = input.getValue().trim()
        if (!pattern) return
        const level = ACTIONS[actionIdx] ?? "allow"
        const scope = UI_SCOPES[scopeIdx]?.scope ?? "project"
        done({ pattern, level, scope })
      }

      function handleInput(data: string) {
        if (matchesKey(data, Key.escape)) {
          done(null)
          return
        }

        if (focused === "pattern") {
          if (matchesKey(data, Key.tab) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
            moveFocus(1)
            return
          }
          input.handleInput(data)
          invalidate()
          tui.requestRender()
          return
        }

        if (focused === "action") {
          if (matchesKey(data, Key.left)) {
            actionIdx = (actionIdx - 1 + ACTIONS.length) % ACTIONS.length
            invalidate()
            tui.requestRender()
            return
          }
          if (matchesKey(data, Key.right)) {
            actionIdx = (actionIdx + 1) % ACTIONS.length
            invalidate()
            tui.requestRender()
            return
          }
          if (matchesKey(data, Key.tab) || matchesKey(data, Key.down) || matchesKey(data, Key.enter)) {
            moveFocus(1)
            return
          }
          if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up)) {
            moveFocus(-1)
            return
          }
          return
        }

        // focused === "scope"
        {
          if (matchesKey(data, Key.left)) {
            scopeIdx = (scopeIdx - 1 + UI_SCOPES.length) % UI_SCOPES.length
            invalidate()
            tui.requestRender()
            return
          }
          if (matchesKey(data, Key.right)) {
            scopeIdx = (scopeIdx + 1) % UI_SCOPES.length
            invalidate()
            tui.requestRender()
            return
          }
          if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
            moveFocus(1) // wraps back to pattern
            return
          }
          if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up)) {
            moveFocus(-1)
            return
          }
          if (matchesKey(data, Key.enter)) {
            save()
            return
          }
          return
        }
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines

        const lines: string[] = []
        const add = (s: string) => lines.push(truncateToWidth(s, width))

        add(theme.fg("accent", "─".repeat(width)))
        add(theme.fg("accent", theme.bold(` ${title}`)))
        add("")

        // ── pattern ─────────────────────────────────────────────────────────
        const patternFocused = focused === "pattern"
        add(patternFocused ? theme.fg("accent", " Pattern") : theme.fg("muted", " Pattern"))
        const borderColor = patternFocused ? "accent" : "dim"
        const innerWidth = Math.max(4, width - 4)
        add(" " + theme.fg(borderColor, "┌" + "─".repeat(innerWidth) + "┐"))
        for (const line of input.render(innerWidth)) {
          add(" " + theme.fg(borderColor, "│") + line + theme.fg(borderColor, "│"))
        }
        add(" " + theme.fg(borderColor, "└" + "─".repeat(innerWidth) + "┘"))
        add("")

        // ── action ──────────────────────────────────────────────────────────
        const actionFocused = focused === "action"
        add(actionFocused ? theme.fg("accent", " Action") : theme.fg("muted", " Action"))
        const actionRow = ACTIONS.map((a, i) => {
          const sel = i === actionIdx
          const dot = sel ? "●" : "○"
          if (sel) return theme.fg(actionColor(a), dot + " " + (actionFocused ? theme.bold(a) : a))
          return theme.fg("dim", dot + " " + a)
        }).join("   ")
        add("   " + actionRow)
        add("")

        // ── scope ───────────────────────────────────────────────────────────
        const scopeFocused = focused === "scope"
        add(scopeFocused ? theme.fg("accent", " Scope") : theme.fg("muted", " Scope"))
        const scopeRow = UI_SCOPES.map((s, i) => {
          const sel = i === scopeIdx
          const dot = sel ? "●" : "○"
          if (sel) return theme.fg("accent", dot + " " + (scopeFocused ? theme.bold(s.label) : s.label))
          return theme.fg("dim", dot + " " + s.label)
        }).join("   ")
        add("   " + scopeRow)
        add("")

        // ── footer ──────────────────────────────────────────────────────────
        const hint =
          focused === "scope" ? " ←→ change  •  enter save  •  esc cancel" : " tab / ↓ next field  •  esc cancel"
        add(theme.fg("dim", hint))
        add(theme.fg("accent", "─".repeat(width)))

        cachedLines = lines
        return lines
      }

      return { render, invalidate, handleInput }
    },
    { overlay: true, overlayOptions: { width: "60%", minWidth: 52 } },
  )

  if (!result) return

  if (existing) {
    removeRuleFromFile(scopeToConfigPath(existing.scope, cwd), existing.pattern)
  }
  writeRuleToFile(scopeToConfigPath(result.scope, cwd), result.pattern, result.level)
}

// ─── screen 5: delete confirm ────────────────────────────────────────────────

async function showDeleteConfirm(ctx: ExtensionCommandContext, rule: Rule): Promise<boolean> {
  const items: SelectItem[] = [
    { value: "confirm", label: "Delete" },
    { value: "cancel", label: "Cancel" },
  ]

  const result = await ctx.ui.custom<"confirm" | "cancel" | null>(
    (tui, theme, _kb, done) => {
      const levelColor = actionColor(rule.level)
      const container = new Container()
      container.addChild(new DynamicBorder((s: string) => theme.fg("error", s)))
      container.addChild(new Text(theme.fg("error", theme.bold(" Delete rule?")), 1, 0))
      container.addChild(
        new Text(
          "\n " +
            theme.fg("text", rule.pattern) +
            "  " +
            theme.fg(levelColor, rule.level) +
            "\n " +
            theme.fg("dim", rule.scope),
          1,
          0,
        ),
      )

      const list = new SelectList(items, items.length, {
        selectedPrefix: (t) => theme.fg("error", t),
        selectedText: (t) => theme.fg("error", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      })
      list.onSelect = (item) => {
        done(item.value as "confirm" | "cancel")
      }
      list.onCancel = () => {
        done(null)
      }
      container.addChild(list)
      container.addChild(new Text(theme.fg("dim", " enter select  •  esc cancel"), 1, 0))
      container.addChild(new DynamicBorder((s: string) => theme.fg("error", s)))

      return {
        render: (w) => container.render(w),
        invalidate: () => {
          container.invalidate()
        },
        handleInput: (data) => {
          list.handleInput(data)
          tui.requestRender()
        },
      }
    },
    { overlay: true, overlayOptions: { width: "50%", minWidth: 44 } },
  )

  return result === "confirm"
}
