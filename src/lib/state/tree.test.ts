import { describe, expect, it } from "vitest";
import { buildTree, flattenVisible, sortedChildren, type Listing } from "./tree";

/** A listing of `paths`, in this order; a trailing "/" marks a folder. */
function listing(...paths: string[]): Listing {
  const list: Listing = { paths: [], kinds: "", mtimes: [] };
  for (const p of paths) {
    const dir = p.endsWith("/");
    list.paths.push(dir ? p.slice(0, -1) : p);
    list.kinds += dir ? "d" : "f";
    list.mtimes.push(dir ? 0 : 7);
  }
  return list;
}

describe("tree", () => {
  it("builds a tree sorted on first use: folders first, natural order, every file kept", () => {
    const { root, nodes } = buildTree(listing("note 10.md", "note 2.md", "b/", "a/x.md", "data.csv", "pic.PNG"));
    expect(root.children!.map((n) => n.name)).toEqual(["note 10.md", "note 2.md", "b", "a", "data.csv", "pic.PNG"]);
    const shown = ["a", "b", "data.csv", "note 2.md", "note 10.md", "pic.PNG"];
    expect(sortedChildren(root).map((n) => n.name)).toEqual(shown);
    expect(root.children!.map((n) => n.name)).toEqual(shown);
    expect(nodes.get("a/x.md")?.depth).toBe(1);
    expect(nodes.get("note 2.md")?.title).toBe("note 2");
    expect(nodes.get("note 2.md")?.mtime).toBe(7);
    expect(nodes.get("pic.PNG")?.fileKind).toBe("image");
    expect(nodes.get("data.csv")).toMatchObject({ fileKind: "other", title: "data.csv", ext: "csv" });
  });

  it("flattens only expanded folders", () => {
    const { root } = buildTree(listing("a/", "a/x.md", "y.md"));
    expect(flattenVisible(root, new Set()).map((r) => r.node.path)).toEqual(["a", "y.md"]);
    expect(flattenVisible(root, new Set(["a"])).map((r) => r.node.path)).toEqual(["a", "a/x.md", "y.md"]);
  });

  it("marks the guide lines that run on below each row", () => {
    const { root } = buildTree(listing("z.md", "a/", "a/y.md", "a/b/", "a/b/x.md"));
    expect(flattenVisible(root, new Set(["a", "a/b"])).map((r) => [r.node.path, r.guides])).toEqual([
      ["a", []],
      ["a/b", [true]],
      ["a/b/x.md", [true, false]],
      ["a/y.md", [false]],
      ["z.md", []],
    ]);
  });
});
