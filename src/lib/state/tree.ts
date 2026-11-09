/** Pure tree building from the backend's flat listing. */
import type { Entry, TreeNode, VaultPath } from "../types";
import { basename, dirname, extname, nfc } from "../utils/path";
import { fileKindOf, titleOf } from "../utils/names";

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Folders first, then natural, case/accent-insensitive name order. */
export function compareNodes(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
  return collator.compare(a.name, b.name) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export interface TreeData {
  root: TreeNode;
  nodes: Map<VaultPath, TreeNode>;
}

export function buildTree(entries: readonly Entry[]): TreeData {
  const root: TreeNode = {
    path: "",
    name: "",
    title: "",
    kind: "dir",
    fileKind: null,
    ext: "",
    mtime: 0,
    parent: "",
    depth: -1,
    children: [],
  };
  const nodes = new Map<VaultPath, TreeNode>([["", root]]);

  const ensureDir = (path: VaultPath): TreeNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const parent = ensureDir(dirname(path));
    const name = nfc(basename(path));
    const node: TreeNode = {
      path,
      name,
      title: name,
      kind: "dir",
      fileKind: null,
      ext: "",
      mtime: 0,
      parent: parent.path,
      depth: parent.depth + 1,
      children: [],
    };
    nodes.set(path, node);
    parent.children!.push(node);
    return node;
  };

  for (const e of entries) {
    if (e.path === "") continue;
    if (e.kind === "dir") {
      ensureDir(e.path).mtime = e.mtime;
      continue;
    }
    const ext = extname(e.path);
    const fileKind = fileKindOf(ext);
    if (!fileKind || nodes.has(e.path)) continue;
    const parent = ensureDir(dirname(e.path));
    const name = nfc(basename(e.path));
    const node: TreeNode = {
      path: e.path,
      name,
      title: titleOf(name, fileKind),
      kind: "file",
      fileKind,
      ext,
      mtime: e.mtime,
      parent: parent.path,
      depth: parent.depth + 1,
      children: null,
    };
    nodes.set(e.path, node);
    parent.children!.push(node);
  }

  const sortRec = (n: TreeNode) => {
    if (!n.children) return;
    n.children.sort(compareNodes);
    for (const c of n.children) sortRec(c);
  };
  sortRec(root);
  return { root, nodes };
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
    const children = n.children ?? [];
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
