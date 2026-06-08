import { describe, expect, it } from "vitest"

import defaultExport from "./task-runner.ts"

describe("task-runner", () => {
  it("is a function", () => {
    expect(typeof defaultExport).toBe("function")
  })

  it("has length 1 (takes pi: ExtensionAPI parameter)", () => {
    expect(defaultExport.length).toBe(1)
  })
})
