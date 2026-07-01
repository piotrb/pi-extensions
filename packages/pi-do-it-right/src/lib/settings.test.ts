/**
 * tests for src/lib/settings.ts
 *
 * Hermeticizes the user's HOME via the `homedirFn` injection seam.
 */

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { DEFAULT_SETTINGS, loadSettings, saveSettings, settingsPath } from "./settings.ts"

let tmpHome: string

beforeEach(async () => {
  tmpHome = await realpath(await mkdtemp(join(tmpdir(), "doit-settings-home-")))
})

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true })
})

const homedirFn = (): string => tmpHome

async function writeSettings(content: string): Promise<void> {
  await mkdir(join(tmpHome, ".pi", "agent"), { recursive: true })
  await writeFile(settingsPath(tmpHome), content, "utf8")
}

describe("loadSettings", () => {
  it("returns DEFAULT_SETTINGS when no settings file exists", async () => {
    expect(await loadSettings(homedirFn)).toEqual(DEFAULT_SETTINGS)
  })

  it("returns DEFAULT_SETTINGS when settings file is empty", async () => {
    await writeSettings("")
    expect(await loadSettings(homedirFn)).toEqual(DEFAULT_SETTINGS)
  })

  it("returns DEFAULT_SETTINGS when JSON is malformed", async () => {
    await writeSettings("{ this is not valid JSON")
    expect(await loadSettings(homedirFn)).toEqual(DEFAULT_SETTINGS)
  })

  it("returns DEFAULT_SETTINGS when top-level value is not an object", async () => {
    await writeSettings('"a string"')
    expect(await loadSettings(homedirFn)).toEqual(DEFAULT_SETTINGS)
  })

  it("returns DEFAULT_SETTINGS when model is missing", async () => {
    await writeSettings("{}")
    expect(await loadSettings(homedirFn)).toEqual(DEFAULT_SETTINGS)
  })

  it("returns DEFAULT_SETTINGS when model.provider is not a string", async () => {
    await writeSettings('{"model": {"provider": 42, "id": "x"}}')
    expect(await loadSettings(homedirFn)).toEqual(DEFAULT_SETTINGS)
  })

  it("returns DEFAULT_SETTINGS when model.provider is missing (strict merge)", async () => {
    await writeSettings('{"model": {"id": "claude-haiku-4-5"}}')
    expect(await loadSettings(homedirFn)).toEqual(DEFAULT_SETTINGS)
  })

  it("uses both user values when both fields are valid strings", async () => {
    await writeSettings('{"model": {"provider": "google", "id": "gemini-3-flash"}}')
    const result = await loadSettings(homedirFn)
    expect(result.model).toEqual({ provider: "google", id: "gemini-3-flash" })
  })
})

describe("settingsPath", () => {
  it("joins home with .pi/agent/auto-reject-rules.json", () => {
    expect(settingsPath("/home/u")).toBe("/home/u/.pi/agent/auto-reject-rules.json")
  })
})

describe("saveSettings", () => {
  it("creates parent directories and writes valid JSON", async () => {
    // tmpHome is fresh; no .pi/agent/ inside it.
    await saveSettings({ model: { provider: "google", id: "gemini-3-flash" } }, homedirFn)
    const written = await readFile(settingsPath(tmpHome), "utf8")
    expect(JSON.parse(written)).toEqual({ model: { provider: "google", id: "gemini-3-flash" } })
  })

  it("uses write-then-rename atomically (no .tmp leftover on success)", async () => {
    await saveSettings(DEFAULT_SETTINGS, homedirFn)
    await expect(readFile(`${settingsPath(tmpHome)}.tmp`, "utf8")).rejects.toThrow()
  })

  it("round-trips through loadSettings", async () => {
    const newSettings = { model: { provider: "google", id: "gemini-3-flash" } }
    await saveSettings(newSettings, homedirFn)
    const loaded = await loadSettings(homedirFn)
    expect(loaded).toEqual(newSettings)
  })

  it("overwrites a previous file", async () => {
    await writeSettings('{"model":{"provider":"old","id":"old"}}')
    await saveSettings({ model: { provider: "new", id: "new" } }, homedirFn)
    expect(await loadSettings(homedirFn)).toEqual({ model: { provider: "new", id: "new" } })
  })
})
