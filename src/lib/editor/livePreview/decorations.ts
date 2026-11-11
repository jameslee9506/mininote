/**
 * Inline and per-line live-preview decorations for the visible ranges
 * (ARCHITECTURE §10.2): hidden marks, style marks, line classes, the checkbox
 * widget, hanging indents and the block-pair attributes of DESIGN §3.2.
 * One tree walk per visible range; every construct reveals by its own unit.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Line, Range, SelectionRange, Text } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import type { EditorHost } from "../host";
import { parseWikiInner } from "../../markdown/resolve";
import {
  blockAtOrAfter,
  blockBefore,
  carriesLead,
  enclosing,
  flowBlock,
  leadOf,
  listContext,
  listDepth,
  nextBlock,
  pairWith,
  type FlowBlock,
  type FlowContext,
  type Pair,
} from "./flow";
import type { FrontmatterRange } from "./frontmatter";
import { linkUrl, unresolvedTest, wikiInner } from "./links";
import { fenceLabel, isImageTarget, touches, type BlockKind } from "./model";
import { fmField, reportOnce } from "./state";
import { CheckboxWidget } from "./widgets";

/** Hanging-indent cache access (indent.ts), injected by the plugin. */
export interface HangSource {
  get(key: string): number | undefined;
  request(key: string, from: number, to: number): void;
}

export interface BuildInput {
  state: EditorState;
  ranges: readonly { from: number; to: number }[];
  /** Ranges that reveal syntax (empty while the editor is unfocused). */
  sel: readonly SelectionRange[];
  host: EditorHost;
  hang: HangSource;
}

const HIDE = Decoration.replace({});
/** Revealed syntax marks: faint (DESIGN §5). */
const SYNTAX = Decoration.mark({ class: "cm-syntax" });
/**
 * Wraps the content of lines whose height differs from body text, so CodeMirror
 * never samples them for its line-height estimate (TECHNIQUES §1.7).
 */
const GUARD = Decoration.mark({ class: "cm-nosample", inclusive: true });
const EM = Decoration.mark({ class: "cm-em" });
const STRONG = Decoration.mark({ class: "cm-strong" });
const STRIKE = Decoration.mark({ class: "cm-strike" });
const HIGHLIGHT = Decoration.mark({ class: "cm-highlight" });
const INLINE_CODE = Decoration.mark({ class: "cm-inline-code", attributes: { spellcheck: "false" } });
const LINK = Decoration.mark({ class: "cm-link" });
const WIKI = Decoration.mark({ class: "cm-wikilink" });
const WIKI_UNRESOLVED = Decoration.mark({ class: "cm-wikilink cm-unresolved" });
const BULLET = Decoration.mark({ class: "cm-bullet" });
const LIST_NUMBER = Decoration.mark({ class: "cm-list-num" });
const TASK_DONE = Decoration.mark({ class: "cm-task-done" });
const FENCE_TEXT = Decoration.mark({ class: "cm-fence-text" });
const HR_TEXT = Decoration.mark({ class: "cm-hr-text" });

const HEADING_LINES = [1, 2, 3, 4, 5, 6].map((n) => Decoration.line({ class: `cm-h${n}` }));
const HR_LINE = Decoration.line({ class: "cm-hr" });
const TABLE_LINE = Decoration.line({ class: "cm-table" });
const FM_LINE = Decoration.line({ class: "cm-fm", attributes: { spellcheck: "false" } });

/** Checkbox replacements by [checked]; widgets are immutable, so they are shared. */
const CHECKBOXES = [false, true].map((checked) => Decoration.replace({ widget: new CheckboxWidget(checked) }));

function cached<K>(cache: Map<K, Decoration>, key: K, make: () => Decoration): Decoration {
  let deco = cache.get(key);
  if (!deco) {
    if (cache.size > 256) cache.clear();
    deco = make();
    cache.set(key, deco);
  }
  return deco;
}

const pairCache = new Map<string, Decoration>();
const quoteCache = new Map<string, Decoration>();
const hangCache = new Map<string, Decoration>();
const codeCache = new Map<string, Decoration>();

/**
 * A block's first line (or the blank line that stands where a paragraph would): its kind,
 * the block before it, the container, the blank lines above it and the lead the first of
 * them shows.
 */
