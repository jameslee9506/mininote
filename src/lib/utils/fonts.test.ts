import { describe, expect, it } from "vitest";
import { monoFontValue, sanitizeFontFamily } from "./fonts";

describe("code font", () => {
  it("cleans a family name so that it is safe inside a quoted CSS string", () => {
    expect(sanitizeFontFamily('  "JetBrains   Mono" ')).toBe("JetBrains Mono");
    expect(sanitizeFontFamily("Fira Code, monospace")).toBe("Fira Code");
    expect(sanitizeFontFamily("Fira\tCode")).toBe("Fira Code");
    expect(sanitizeFontFamily('a"; } body { color: red\\')).toBe("a; } body { color: red");
    expect(sanitizeFontFamily("\uB098\uB214\uACE0\uB515\uCF54\uB529\n")).toBe("\uB098\uB214\uACE0\uB515\uCF54\uB529");
    expect(sanitizeFontFamily("x".repeat(200))).toHaveLength(80);
    expect(sanitizeFontFamily(undefined)).toBe("");
    expect(sanitizeFontFamily(42)).toBe("");
  });

  it("puts the family before the default stack", () => {
    expect(monoFontValue("")).toBeNull();
    expect(monoFontValue("Fira Code")).toBe('"Fira Code", var(--font-mono-default)');
  });
});
