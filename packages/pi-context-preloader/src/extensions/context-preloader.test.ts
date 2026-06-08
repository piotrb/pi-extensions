import { describe, expect, it } from "vitest"

import defaultExport from "./context-preloader.ts"

describe("context-preloader", () => {
  it("is a function", () => {
    expect(typeof defaultExport).toBe("function")
  })

  it("has length 1 (takes pi: ExtensionAPI parameter)", () => {
    expect(defaultExport.length).toBe(1)
  })
})