function pairLine(pair: Pair, ctx: FlowContext | null): Decoration {
  return cached(pairCache, `${pair.blk}|${pair.prev}|${ctx ?? ""}|${pair.blank}|${pair.lead ?? ""}`, () => {
    const attributes: Record<string, string> = { "data-blk": pair.blk, "data-prev": pair.prev };
    if (ctx) attributes["data-ctx"] = ctx;
    if (pair.lead) attributes["data-lead"] = pair.lead;
    if (pair.blank > 0) attributes.style = `--mn-blank: ${pair.blank}`;
    return Decoration.line({ attributes });
  });
}

/**
 * A quote line: `depth` bars, drawn at the gutter of the `list` levels the innermost quote
 * sits in. The innermost `fresh` quotes start on this line: their bars begin below the
 * line's pair padding, while the outer ones run through it.
 */
function quoteLine(depth: number, list: number, fresh: number): Decoration {
  return cached(quoteCache, `${depth}|${list}|${fresh}`, () =>
    Decoration.line({
      class: "cm-quote",
      attributes: { style: `--mn-quote: ${depth}; --mn-quote-list: ${list}; --mn-quote-new: ${fresh}` },
    }),
  );
}

/** A list line: its measured prefix hangs, and padding fills the rest of the gutter of `depth` levels. */
function hangLine(width: number, depth: number): Decoration {
  return cached(hangCache, `${width}|${depth}`, () =>
    Decoration.line({ class: "cm-hang", attributes: { style: `--mn-hang: ${width}px; --mn-depth: ${depth}` } }),
  );
}

function codeLine(cls: string, lang: string): Decoration {
  return cached(codeCache, `${cls}|${lang}`, () =>
    Decoration.line({
      class: cls,
      attributes: lang ? { spellcheck: "false", "data-lang": lang } : { spellcheck: "false" },
    }),
  );
}

const ATX_LEVEL: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
};
/** Blocks whose first line is plain text and now padded: it needs the sampling guard (TECHNIQUES §1.7). */
const GUARDED = new Set<BlockKind>(["p", "quote", "html"]);
/** Blocks set in the code font: a list prefix on their lines measures differently. */
const MONO = new Set(["FencedCode", "CodeBlock", "Table"]);
/** Blocks whose text is verbatim: their lines give up only the item's content indent to the gutter. */
const VERBATIM = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock", "ProcessingInstructionBlock"]);
/** Inline elements: the outermost one decides the reveal state of everything inside it. */
const INLINE = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "InlineCode",
  "Highlight",
  "Link",
  "Autolink",
  "URL",
  "WikiLink",
  "WikiEmbed",
]);
/** Shown as written; their children need no visit. */
const RAW = new Set([
  "HTMLBlock",
  "CommentBlock",
  "ProcessingInstructionBlock",
  "LinkReference",
  "Image",
  "HTMLTag",
  "Entity",
  "Comment",
  "ProcessingInstruction",
  "HeaderMark",
  "ListMark",
  "TaskMarker",
]);
/** Mark children hidden (or shown faint) together with their element. */
const ELEMENT_MARKS = new Set(["EmphasisMark", "StrikethroughMark", "HighlightMark", "CodeMark"]);
/**
 * Blocks that can run past the frontmatter's closing fence: Lezer reads a line right
 * after a `...` fence as more of the YAML's last paragraph (LIVE-10).
 */
const FM_CROSSING = new Set(["Paragraph", "Task", "BulletList", "OrderedList", "ListItem", "Blockquote"]);
const TASK_TEXT = /^\[[ xX]\][ \t]*$/;
/** A line between two blocks: nothing on it, or only the marks of the quotes it is in. */
const BLANK_LINE = /^[ \t>]*$/;
const QUOTE_PREFIX = /^(?:[ \t]*>[ ]?)+/;

function isBlank(ch: string): boolean {
  return ch === " " || ch === "\t";
}

interface TaskSpan {
  /** `[ ]` range. */
  from: number;
  to: number;
  /** The item's text after the box. */
  textFrom: number;
  textTo: number;
}

/**
 * The task box of a list item: a Lezer Task node, or an item whose only text
 * is `[ ]`/`[x]` (Lezer reads `- [ ]` without trailing text as a paragraph;
 * LIVE-05 still wants a checkbox there).
 */
