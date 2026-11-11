/**
 * Block widgets from a StateField (TECHNIQUES §1.2, §1.8): images alone on a
 * line (LIVE-11) and tables (LIVE-12). Only static decoration sources shape
 * CodeMirror's height map, so these never come from the ViewPlugin.
 *
 * Regions come from the block structure (top-level blocks plus the blocks inside
 * lists and quotes) and are cached. An edit rescans only the blocks around it
 * (PERF-02): one item of a long outline costs one item. During an IME
 * composition regions are only mapped, and the first update after it rescans
 * around everything the composition changed. Decorations are derived from the
 * regions plus the reveal selection, and are only mapped while frozen
 * (composition, the pointer hold).
 */
import { syntaxTree } from "@codemirror/language";
import {
  StateField,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type Range,
  type SelectionRange,
  type Text,
} from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode, Tree, TreeCursor } from "@lezer/common";
import type { VaultPath } from "../../types";
import type { EditorHost } from "../host";
import { refreshEffect, resolutionEpoch } from "../shared";
import { parseWikiInner } from "../../markdown/resolve";
import type { FrontmatterRange } from "./frontmatter";
import { linkUrl, unresolvedTest, wikiInner } from "./links";
import { endsInside, isImageTarget, linkDestination } from "./model";
import { enclosing, pairOf } from "./flow";
import { fmField, freezeField, mapSelection, reportOnce, revealSelection } from "./state";
import { ImageWidget, NO_INSET, NOTHING_ABOVE, TableWidget, type Above, type Inset } from "./widgets";

interface ImageRegion {
  kind: "image";
  /** The whole source line. */
  from: number;
  to: number;
  src: string;
  srcKind: "wiki" | "href";
  alt: string;
  inset: Inset;
}

interface TableRegion {
  kind: "table";
  /** First line start to last line end. */
  from: number;
  to: number;
  source: string;
  /** Where the Table node starts in `source` (after indentation and quote markers). */
  offset: number;
  inset: Inset;
}

type Region = ImageRegion | TableRegion;

interface Blocks {
  /** In document order. */
  regions: readonly Region[];
  /** Reveal state per region, as drawn. */
  revealed: readonly boolean[];
  /** The selection the reveal state was computed from (a frozen snapshot while held). */
  sel: readonly SelectionRange[];
  /**
   * Unresolved wikilink targets per rendered table source (TableWidget.eq) and resolved
   * image URLs per source. Carried across keystrokes; refreshEffect or a new resolution
   * epoch empties them, so the next compose re-resolves.
   */
  links: ReadonlyMap<string, string>;
  urls: ReadonlyMap<string, string | null>;
  /**
   * The resolution epoch `links` and `urls` were filled in, and the note they were
   * resolved for: relative targets depend on it, and the store builds a note's state
   * before it shows that note.
   */
  epoch: number;
  path: VaultPath | null;
  /** The tree and frontmatter the regions were scanned from. */
  tree: Tree;
  fm: FrontmatterRange | null;
  /** Edits the regions were only mapped through since (a composition), or null. */
  since: ChangeDesc | null;
  /** The regions are no scan of `tree` (a build failed): the next rescan reads the whole tree. */
  stale: boolean;
  deco: DecorationSet;
}

const NO_LINKS: ReadonlyMap<string, string> = new Map();
const NO_URLS: ReadonlyMap<string, string | null> = new Map();

/** Image URLs the widget may load (READ-04/05 scheme allowlist). */
const SAFE_IMAGE_URL = /^(?:asset:|https?:|data:image\/)/i;
/** What may precede a widget's source on its first line: indentation and quote markers, never a list marker. */
const LINE_PREFIX = /^[ \t>]*$/;
/** Blocks whose own children are inline content that can hold an image line. */
const TEXT_BLOCKS = new Set(["Paragraph", "Task"]);
/** Containers walked for nested images and tables (LIVE-11, LIVE-12). */
const CONTAINERS = new Set(["BulletList", "OrderedList", "ListItem", "Blockquote"]);

