import { describe, expect, it } from "vitest"

import defaultExport from "./ripgrep.ts"

describe("ripgrep", () => {
  it("is a function", () => {
    expect(typeof defaultExport).toBe("function")
  })

  it("has length 1 (takes pi: ExtensionAPI parameter)", () => {
    expect(defaultExport.length).toBe(1)
  })
})
