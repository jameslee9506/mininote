import { describe, expect, it } from "vitest";
import { detectLineEnding, fromLF, minimalChange, toLF, wellFormed } from "./lineEndings";

describe("line endings", () => {
  it("detects the first line ending", () => {
    expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
    expect(detectLineEnding("a\nb\r\n")).toBe("\n");
    expect(detectLineEnding("a\rb")).toBe("\r");
    expect(detectLineEnding("one line")).toBeNull();
  });

  it("round-trips CRLF and CR files byte for byte", () => {
    for (const raw of ["# Heading\r\n\r\nBody\r\n", "a\rb\r", "x\ny\n"]) {
      const eol = detectLineEnding(raw) ?? "\n";
      expect(fromLF(toLF(raw), eol)).toBe(raw);
    }
    expect(toLF("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });

  it("finds one minimal replacement", () => {
    expect(minimalChange("hello world", "hello brave world")).toEqual({ from: 6, to: 6, insert: "brave " });
    expect(minimalChange("aaa", "aa")).toEqual({ from: 2, to: 3, insert: "" });
    expect(minimalChange("same", "same")).toBeNull();
    const a = "x😀y";
    const b = "x😃y";
    const ch = minimalChange(a, b)!;
    expect(a.slice(0, ch.from) + ch.insert + a.slice(ch.to)).toBe(b);
    expect(ch).toEqual({ from: 1, to: 3, insert: "😃" });
  });

  it("replaces lone surrogates only, keeping a leading U+FEFF", () => {
    expect(wellFormed("ok \uD55C\uAE00 😀")).toBe("ok \uD55C\uAE00 😀");
    expect(wellFormed("a\uD800b")).toBe("a�b");
    expect(wellFormed("\uDE00x")).toBe("�x");
    expect(wellFormed("😀\uDE00")).toBe("😀�");
    expect(wellFormed("﻿😀\uD800")).toBe("﻿😀�");
  });
});
