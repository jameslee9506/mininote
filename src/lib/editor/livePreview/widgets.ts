/**
 * Live-preview widgets (TECHNIQUES §1.8): the task checkbox (inline, from the
 * ViewPlugin) and the image and table block widgets (from the StateField).
 * - eq() compares rendering inputs only, never document positions.
 * - Positions are resolved with posAtDOM at event time.
 * - DOM is built through properties and text nodes, never innerHTML of note text.
 */
import { EditorSelection } from "@codemirror/state";
import { WidgetType, type EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { EditorHost } from "../host";
import { t } from "../../i18n";
import { parseWikiInner } from "../../markdown/resolve";
import { hasMod } from "../../utils/platform";
import { eventElement, followLink, followOnRelease, linkAt, linkUrl, unresolvedTest } from "./links";
import { samePair, type Pair } from "./flow";
import { hashString, tableAlignments, type Align } from "./model";
import { reportOnce } from "./state";

/** Drag-and-drop over a widget must still reach the editor's drop handling. */
function isDragEvent(e: Event): boolean {
  return e.type.startsWith("drag") || e.type === "drop";
}

/** `[ ]` / `[x]` drawn as a CSS checkbox (LIVE-05). Toggling happens in the plugin's mousedown handler. */
export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(): HTMLElement {
    const box = document.createElement("span");
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-label", t("ariaCheckbox"));
    this.paint(box);
    return box;
  }

  override updateDOM(dom: HTMLElement): boolean {
    this.paint(dom);
    return true;
  }

  private paint(box: HTMLElement): void {
    box.className = this.checked ? "cm-task cm-task-checked" : "cm-task";
    box.setAttribute("aria-checked", this.checked ? "true" : "false");
  }

  override ignoreEvent(e: Event): boolean {
    return !(e.type === "mousedown" || isDragEvent(e));
  }
}

// ── Height caches (block widgets feed CodeMirror's height map) ────────────

const CACHE_LIMIT = 500;
/** Natural image sizes by URL: reserve the aspect ratio before the image loads. */
const imageSizes = new Map<string, { w: number; h: number }>();
/** Rendered heights by image URL / table source hash, for `estimatedHeight`. */
const imageHeights = new Map<string, number>();
const tableHeights = new Map<number, number>();
let lineHeightGuess = 25.5;

/** Keeps the editor's measured line height for table height estimates. */
export function noteLineHeight(px: number): void {
  if (px > 0) lineHeightGuess = px;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= CACHE_LIMIT && !map.has(key)) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

/** Measures `dom` in CodeMirror's next read phase; also makes the editor re-measure its heights. */
function measureInto<K>(view: EditorView, dom: HTMLElement, map: Map<K, number>, key: K): void {
  view.requestMeasure({
    read: () => (dom.isConnected ? dom.getBoundingClientRect().height : 0),
    write: (height) => {
      if (height > 0) remember(map, key, height);
    },
  });
}

/** A click on a block widget puts the caret on its source, which reveals it. */
function placeCaret(view: EditorView, pos: number): void {
  view.dispatch({ selection: EditorSelection.cursor(Math.min(pos, view.state.doc.length)), userEvent: "select.pointer" });
  view.focus();
}

/**
 * Where a block widget nested in a quote or list item sits: at its container's
 * inset, as its source line would show it (editor.css).
 */
export interface Inset {
  /** Quote depth: one step and one bar per level, as on quote lines. */
  readonly quote: number;
  /** The list depth the innermost quote sits in: its bars are drawn at that gutter. */
  readonly quoteList: number;
  /** List depth: the widget starts at the reading view's gutter, one indent per level. */
  readonly depth: number;
}

export const NO_INSET: Inset = { quote: 0, quoteList: 0, depth: 0 };

/** How a widget joins the flow above it (DESIGN §3.2), read from the tree when it is drawn. */
export interface Above {
  /** The gap above the widget, or null when it has none. */
  readonly pair: Pair | null;
  /** How many of its quotes start on its first line: their bars begin below the gap. */
  readonly fresh: number;
}

export const NOTHING_ABOVE: Above = { pair: null, fresh: 0 };

function sameInset(a: Inset, b: Inset): boolean {
  return a.quote === b.quote && a.quoteList === b.quoteList && a.depth === b.depth;
}

