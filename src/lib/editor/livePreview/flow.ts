/**
 * Flow containers and block pairs (DESIGN §3): the reading view's
 * `CONTAINER > A + B` model, read from the Lezer tree so the editor spaces and
 * indents blocks the same way. Pure functions over nodes and the document text.
 */
import type { Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { blockKind, type BlockKind } from "./model";

/** Children of a container that are not blocks. */
const MARKS = new Set(["QuoteMark", "ListMark"]);
/** Containers whose direct children take part in pair spacing. */
const CONTAINERS = new Set(["BulletList", "OrderedList", "ListItem", "Blockquote"]);
/** Item children that are text or a nested list; any other child makes its list `list-blocks` (the renderer's `has-blocks`). */
const ITEM_TEXT = new Set(["Paragraph", "Task", "BulletList", "OrderedList", "LinkReference"]);

/** The container a pair lives in, written to `data-ctx`; the top level has none. */
export type FlowContext = "quote" | "li" | "list" | "list-loose" | "list-blocks";

/** The first block child of `node`. */
export function firstBlock(node: SyntaxNode): SyntaxNode | null {
  let c = node.firstChild;
  while (c && MARKS.has(c.name)) c = c.nextSibling;
  return c;
}

/** The last block child of `node`. */
export function lastBlock(node: SyntaxNode): SyntaxNode | null {
  let c = node.lastChild;
  while (c && MARKS.has(c.name)) c = c.prevSibling;
  return c;
}

/** The block sibling after `node`. */
export function nextBlock(node: SyntaxNode): SyntaxNode | null {
  let c = node.nextSibling;
  while (c && MARKS.has(c.name)) c = c.nextSibling;
  return c;
}

/** The block sibling before `node`. */
export function prevBlock(node: SyntaxNode): SyntaxNode | null {
  let c = node.prevSibling;
  while (c && MARKS.has(c.name)) c = c.prevSibling;
  return c;
}

/** The first block child of `container` that ends after `pos`. */
export function blockAtOrAfter(container: SyntaxNode, pos: number): SyntaxNode | null {
  let c = container.childAfter(pos);
  while (c && MARKS.has(c.name)) c = c.nextSibling;
  return c;
}

/** Where a block's content ends: a quote's trailing `>` lines (marks after its last block) do not count. */
export function contentEnd(node: SyntaxNode): number {
  if (!CONTAINERS.has(node.name)) return node.to;
  const last = lastBlock(node);
  return last ? contentEnd(last) : node.to;
}

/** Lines strictly between blocks `a` and `b`: blank, or holding only quote markers. */
export function blankLinesBetween(doc: Text, a: SyntaxNode, b: SyntaxNode): number {
  return Math.max(0, doc.lineAt(b.from).number - doc.lineAt(contentEnd(a)).number - 1);
}

/** The pair kind of a container's child. */
export function kindOf(node: SyntaxNode): BlockKind {
  return node.name === "ListItem" ? "li" : blockKind(node.name);
}

/** The nearest node named `name` at or above `node`, or null. */
export function enclosing(node: SyntaxNode | null, name: string): SyntaxNode | null {
  for (let n = node; n; n = n.parent) if (n.name === name) return n;
  return null;
}

/** How many list items enclose `node` (itself included when it is one). */
export function listDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let n: SyntaxNode | null = node; n; n = n.parent) if (n.name === "ListItem") depth++;
  return depth;
}

/**
 * A list's spacing context (DESIGN §3.1): `list-loose` when blank lines separate
 * its items, or two blocks inside an item (CommonMark looseness, as markdown-it
 * reads it); `list-blocks` when an item directly holds a block that is neither
 * text nor a nested list; `list` for a tight list of text. Blocks win over loose,
 * as in markdown.css.
 */
export function listContext(doc: Text, list: SyntaxNode): FlowContext {
  let loose = false;
  let blocks = false;
  let prev: SyntaxNode | null = null;
  for (let item = list.firstChild; item && !(loose && blocks); item = item.nextSibling) {
    if (item.name !== "ListItem") continue;
    if (prev && blankLinesBetween(doc, prev, item) > 0) loose = true;
    let prevChild: SyntaxNode | null = null;
    for (let c = firstBlock(item); c; c = nextBlock(c)) {
      if (!ITEM_TEXT.has(c.name)) blocks = true;
      if (prevChild && blankLinesBetween(doc, prevChild, c) > 0) loose = true;
      prevChild = c;
    }
    prev = item;
  }
  return blocks ? "list-blocks" : loose ? "list-loose" : "list";
}
