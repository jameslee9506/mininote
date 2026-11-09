import { describe, expect, it } from "vitest";
import { buildLinkIndex, isExternalHref, parseWikiInner, resolveMarkdownHref, resolveWikiTarget, wikiLinkText } from "./resolve";

const index = buildLinkIndex([
  { path: "Home.md", isNote: true },
  { path: "projects/Plan.md", isNote: true },
  { path: "archive/Plan.md", isNote: true },
  { path: "projects/sub/Deep.md", isNote: true },
  { path: "\uD55C\uAE00 \uB178\uD2B8.md".normalize("NFD"), isNote: true },
  { path: "attachments/photo.png", isNote: false },
]);

describe("resolve", () => {
  it("parses wikilink parts", () => {
    expect(parseWikiInner("Note#Head|Alias")).toEqual({ target: "Note", subpath: "Head", alias: "Alias" });
    expect(parseWikiInner("#Only")).toEqual({ target: "", subpath: "Only", alias: null });
  });

  it("resolves exact paths case-insensitively, with or without .md", () => {
    expect(resolveWikiTarget("home", null, index)).toBe("Home.md");
    expect(resolveWikiTarget("projects/plan.md", null, index)).toBe("projects/Plan.md");
  });

  it("prefers the source note's folder for ambiguous names", () => {
    expect(resolveWikiTarget("Plan", "archive/x.md", index)).toBe("archive/Plan.md");
    expect(resolveWikiTarget("Plan", "projects/sub/Deep.md", index)).toBe("archive/Plan.md");
  });

  it("resolves path suffixes and unique basenames", () => {
    expect(resolveWikiTarget("sub/Deep", null, index)).toBe("projects/sub/Deep.md");
    expect(resolveWikiTarget("Deep", null, index)).toBe("projects/sub/Deep.md");
  });

  it("matches NFC targets to NFD file names", () => {
    expect(resolveWikiTarget("\uD55C\uAE00 \uB178\uD2B8", null, index)).toBe("\uD55C\uAE00 \uB178\uD2B8.md".normalize("NFD"));
  });

  it("resolves non-note files only by full name", () => {
    expect(resolveWikiTarget("photo.png", null, index)).toBe("attachments/photo.png");
    expect(resolveWikiTarget("photo", null, index)).toBeNull();
    expect(resolveWikiTarget("Missing", null, index)).toBeNull();
  });

  it("resolves markdown hrefs relative to the source note", () => {
    expect(resolveMarkdownHref("../attachments/photo.png", "projects/Plan.md", index)).toBe("attachments/photo.png");
    expect(resolveMarkdownHref("sub/Deep.md#x", "projects/Plan.md", index)).toBe("projects/sub/Deep.md");
    expect(resolveMarkdownHref("https://example.com", null, index)).toBeNull();
    expect(isExternalHref("C:\\x.md")).toBe(false);
  });

  it("generates shortest unambiguous link text", () => {
    expect(wikiLinkText("Home.md", index)).toBe("Home");
    expect(wikiLinkText("projects/Plan.md", index)).toBe("projects/Plan");
    expect(wikiLinkText("attachments/photo.png", index)).toBe("photo.png");
  });
});