function taskOf(doc: Text, item: SyntaxNode): TaskSpan | null {
  const mark = item.firstChild;
  const second = mark?.nextSibling;
  if (!mark || !second) return null;
  const line = doc.lineAt(mark.from);
  if (second.from > line.to) return null;
  if (second.name === "Task") {
    const box = second.firstChild;
    if (!box || box.name !== "TaskMarker") return null;
    let textFrom = box.to;
    while (textFrom < line.to && isBlank(doc.sliceString(textFrom, textFrom + 1))) textFrom++;
    return { from: box.from, to: box.to, textFrom, textTo: Math.max(textFrom, second.to) };
  }
  if (second.name === "Paragraph" && second.to <= line.to && TASK_TEXT.test(doc.sliceString(second.from, second.to))) {
    return { from: second.from, to: second.from + 3, textFrom: second.from + 3, textTo: second.from + 3 };
  }
  return null;
}

class Builder {
  private readonly out: Range<Decoration>[] = [];
  private readonly doc: Text;
  private readonly tree: Tree;
  private readonly sel: readonly SelectionRange[];
  private readonly fm: FrontmatterRange | null;
  /**
   * Per quote line start: the quote depth, summed over nested Blockquote nodes, the innermost
   * quote's list depth, and how many of those quotes start on the line.
   */
  private readonly quotes = new Map<number, { depth: number; list: number; fresh: number }>();
  /** Line starts that carry a pair tag (one decoration each). */
  private readonly flowLines = new Set<number>();
  /** Line starts whose content carries the sampling guard. */
  private readonly guarded = new Set<number>();
  /** List contexts by list start, for this build. */
  private readonly lists = new Map<number, FlowContext>();
  private readonly unresolved: (target: string) => boolean;
  private from = 0;
  private to = 0;

  constructor(private readonly input: BuildInput) {
    this.doc = input.state.doc;
    this.tree = syntaxTree(input.state);
    this.sel = input.sel;
    this.fm = input.state.field(fmField, false) ?? null;
    this.unresolved = unresolvedTest(input.host);
  }

  run(): DecorationSet {
    for (const range of this.input.ranges) {
      this.from = range.from;
      this.to = range.to;
      if (this.fm) this.frontmatter(this.fm);
      this.flow(this.tree.topNode, null);
      this.tree.iterate({ from: range.from, to: range.to, enter: (n) => this.enter(n) });
    }
    for (const [lineFrom, q] of this.quotes) this.out.push(quoteLine(q.depth, q.list, q.fresh).range(lineFrom));
    return Decoration.set(this.out, true);
  }

  // ── helpers ──

  private inRange(pos: number): boolean {
    return pos >= this.from && pos <= this.to;
  }

  private lineTouched(line: Line): boolean {
    return touches(this.sel, line.from, line.to);
  }

  /** Hides [from, to], split at line breaks (a plugin may not replace a newline). */
  private hide(from: number, to: number): void {
    let pos = from;
    while (pos < to) {
      const line = this.doc.lineAt(pos);
      const end = Math.min(to, line.to);
      if (end > pos) this.out.push(HIDE.range(pos, end));
      pos = line.to + 1;
    }
  }

  private mark(deco: Decoration, from: number, to: number): void {
    if (to > from) this.out.push(deco.range(from, to));
  }

  private markOrHide(from: number, to: number, revealed: boolean): void {
    if (revealed) this.mark(SYNTAX, from, to);
    else this.hide(from, to);
  }

  private guard(line: Line): void {
    if (this.guarded.has(line.from)) return;
    this.guarded.add(line.from);
    this.mark(GUARD, line.from, line.to);
  }

  /** Calls `f` for each line of [from, to] inside the current visible range. */
  private eachLine(from: number, to: number, f: (line: Line) => void): void {
    const start = Math.max(from, this.from);
    const end = Math.min(to, this.to);
    if (start > end) return;
    for (let line = this.doc.lineAt(start); ; line = this.doc.line(line.number + 1)) {
      f(line);
      if (line.to >= end || line.number >= this.doc.lines) break;
    }
  }

  /** Where a line's own content starts, after any blockquote markers. */
  private contentStart(line: Line): number {
    if (!this.quotes.has(line.from)) return line.from;
    const m = QUOTE_PREFIX.exec(line.text);
    return m ? line.from + m[0].length : line.from;
  }

