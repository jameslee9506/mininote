import { describe, expect, it } from "vitest";
import { copyName, fileKindOf, pastedImageName, titleOf, uniqueName, validateName, withKeptExtension } from "./names";

const bytes = (s: string) => new TextEncoder().encode(s).length;

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

  it("names a copy after its file, numbered where the name is taken", () => {
    const taken = new Set(["note.md", "note 1.md", "makefile", "draft."]);
    const has = (k: string) => taken.has(k);
    expect(copyName("Other.md", has)).toBe("Other.md");
    expect(copyName("Note.md", has)).toBe("Note 2.md");
    expect(copyName("NOTE.MD", has)).toBe("NOTE 2.MD");
    expect(copyName("Makefile", has)).toBe("Makefile 1");
    // A dot that ends the name starts no extension.
    expect(copyName("draft.", has)).toBe("draft. 1");
    // Written in NFC, and found taken under either form.
    const hangul = "\uD55C\uAE00.md";
    expect(copyName(hangul.normalize("NFD"), () => false)).toBe(hangul);
    expect(copyName(hangul.normalize("NFD"), (k) => k === hangul)).toBe("\uD55C\uAE00 1.md");
    // A numbered name still fits 255 bytes: the stem gives way, never the extension.
    const long = `${"\uAC00".repeat(84)}.md`;
    const copy = copyName(long, (k) => k === long);
    expect(bytes(copy)).toBeLessThanOrEqual(255);
    expect(copy.endsWith(" 1.md")).toBe(true);
  });

  it("tells notes, images, code and every other file apart by name", () => {
    expect(fileKindOf("a/Note.MD")).toBe("note");
    expect(fileKindOf("x.markdown")).toBe("note");
    expect(fileKindOf("pics/p.JPEG")).toBe("image");
    expect(fileKindOf("src/main.RS")).toBe("code");
    expect(fileKindOf("Makefile")).toBe("code");
    // A note or an image stays one, whatever its name starts with.
    expect(fileKindOf("Makefile.md")).toBe("note");
    expect(fileKindOf("Dockerfile.png")).toBe("image");
    expect(fileKindOf("report.pdf")).toBe("pdf");
    expect(fileKindOf("docs/Q3.PDF")).toBe("pdf");
    expect(fileKindOf("Makefile.pdf")).toBe("pdf");
    expect(fileKindOf("archive.zip")).toBe("other");
    expect(fileKindOf(".md")).toBe("other");
    expect(fileKindOf("md")).toBe("other");
  });

  it("keeps a file's extension when the new name brings none", () => {
    expect(withKeptExtension("photo", "IMG_1.png")).toBe("photo.png");
    expect(withKeptExtension("data.txt", "data.csv")).toBe("data.txt");
    expect(withKeptExtension("Trip 2024.01", "a.pdf")).toBe("Trip 2024.01");
    expect(withKeptExtension("Build", "Makefile")).toBe("Build");
    expect(withKeptExtension("photo.", "a.png")).toBe("photo.");
  });

  it("derives titles and pasted image names", () => {
    expect(titleOf("note.md", "note")).toBe("note");
    expect(titleOf("pic.png", "image")).toBe("pic.png");
    expect(pastedImageName("png", new Date(2026, 10, 8, 9, 5, 3))).toBe("Pasted image 20261108090503.png");
  });
});
