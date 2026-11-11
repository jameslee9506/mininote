import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { frontmatterRange } from "./frontmatter";
import {
  autolinkHref,
  blockKind,
  endsInside,
  fenceLabel,
  isImageTarget,
  linkDestination,
  tableAlignments,
  touches,
  type SelRange,
} from "./model";

const doc = (s: string) => Text.of(s.split("\n"));
const cursor = (pos: number): SelRange => ({ from: pos, to: pos, anchor: pos, head: pos, empty: true });
const range = (anchor: number, head: number): SelRange => ({
  from: Math.min(anchor, head),
  to: Math.max(anchor, head),
  anchor,
  head,
  empty: anchor === head,
});

describe("frontmatterRange", () => {
  it("spans from the opening fence to the closing --- or ... line", () => {
    expect(frontmatterRange(doc("---\ntitle: x\n---\nbody"))).toEqual({ from: 0, to: 16 });
    expect(frontmatterRange(doc("---  \na: 1\n...\n"))).toEqual({ from: 0, to: 14 });
    expect(frontmatterRange(doc("---\n---"))).toEqual({ from: 0, to: 7 });
  });

  it("needs --- on line 1 and a closing fence", () => {
    expect(frontmatterRange(doc("---\ntitle: x"))).toBeNull();
    expect(frontmatterRange(doc("\n---\na\n---"))).toBeNull();
    expect(frontmatterRange(doc("----\na\n---"))).toBeNull();
    expect(frontmatterRange(doc("---"))).toBeNull();
  });
});

describe("blockKind", () => {
  it("maps block nodes to DESIGN §3.2 kinds", () => {
    expect(blockKind("ATXHeading2")).toBe("h2");
    expect(blockKind("FencedCode")).toBe("code");
    expect(blockKind("CodeBlock")).toBe("code");
    expect(blockKind("HTMLBlock")).toBe("html");
    expect(blockKind("CommentBlock")).toBe("html");
    expect(blockKind("Blockquote")).toBe("quote");
    expect(blockKind("BulletList")).toBe("ul");
    expect(blockKind("OrderedList")).toBe("ol");
    expect(blockKind("Task")).toBe("p");
    expect(blockKind("SomethingNew")).toBe("p");
  });
});

describe("reveal tests", () => {
  it("touches is inclusive at both ends", () => {
    expect(touches([cursor(5)], 5, 9)).toBe(true);
    expect(touches([cursor(9)], 5, 9)).toBe(true);
    expect(touches([cursor(10)], 5, 9)).toBe(false);
    expect(touches([range(0, 20)], 5, 9)).toBe(true);
    expect(touches([], 5, 9)).toBe(false);
  });

  it("block widgets reveal for a caret on them, a selection end strictly inside, or a selection within them", () => {
    expect(endsInside([cursor(10)], 10, 20)).toBe(true);
    expect(endsInside([cursor(20)], 10, 20)).toBe(true);
    expect(endsInside([range(0, 15)], 10, 20)).toBe(true);
    // Shift+Home / Shift+End on a revealed image line selects exactly its source.
    expect(endsInside([range(20, 10)], 10, 20)).toBe(true);
    expect(endsInside([range(10, 20)], 10, 20, 25)).toBe(true);
    // Select All, or a drag across the block, keeps it rendered.
    expect(endsInside([range(0, 30)], 10, 20)).toBe(false);
    expect(endsInside([range(0, 20)], 10, 20)).toBe(false);
    expect(endsInside([range(10, 21)], 10, 20)).toBe(false);
    // So does Select All on a note that is only this block.
    expect(endsInside([range(0, 20)], 0, 20, 20)).toBe(false);
  });
});

describe("link targets", () => {
  it("keeps destinations as written, minus angle brackets", () => {
    expect(linkDestination("<my pic.png>")).toBe("my pic.png");
    expect(linkDestination("Note%20A.md")).toBe("Note%20A.md");
    expect(linkDestination("#heading")).toBe("#heading");
  });

  it("gives autolinks and bare URLs a scheme", () => {
    expect(autolinkHref("https://x.com")).toBe("https://x.com");
    expect(autolinkHref("<https://x.com>")).toBe("https://x.com");
    expect(autolinkHref("www.x.com")).toBe("https://www.x.com");
    expect(autolinkHref("me@x.com")).toBe("mailto:me@x.com");
  });

  it("recognizes image embeds by extension", () => {
    expect(isImageTarget("photo.PNG")).toBe(true);
    expect(isImageTarget("folder/\uC0AC\uC9C4.jpeg")).toBe(true);
    expect(isImageTarget("Meeting 2024.01")).toBe(false);
    expect(isImageTarget("Note")).toBe(false);
  });
});

describe("tables and fences", () => {
  it("reads alignments from the delimiter row", () => {
    expect(tableAlignments("| :-- | :-: | --: | --- |")).toEqual(["left", "center", "right", null]);
    expect(tableAlignments(":-|-:")).toEqual(["left", "right"]);
  });

  it("labels a fence with the first word of its info string", () => {
    expect(fenceLabel(" ts title=x ")).toBe("ts");
    expect(fenceLabel("")).toBe("");
  });
});