  private skipBlank(pos: number, end: number): number {
    while (pos < end && isBlank(this.doc.sliceString(pos, pos + 1))) pos++;
    return pos;
  }

  // ── walk ──

  private enter(n: SyntaxNodeRef): boolean {
    if (n.type.isTop) return true;
    // Nothing inside the frontmatter is Markdown (LIVE-10). A block that runs past
    // its closing fence is walked, not decorated, so its children after the fence render.
    if (this.fm && n.from < this.fm.to) return n.to > this.fm.to && FM_CROSSING.has(n.name);
    try {
      return this.node(n);
    } catch (err) {
      reportOnce(n.name, err);
      return false;
    }
  }

  private node(n: SyntaxNodeRef): boolean {
    const name = n.name;
    const atx = ATX_LEVEL[name];
    if (atx) {
      this.atxHeading(n.node, atx);
      return true;
    }
    if (INLINE.has(name)) {
      this.inline(n.node, touches(this.sel, n.from, n.to));
      return false;
    }
    switch (name) {
      case "Blockquote": {
        const list = listDepth(n.node);
        const start = n.from;
        this.eachLine(n.from, n.to, (line) => {
          const q = this.quotes.get(line.from);
          const fresh = (q?.fresh ?? 0) + (start >= line.from ? 1 : 0);
          this.quotes.set(line.from, { depth: (q?.depth ?? 0) + 1, list, fresh });
        });
        this.flow(n.node, "quote");
        return true;
      }
      case "QuoteMark":
        this.quoteMark(n.from, n.to);
        return false;
      case "BulletList":
      case "OrderedList": {
        let ctx = this.lists.get(n.from);
        if (!ctx) {
          ctx = listContext(this.doc, n.node);
          this.lists.set(n.from, ctx);
        }
        this.flow(n.node, ctx);
        return true;
      }
      case "ListItem":
        this.flow(n.node, "li");
        this.listItem(n.node);
        return true;
      case "FencedCode":
        this.code(n.node, true);
        return false;
      case "CodeBlock":
        this.code(n.node, false);
        return false;
      case "HorizontalRule":
        this.horizontalRule(n.from, n.to);
        return false;
      case "Table":
        // Raw source lines; the block field replaces tables (top-level, or in lists and
        // quotes) with a widget while not revealed.
        this.eachLine(n.from, n.to, (line) => {
          this.out.push(TABLE_LINE.range(line.from));
          this.guard(line);
        });
        return false;
      case "Escape":
        this.escape(n.from, false);
        return false;
    }
    return !RAW.has(name);
  }

  // ── blocks ──

  private frontmatter(fm: FrontmatterRange): void {
    this.eachLine(fm.from, fm.to, (line) => {
      this.out.push(FM_LINE.range(line.from));
      this.guard(line);
    });
  }

  /**
   * Pair spacing for the block children of `container` (DESIGN §3.2, LIVE-15): every child
   * but the first gets its pair on its first line (`data-blk`, `data-prev`, the container's
   * `data-ctx`, the blank lines above it). A blank line is a body line: in the document and
   * in a quote, the one right below a block is tagged as the paragraph it would become, so
   * typing on it moves nothing, and the block after the blank lines pads only what is left
   * of its gap. From the tree only, never the selection, so a caret move reflows nothing.
   * At the top level the frontmatter stands in for a first block (LIVE-10).
   */
  private flow(container: SyntaxNode, ctx: FlowContext | null): void {
    const doc = this.doc;
    const top = container.type.isTop;
    const fm = top ? this.fm : null;
    const leads = carriesLead(container);
    /** The container's last line: the blank lines up to it follow its last block. */
    const lastLine = top ? doc.lines : doc.lineAt(container.to).number;
    let node = blockAtOrAfter(container, this.from);
    let cur: FlowBlock | null = null;
    // Blocks inside the frontmatter are not blocks of the document.
    while (node && !(cur = flowBlock(doc, node, fm))) node = nextBlock(node);
    let prev = blockBefore(doc, container, node, fm);
    for (;;) {
      if (prev) {
        const below = prev.last + 1;
        const lead = leads && below < (cur ? cur.first : lastLine + 1) ? leadOf(prev.kind) : null;
        // Blank, or quote marks only: past a partial parse the line below may still hold text.
        if (lead && BLANK_LINE.test(doc.line(below).text)) {
          this.tag(doc.line(below), { blk: "p", prev: prev.kind, blank: 0, lead: null }, ctx);
        }
        if (cur) this.tag(doc.line(cur.first), pairWith(prev, cur, leads), ctx);
      }
      if (!node || !cur || node.from > this.to) break;
      prev = cur;
      node = nextBlock(node);
      cur = node ? flowBlock(doc, node, fm) : null;
    }
  }

