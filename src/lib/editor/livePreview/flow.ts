/**
 * Flow containers and block pairs (DESIGN §3): the reading view's
 * `CONTAINER > A + B` model, read from the Lezer tree so the editor spaces and
 * indents blocks the same way. Pure functions over nodes and the document text.
 */
import type { Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import type { FrontmatterRange } from "./frontmatter";
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

// ── Blocks, blank lines and pairs (DESIGN §3.2) ───────────────────────────

/** A block as its container's flow sees it, in line numbers. */
export interface FlowBlock {
  kind: BlockKind;
  /** Its first line. */
  first: number;
  /** The line its content ends on (a quote's trailing `>` lines excluded). */
  end: number;
  /** Its last line, trailing quote marks included. */
  last: number;
}

/**
 * The gap a blank line right below a block already shows, as a kind: a blank line is
 * a body line, so it sits where a paragraph typed on it would sit (`gap(block, p)`).
 * - `h` after a heading, `hr` after a rule, `block` after any other block.
 * - null where typed text would join the block instead: a paragraph's next line, a
 *   table's next row, an HTML block's next line.
 */
export type Lead = "h" | "hr" | "block";

export function leadOf(kind: BlockKind): Lead | null {
  if (kind === "p" || kind === "table" || kind === "html") return null;
  if (kind === "hr") return "hr";
  return /^h[1-6]$/.test(kind) ? "h" : "block";
}

/**
 * True for the containers whose blank lines stay in them when text is typed: the
 * document, and a quote (its blank lines carry `>`). A blank line between list items
 * or inside an item belongs to whatever its own indentation says once it has text.
 */
export function carriesLead(container: SyntaxNode): boolean {
  return container.type.isTop || container.name === "Blockquote";
}

/** The pair a block's first line (or the widget standing in for it) shows: `data-blk`, `data-prev`, `--mn-blank`, `data-lead`. */
export interface Pair {
  readonly blk: BlockKind;
  readonly prev: BlockKind;
  /** Lines strictly between the two blocks: blank, or holding only quote marks. */
  readonly blank: number;
  /** The gap the first of those lines already shows, or null. */
  readonly lead: Lead | null;
}

export function samePair(a: Pair | null, b: Pair | null): boolean {
  return (
    a === b || (a !== null && b !== null && a.blk === b.blk && a.prev === b.prev && a.blank === b.blank && a.lead === b.lead)
  );
}

/**
 * `node` as a block of its container, or null when it lies inside the frontmatter
 * (`fm`, for top-level nodes only). Lezer reads the frontmatter as blocks of its own,
 * and text right after a `...` fence as more of its last paragraph: a block that
 * runs past the closing fence counts as a paragraph from its first non-blank line
 * after the fence (LIVE-10).
 */
export function flowBlock(doc: Text, node: SyntaxNode, fm: FrontmatterRange | null): FlowBlock | null {
  const end = doc.lineAt(contentEnd(node)).number;
  const last = doc.lineAt(node.to).number;
  if (fm && node.from < fm.to) {
    if (node.to <= fm.to) return null;
    let first = doc.lineAt(fm.to).number + 1;
    while (first < last && doc.line(first).text.trim() === "") first++;
    return { kind: "p", first, end, last };
  }
  return { kind: kindOf(node), first: doc.lineAt(node.from).number, end, last };
}

/**
 * The block before `node` in its container; `node` null stands for the container's
 * end. At the top level the frontmatter stands in for a first block.
 */
export function blockBefore(
  doc: Text,
  container: SyntaxNode,
  node: SyntaxNode | null,
  fm: FrontmatterRange | null,
): FlowBlock | null {
  for (let p = node ? prevBlock(node) : lastBlock(container); p; p = prevBlock(p)) {
    const block = flowBlock(doc, p, fm);
    if (block) return block;
  }
  if (!fm) return null;
  const line = doc.lineAt(fm.to).number;
  return { kind: "fm", first: 1, end: line, last: line };
}

/**
 * The pair of `cur` with the block before it. The blank lines between them count
 * from the upper block's content; the first one below that block shows its lead
 * when the container carries leads.
 */
export function pairWith(prev: FlowBlock, cur: FlowBlock, leads: boolean): Pair {
  const lead = leads && cur.first > prev.last + 1 ? leadOf(prev.kind) : null;
  return { blk: cur.kind, prev: prev.kind, blank: Math.max(0, cur.first - prev.end - 1), lead };
}

/** The pair of block `node` in its container, or null for a first block (and inside the frontmatter). */
export function pairOf(doc: Text, node: SyntaxNode, fm: FrontmatterRange | null): Pair | null {
  const container = node.parent;
  if (!container) return null;
  const scoped = container.type.isTop ? fm : null;
  const cur = flowBlock(doc, node, scoped);
  const prev = cur && blockBefore(doc, container, node, scoped);
  return cur && prev ? pairWith(prev, cur, carriesLead(container)) : null;
}
