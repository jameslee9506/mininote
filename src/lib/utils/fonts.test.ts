import { describe, expect, it } from "vitest";
import {
  headingFontValue,
  monoFontValue,
  sanitizeFontFamily,
  sanitizeHeadingFont,
  sanitizeTextFont,
  SANS_FONT_CANDIDATES,
  SERIF_FONT_CANDIDATES,
  textFontValue,
} from "./fonts";

describe("code font", () => {
  it("cleans a family name so that it is safe inside a quoted CSS string", () => {
    expect(sanitizeFontFamily('  "JetBrains   Mono" ')).toBe("JetBrains Mono");
    expect(sanitizeFontFamily("Fira Code, monospace")).toBe("Fira Code");
    expect(sanitizeFontFamily("Fira\tCode")).toBe("Fira Code");
    expect(sanitizeFontFamily('a"; } body { color: red\\')).toBe("a; } body { color: red");
    expect(sanitizeFontFamily("나눔고딕코딩\n")).toBe("나눔고딕코딩");
    expect(sanitizeFontFamily("x".repeat(200))).toHaveLength(80);
    expect(sanitizeFontFamily(undefined)).toBe("");
    expect(sanitizeFontFamily(42)).toBe("");
  });

  it("puts the family before the default stack", () => {
    expect(monoFontValue("")).toBeNull();
    expect(monoFontValue("Fira Code")).toBe('"Fira Code", var(--font-mono-default)');
  });
});

describe("text and heading fonts", () => {
  it("keeps the generic families in lower case, and the text's sans-serif as its default", () => {
    expect(sanitizeHeadingFont(" Serif ")).toBe("serif");
    expect(sanitizeHeadingFont("SANS-SERIF")).toBe("sans-serif");
    expect(sanitizeHeadingFont('"Georgia", serif')).toBe("Georgia");
    expect(sanitizeHeadingFont(null)).toBe("");
    expect(sanitizeTextFont("serif")).toBe("serif");
    expect(sanitizeTextFont("sans-serif")).toBe("");
    expect(sanitizeTextFont("Iowan Old Style")).toBe("Iowan Old Style");
  });

  it("follows a family with the system's stack of its kind", () => {
    expect(textFontValue("")).toBeNull();
    expect(textFontValue("serif")).toBe("var(--font-serif)");
    expect(textFontValue("Georgia")).toBe('"Georgia", var(--font-serif)');
    expect(textFontValue("pretendard")).toBe('"pretendard", var(--font-text)');
    expect(textFontValue("Unlisted Text")).toBe('"Unlisted Text", var(--font-text)');
    expect(headingFontValue("")).toBeNull();
    expect(headingFontValue("serif")).toBe("var(--font-serif)");
    expect(headingFontValue("sans-serif")).toBe("var(--font-text)");
    expect(headingFontValue("Baskerville")).toBe('"Baskerville", var(--font-serif)');
    expect(headingFontValue("Avenir Next")).toBe('"Avenir Next", var(--font-text)');
    expect(headingFontValue("Unlisted Display")).toBe('"Unlisted Display", var(--font-content)');
  });

  it("lists every family once, as one kind, under a name that needs no cleaning", () => {
    const all = [...SERIF_FONT_CANDIDATES, ...SANS_FONT_CANDIDATES].map((f) => f.toLowerCase());
    expect(new Set(all).size).toBe(all.length);
    for (const f of [...SERIF_FONT_CANDIDATES, ...SANS_FONT_CANDIDATES]) expect(sanitizeFontFamily(f)).toBe(f);
  });
});
