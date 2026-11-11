import { describe, expect, it } from "vitest";
import { GFM, parser as baseParser } from "@lezer/markdown";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import { markdownExtensions } from "./syntax";

const parser = baseParser.configure([GFM, ...markdownExtensions]);

function nodes(text: string): string[] {
  const out: string[] = [];
  parser.parse(text).iterate({
    enter: (n: SyntaxNodeRef) => {
      if (n.name !== "Document" && n.name !== "Paragraph") out.push(`${n.name}:${text.slice(n.from, n.to)}`);
    },
  });
  return out;
}

describe("markdown syntax extensions", () => {
  it("parses wikilinks with alias and heading", () => {
    expect(nodes("see [[Note#Head|alias]] now")).toEqual([
      "WikiLink:[[Note#Head|alias]]",
      "WikiLinkMark:[[",
      "WikiLinkTarget:Note#Head",
      "WikiLinkMark:|",
      "WikiLinkAlias:alias",
      "WikiLinkMark:]]",
    ]);
  });

  it("parses embeds and rejects empty or unclosed links", () => {
    expect(nodes("![[pic.png]]")[0]).toBe("WikiEmbed:![[pic.png]]");
    expect(nodes("[[]] and [[open").some((n) => n.startsWith("WikiLink"))).toBe(false);
  });

  it("parses Korean wikilinks", () => {
    expect(nodes("[[\uD68C\uC758\uB85D]]")).toContain("WikiLinkTarget:\uD68C\uC758\uB85D");
  });

  it("parses ==highlight== with marks", () => {
    expect(nodes("a ==b== c")).toEqual(["Highlight:==b==", "HighlightMark:==", "HighlightMark:=="]);
    expect(nodes("a == b == c").some((n) => n.startsWith("Highlight"))).toBe(false);
  });
});

/** Nodes that take part in block structure, as `outline` prints them. */
const BLOCKS = /^(?:Paragraph|Task|Blockquote|BulletList|OrderedList|ListItem|CodeBlock|HorizontalRule|Table|ATXHeading\d|SetextHeading\d)$/;

/** The block structure of `text`: "Blockquote(Paragraph) Paragraph". */
function outline(text: string): string {
  const walk = (node: SyntaxNode): string => {
    const out: string[] = [];
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (!BLOCKS.test(c.name)) continue;
      const inner = walk(c);
      out.push(inner ? `${c.name}(${inner})` : c.name);
    }
    return out.join(" ");
  };
  return walk(parser.parse(text).topNode);
}

describe("block dialect (shared with the reading view, markdown/render.test.ts)", () => {
  it("has no setext headings: a line under text never changes it", () => {
    // A "-" typed under a paragraph, on the way to a list item.
    expect(outline("\uAC00\n-")).toBe("Paragraph");
    expect(outline("\uAC00\n- ")).toBe("Paragraph");
    expect(outline("\uAC00\n=")).toBe("Paragraph");
    expect(outline("\uAC00\n===")).toBe("Paragraph");
    expect(outline("\uAC00\n---")).toBe("Paragraph HorizontalRule");
    expect(outline("\uAC00\n- \uB098")).toBe("Paragraph BulletList(ListItem(Paragraph))");
  });

  it("ends a quote at the first line without its mark", () => {
    expect(outline("> a\nb")).toBe("Blockquote(Paragraph) Paragraph");
    expect(outline("> a\n> b\nc")).toBe("Blockquote(Paragraph) Paragraph");
    expect(outline("> a\n>\n> b\nc")).toBe("Blockquote(Paragraph Paragraph) Paragraph");
    // An indented line is no lazy line either: it starts a code block.
    expect(outline("> a\n    b")).toBe("Blockquote(Paragraph) CodeBlock");
    expect(outline("> - a\n> b")).toBe("Blockquote(BulletList(ListItem(Paragraph)) Paragraph)");
  });

  it("ends a list item at the first line indented less than its text", () => {
    expect(outline("- a\nb")).toBe("BulletList(ListItem(Paragraph)) Paragraph");
    expect(outline("1. a\n  b")).toBe("OrderedList(ListItem(Paragraph)) Paragraph");
    expect(outline("- a\n  b")).toBe("BulletList(ListItem(Paragraph))");
    expect(outline("- a\n  - b\n  c")).toBe("BulletList(ListItem(Paragraph BulletList(ListItem(Paragraph)) Paragraph))");
    expect(outline("- a\n  - b\n c")).toBe("BulletList(ListItem(Paragraph BulletList(ListItem(Paragraph)))) Paragraph");
    expect(outline("- > q\n  b")).toBe("BulletList(ListItem(Blockquote(Paragraph) Paragraph))");
  });

  it("finishes the block a lazy line ends as a blank line would", () => {
    expect(outline("- [ ] a\nb")).toBe("BulletList(ListItem(Task)) Paragraph");
    expect(outline("- | a | b |\n  | - | - |\n| c | d |")).toBe("BulletList(ListItem(Table)) Paragraph");
  });
});