function sameAbove(a: Above, b: Above): boolean {
  return a.fresh === b.fresh && samePair(a.pair, b.pair);
}

/**
 * A block widget's box, laid out as its block's first line would be (editor.css): the
 * quote steps and list gutter as padding, and the pair attributes for the gap above it.
 */
function frame(className: string, inset: Inset, above: Above): { wrap: HTMLElement; body: HTMLElement } {
  const wrap = document.createElement("div");
  wrap.className = `cm-block ${className}`;
  if (inset.quote > 0) {
    wrap.classList.add("cm-widget-quote");
    wrap.style.setProperty("--mn-quote", String(inset.quote));
    wrap.style.setProperty("--mn-quote-list", String(inset.quoteList));
    wrap.style.setProperty("--mn-quote-new", String(Math.min(above.fresh, inset.quote)));
  }
  if (inset.depth > 0) wrap.style.setProperty("--mn-depth", String(inset.depth));
  const { pair } = above;
  if (pair) {
    wrap.dataset.blk = pair.blk;
    wrap.dataset.prev = pair.prev;
    if (pair.lead) wrap.dataset.lead = pair.lead;
    if (pair.blank > 0) wrap.style.setProperty("--mn-blank", String(pair.blank));
  }
  const body = document.createElement("div");
  body.className = "cm-widget-body";
  wrap.append(body);
  return { wrap, body };
}

// ── Image (LIVE-11) ───────────────────────────────────────────────────────

function brokenBox(): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-image-broken";
  return box;
}

/** An image alone on its line. `url` is already resolved and scheme-checked; null shows the empty box. */
export class ImageWidget extends WidgetType {
  constructor(
    readonly url: string | null,
    readonly alt: string,
    readonly inset: Inset,
    /** The flow above the image; no gap below a revealed source line. */
    readonly above: Above,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return (
      other.url === this.url && other.alt === this.alt && sameInset(other.inset, this.inset) && sameAbove(other.above, this.above)
    );
  }

  override get estimatedHeight(): number {
    return (this.url !== null && imageHeights.get(this.url)) || -1;
  }

  toDOM(view: EditorView): HTMLElement {
    const { wrap, body } = frame("cm-image-widget", this.inset, this.above);
    wrap.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        placeCaret(view, view.state.doc.lineAt(view.posAtDOM(wrap)).to);
      } catch (err) {
        reportOnce("image click", err);
      }
    });
    const url = this.url;
    if (url === null) {
      body.append(brokenBox());
      return wrap;
    }
    const img = document.createElement("img");
    img.alt = this.alt;
    img.draggable = false;
    img.decoding = "async";
    const size = imageSizes.get(url);
    if (size) {
      // Width/height attributes give the box its aspect ratio before the bytes arrive.
      img.width = size.w;
      img.height = size.h;
    }
    img.addEventListener("load", () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) remember(imageSizes, url, { w: img.naturalWidth, h: img.naturalHeight });
      measureInto(view, wrap, imageHeights, url);
    });
    img.addEventListener("error", () => {
      img.replaceWith(brokenBox());
      measureInto(view, wrap, imageHeights, url);
    });
    img.src = url;
    body.append(img);
    return wrap;
  }

  override ignoreEvent(e: Event): boolean {
    return !isDragEvent(e);
  }
}

// ── Table (LIVE-12) ───────────────────────────────────────────────────────

/** A rendered GFM table. `node` and `base` come from a state whose text holds `source` at `base`. */
export class TableWidget extends WidgetType {
  private hash = -1;

  constructor(
    readonly source: string,
    /** Document position of `source[0]` (the table's first line start) when the widget was made. */
    readonly base: number,
    readonly node: SyntaxNode,
    /**
     * The cells' unresolved wikilink targets, in order: with `source`, everything the
     * rendering depends on, so a listing refresh that changes no resolution keeps
     * the DOM (and its horizontal scroll).
     */
    readonly unresolved: string,
    readonly host: EditorHost,
    readonly inset: Inset,
    readonly above: Above,
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return (
      other.source === this.source &&
      other.unresolved === this.unresolved &&
      sameInset(other.inset, this.inset) &&
      sameAbove(other.above, this.above)
    );
  }

  private get cacheKey(): number {
    if (this.hash < 0) this.hash = hashString(this.source);
    return this.hash;
  }

