import { describe, expect, it } from "vitest";
import { buildTree, flattenVisible } from "./tree";
import type { Entry } from "../types";

const e = (path: string, kind: "dir" | "file" = "file"): Entry => ({ path, kind, mtime: 0, size: 0 });

describe("tree", () => {
  it("builds a sorted tree: folders first, natural order, unsupported files dropped", () => {
    const { root, nodes } = buildTree([
      e("note 10.md"),
      e("note 2.md"),
      e("b", "dir"),
      e("a/x.md"),
      e("data.csv"),
      e("pic.PNG"),
    ]);
    expect(root.children!.map((n) => n.name)).toEqual(["a", "b", "note 2.md", "note 10.md", "pic.PNG"]);
    expect(nodes.get("a/x.md")?.depth).toBe(1);
    expect(nodes.get("note 2.md")?.title).toBe("note 2");
    expect(nodes.get("pic.PNG")?.fileKind).toBe("image");
    expect(nodes.has("data.csv")).toBe(false);
  });

  it("flattens only expanded folders", () => {
    const { root } = buildTree([e("a", "dir"), e("a/x.md"), e("y.md")]);
    expect(flattenVisible(root, new Set()).map((r) => r.node.path)).toEqual(["a", "y.md"]);
    expect(flattenVisible(root, new Set(["a"])).map((r) => r.node.path)).toEqual(["a", "a/x.md", "y.md"]);
  });

  it("marks the guide lines that run on below each row", () => {
    const { root } = buildTree([e("a", "dir"), e("a/b", "dir"), e("a/b/x.md"), e("a/y.md"), e("z.md")]);
    expect(flattenVisible(root, new Set(["a", "a/b"])).map((r) => [r.node.path, r.guides])).toEqual([
      ["a", []],
      ["a/b", [true]],
      ["a/b/x.md", [true, false]],
      ["a/y.md", [false]],
      ["z.md", []],
    ]);
  });
});