/** The line `node` is alone on (after indentation and quote markers), and what precedes it there. */
function lineIsOnly(doc: Text, node: SyntaxNode): { from: number; to: number; prefix: string } | null {
  const line = doc.lineAt(node.from);
  if (node.to > line.to) return null;
  const prefix = doc.sliceString(line.from, node.from);
  if (!LINE_PREFIX.test(prefix) || doc.sliceString(node.to, line.to).trim()) return null;
  return { from: line.from, to: line.to, prefix };
}

/** The inset of a container's children, entered from `inset`: quote bars are drawn at the list gutter the quote sits in. */
function insetInside(name: string, inset: Inset): Inset {
  if (name === "Blockquote") return { quote: inset.quote + 1, quoteList: inset.depth, depth: inset.depth };
  if (name === "ListItem") return { ...inset, depth: inset.depth + 1 };
  return inset;
}

/** Image regions in the cursor's paragraph: an Image or image WikiEmbed at or after `after`, alone on its line. */
function imagesIn(doc: Text, cursor: TreeCursor, after: number, inset: Inset, out: Region[]): void {
  if (!cursor.firstChild()) return;
  do {
    if ((cursor.name !== "Image" && cursor.name !== "WikiEmbed") || cursor.from < after) continue;
    const c = cursor.node;
    const line = lineIsOnly(doc, c);
    if (!line) continue;
    if (c.name === "Image") {
      const url = linkUrl(c);
      const marks = c.getChildren("LinkMark");
      if (!url || marks.length < 2) continue;
      const src = linkDestination(doc.sliceString(url.from, url.to));
      const alt = doc.sliceString(marks[0].to, marks[1].from);
      out.push({ kind: "image", from: line.from, to: line.to, src, srcKind: "href", alt, inset });
    } else {
      const open = c.firstChild;
      const close = c.lastChild;
      if (!open || !close || close.from <= open.from) continue;
      const { target } = parseWikiInner(wikiInner(doc, open.to, close.from));
      if (!isImageTarget(target)) continue;
      out.push({ kind: "image", from: line.from, to: line.to, src: target, srcKind: "wiki", alt: target, inset });
    }
  } while (cursor.nextSibling());
  cursor.parent();
}

/** A table region over whole lines; a table that starts on a list marker's line stays source. */
function tableIn(doc: Text, table: SyntaxNode, inset: Inset, out: Region[]): void {
  const first = doc.lineAt(table.from);
  const prefix = doc.sliceString(first.from, table.from);
  if (!LINE_PREFIX.test(prefix)) return;
  const to = doc.lineAt(table.to).to;
  const source = doc.sliceString(first.from, to);
  out.push({ kind: "table", from: first.from, to, source, offset: prefix.length, inset });
}

/**
 * Regions in the children of the cursor's node that overlap [from, to], in document
 * order; `inset` is that node's own inset. Walks the block structure only: blocks,
 * the blocks inside lists and quotes, and the own children of paragraphs (PERF: no
 * deeper inline walk).
 */
function scanIn(state: EditorState, cursor: TreeCursor, from: number, to: number, inset: Inset): Region[] {
  const regions: Region[] = [];
  const doc = state.doc;
  const fm = state.field(fmField, false) ?? null;
  // Nothing inside the frontmatter is Markdown (LIVE-10). A block that runs past its
  // closing fence (Lezer reads text right after `...` as more of the same paragraph)
  // is scanned for what follows the fence.
  const after = fm ? fm.to : 0;
  const visit = (inset: Inset): void => {
    if (fm && cursor.to <= fm.to) return;
    const name = cursor.name;
    if (name === "Table") {
      if (cursor.from >= after) tableIn(doc, cursor.node, inset, regions);
    } else if (TEXT_BLOCKS.has(name)) {
      imagesIn(doc, cursor, after, inset, regions);
    } else if (CONTAINERS.has(name) && cursor.firstChild()) {
      const inner = insetInside(name, inset);
      do visit(inner);
      while (cursor.nextSibling());
      cursor.parent();
    }
  };
  if (!cursor.childAfter(from)) return regions;
  do {
    if (cursor.from > to) break;
    visit(inset);
  } while (cursor.nextSibling());
  return regions;
}

