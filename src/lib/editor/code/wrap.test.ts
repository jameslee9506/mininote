import { describe, expect, it } from "vitest";
import { indentColumns } from "./wrap";

describe("wrapped code lines", () => {
  it("measures indentation in columns, tabs running to the next stop", () => {
    expect(indentColumns("    x", 4)).toBe(4);
    expect(indentColumns("\t\tx", 4)).toBe(8);
    expect(indentColumns("  \tx", 4)).toBe(4);
    expect(indentColumns("x  y", 4)).toBe(0);
    // A blank line has nothing to hang.
    expect(indentColumns("   ", 4)).toBe(0);
  });
});