  /** Puts a pair on a visible line, once. A padded line of plain text (or of blanks) must not be sampled. */
  private tag(line: Line, pair: Pair, ctx: FlowContext | null): void {
    if (!this.inRange(line.from) || this.flowLines.has(line.from)) return;
    this.flowLines.add(line.from);
    this.out.push(pairLine(pair, ctx).range(line.from));
    if (GUARDED.has(pair.blk) && line.length > 0) this.guard(line);
  }

  private atxHeading(node: SyntaxNode, level: number): void {
    const line = this.doc.lineAt(node.from);
    if (!this.inRange(line.from)) return;
    this.out.push(HEADING_LINES[level - 1].range(line.from));
    this.guard(line);
    const open = node.firstChild;
    if (!open || open.name !== "HeaderMark") return;
    const last = node.lastChild;
    // SyntaxNode objects are created per access: compare positions, never identity.
    const close = last && last.from > open.from && last.name === "HeaderMark" ? last : null;
    const empty = this.doc.sliceString(open.to, close ? close.from : node.to).trim() === "";
    // An empty heading keeps its "#" (LIVE-03); otherwise the line is the reveal unit.
    if (empty || this.lineTouched(line)) {
      this.mark(SYNTAX, open.from, open.to);
      if (close) this.mark(SYNTAX, close.from, close.to);
      return;
    }
    // Never a fixed "+1": "# Title #" or a bare "#" would cross the line end.
    const end = this.skipBlank(open.to, line.to);
    this.hide(open.from, end);
    if (close) {
      let start = close.from;
      while (start > end && isBlank(this.doc.sliceString(start - 1, start))) start--;
      this.hide(start, close.to);
    }
  }

  /** `>` plus one space, hidden per line (LIVE-07); the bar is drawn on the line box. */
  private quoteMark(from: number, to: number): void {
    const line = this.doc.lineAt(from);
    if (!this.inRange(line.from)) return;
    if (this.lineTouched(line)) {
      this.mark(SYNTAX, from, to);
      return;
    }
    this.hide(from, to < line.to && this.doc.sliceString(to, to + 1) === " " ? to + 1 : to);
  }

  private listItem(item: SyntaxNode): void {
    const mark = item.firstChild;
    if (!mark || mark.name !== "ListMark") return;
    const doc = this.doc;
    const line = doc.lineAt(mark.from);
    const bullet = item.parent?.name === "BulletList";
    const depth = listDepth(item);
    const task = taskOf(doc, item);
    const textStart = task ? task.textFrom : this.skipBlank(mark.to, line.to);
    /** The item's content indent in characters: all that a nested verbatim block's lines give up. */
    const indent = textStart - line.from;
    if (this.inRange(line.from)) {
      let hangKey = "s";
      if (task) {
        const checked = doc.sliceString(task.from + 1, task.from + 2) !== " ";
        if (touches(this.sel, mark.from, task.to)) {
          this.mark(bullet ? SYNTAX : LIST_NUMBER, mark.from, mark.to);
          this.mark(SYNTAX, task.from, task.to);
        } else {
          // The marker and its space give way to the box: a task item shows no bullet or number,
          // as in the reading view. The box also takes the blank after it, so the gap before
          // the text is the box's own (--md-task-gap) in both views.
          this.hide(mark.from, task.from);
          const boxEnd = task.to < line.to && isBlank(doc.sliceString(task.to, task.to + 1)) ? task.to + 1 : task.to;
          this.out.push(CHECKBOXES[checked ? 1 : 0].range(task.from, boxEnd));
          hangKey = "r";
        }
        if (checked) this.mark(TASK_DONE, task.textFrom, task.textTo);
      } else if (!bullet) {
        this.mark(LIST_NUMBER, mark.from, mark.to);
      } else {
        this.mark(touches(this.sel, mark.from, mark.to) ? SYNTAX : BULLET, mark.from, mark.to);
      }
      // The gutter (LIVE-13): the whole prefix up to the text, indentation and hidden quote
      // marks included, measured in the line's own font; padding fills the rest of the level.
      const font = this.lineFont(this.tree.resolveInner(textStart, 1), item).font;
      this.hang(line, line.from, textStart, hangKey + font, depth);
    }
    // Later lines of the item sit in the same gutter: their indentation is absorbed into it. A
    // nested item's lines are its own, and a verbatim block gives up only the content indent.
    this.eachLine(item.from, item.to, (l) => {
      if (l.number === line.number) return;
      const text = this.skipBlank(this.contentStart(l), l.to);
      if (text >= l.to) return;
      const inner = this.tree.resolveInner(text, 1);
      const owner = enclosing(inner, "ListItem");
      if (!owner || owner.from !== item.from) return;
      const { font, verbatim } = this.lineFont(inner, item);
      this.hang(l, l.from, verbatim ? Math.min(text, l.from + indent) : text, "s" + font, depth);
    });
  }

