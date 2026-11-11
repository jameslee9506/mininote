import { describe, expect, it } from "vitest";
import { findHeadingLine, findInLine } from "./headings";

const doc = [
  "---",
  "title: # Not a heading",
  "---",
  "# Intro",
  "```",
  "# Inside code",
  "```",
  "## \uD68C\uC758 \uB178\uD2B8 ##",
  "Setext Title",
  "===",
  "### C# and **bold**",
].join("\n");

describe("findHeadingLine", () => {
  it("matches heading text loosely and skips code and frontmatter", () => {
    expect(findHeadingLine(doc, "Intro")).toBe(3);
    expect(findHeadingLine(doc, "Inside code")).toBeNull();
    expect(findHeadingLine(doc, "Not a heading")).toBeNull();
    expect(findHeadingLine(doc, "\uD68C\uC758 \uB178\uD2B8")).toBe(7);
    expect(findHeadingLine(doc, "C# and bold")).toBe(10);
  });

  it("takes no underlined text for a heading: the dialect has no setext headings", () => {
    expect(findHeadingLine(doc, "setext title")).toBeNull();
  });

  it("accepts slugs and nested subpaths", () => {
    expect(findHeadingLine(doc, "\uD68C\uC758-\uB178\uD2B8")).toBe(7);
    expect(findHeadingLine(doc, "Intro#\uD68C\uC758 \uB178\uD2B8")).toBe(7);
    expect(findHeadingLine(doc, "missing")).toBeNull();
    expect(findHeadingLine(doc, "")).toBeNull();
  });
});

describe("findInLine", () => {
  it("finds the hit exactly, else ignoring case, with offsets into the line", () => {
    expect(findInLine("the Q3 budget is set", "budget")).toEqual({ from: 7, to: 13 });
    expect(findInLine("Budget and budget", "budget")).toEqual({ from: 11, to: 17 });
    expect(findInLine("BUDGET (q3)", "budget")).toEqual({ from: 0, to: 6 });
    expect(findInLine("Über straße", "über")).toEqual({ from: 0, to: 4 });
    expect(findInLine("😀 emoji Hit", "hit")).toEqual({ from: 9, to: 12 });
    expect(findInLine("\uD68C\uC758 \uB178\uD2B8", "\uB178\uD2B8")).toEqual({ from: 3, to: 5 });
    // An NFD line (pasted from HFS+ names) still matches the NFC hit the search reports.
    expect(findInLine("\uD68C\uC758 \uB178\uD2B8".normalize("NFD"), "\uB178\uD2B8")).toEqual({ from: 5, to: 9 });
  });

  it("treats the hit as plain text and reports misses", () => {
    expect(findInLine("cost (USD) [total]", "(usd) [TOTAL]")).toEqual({ from: 5, to: 18 });
    expect(findInLine("a.b", "A*B")).toBeNull();
    expect(findInLine("abc", "")).toBeNull();
  });
});
