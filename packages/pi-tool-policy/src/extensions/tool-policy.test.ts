import { describe, expect, it } from "vitest"

import toolPolicy from "./tool-policy.ts"

describe("tool-policy extension", () => {
  it("default export is a function of arity 1", () => {
    expect(typeof toolPolicy).toBe("function")
    expect(toolPolicy.length).toBe(1)
  })
})