  /**
   * How a line of `item` measures: the font its prefix is set in ("" body, "c" code, "hN"
   * heading) and whether its block keeps its text verbatim (code, HTML).
   */
  private lineFont(inner: SyntaxNode, item: SyntaxNode): { font: string; verbatim: boolean } {
    let font = "";
    let verbatim = false;
    for (let n: SyntaxNode | null = inner; n && n.from >= item.from && n.name !== "ListItem"; n = n.parent) {
      const level = ATX_LEVEL[n.name];
      if (level) font = `h${level}`;
      else if (MONO.has(n.name)) font = "c";
      if (VERBATIM.has(n.name)) verbatim = true;
    }
    return { font, verbatim };
  }

  /**
   * The gutter of a list line (LIVE-13): `[from, to)` is the prefix before its text, measured
   * once per distinct text and font and cached; the line hangs by that width and pads the
   * rest of its `depth` levels (editor.css). An empty prefix needs no measure.
   */
  private hang(line: Line, from: number, to: number, keyPrefix: string, depth: number): void {
    if (to <= from) {
      this.out.push(hangLine(0, depth).range(line.from));
      return;
    }
    const key = keyPrefix + this.doc.sliceString(from, to);
    const width = this.input.hang.get(key);
    if (width === undefined) this.input.hang.request(key, from, to);
    else this.out.push(hangLine(width, depth).range(line.from));
  }

  /** Fenced code reveals per block; indented code only gets the box (LIVE-08). */
  private code(node: SyntaxNode, fenced: boolean): void {
    const doc = this.doc;
    const first = doc.lineAt(node.from).number;
    const last = doc.lineAt(node.to).number;
    let revealed = false;
    let closeFrom = -1;
    let closeLine = -1;
    let lang = "";
    if (fenced) {
      revealed = touches(this.sel, node.from, node.to);
      const close = node.lastChild;
      if (close && close.from > node.from && close.name === "CodeMark") {
        closeFrom = close.from;
        closeLine = doc.lineAt(close.from).number;
      }
      const info = node.getChild("CodeInfo");
      if (info && !revealed) lang = fenceLabel(doc.sliceString(info.from, info.to));
    }
    this.eachLine(node.from, node.to, (line) => {
      const n = line.number;
      const open = fenced && n === first;
      const fence = open || n === closeLine;
      let cls = "cm-code";
      if (n === first) cls += " cm-code-first";
      if (n === last) cls += " cm-code-last";
      if (fence) cls += " cm-fence";
      this.out.push(codeLine(cls, open ? lang : "").range(line.from));
      // The fence mark doubles as the line's sampling guard.
      if (fence) this.mark(revealed ? SYNTAX : FENCE_TEXT, open ? node.from : closeFrom, line.to);
      else this.guard(line);
    });
  }

  private horizontalRule(from: number, to: number): void {
    const line = this.doc.lineAt(from);
    if (!this.inRange(line.from)) return;
    if (this.lineTouched(line)) {
      this.mark(SYNTAX, from, to);
      return;
    }
    this.out.push(HR_LINE.range(line.from));
    this.mark(HR_TEXT, from, to);
  }

  /** The backslash of `\x` hides unless its line (or an enclosing revealed element) is touched. */
  private escape(from: number, revealed: boolean): void {
    if (revealed || this.lineTouched(this.doc.lineAt(from))) this.mark(SYNTAX, from, from + 1);
    else this.hide(from, from + 1);
  }