  override get estimatedHeight(): number {
    const known = tableHeights.get(this.cacheKey);
    if (known) return known;
    let rows = 0;
    for (let i = this.source.indexOf("\n"); i >= 0; i = this.source.indexOf("\n", i + 1)) rows++;
    // Lines minus the delimiter row; each row is one text line plus 12px padding and a border.
    return Math.max(1, rows) * (lineHeightGuess + 13) + 8;
  }

  toDOM(view: EditorView): HTMLElement {
    const { wrap, body } = frame("cm-table-widget", this.inset, this.above);
    try {
      body.append(renderTable(this.node, this.source, this.base, this.host));
    } catch (err) {
      reportOnce("table", err);
    }
    wrap.addEventListener("mousedown", (e) => tableMouseDown(e, view, wrap, this.host));
    measureInto(view, wrap, tableHeights, this.cacheKey);
    return wrap;
  }

  override ignoreEvent(e: Event): boolean {
    return !isDragEvent(e);
  }
}

/**
 * Cell click: caret to the cell's source position (revealing the raw table).
 * A link in a cell follows on release, like a rendered link in text.
 */
function tableMouseDown(e: MouseEvent, view: EditorView, wrap: HTMLElement, host: EditorHost): void {
  if (e.button !== 0) return;
  const el = eventElement(e);
  const cell = el?.closest("td, th");
  // Elsewhere (the horizontal scrollbar) the browser's default behavior applies.
  if (!el || !cell || !wrap.contains(cell)) return;
  e.preventDefault();
  try {
    const base = view.posAtDOM(wrap);
    const doc = view.state.doc;
    const link = el.closest("[data-link]");
    if (link && !e.altKey && !e.shiftKey) {
      const found = linkAt(view.state, Math.min(doc.length, base + (Number(link.getAttribute("data-link")) || 0)));
      if (found) {
        if (hasMod(e)) followLink(host, found.target);
        else followOnRelease(e, host, found.target);
        return;
      }
    }
    placeCaret(view, base + (Number(cell.getAttribute("data-off")) || 0));
  } catch (err) {
    reportOnce("table click", err);
  }
}

interface Cell {
  /** Source position the caret goes to. */
  pos: number;
  node: SyntaxNode | null;
}

/** Cells of a TableHeader/TableRow, including empty ones (which have no TableCell node). */
function rowCells(row: SyntaxNode, text: (from: number, to: number) => string): Cell[] {
  const pipes: number[] = [];
  const nodes: SyntaxNode[] = [];
  for (let c = row.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableDelimiter") pipes.push(c.from);
    else if (c.name === "TableCell") nodes.push(c);
  }
  const bounds = [row.from - 1, ...pipes, row.to];
  const cells: Cell[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const from = bounds[i] + 1;
    const to = bounds[i + 1];
    // The segments outside a leading or trailing pipe are not cells.
    const outer = (i === 0 && pipes[0] === row.from) || (i === bounds.length - 2 && pipes[pipes.length - 1] === row.to - 1);
    if (outer && text(from, to).trim() === "") continue;
    const node = nodes.find((n) => n.from >= from && n.to <= to) ?? null;
    cells.push({ pos: node ? node.from : Math.min(to, from + 1), node });
  }
  return cells;
}

interface Renderer {
  base: number;
  text(from: number, to: number): string;
  unresolved(target: string): boolean;
}

function renderTable(node: SyntaxNode, source: string, base: number, host: EditorHost): HTMLTableElement {
  const r: Renderer = {
    base,
    text: (from, to) => source.slice(from - base, to - base),
    unresolved: unresolvedTest(host),
  };
  const table = document.createElement("table");
  let aligns: (Align | null)[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableDelimiter") {
      aligns = tableAlignments(r.text(c.from, c.to));
      break;
    }
  }
  let head: HTMLTableSectionElement | null = null;
  let body: HTMLTableSectionElement | null = null;
  for (let row = node.firstChild; row; row = row.nextSibling) {
    if (row.name !== "TableHeader" && row.name !== "TableRow") continue;
    const isHead = row.name === "TableHeader";
    const section = isHead ? (head ??= table.createTHead()) : (body ??= table.createTBody());
    const tr = section.insertRow();
    const cells = rowCells(row, r.text);
    // GFM: the delimiter row fixes the column count; short rows are padded, long ones cut.
    const cols = aligns.length || cells.length;
    for (let i = 0; i < cols; i++) {
      const cell = document.createElement(isHead ? "th" : "td");
      const align = aligns[i];
      if (align) cell.className = `cm-align-${align}`;
      const seg = cells[i];
      cell.dataset.off = String((seg ? seg.pos : row.to) - base);
      if (seg?.node) renderRange(cell, seg.node, seg.node.from, seg.node.to, r);
      tr.append(cell);
    }
  }
  return table;
}

