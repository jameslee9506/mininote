import { describe, expect, it } from "vitest";
import { basename, dirname, extname, isAncestor, normalizeRel, rebase, relativeTo, toAbsolute, decodeLinkPath, encodeLinkPath } from "./path";

describe("path", () => {
  it("splits paths", () => {
    expect(dirname("a/b/c.md")).toBe("a/b");
    expect(dirname("c.md")).toBe("");
    expect(basename("a/b/c.md")).toBe("c.md");
    expect(extname("a/b/C.MD")).toBe("md");
    expect(extname(".hidden")).toBe("");
  });

  it("checks ancestry without prefix confusion", () => {
    expect(isAncestor("a", "a/b")).toBe(true);
    expect(isAncestor("a", "ab/c")).toBe(false);
    expect(isAncestor("", "x")).toBe(true);
    expect(isAncestor("a", "a")).toBe(false);
  });

  it("rebases moved paths", () => {
    expect(rebase("a/b/c.md", "a/b", "x")).toBe("x/c.md");
    expect(rebase("a/b", "a/b", "x/y")).toBe("x/y");
    expect(rebase("a/bc", "a/b", "x")).toBeNull();
  });

  it("normalizes relative link paths and refuses to escape the root", () => {
    expect(normalizeRel("./a\\b/../c.md")).toBe("a/c.md");
    expect(normalizeRel("../x")).toBeNull();
  });

  it("computes relative paths", () => {
    expect(relativeTo("a/b", "a/c/x.png")).toBe("../c/x.png");
    expect(relativeTo("", "img/x.png")).toBe("img/x.png");
    expect(relativeTo("a", "a/x.png")).toBe("x.png");
  });

  it("builds absolute paths with the root's separator", () => {
    expect(toAbsolute("/Users/me/vault", "a/b.md")).toBe("/Users/me/vault/a/b.md");
    expect(toAbsolute("C:\\vault", "a/b.md")).toBe("C:\\vault\\a\\b.md");
  });

  it("round-trips link destinations", () => {
    const p = "Pasted image 1 (2).png";
    expect(decodeLinkPath(encodeLinkPath(p))).toBe(p);
    expect(decodeLinkPath("<a b.png>")).toBe("a b.png");
    expect(decodeLinkPath("100%.png")).toBe("100%.png");
  });
});
