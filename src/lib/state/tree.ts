/** Pure tree building from the backend's columnar listing. */
import type { ListResult, TreeNode, VaultPath } from "../types";
import { nfc } from "../utils/path";
import { fileKindOf, titleOf } from "../utils/names";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then natural, case/accent-insensitive name order. */
export function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** The columns of a `vault_list` result that make the tree. */
export type Listing = Pick<ListResult, "paths" | "kinds" | "mtimes">;

/** The listing of no vault. */
export const EMPTY_LISTING: ListResult = { paths: [], kinds: "", mtimes: [], truncated: false };

const DIR = "d".charCodeAt(0);

export interface TreeData {
  root: TreeNode;
  nodes: Map<VaultPath, TreeNode>;
}

const folder = (path: VaultPath, name: string, parent: TreeNode | null): TreeNode => ({
  path,
  name,
  title: name,
  kind: "dir",
  fileKind: null,
  ext: "",
  mtime: 0,
  parent: parent?.path ?? "",
  depth: parent === null ? -1 : parent.depth + 1,
  children: [],
});

/**
 * Builds the tree in one pass over the listing. Children stay in listing order:
 * `sortedChildren` sorts a folder when it is first shown, so opening a huge vault
 * sorts only the folders on screen (PERF-01).
 */
export function buildTree(list: Listing): TreeData {
  const root = folder("", "", null);
  const nodes = new Map<VaultPath, TreeNode>([["", root]]);

  const ensureDir = (path: VaultPath): TreeNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = ensureDir(slash < 0 ? "" : path.slice(0, slash));
    const node = folder(path, nfc(path.slice(slash + 1)), parent);
    nodes.set(path, node);
    parent.children!.push(node);
    return node;
  };

  const { paths, kinds, mtimes } = list;
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    if (path === "") continue;
    if (kinds.charCodeAt(i) === DIR) {
      ensureDir(path);
      continue;
    }
    if (nodes.has(path)) continue;
    const slash = path.lastIndexOf("/");
    const name = nfc(path.slice(slash + 1));
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    const fileKind = fileKindOf(name);
    const parent = ensureDir(slash < 0 ? "" : path.slice(0, slash));
    const node: TreeNode = {
      path,
      name,
      title: titleOf(name, fileKind),
      kind: "file",
      fileKind,
      ext,
      mtime: mtimes[i] ?? 0,
      parent: parent.path,
      depth: parent.depth + 1,
      children: null,
    };
    nodes.set(path, node);
    parent.children!.push(node);
  }
  return { root, nodes };
}

/** Folders whose children are already in display order. */
const sorted = new WeakSet<TreeNode>();

/** A folder's children in display order (compareNodes), sorted in place on first use. */
export function sortedChildren(dir: TreeNode): readonly TreeNode[] {
  const children = dir.children;
  if (children === null) return [];
  if (!sorted.has(dir)) {
    children.sort(compareNodes);
    sorted.add(dir);
  }
  return children;
}

/** One visible row of the flattened tree (what FileTree renders). */
export interface TreeRow {
  node: TreeNode;
  expanded: boolean;
  /**
   * Guide lines (DESIGN §4), one per ancestor folder (the root has none): `guides[d]` is
   * true when the line of the depth-`d` ancestor runs on below this row, to a later child
   * of that folder. The last entry is the row's own folder; the length is the node's depth.
   */
  guides: readonly boolean[];
}

export function flattenVisible(root: TreeNode, expanded: ReadonlySet<VaultPath>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (n: TreeNode, above: readonly boolean[]) => {
    const children = sortedChildren(n);
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      const open = c.kind === "dir" && expanded.has(c.path);
      const guides = n.depth < 0 ? above : [...above, i < children.length - 1];
      rows.push({ node: c, expanded: open, guides });
      if (open) walk(c, guides);
    }
  };
  walk(root, []);
  return rows;
}