/** Every region in the document. */
function scan(state: EditorState): Region[] {
  return scanIn(state, syntaxTree(state).cursor(), 0, state.doc.length, NO_INSET);
}

/** The child of `parent` whose extent includes `pos` (both ends count). */
function blockAt(parent: SyntaxNode, pos: number): SyntaxNode | null {
  const node = parent.childBefore(pos + 1);
  return node && node.to >= pos ? node : null;
}

/**
 * Regions after `changes` (to `state`) or a new tree: `mapped` (scanned from
 * `oldTree`, mapped through the changes) with the blocks around the changes
 * rescanned. The span is settled in the innermost container (list, item, quote)
 * that holds the changes and ends at the same place in both trees, so nothing
 * outside it changed. An edit can merge or split blocks (a deleted blank line),
 * and an opened or closed fence or HTML block changes every block up to its end,
 * so the span grows until both trees end a block at its edges. Past a partial
 * parse a full scan would find nothing either, so that part is rescanned too.
 */
function rescan(mapped: readonly Region[], oldTree: Tree, changes: ChangeDesc, state: EditorState): Region[] {
  const newTree = syntaxTree(state);
  const len = state.doc.length;
  let lo = Infinity;
  let hi = -1;
  changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    lo = Math.min(lo, fromB);
    hi = Math.max(hi, toB);
  });
  // Up to the first change both documents agree on positions; after the last one
  // they differ by `shift`.
  const shift = len - changes.length;
  let parentNew: SyntaxNode = newTree.topNode;
  let parentOld: SyntaxNode = oldTree.topNode;
  let inset: Inset = NO_INSET;
  const oldEnd = oldTree.length < changes.length ? changes.mapPos(oldTree.length, -1) : Infinity;
  const parsed = Math.min(oldEnd, newTree.length < len ? newTree.length : Infinity);
  if (parsed !== Infinity) {
    lo = Math.min(lo, parsed);
    hi = len;
  } else if (lo === Infinity) {
    // A new tree over the same text and extent (a nested parser loaded): read it all.
    return scan(state);
  } else {
    for (;;) {
      const a = blockAt(parentNew, lo);
      const b = blockAt(parentOld, lo);
      if (!a || !b || !CONTAINERS.has(a.name) || a.name !== b.name) break;
      if (a.from !== b.from || a.from >= lo || a.to < hi || a.to !== b.to + shift) break;
      parentNew = a;
      parentOld = b;
      inset = insetInside(a.name, inset);
    }
  }
  // Whole lines: regions are lines, and an edit in a line's indentation or quote
  // markers can change a block that starts later on that line.
  for (;;) {
    const lo0 = lo;
    const hi0 = hi;
    lo = state.doc.lineAt(lo).from;
    hi = state.doc.lineAt(hi).to;
    for (;;) {
      const a = blockAt(parentNew, lo);
      const b = blockAt(parentOld, lo);
      const next = Math.min(a ? a.from : lo, b ? b.from : lo);
      if (next >= lo) break;
      lo = next;
    }
    while (hi < len) {
      const a = blockAt(parentNew, hi);
      const b = blockAt(parentOld, hi - shift);
      const next = Math.max(a ? a.to : hi, b ? b.to + shift : hi);
      if (next <= hi) break;
      hi = next;
    }
    if (lo === lo0 && hi === hi0) break;
  }
  const out: Region[] = [];
  let i = 0;
  while (i < mapped.length && mapped[i].to < lo) out.push(mapped[i++]);
  for (const r of scanIn(state, parentNew.cursor(), lo, hi, inset)) out.push(r);
  while (i < mapped.length && mapped[i].from <= hi) i++;
  while (i < mapped.length) out.push(mapped[i++]);
  return out;
}

/** The Table node that starts at `pos`, looked up in the current tree (regions keep no nodes). */
function tableAt(tree: Tree, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = tree.resolve(pos, 1); n; n = n.parent) {
    if (n.name === "Table") return n.from === pos ? n : null;
  }
  return null;
}

