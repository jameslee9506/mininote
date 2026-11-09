import { describe, expect, it } from "vitest";
import { conflictCopyName } from "./conflict";

const at = new Date(2026, 10, 8, 9, 30, 12);
const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("conflictCopyName", () => {
  it("adds the unlocalized suffix and keeps the extension", () => {
    expect(conflictCopyName("Meeting notes.md", at)).toBe("Meeting notes (conflict 20261108-093012).md");
    expect(conflictCopyName("Notes.MARKDOWN", at, 2)).toBe("Notes (conflict 20261108-093012) 2.MARKDOWN");
  });

  it("writes the stem in NFC", () => {
    expect(conflictCopyName("\uD55C\uAE00.md".normalize("NFD"), at)).toBe("\uD55C\uAE00 (conflict 20261108-093012).md");
  });

  it("truncates long stems at a code-point boundary to fit 255 bytes", () => {
    const hangul = conflictCopyName(`${"\uAC00".repeat(84)}.md`, at, 3);
    expect(bytes(hangul)).toBeLessThanOrEqual(255);
    expect(hangul.endsWith(" (conflict 20261108-093012) 3.md")).toBe(true);
    const emoji = conflictCopyName(`${"😀".repeat(70)}.md`, at);
    expect(bytes(emoji)).toBeLessThanOrEqual(255);
    expect(emoji).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