const WRAPPERS: Record<string, string> = {
  Emphasis: "cm-em",
  StrongEmphasis: "cm-strong",
  Strikethrough: "cm-strike",
  Highlight: "cm-highlight",
};
const SKIPPED = new Set(["EmphasisMark", "StrikethroughMark", "HighlightMark", "CodeMark", "LinkMark", "WikiLinkMark"]);

function span(className: string, fill: (el: HTMLElement) => void): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  fill(el);
  return el;
}

/** Renders the inline content of `node` between `from` and `to` as text and styled spans. */
function renderRange(parent: HTMLElement, node: SyntaxNode, from: number, to: number, r: Renderer): void {
  let pos = from;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.to <= from || c.from >= to) continue;
    if (c.from > pos) parent.append(r.text(pos, c.from));
    renderNode(parent, c, r);
    pos = Math.max(pos, c.to);
  }
  if (to > pos) parent.append(r.text(pos, to));
}

/** Cell markup as plain DOM (LIVE-12 [critic]): raw HTML in a cell stays text. */
function renderNode(parent: HTMLElement, node: SyntaxNode, r: Renderer): void {
  if (SKIPPED.has(node.name)) return;
  const wrapper = WRAPPERS[node.name];
  if (wrapper) {
    parent.append(span(wrapper, (el) => renderRange(el, node, node.from, node.to, r)));
    return;
  }
  switch (node.name) {
    case "InlineCode": {
      const open = node.firstChild;
      const close = node.lastChild;
      const from = open?.name === "CodeMark" ? open.to : node.from;
      const to = close && open && close.from > open.from && close.name === "CodeMark" ? close.from : node.to;
      parent.append(span("cm-inline-code", (el) => (el.textContent = r.text(from, to))));
      return;
    }
    case "Link": {
      if (!linkUrl(node)) {
        // A reference link stays plain text, except for a bare URL in its label (LIVE-06).
        let pos = node.from;
        for (let c = node.firstChild; c; c = c.nextSibling) {
          if (c.name !== "URL") continue;
          if (c.from > pos) parent.append(r.text(pos, c.from));
          renderNode(parent, c, r);
          pos = c.to;
        }
        if (node.to > pos) parent.append(r.text(pos, node.to));
        return;
      }
      const marks = node.getChildren("LinkMark");
      if (marks.length < 2 || marks[1].from <= marks[0].to) break;
      const el = span("cm-link", (s) => renderRange(s, node, marks[0].to, marks[1].from, r));
      el.dataset.link = String(node.from - r.base);
      parent.append(el);
      return;
    }
    case "Autolink":
    case "URL": {
      const url = node.name === "URL" ? node : node.getChild("URL");
      if (!url) break;
      const el = span("cm-link", (s) => (s.textContent = r.text(url.from, url.to)));
      el.dataset.link = String(url.from - r.base);
      parent.append(el);
      return;
    }
    case "WikiLink":
    case "WikiEmbed": {
      const open = node.firstChild;
      const close = node.lastChild;
      const shown = node.getChild("WikiLinkAlias") ?? node.getChild("WikiLinkTarget");
      if (!open || !close || close.from <= open.from || !shown) break;
      const { target } = parseWikiInner(r.text(open.to, close.from).replace(/\\\|/g, "|"));
      const cls = r.unresolved(target) ? "cm-wikilink cm-unresolved" : "cm-wikilink";
      const el = span(cls, (s) => (s.textContent = r.text(shown.from, shown.to)));
      el.dataset.link = String(node.from - r.base);
      parent.append(el);
      return;
    }
    case "Image": {
      const marks = node.getChildren("LinkMark");
      if (marks.length < 2) break;
      parent.append(r.text(marks[0].to, marks[1].from));
      return;
    }
    case "Escape":
      parent.append(r.text(node.from + 1, node.to));
      return;
  }
  parent.append(r.text(node.from, node.to));
}
