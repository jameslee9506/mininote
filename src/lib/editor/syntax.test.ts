import { describe, expect, it } from "vitest";
import { GFM, parser as baseParser } from "@lezer/markdown";
import type { SyntaxNodeRef } from "@lezer/common";
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
