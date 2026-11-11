import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { GFM, parser as commonmark } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import { markdownExtensions } from "../syntax";
import { blankLinesBetween, contentEnd, kindOf, leadOf, listContext, listDepth, pairOf, prevBlock } from "./flow";

const parser = commonmark.configure([GFM, ...markdownExtensions]);

function parse(src: string): { doc: Text; top: SyntaxNode } {
  return { doc: Text.of(src.split("\n")), top: parser.parse(src).topNode };
}

/** The first node named `name`, in document order. */
function find(node: SyntaxNode, name: string): SyntaxNode {
  const cursor = node.cursor();
  do {
    if (cursor.name === name) return cursor.node;
  } while (cursor.next());
  throw new Error(`no ${name}`);
}

describe("list context", () => {
  const ctx = (src: string) => {
    const { doc, top } = parse(src);
    return listContext(doc, find(top, "BulletList"));
  };

  it("is tight for items of text, nested lists included", () => {
    expect(ctx("- a\n- b")).toBe("list");
    expect(ctx("- a\n  - b\n- c")).toBe("list");
  });

  it("is loose when blank lines separate items or blocks inside an item (CommonMark)", () => {
    expect(ctx("- a\n\n- b")).toBe("list-loose");
    expect(ctx("- a\n\n  text\n- b")).toBe("list-loose");
    expect(ctx("- a\n\n  - b\n- c")).toBe("list-loose");
  });

  it("reports items holding blocks, which win over looseness, as the renderer's has-blocks", () => {
    expect(ctx("- a\n  > q\n- b")).toBe("list-blocks");
    expect(ctx("- a\n\n  ```\n  x\n  ```\n\n- b")).toBe("list-blocks");
  });
});

describe("blocks and blank lines", () => {
  it("counts the lines strictly between two blocks", () => {
    const { doc, top } = parse("# H\n\n\ntext\nmore\n- a");
    const heading = find(top, "ATXHeading1");
    const para = find(top, "Paragraph");
    const list = find(top, "BulletList");
    expect(blankLinesBetween(doc, heading, para)).toBe(2);
    expect(blankLinesBetween(doc, para, list)).toBe(0);
    expect(prevBlock(list)).not.toBeNull();
    expect(kindOf(prevBlock(list)!)).toBe("p");
  });

  it("ends a quote at its last block, so trailing marker lines count as blank", () => {
    const src = "> a\n>\n> b\n>\n\nnext";
    const { doc, top } = parse(src);
    const quote = find(top, "Blockquote");
    expect(doc.lineAt(contentEnd(quote)).number).toBe(3);
    expect(blankLinesBetween(doc, quote, quote.nextSibling!)).toBe(2);
  });

  it("skips quote marks between a quote's blocks", () => {
    const { top } = parse("> a\n>\n> b");
    const second = find(top, "Blockquote").lastChild!;
    expect(second.name).toBe("Paragraph");
    expect(prevBlock(second)?.name).toBe("Paragraph");
  });

  it("names list items li and counts their depth", () => {
    const { top } = parse("- a\n  - b");
    const outer = find(top, "ListItem");
    const inner = find(find(outer, "BulletList"), "ListItem");
    expect(kindOf(outer)).toBe("li");
    expect(listDepth(outer)).toBe(1);
    expect(listDepth(inner)).toBe(2);
    expect(listDepth(find(inner, "Paragraph"))).toBe(2);
  });
});

describe("pairs and leads", () => {
  /** The pair of the first node named `name`. */
  const pair = (src: string, name: string, fm: { from: number; to: number } | null = null) => {
    const { doc, top } = parse(src);
    return pairOf(doc, find(top, name), fm);
  };

  it("leads a blank line with the gap a paragraph typed on it would have", () => {
    expect(leadOf("h2")).toBe("h");
    expect(leadOf("hr")).toBe("hr");
    for (const kind of ["ul", "ol", "quote", "code", "fm"] as const) expect(leadOf(kind)).toBe("block");
    // Typed text joins these blocks: a paragraph's next line, a table's next row, an HTML block's next line.
    for (const kind of ["p", "table", "html"] as const) expect(leadOf(kind)).toBeNull();
  });

  it("pairs a block with the one above it, counting the blank lines and their lead", () => {
    expect(pair("# H\ntext", "Paragraph")).toEqual({ blk: "p", prev: "h1", blank: 0, lead: null });
    expect(pair("# H\n\n\ntext", "Paragraph")).toEqual({ blk: "p", prev: "h1", blank: 2, lead: "h" });
    expect(pair("text\n\n- a", "BulletList")).toEqual({ blk: "ul", prev: "p", blank: 1, lead: null });
    expect(pair("text", "Paragraph")).toBeNull();
  });

  it("counts a quote's trailing mark lines as blank, and leads only a line below the quote", () => {
    // ">" on line 2 belongs to the quote: no body line stands between the quote and the text.
    const below = (src: string) => {
      const { doc, top } = parse(src);
      return pairOf(doc, top.lastChild!, null);
    };
    expect(below("> a\n>\ntext")).toEqual({ blk: "p", prev: "quote", blank: 1, lead: null });
    expect(below("> a\n>\n\ntext")).toEqual({ blk: "p", prev: "quote", blank: 2, lead: "block" });
  });

  it("carries no lead between list items or inside one", () => {
    const { doc, top } = parse("- a\n\n- b\n\n  ```\n  x\n  ```\n\n  text");
    const second = find(top, "BulletList").lastChild!;
    expect(pairOf(doc, second, null)).toEqual({ blk: "li", prev: "li", blank: 1, lead: null });
    expect(pairOf(doc, second.lastChild!, null)).toEqual({ blk: "p", prev: "code", blank: 1, lead: null });
  });

  it("takes the frontmatter for the block before the first one", () => {
    const src = "---\nt: 1\n---\n\n# H";
    const fm = { from: 0, to: src.indexOf("\n\n") };
    expect(pair(src, "ATXHeading1", fm)).toEqual({ blk: "h1", prev: "fm", blank: 1, lead: "block" });
    // Lezer's own reading of the fence lines is no block of the document.
    expect(pair(src, "HorizontalRule", fm)).toBeNull();
  });
});