/**
 * The unresolved wikilink targets in a table's cells, in order: the only host
 * state its widget renders (LIVE-14), so it stands in for that state in eq().
 */
function unresolvedIn(table: SyntaxNode, source: string, base: number, unresolved: (target: string) => boolean): string {
  const found: string[] = [];
  table.cursor().iterate((n) => {
    if (n.name !== "WikiLink" && n.name !== "WikiEmbed") return;
    const open = n.node.firstChild;
    const close = n.node.lastChild;
    if (open && close && close.from > open.from) {
      // Same text as wikiInner(): `source` starts at `base`.
      const inner = source.slice(open.to - base, close.from - base).replace(/\\\|/g, "|");
      const { target } = parseWikiInner(inner);
      if (unresolved(target)) found.push(target);
    }
    return false;
  });
  return found.join("\n");
}

/** The note the host resolves against now (null if it cannot say). */
function hostPath(host: EditorHost): VaultPath | null {
  try {
    return host.currentPath();
  } catch (err) {
    reportOnce("currentPath", err);
    return null;
  }
}

function imageUrl(host: EditorHost, region: ImageRegion): string | null {
  let url: string | null = null;
  try {
    url = host.resolveImage(region.src, region.srcKind);
  } catch (err) {
    reportOnce("resolveImage", err);
  }
  return url && SAFE_IMAGE_URL.test(url) ? url : null;
}

type Drawn = Pick<Blocks, "revealed" | "links" | "urls" | "deco">;

/**
 * How a widget joins the flow above it (DESIGN §3.2), read from the current tree at
 * compose time, so an edit above never leaves its gap stale. The widget replaces its
 * first line, so it shows the gap that line would: `block`'s own pair, or, for the first
 * block of quotes that start on that line, the pair of the outermost such quote. Those
 * quotes' bars begin below the gap.
 */
function flowAbove(doc: Text, fm: FrontmatterRange | null, block: SyntaxNode): Above {
  const line = doc.lineAt(block.from).number;
  let fresh = 0;
  for (let node: SyntaxNode = block; ; ) {
    const pair = pairOf(doc, node, fm);
    const parent = node.parent;
    if (pair || !parent || parent.name !== "Blockquote" || doc.lineAt(parent.from).number !== line) return { pair, fresh };
    fresh++;
    node = parent;
  }
}

/** The paragraph an image line opens; an image on a later line of its paragraph gets no gap of its own. */
function imageBlock(doc: Text, tree: Tree, r: ImageRegion): SyntaxNode | null {
  const inner = tree.resolveInner(r.to, -1);
  const block = enclosing(inner, "Paragraph") ?? enclosing(inner, "Task");
  return block && doc.lineAt(block.from).number === doc.lineAt(r.from).number ? block : null;
}

function compose(
  host: EditorHost,
  state: EditorState,
  tree: Tree,
  fm: FrontmatterRange | null,
  regions: readonly Region[],
  sel: readonly SelectionRange[],
  prevLinks: ReadonlyMap<string, string>,
  prevUrls: ReadonlyMap<string, string | null>,
): Drawn {
  const doc = state.doc;
  const revealed = regions.map((r) => endsInside(sel, r.from, r.to, doc.length));
  const out: Range<Decoration>[] = [];
  const links = new Map<string, string>();
  const urls = new Map<string, string | null>();
  let unresolved: ((target: string) => boolean) | null = null;
  regions.forEach((r, i) => {
    if (r.kind === "image") {
      const key = `${r.srcKind}:${r.src}`;
      let url: string | null;
      if (urls.has(key)) url = urls.get(key) ?? null;
      else if (prevUrls.has(key)) url = prevUrls.get(key) ?? null;
      else url = imageUrl(host, r);
      urls.set(key, url);
      const block = revealed[i] ? null : imageBlock(doc, tree, r);
      const widget = new ImageWidget(url, r.alt, r.inset, block ? flowAbove(doc, fm, block) : NOTHING_ABOVE);
      // Revealed: the source line shows and the image stays below it, so nothing jumps.
      out.push(
        revealed[i]
          ? Decoration.widget({ widget, block: true, side: 1 }).range(r.to)
          : Decoration.replace({ widget, block: true }).range(r.from, r.to),
      );
    } else if (!revealed[i]) {
      const node = tableAt(tree, r.from + r.offset);
      if (!node) return;
      let sig = links.get(r.source) ?? prevLinks.get(r.source);
      if (sig === undefined) sig = unresolvedIn(node, r.source, r.from, (unresolved ??= unresolvedTest(host)));
      links.set(r.source, sig);
      const widget = new TableWidget(r.source, r.from, node, sig, host, r.inset, flowAbove(doc, fm, node));
      out.push(Decoration.replace({ widget, block: true }).range(r.from, r.to));
    }
  });
  return { revealed, links, urls, deco: Decoration.set(out, true) };
}