  // ── inline ──

  private inline(node: SyntaxNode, revealed: boolean): void {
    switch (node.name) {
      case "Emphasis":
        return this.styled(node, EM, revealed);
      case "StrongEmphasis":
        return this.styled(node, STRONG, revealed);
      case "Strikethrough":
        return this.styled(node, STRIKE, revealed);
      case "Highlight":
        return this.styled(node, HIGHLIGHT, revealed);
      case "InlineCode":
        return this.styled(node, INLINE_CODE, revealed);
      case "Link":
        return this.link(node, revealed);
      case "Autolink":
        for (let c = node.firstChild; c; c = c.nextSibling) {
          if (c.name === "LinkMark") this.markOrHide(c.from, c.to, revealed);
          else if (c.name === "URL" && !revealed) this.mark(LINK, c.from, c.to);
        }
        return;
      case "URL":
        // A bare URL has no syntax to hide; it is a clickable link while not touched.
        if (!revealed) this.mark(LINK, node.from, node.to);
        return;
      case "WikiLink":
      case "WikiEmbed":
        return this.wiki(node, revealed);
      case "Escape":
        return this.escape(node.from, revealed);
    }
    if (RAW.has(node.name)) return;
    this.children(node, node.from, node.to, revealed);
  }

  /** Inline children of `node` inside [from, to]: link parts are skipped, except bare URLs when `urls` is set. */
  private children(node: SyntaxNode, from: number, to: number, revealed: boolean, urls = false): void {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.from < from || c.to > to) continue;
      if (!LINK_PARTS.has(c.name) || (urls && c.name === "URL")) this.inline(c, revealed);
    }
  }

  private styled(node: SyntaxNode, deco: Decoration, revealed: boolean): void {
    this.mark(deco, node.from, node.to);
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (ELEMENT_MARKS.has(c.name)) this.markOrHide(c.from, c.to, revealed);
      else this.inline(c, revealed);
    }
  }

  /** `[t](u)`: `[` and `](u)` hide, the label stays real text (LIVE-06). */
  private link(node: SyntaxNode, revealed: boolean): void {
    const marks = node.getChildren("LinkMark");
    if (marks.length < 2) return;
    const labelFrom = marks[0].to;
    const labelTo = marks[1].from;
    // Only a destination after the label's `]` makes an inline link. Reference links
    // stay plain text, though a bare URL in their label is still a link; an empty
    // label is never hidden.
    const dest = linkUrl(node);
    if (dest && labelTo > labelFrom) {
      if (revealed) {
        this.mark(SYNTAX, node.from, labelFrom);
        this.mark(SYNTAX, labelTo, node.to);
      } else {
        this.hide(node.from, labelFrom);
        this.hide(labelTo, node.to);
        this.mark(LINK, labelFrom, labelTo);
      }
    }
    this.children(node, labelFrom, labelTo, revealed, !dest);
  }

  /** `[[t|a]]`: brackets and `t|` hide; the visible text is the alias or the target (LIVE-14). */
  private wiki(node: SyntaxNode, revealed: boolean): void {
    const open = node.firstChild;
    const close = node.lastChild;
    if (!open || !close || close.from <= open.from) return;
    const { target } = parseWikiInner(wikiInner(this.doc, open.to, close.from));
    // Image embeds show their source; the block field renders the ones alone on a line.
    if (node.name === "WikiEmbed" && isImageTarget(target)) return;
    const shown = node.getChild("WikiLinkAlias") ?? node.getChild("WikiLinkTarget");
    if (!shown) return;
    if (revealed) {
      for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === "WikiLinkMark") this.mark(SYNTAX, c.from, c.to);
      return;
    }
    this.hide(node.from, shown.from);
    this.hide(shown.to, node.to);
    this.mark(this.unresolved(target) ? WIKI_UNRESOLVED : WIKI, shown.from, shown.to);
  }
}

const LINK_PARTS = new Set(["LinkMark", "URL", "LinkTitle", "LinkLabel"]);

/** Builds the ViewPlugin's decoration set; any failure leaves the note as plain text. */
export function buildDecorations(input: BuildInput): DecorationSet {
  try {
    return new Builder(input).run();
  } catch (err) {
    reportOnce("decorations", err);
    return Decoration.none;
  }
}
