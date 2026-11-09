import { describe, expect, it } from "vitest";
import { key } from "../utils/path";
import { mayBecomeNote, noteTargetPath, type TargetOptions } from "./targets";

// Listing: folders "Projects", "a/b", and a Hangul note name stored in NFD.
const dirs: Record<string, string[]> = { "": ["Projects", "a"], a: ["b"] };
const files: Record<string, string[]> = { "": ["\uD68C\uC758.md".normalize("NFD")] };
const existing: TargetOptions["existing"] = (dir, nameKey, kind) =>
  ((kind === "dir" ? dirs : files)[dir] ?? []).find((n) => key(n) === nameKey) ?? null;

const link = (target: string, linkDir: string) => noteTargetPath(target, { linkDir, bareDir: linkDir, existing });
const query = (target: string, bareDir = "") => noteTargetPath(target, { linkDir: null, bareDir, existing });

describe("noteTargetPath", () => {
  it("places links relative to the vault root or the linking note", () => {
    expect(link("Page", "a/b")).toBe("a/b/Page.md");
    expect(link("projects/Page", "a")).toBe("Projects/Page.md");
    expect(link("./x", "a/b")).toBe("a/b/x.md");
    expect(link("../x", "a")).toBe("x.md");
    expect(link("/A/new/x.md", "")).toBe("a/new/x.md");
  });

  it("rejects invalid targets and escapes", () => {
    expect(link("../x", "")).toBeNull();
    expect(link("a:b", "")).toBeNull();
    expect(link("CON", "")).toBeNull();
    expect(link("bad|name", "")).toBeNull();
    expect(query("/x")).toBeNull();
    expect(query("a/../b")).toBeNull();
    expect(query("a//b")).toBeNull();
  });

  it("reuses stored names and writes new ones in NFC", () => {
    expect(query("\uD68C\uC758")).toBe("\uD68C\uC758.md".normalize("NFD"));
    expect(query("\uC0C8 \uB178\uD2B8".normalize("NFD"), "a/b")).toBe("a/b/\uC0C8 \uB178\uD2B8.md");
    expect(query("Page.md")).toBe("Page.md");
  });
});

describe("mayBecomeNote", () => {
  it("keeps note titles, dotted ones included, and refuses other kinds of files", () => {
    expect(mayBecomeNote("Ideas")).toBe(true);
    expect(mayBecomeNote("Projects/Plan.md")).toBe(true);
    expect(mayBecomeNote("Meeting 2024.01")).toBe(true);
    expect(mayBecomeNote("example.com")).toBe(true);
    expect(mayBecomeNote("attachments/Q3.PDF")).toBe(false);
    expect(mayBecomeNote("diagram.png")).toBe(false);
    expect(mayBecomeNote("setup.exe")).toBe(false);
  });
});
