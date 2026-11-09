import { describe, expect, it } from "vitest";
import { pastedImageName, titleOf, uniqueName, validateName } from "./names";

describe("names", () => {
  it("validates cross-platform file names", () => {
    expect(validateName("\uD68C\uC758\uB85D", { note: true })).toBeNull();
    expect(validateName("", { note: true })).toBe("empty");
    expect(validateName("a/b", { note: false })).toBe("invalid");
    expect(validateName("a:b", { note: false })).toBe("invalid");
    expect(validateName("trailing.", { note: false })).toBe("invalid");
    expect(validateName(".hidden", { note: false })).toBe("hidden");
    expect(validateName("CON", { note: false })).toBe("reserved");
    expect(validateName("com1.md", { note: false })).toBe("reserved");
    expect(validateName("a#b", { note: true })).toBe("invalid");
    expect(validateName("a#b", { note: false })).toBeNull();
    expect(validateName(`${"\uAC00".repeat(85)}.md`, { note: true })).toBe("too_long");
    expect(validateName(`${"\uAC00".repeat(84)}.md`, { note: true })).toBeNull();
  });

  it("finds the first free name, case- and NFC-insensitively", () => {
    const taken = new Set(["untitled.md", "untitled 1.md"]);
    expect(uniqueName("Untitled", "md", (k) => taken.has(k))).toBe("Untitled 2.md");
    const nfd = new Set(["\uC81C\uBAA9 \uC5C6\uC74C.md".normalize("NFD").normalize("NFC").toLowerCase()]);
    expect(uniqueName("\uC81C\uBAA9 \uC5C6\uC74C", "md", (k) => nfd.has(k))).toBe("\uC81C\uBAA9 \uC5C6\uC74C 1.md");
  });

  it("derives titles and pasted image names", () => {
    expect(titleOf("note.md", "note")).toBe("note");
    expect(titleOf("pic.png", "image")).toBe("pic.png");
    expect(pastedImageName("png", new Date(2026, 10, 8, 9, 5, 3))).toBe("Pasted image 20261108090503.png");
  });
});
