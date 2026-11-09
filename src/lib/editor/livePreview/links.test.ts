import { describe, expect, it } from "vitest";
import { GFM, parser as baseParser } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import { markdownExtensions } from "../syntax";
import { linkUrl } from "./links";

const parser = baseParser.configure([GFM, ...markdownExtensions]);

/** Destination text of the first Link or Image in `text`, or null when it has none. */
function destination(text: string): string | null {
  const found: SyntaxNode[] = [];
  parser.parse(text).iterate({
    enter: (n) => {
      if (found.length) return false;
      if (n.name === "Link" || n.name === "Image") found.push(n.node);
    },
  });
  const url = found.length ? linkUrl(found[0]) : null;
  return url ? text.slice(url.from, url.to) : null;
}

describe("linkUrl", () => {
  it("takes the destination, not a bare URL in the label", () => {
    expect(destination("[www.example.com](https://example.com)")).toBe("https://example.com");
    expect(destination("[a@b.com](mailto:a@b.com)")).toBe("mailto:a@b.com");
    expect(destination("[http://a.com](http://b.com)")).toBe("http://b.com");
    expect(destination("![shot of www.x.com](a.png)")).toBe("a.png");
    expect(destination('[docs](<my file.md> "title")')).toBe("<my file.md>");
  });

  it("finds none in reference links", () => {
    expect(destination("[www.x.com][ref]")).toBeNull();
    expect(destination("[see https://x.com]")).toBeNull();
    expect(destination("![alt][ref]")).toBeNull();
  });
});
