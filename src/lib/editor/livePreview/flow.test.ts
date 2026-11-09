import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { GFM, parser as commonmark } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import { blankLinesBetween, contentEnd, kindOf, listContext, listDepth, prevBlock } from "./flow";

const parser = commonmark.configure([GFM]);

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