function mapRegion<R extends Region>(r: R, changes: ChangeDesc): R {
  const from = changes.mapPos(r.from, 1);
  return { ...r, from, to: Math.max(from, changes.mapPos(r.to, -1)) };
}

/** The image/table block-widget field for `host`. */
export function blockPreview(host: EditorHost): Extension {
  /** Regions (from `regions()`, for `state`) composed into a field value; any failure leaves the note as plain text. */
  const build = (
    state: EditorState,
    regions: () => readonly Region[],
    sel: readonly SelectionRange[],
    links: ReadonlyMap<string, string>,
    urls: ReadonlyMap<string, string | null>,
    epoch: number,
  ): Blocks => {
    const tree = syntaxTree(state);
    const scanned = { sel, epoch, path: hostPath(host), tree, fm: state.field(fmField, false) ?? null, since: null };
    try {
      const list = regions();
      return { ...scanned, regions: list, stale: false, ...compose(host, state, tree, scanned.fm, list, sel, links, urls) };
    } catch (err) {
      reportOnce("block widgets", err);
      return { ...scanned, regions: [], revealed: [], links: NO_LINKS, urls: NO_URLS, stale: true, deco: Decoration.none };
    }
  };

  return StateField.define<Blocks>({
    create: (state) => build(state, () => scan(state), revealSelection(state), NO_LINKS, NO_URLS, resolutionEpoch()),

    update(value, tr) {
      const composing = tr.isUserEvent("input.type.compose");
      const frozen = composing || tr.state.field(freezeField);
      const sel = frozen ? mapSelection(value.sel, tr.changes) : revealSelection(tr.state);
      const regions = tr.docChanged ? value.regions.map((r) => mapRegion(r, tr.changes)) : value.regions;
      let since = value.since;
      if (tr.docChanged) since = since ? since.composeDesc(tr.changes.desc) : tr.changes.desc;
      // During composition everything is only mapped; the first update after it rescans.
      if (composing) {
        if (!tr.docChanged && sel === value.sel) return value;
        return { ...value, regions, sel, since, deco: value.deco.map(tr.changes) };
      }
      const epoch = resolutionEpoch();
      // Wikilink and image resolution may have changed: everything re-resolves on the next compose.
      const refresh =
        epoch !== value.epoch || hostPath(host) !== value.path || tr.effects.some((e) => e.is(refreshEffect));
      const links = refresh ? NO_LINKS : value.links;
      const urls = refresh ? NO_URLS : value.urls;
      const state = tr.state;
      if (since !== null || syntaxTree(state) !== value.tree) {
        const full = value.stale || (state.field(fmField, false) ?? null) !== value.fm;
        const changes = since ?? tr.changes.desc;
        const next = full ? () => scan(state) : () => rescan(regions, value.tree, changes, state);
        return build(state, next, sel, links, urls, epoch);
      }
      const docLength = state.doc.length;
      if (
        refresh ||
        (!frozen && sel !== value.sel && regions.some((r, i) => endsInside(sel, r.from, r.to, docLength) !== value.revealed[i]))
      ) {
        return build(state, value.stale ? () => scan(state) : () => regions, sel, links, urls, epoch);
      }
      return sel === value.sel ? value : { ...value, sel };
    },

    provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
  });
}
