/**
 * Markdown editing commands and the editor keymap (ARCHITECTURE §9.1 "editor"
 * scope; EDIT-03, EDIT-04, EDIT-05, LINK-02). Line transforms are pure
 * functions, exported for unit tests.
 */
import { completionStatus } from "@codemirror/autocomplete";
import { EditorSelection, Prec, countColumn } from "@codemirror/state";
import type { ChangeSpec, EditorState, Extension, Line, StateCommand, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Command, KeyBinding } from "@codemirror/view";
import { ensureSyntaxTree, forceParsing, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { indentLess, insertTab } from "@codemirror/commands";
import { insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import type { SyntaxNode, Tree } from "@lezer/common";
import type { MessageKey } from "../i18n";
import { parseWikiInner } from "../markdown/resolve";
import { matchShortcut } from "../utils/keys";
import { isComposing } from "../utils/platform";
import type { EditorHost, LinkTarget } from "./host";
import { linkUrl } from "./livePreview/links";
import { autolinkHref } from "./livePreview/model";

/** An edit inside one line; offsets are relative to the line start. */
export interface LineEdit {
  from: number;
  to: number;
  insert: string;
}

/** Leading blockquote markers. */
const QUOTES = /^(?:[ \t]*>[ \t]?)*/;
/** A list marker with its indentation and spacing (empty spacing only at the end of the line). */
const LIST_MARK = /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+|$)/;
/** A list marker at the current position. */
const ITEM_MARKER = /^(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/;
/** A GFM task box right after a list marker. */
const TASK_BOX = /^\[([ xX])\](?=[ \t]|$)/;
/** Blocks whose lines are literal text: no list behavior inside. */
const LITERAL_BLOCKS = new Set(["FencedCode", "CodeBlock", "HTMLBlock"]);
/** Characters of emphasis-like delimiter runs. */
const DELIMS = /^[*_~=]*$/;

const PARSE_BUDGET_MS = 50;
const TAB_COLUMNS = 4;

/** The syntax tree up to `upto`, parsing a little further when the parser lags (large notes). */
function treeUpTo(state: EditorState, upto: number): Tree {
  return ensureSyntaxTree(state, upto, PARSE_BUDGET_MS) ?? syntaxTree(state);
}

const columnAt = (text: string, offset: number): number => countColumn(text.slice(0, offset), TAB_COLUMNS);

// ── Pure line transforms ─────────────────────────────────────────────────

/** Mod-L on one line: "x" → "- [ ] x", "- x" → "- [ ] x", "- [ ] x" ↔ "- [x] x". */
export function cycleTaskText(text: string): LineEdit {
  const quotes = QUOTES.exec(text)![0].length;
  const list = LIST_MARK.exec(text.slice(quotes));
  if (!list) {
    const at = quotes + /^[ \t]*/.exec(text.slice(quotes))![0].length;
    return { from: at, to: at, insert: "- [ ] " };
  }
  const afterMarker = quotes + list[0].length;
  const box = TASK_BOX.exec(text.slice(afterMarker));
  if (!box) return { from: afterMarker, to: afterMarker, insert: list[3] === "" ? " [ ] " : "[ ] " };
  const at = afterMarker + 1;
  return { from: at, to: at + 1, insert: box[1] === " " ? "x" : " " };
}

/** True for a list item line that carries a task box ("- [ ] x", "> 1. [x] y"). */
export function isTaskText(text: string): boolean {
  const quotes = QUOTES.exec(text)![0].length;
  const list = LIST_MARK.exec(text.slice(quotes));
  return list !== null && TASK_BOX.test(text.slice(quotes + list[0].length));
}

/**
 * Sets an ATX heading level on one line (0 = plain paragraph). The marker goes
 * after blockquote and list markup; null when nothing changes. GFM has no heading
 * task, so a task line only loses a "#…" typed after its box (level 0) and never
 * gets one: "- [ ] ## x" would just be a task whose text starts with "##".
 */
export function headingEdit(text: string, level: number): LineEdit | null {
  const quotes = QUOTES.exec(text)![0].length;
  const rest = text.slice(quotes);
  const list = LIST_MARK.exec(rest);
  let at = quotes + (list ? list[0].length : /^ {0,3}/.exec(rest)![0].length);
  const box = list ? TASK_BOX.exec(text.slice(at)) : null;
  if (box) {
    if (level > 0) return null;
    at += box[0].length;
    at += /^[ \t]*/.exec(text.slice(at))![0].length;
  }
  const existing = /^(#{1,6})(?:[ \t]+|$)/.exec(text.slice(at));
  const marker = level > 0 ? "#".repeat(level) + " " : "";
  if (existing) {
    if (existing[1].length === level) return null;
    return { from: at, to: at + existing[0].length, insert: marker };
  }
  return marker ? { from: at, to: at, insert: marker } : null;
}

export interface LinePrefix {
  /** Indentation that continues the line's innermost block without a new marker. */
  continuation: string;
  /** The prefix in front of the innermost list marker (where a new marker goes), or null without one. */
  beforeMarker: string | null;
  /** Offset where the line's own content starts, after all container markup. */
  contentStart: number;
}

/** Splits a line's leading quote and list markup (EDIT-03). Tabs count as 4 columns. */
export function listLinePrefix(text: string): LinePrefix {
  let out = "";
  let beforeMarker: string | null = null;
  let i = 0;
  for (;;) {
    const ws = /^[ \t]*/.exec(text.slice(i))![0];
    const at = i + ws.length;
    if (text[at] === ">") {
      const end = at + 1 + (text[at + 1] === " " || text[at + 1] === "\t" ? 1 : 0);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    const marker = ITEM_MARKER.exec(text.slice(at));
    if (!marker) return { continuation: out + ws, beforeMarker, contentStart: at };
    const markEnd = at + marker[0].length;
    let content = markEnd + /^[ \t]*/.exec(text.slice(markEnd))![0].length;
    let width: number;
    if (content === text.length || columnAt(text, content) - columnAt(text, markEnd) > TAB_COLUMNS) {
      // An empty item, or indented code after the marker: the text column is one past the marker.
      width = marker[0].length + 1;
      content = Math.min(text.length, markEnd + 1);
    } else {
      const box = TASK_BOX.exec(text.slice(content));
      if (box) {
        const afterBox = content + box[0].length;
        const space = /^[ \t]*/.exec(text.slice(afterBox))![0];
        if (space !== "") content = afterBox + space.length;
      }
      width = columnAt(text, content) - columnAt(text, at);
    }
    beforeMarker = out + ws;
    out += ws + " ".repeat(width);
    i = content;
  }
}

/**
 * Removes `delta` columns of the whitespace that starts at `from` (Shift-Tab),
 * keeping leading tabs where possible. Null when there is nothing to remove.
 */
export function outdentWhitespace(text: string, from: number, delta: number): LineEdit | null {
  let end = from;
  while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
  if (end === from || delta <= 0) return null;
  const start = columnAt(text, from);
  const want = Math.max(start, columnAt(text, end) - delta);
  let keep = from;
  let col = start;
  while (keep < end) {
    const next = text[keep] === "\t" ? col + TAB_COLUMNS - (col % TAB_COLUMNS) : col + 1;
    if (next > want) break;
    col = next;
    keep++;
  }
  if (keep === end && col === want) return null;
  return { from: keep, to: end, insert: " ".repeat(want - col) };
}

// ── Shared helpers ───────────────────────────────────────────────────────

/** Lines touched by the selection, each once. A range that ends at a line start leaves that line out. */
function selectedLines(state: EditorState): { line: Line; multi: boolean }[] {
  const out: { line: Line; multi: boolean }[] = [];
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    let last = state.doc.lineAt(r.to).number;
    if (last > first && state.doc.line(last).from === r.to) last--;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push({ line: state.doc.line(n), multi: last > first });
    }
  }
  return out;
}

/** Applies one edit per line; carets at an insertion point move past the inserted markup. */
function applyLineEdits(
  state: EditorState,
  dispatch: (tr: Transaction) => void,
  edits: { line: Line; edit: LineEdit }[],
): void {
  if (edits.length === 0) return;
  const changes = state.changes(
    edits.map(({ line, edit }) => ({ from: line.from + edit.from, to: line.from + edit.to, insert: edit.insert })),
  );
  dispatch(state.update({ changes, selection: state.selection.map(changes, 1), scrollIntoView: true, userEvent: "input" }));
}

function maxSelectionEnd(state: EditorState): number {
  return state.selection.ranges.reduce((max, r) => Math.max(max, r.to), 0);
}

// ── Inline toggles (EDIT-05) ─────────────────────────────────────────────

interface MarkRanges {
  openFrom: number;
  openTo: number;
  closeFrom: number;
  closeTo: number;
}

/** The opening and closing mark children of an emphasis-like element. */
function elementMarks(node: SyntaxNode): MarkRanges | null {
  const open = node.firstChild;
  const close = node.lastChild;
  if (!open || !close || open.from === close.from || !open.name.endsWith("Mark") || !close.name.endsWith("Mark")) return null;
  return { openFrom: open.from, openTo: open.to, closeFrom: close.from, closeTo: close.to };
}

/**
 * The element of type `name` that the selection covers (inside) or sits in
 * (outside). Other delimiter runs may lie in between, so `***x***` toggles
 * its italic and its bold independently.
 */
function wrappingElement(state: EditorState, tree: Tree, from: number, to: number, name: string): MarkRanges | null {
  let found = null as MarkRanges | null;
  tree.iterate({
    from,
    to,
    enter: (n) => {
      if (found) return false;
      if (n.name !== name || n.from < from || n.to > to) return;
      if (DELIMS.test(state.sliceDoc(from, n.from)) && DELIMS.test(state.sliceDoc(n.to, to))) found = elementMarks(n.node);
    },
  });
  if (found) return found;
  for (let n: SyntaxNode | null = tree.resolveInner(from, 1); n; n = n.parent) {
    if (n.name !== name) continue;
    const marks = elementMarks(n);
    if (
      marks &&
      marks.openTo <= from &&
      to <= marks.closeFrom &&
      DELIMS.test(state.sliceDoc(marks.openTo, from)) &&
      DELIMS.test(state.sliceDoc(to, marks.closeFrom))
    )
      return marks;
  }
  return null;
}

/** Text fallback for markers the parser does not see as an element ("** x **"): exact runs only. */
function plainMarks(state: EditorState, from: number, to: number, marker: string): MarkRanges | null {
  const len = marker.length;
  const ch = marker[0];
  const at = (a: number, b: number) => state.sliceDoc(Math.max(0, a), Math.max(0, b));
  if (at(from - len, from) === marker && at(to, to + len) === marker && at(from - len - 1, from - len) !== ch && at(to + len, to + len + 1) !== ch)
    return { openFrom: from - len, openTo: from, closeFrom: to, closeTo: to + len };
  if (
    to - from > 2 * len &&
    at(from, from + len) === marker &&
    at(to - len, to) === marker &&
    at(from + len, from + len + 1) !== ch &&
    at(to - len - 1, to - len) !== ch
  )
    return { openFrom: from, openTo: from + len, closeFrom: to - len, closeTo: to };
  return null;
}

/** Caret between a freshly inserted pair ("**|**"), with no longer run around it. */
function inEmptyPair(state: EditorState, pos: number, marker: string): boolean {
  const len = marker.length;
  if (state.sliceDoc(Math.max(0, pos - len), pos) !== marker || state.sliceDoc(pos, pos + len) !== marker) return false;
  return state.sliceDoc(Math.max(0, pos - len - 1), Math.max(0, pos - len)) !== marker[0] && state.sliceDoc(pos + len, pos + len + 1) !== marker[0];
}

/** End of the closing mark of a `name` element that starts exactly at `pos`, or null. */
function closingMarkEnd(tree: Tree, pos: number, name: string): number | null {
  const n = tree.resolveInner(pos, 1);
  if (n.from !== pos || !n.name.endsWith("Mark") || n.parent?.name !== name) return null;
  const marks = elementMarks(n.parent);
  return marks && marks.closeFrom === pos ? marks.closeTo : null;
}

/** Shrinks a range to exclude leading and trailing whitespace ("word " → "word"). */
function trimRange(state: EditorState, from: number, to: number): { from: number; to: number } {
  const text = state.sliceDoc(from, to);
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  return lead + trail >= text.length ? { from, to } : { from: from + lead, to: to - trail };
}

/**
 * Toggle rule (EDIT-05): a selection is wrapped, or unwrapped when it already
 * is (or sits in) that element; an empty caret inserts a pair, removes an
 * empty pair, or steps over a closing marker.
 */
function toggleWrap(marker: string, element: string): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const len = marker.length;
    const tree = treeUpTo(state, maxSelectionEnd(state) + len);
    const spec = state.changeByRange((range) => {
      if (range.empty) {
        const pos = range.head;
        if (inEmptyPair(state, pos, marker))
          return { changes: { from: pos - len, to: pos + len }, range: EditorSelection.cursor(pos - len) };
        const stepTo = closingMarkEnd(tree, pos, element);
        if (stepTo !== null) return { range: EditorSelection.cursor(stepTo) };
        return { changes: { from: pos, insert: marker + marker }, range: EditorSelection.cursor(pos + len) };
      }
      // A selection that also takes in surrounding spaces ("**bold** ") still unwraps.
      const { from, to } = trimRange(state, range.from, range.to);
      const trimmed = from !== range.from || to !== range.to;
      const marks =
        wrappingElement(state, tree, range.from, range.to, element) ??
        plainMarks(state, range.from, range.to, marker) ??
        (trimmed ? (wrappingElement(state, tree, from, to, element) ?? plainMarks(state, from, to, marker)) : null);
      if (marks) {
        const changes = state.changes([
          { from: marks.openFrom, to: marks.openTo },
          { from: marks.closeFrom, to: marks.closeTo },
        ]);
        return { changes, range: range.map(changes) };
      }
      const forward = range.head >= range.anchor;
      return {
        changes: [
          { from, insert: marker },
          { from: to, insert: marker },
        ],
        range: forward ? EditorSelection.range(from + len, to + len) : EditorSelection.range(to + len, from + len),
      };
    });
    dispatch(state.update(spec, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

/** Mod-Shift-B (Mod-B toggles the sidebar). */
export const toggleBold = toggleWrap("**", "StrongEmphasis");
/** Mod-I. */
export const toggleItalic = toggleWrap("*", "Emphasis");
/** Mod-Shift-X. */
export const toggleStrikethrough = toggleWrap("~~", "Strikethrough");
/** Mod-Shift-H. */
export const toggleHighlight = toggleWrap("==", "Highlight");

const URL_LIKE = /^(?:https?:\/\/|mailto:|www\.)\S+$/i;

/** Mod-K: "[selection](|)"; a selected URL becomes "[|](url)"; an empty caret gets "[|]()". */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const spec = state.changeByRange((range) => {
    if (range.empty) return { changes: { from: range.from, insert: "[]()" }, range: EditorSelection.cursor(range.from + 1) };
    const { from, to } = trimRange(state, range.from, range.to);
    if (URL_LIKE.test(state.sliceDoc(from, to))) {
      return {
        changes: [
          { from, insert: "[](" },
          { from: to, insert: ")" },
        ],
        range: EditorSelection.cursor(from + 1),
      };
    }
    return {
      changes: [
        { from, insert: "[" },
        { from: to, insert: "]()" },
      ],
      range: EditorSelection.cursor(to + 3),
    };
  });
  dispatch(state.update(spec, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

// ── Line commands ────────────────────────────────────────────────────────

/** Mod-1…6 / Mod-0 on every selected line (blank lines are skipped in multi-line selections). */
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const edits: { line: Line; edit: LineEdit }[] = [];
    for (const { line, multi } of selectedLines(state)) {
      if (multi && line.text.trim() === "") continue;
      const edit = headingEdit(line.text, level);
      if (edit) edits.push({ line, edit });
    }
    applyLineEdits(state, dispatch, edits);
    return true;
  };
}

/** Mod-L on every selected line (blank lines are skipped in multi-line selections). */
export const cycleTasks: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const edits: { line: Line; edit: LineEdit }[] = [];
  for (const { line, multi } of selectedLines(state)) {
    if (multi && line.text.trim() === "") continue;
    edits.push({ line, edit: cycleTaskText(line.text) });
  }
  applyLineEdits(state, dispatch, edits);
  return true;
};

/** Cycles the task state of a 0-based line: "- x" → "- [ ] x" → "- [x] x" → "- [ ] x". Returns true if changed. */
export function toggleTaskAtLine(view: EditorView, line: number): boolean {
  const { state } = view;
  if (state.readOnly || !Number.isInteger(line) || line < 0 || line >= state.doc.lines) return false;
  const l = state.doc.line(line + 1);
  applyLineEdits(state, (tr) => view.dispatch(tr), [{ line: l, edit: cycleTaskText(l.text) }]);
  return true;
}

/** True when the 0-based line is a task item. Reading-view toggles check this first: raw HTML can forge data-line. */
export function isTaskLine(state: EditorState, line: number): boolean {
  if (!Number.isInteger(line) || line < 0 || line >= state.doc.lines) return false;
  return isTaskText(state.doc.line(line + 1).text);
}

// ── Lists: Tab / Shift-Tab (EDIT-04) ─────────────────────────────────────

/** The innermost list item holding the line's content, or null (blank line, code, no list). */
function listItemAtLine(tree: Tree, line: Line): SyntaxNode | null {
  const lead = /^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(line.text)![0].length;
  if (lead === line.length) return null;
  for (let n: SyntaxNode | null = tree.resolveInner(line.from + lead, 1); n; n = n.parent) {
    if (LITERAL_BLOCKS.has(n.name)) return null;
    if (n.name === "ListItem") return n;
  }
  return null;
}

function previousItem(item: SyntaxNode): SyntaxNode | null {
  // Lines of a list inside a quote put QuoteMark nodes between the items.
  for (let s = item.prevSibling; s; s = s.prevSibling) if (s.name === "ListItem") return s;
  return null;
}

function nextItem(item: SyntaxNode): SyntaxNode | null {
  for (let s = item.nextSibling; s; s = s.nextSibling) if (s.name === "ListItem") return s;
  return null;
}

/** The item's ListMark, or null (should not happen for parsed items). */
function listMark(item: SyntaxNode): SyntaxNode | null {
  const mark = item.firstChild;
  return mark && mark.name === "ListMark" ? mark : null;
}

/**
 * Column where a list item's text starts (CommonMark): after the marker and its
 * 1–4 columns of spacing, or one past the marker when the spacing is wider (indented
 * code) or the line ends there. A nested item's marker must reach this column.
 */
function contentColumn(state: EditorState, item: SyntaxNode): number {
  const mark = listMark(item);
  if (!mark) return markerColumn(state, item) + 2;
  const line = state.doc.lineAt(mark.from);
  const end = mark.to - line.from;
  const space = /^[ \t]*/.exec(line.text.slice(end))![0].length;
  const markEnd = columnAt(line.text, end);
  const width = columnAt(line.text, end + space) - markEnd;
  return space === 0 || end + space === line.length || width > TAB_COLUMNS ? markEnd + 1 : markEnd + width;
}

function quoteDepth(node: SyntaxNode): number {
  let depth = 0;
  for (let n = node.parent; n; n = n.parent) if (n.name === "Blockquote") depth++;
  return depth;
}

/** Length of the first `depth` blockquote markers of a line (fewer on lazy lines). */
function quotePrefixLength(text: string, depth: number): number {
  let i = 0;
  for (let d = 0; d < depth; d++) {
    const m = /^[ \t]*>[ \t]?/.exec(text.slice(i));
    if (!m) break;
    i += m[0].length;
  }
  return i;
}

/** Column of an item's marker (top-level items include their indentation, nested ones do not). */
function markerColumn(state: EditorState, item: SyntaxNode): number {
  const mark = item.firstChild;
  const pos = mark && mark.name === "ListMark" ? mark.from : item.from;
  const line = state.doc.lineAt(pos);
  return columnAt(line.text, pos - line.from);
}

/**
 * Spaces to add after the indenting tab so the item's marker reaches the previous
 * sibling's text column: a tab is 4 columns, but "100. " needs 5 (and a tab after a
 * quote's "> " reaches only the next tab stop). 0 when the tab alone is enough.
 */
function nestPadding(state: EditorState, item: SyntaxNode, under: SyntaxNode, depth: number): number {
  const mark = listMark(item);
  if (!mark) return 0;
  const line = state.doc.lineAt(mark.from);
  const at = quotePrefixLength(line.text, depth);
  const off = mark.from - line.from;
  if (at > off) return 0;
  const markerAfterTab = countColumn(line.text.slice(0, at) + "\t" + line.text.slice(at, off), TAB_COLUMNS);
  return Math.max(0, contentColumn(state, under) - markerAfterTab);
}

/**
 * Moves the list items under the selection, each with its whole subtree, one
 * level in (a tab, only under a previous sibling, padded with spaces when the
 * sibling's text starts further right) or out (to the parent's column). Returns
 * false when no selected line belongs to a list item.
 */
function shiftListItems(state: EditorState, dispatch: (tr: Transaction) => void, dir: 1 | -1): boolean {
  const lines = selectedLines(state);
  const tree = treeUpTo(state, maxSelectionEnd(state));
  const items: SyntaxNode[] = [];
  for (const { line } of lines) {
    const item = listItemAtLine(tree, line);
    if (item && !items.some((i) => i.from === item.from && i.to === item.to)) items.push(item);
  }
  if (items.length === 0) return false;
  const roots = items.filter((it) => !items.some((o) => o !== it && o.from <= it.from && it.to <= o.to));
  const { doc } = state;
  const changes: ChangeSpec[] = [];
  for (const item of roots) {
    const depth = quoteDepth(item);
    const first = doc.lineAt(item.from).number;
    const last = doc.lineAt(item.to).number;
    let delta = 0;
    let pad = "";
    if (dir > 0) {
      const prev = previousItem(item);
      if (!prev) continue;
      pad = " ".repeat(nestPadding(state, item, prev, depth));
    } else {
      const parent = item.parent?.parent;
      if (!parent || parent.name !== "ListItem") continue;
      delta = markerColumn(state, item) - markerColumn(state, parent);
      if (delta <= 0) continue;
    }
    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      if (line.text.trim() === "") continue;
      const at = quotePrefixLength(line.text, depth);
      if (dir > 0) {
        // The padding goes right before the text, where a following tab cannot swallow it.
        const textAt = at + /^[ \t]*/.exec(line.text.slice(at))![0].length;
        if (pad === "" || textAt === at) {
          changes.push({ from: line.from + at, insert: "\t" + pad });
        } else {
          changes.push({ from: line.from + at, insert: "\t" }, { from: line.from + textAt, insert: pad });
        }
      } else {
        const edit = outdentWhitespace(line.text, at, delta);
        if (edit) changes.push({ from: line.from + edit.from, to: line.from + edit.to, insert: edit.insert });
      }
    }
  }
  if (changes.length > 0)
    dispatch(state.update({ changes, scrollIntoView: true, userEvent: dir > 0 ? "input.indent" : "delete.dedent" }));
  return true;
}

/** Tab: list items move with their subtree; elsewhere a tab at the caret or indented lines. Never leaves the editor. */
export const indentListOrInsertTab: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return true;
  return shiftListItems(state, dispatch, 1) || insertTab({ state, dispatch });
};

/** Shift-Tab: list items move out with their subtree; elsewhere the selected lines lose one indent unit. */
export const outdentListOrLines: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return true;
  if (!shiftListItems(state, dispatch, -1)) indentLess({ state, dispatch });
  return true;
};

// ── Enter / Shift-Enter (EDIT-03) ────────────────────────────────────────

const continueListMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** Innermost list item or quote node at `pos`, or null (none, or inside a code block). */
function markupContainer(tree: Tree, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = tree.resolveInner(pos, -1); n; n = n.parent) {
    if (LITERAL_BLOCKS.has(n.name)) return null;
    if (n.name === "ListItem" || n.name === "Blockquote") return n;
  }
  return null;
}

/** Innermost container at `pos`: a list item, a quote, or nothing (code blocks count as nothing). */
function markupContext(tree: Tree, pos: number): "item" | "quote" | null {
  const node = markupContainer(tree, pos);
  return node === null ? null : node.name === "ListItem" ? "item" : "quote";
}

/** The digits of an ordered item's marker ("12." → "12"), or null for a bullet. */
function markDigits(state: EditorState, mark: SyntaxNode): string | null {
  return /^\d+/.exec(state.sliceDoc(mark.from, mark.to))?.[0] ?? null;
}

/**
 * Shifts the numbers of the ordered items after `item` by `delta`, as long as they
 * count up from `start` (only the following items of that list, like lang-markdown).
 */
function renumberFollowing(state: EditorState, item: SyntaxNode, start: number, delta: number, changes: ChangeSpec[]): void {
  let prev = start;
  for (let next = nextItem(item); next; next = nextItem(next)) {
    const mark = listMark(next);
    const digits = mark ? markDigits(state, mark) : null;
    if (!mark || digits === null || Number(digits) !== prev + 1) return;
    changes.push({ from: mark.from, to: mark.from + digits.length, insert: String(prev + 1 + delta) });
    prev++;
  }
}

/** The TaskMarker ("[ ]", "[x]") right after an item's ListMark, or null when the item is no task. */
function taskBox(mark: SyntaxNode): SyntaxNode | null {
  const task = mark.nextSibling;
  return task && task.name === "Task" ? task.getChild("TaskMarker") : null;
}

/** Whitespace at `at` when it is valid list spacing (1–4 columns, then text), else null. */
function spacingAt(text: string, at: number): string | null {
  const space = /^[ \t]*/.exec(text.slice(at))![0];
  const end = at + space.length;
  if (space === "" || end === text.length || columnAt(text, end) - columnAt(text, at) > TAB_COLUMNS) return null;
  return space;
}

/**
 * Markup for a new item after the one whose marker is `mark`, copied from its first
 * line: what precedes the marker (quotes and indentation; outer markers become
 * spaces), the same bullet or the next number, the original spacing (a tab stays a
 * tab), and an open box after a task.
 */
function nextItemMarkup(state: EditorState, mark: SyntaxNode): string {
  const line = state.doc.lineAt(mark.from);
  const at = (pos: number): number => pos - line.from;
  const markText = state.sliceDoc(mark.from, mark.to);
  const digits = markDigits(state, mark);
  let out = listLinePrefix(line.text.slice(0, at(mark.from))).continuation;
  out += digits === null ? markText : String(Number(digits) + 1) + markText.slice(digits.length);
  const box = taskBox(mark);
  if (box) return out + line.text.slice(at(mark.to), at(box.from)) + "[ ]" + (spacingAt(line.text, at(box.to)) ?? " ");
  return out + (spacingAt(line.text, at(mark.to)) ?? " ");
}

/** True when a tab separates the marker, or the task box, from the item's text (lang-markdown expects spaces). */
function tabAfterMarkup(line: Line, mark: SyntaxNode): boolean {
  const spaceAfter = (pos: number): string => /^[ \t]*/.exec(line.text.slice(pos - line.from))![0];
  const box = taskBox(mark);
  return spaceAfter(mark.to).includes("\t") || (box !== null && spaceAfter(box.to).includes("\t"));
}

/** End of the markup of an item with nothing but its marker (and an empty task box) on `line`, or null. */
function emptyItemEnd(state: EditorState, line: Line, mark: SyntaxNode): number | null {
  let end = mark.to;
  if (mark.nextSibling) {
    const box = taskBox(mark);
    if (!box || box.parent!.nextSibling) return null;
    end = box.to;
  }
  return state.sliceDoc(end, line.to).trim() === "" ? end : null;
}

/** The empty list item whose marker is on the caret's line, with the caret past its markup, or null. */
function emptyItemAtCaret(
  state: EditorState,
  tree: Tree,
  line: Line,
  pos: number,
): { item: SyntaxNode; mark: SyntaxNode } | null {
  const item = markupContainer(tree, pos);
  const mark = item && item.name === "ListItem" ? listMark(item) : null;
  if (!item || !mark || mark.from < line.from || item.to > line.to) return null;
  const end = emptyItemEnd(state, line, mark);
  return end !== null && pos >= end ? { item, mark } : null;
}

/**
 * Enter on an empty top-level item between two others: lang-markdown would leave
 * a blank line there, and a tight list would turn loose (EDIT-03). A list cannot be
 * left mid-way, so the empty item goes away and the caret returns to the end of the
 * previous one; following ordered items are renumbered. Nested items are left to
 * lang-markdown, whose outdent keeps the list tight.
 */
const dropEmptyMiddleItem: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection;
  if (state.readOnly || sel.ranges.length !== 1 || !sel.main.empty) return false;
  const { doc } = state;
  const pos = sel.main.head;
  const line = doc.lineAt(pos);
  if (line.number === 1 || line.number === doc.lines) return false;
  const empty = emptyItemAtCaret(state, treeUpTo(state, doc.line(line.number + 1).to), line, pos);
  if (!empty || empty.item.parent?.parent?.name === "ListItem") return false;
  const { item, mark } = empty;
  const prev = previousItem(item);
  const next = nextItem(item);
  if (!prev || !next || doc.lineAt(prev.to).number !== line.number - 1 || doc.lineAt(next.from).number !== line.number + 1)
    return false;
  const changes: ChangeSpec[] = [{ from: line.from - 1, to: line.to }];
  const digits = markDigits(state, mark);
  if (digits !== null) renumberFollowing(state, item, Number(digits), -1, changes);
  dispatch(state.update({ changes, selection: { anchor: line.from - 1 }, scrollIntoView: true, userEvent: "input" }));
  return true;
};

/**
 * Enter on an empty item whose marker or box is followed by a tab, which
 * lang-markdown does not take for an empty item (EDIT-03): as it does with
 * spaces, a nested item becomes a new item of its parent, and a top-level one
 * loses its markup, which leaves the list.
 */
const exitEmptyTabItem: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection;
  if (state.readOnly || sel.ranges.length !== 1 || !sel.main.empty) return false;
  const pos = sel.main.head;
  const line = state.doc.lineAt(pos);
  const empty = emptyItemAtCaret(state, treeUpTo(state, line.to), line, pos);
  if (!empty || !tabAfterMarkup(line, empty.mark)) return false;
  const { item, mark } = empty;
  const changes: ChangeSpec[] = [];
  const parent = item.parent?.parent;
  const parentMark = parent && parent.name === "ListItem" ? listMark(parent) : null;
  let from = line.from + quotePrefixLength(line.text, quoteDepth(item));
  let insert = "";
  if (parent && parentMark) {
    from = line.from;
    insert = nextItemMarkup(state, parentMark);
    const parentDigits = markDigits(state, parentMark);
    if (parentDigits !== null) renumberFollowing(state, parent, Number(parentDigits), 1, changes);
  }
  changes.push({ from, to: line.to, insert });
  const digits = markDigits(state, mark);
  if (digits !== null) renumberFollowing(state, item, Number(digits), -1, changes);
  dispatch(state.update({ changes, selection: { anchor: from + insert.length }, scrollIntoView: true, userEvent: "input" }));
  return true;
};

/** True when `pos` is in a table inside its innermost list item (or outside any item). */
function inTable(tree: Tree, pos: number): boolean {
  for (let n: SyntaxNode | null = tree.resolveInner(pos, -1); n && n.name !== "ListItem"; n = n.parent) {
    if (n.name === "Table") return true;
  }
  return false;
}

/**
 * Enter where lang-markdown continues an item wrongly (EDIT-03): on a later line
 * of the item (after Shift+Enter, or a lazy line) it adds no marker, and when a tab
 * follows the marker or the task box it drops the separator or the box. Here the
 * new item copies the markup of the item's first line, and following ordered items
 * are renumbered. Lines without text before the caret, and table rows (the next
 * row goes below), stay with lang-markdown.
 */
const continueItem: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection;
  if (state.readOnly || sel.ranges.length !== 1 || !sel.main.empty) return false;
  const pos = sel.main.head;
  const line = state.doc.lineAt(pos);
  const tree = treeUpTo(state, line.to);
  const item = markupContainer(tree, pos);
  const mark = item && item.name === "ListItem" ? listMark(item) : null;
  if (!item || !mark || inTable(tree, pos)) return false;
  const offset = pos - line.from;
  if (mark.from < line.from) {
    if (!/[^\s>]/.test(line.text.slice(0, offset))) return false;
  } else {
    const start = listLinePrefix(line.text).contentStart;
    if (!tabAfterMarkup(line, mark) || offset < start || line.text.slice(start).trim() === "") return false;
  }
  let from = pos;
  while (from > line.from && /\s/.test(line.text[from - line.from - 1])) from--;
  const markup = nextItemMarkup(state, mark);
  const changes: ChangeSpec[] = [{ from, to: pos, insert: state.lineBreak + markup }];
  const digits = markDigits(state, mark);
  if (digits !== null) renumberFollowing(state, item, Number(digits), 1, changes);
  // The line break counts as one character in the document, whatever lineBreak is.
  dispatch(state.update({ changes, selection: { anchor: from + 1 + markup.length }, scrollIntoView: true, userEvent: "input" }));
  return true;
};

/** Enter in front of an existing list marker ("- a|- b"): break the line without adding a second marker. */
const splitBeforeMarker: StateCommand = ({ state, dispatch }) => {
  const sel = state.selection;
  if (state.readOnly || sel.ranges.length !== 1 || !sel.main.empty) return false;
  const pos = sel.main.head;
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  const after = line.text.slice(offset);
  const gap = /^[ \t]*/.exec(after)![0].length;
  if (!ITEM_MARKER.test(after.slice(gap))) return false;
  const prefix = listLinePrefix(line.text.slice(0, offset));
  if (prefix.beforeMarker === null || line.text.slice(prefix.contentStart, offset).trim() === "") return false;
  if (markupContext(treeUpTo(state, pos), pos) !== "item") return false;
  let from = pos;
  while (from - line.from > prefix.contentStart && /[ \t]/.test(line.text[from - line.from - 1])) from--;
  const insert = state.lineBreak + prefix.beforeMarker;
  dispatch(
    state.update({
      changes: { from, to: pos + gap, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

/** Enter: continue list and quote markup (lang-markdown), parsing up to the caret first on fresh large notes. */
export const continueMarkup: Command = (view) => {
  const head = view.state.selection.main.head;
  if (!syntaxTreeAvailable(view.state, head)) forceParsing(view, head, 100);
  return (
    splitBeforeMarker(view) ||
    dropEmptyMiddleItem(view) ||
    exitEmptyTabItem(view) ||
    continueItem(view) ||
    continueListMarkup(view)
  );
};

/** Shift-Enter: a line break inside the list item or quote, aligned with its text, with no new marker. */
export const insertSoftBreak: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const tree = treeUpTo(state, maxSelectionEnd(state));
  let inMarkup = false;
  const spec = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from);
    let indent: string;
    if (markupContext(tree, range.from) !== null) {
      inMarkup = true;
      indent = listLinePrefix(line.text).continuation;
    } else {
      indent = /^[ \t]*/.exec(line.text)![0];
    }
    const insert = state.lineBreak + indent;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
  });
  if (!inMarkup) return false;
  dispatch(state.update(spec, { scrollIntoView: true, userEvent: "input" }));
  return true;
};

// ── Links (LINK-02 Mod-Enter) ────────────────────────────────────────────

function hrefTarget(raw: string): LinkTarget | null {
  let href = raw.trim();
  if (href.startsWith("<") && href.endsWith(">")) href = href.slice(1, -1).trim();
  return href ? { kind: "href", href } : null;
}

function wikiTarget(state: EditorState, node: SyntaxNode): LinkTarget | null {
  const marks = elementMarks(node);
  if (!marks) return null;
  // Inside tables the alias pipe is written "\|".
  const inner = state.sliceDoc(marks.openTo, marks.closeFrom).replace(/\\\|/g, "|");
  const { target, subpath } = parseWikiInner(inner);
  return target !== "" || subpath !== null ? { kind: "wiki", target, subpath } : null;
}

/** An autolink or a bare URL, as a click opens it: `www.x` gets https, an e-mail address mailto (LINK-01). */
function bareTarget(raw: string): LinkTarget | null {
  const href = autolinkHref(raw);
  return href ? { kind: "href", href } : null;
}

/** The link at `pos`: a wikilink or embed, a Markdown link or image, an autolink, or a bare URL. */
export function linkAt(state: EditorState, pos: number): LinkTarget | null {
  const tree = treeUpTo(state, pos);
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (n.name === "WikiLink" || n.name === "WikiEmbed") return wikiTarget(state, n);
      if (n.name === "Link" || n.name === "Image") {
        // The destination follows the label's "]"; a URL inside the label is not it. Reference
        // links have none; resolving their definitions is P2.
        const url = linkUrl(n);
        return url ? hrefTarget(state.sliceDoc(url.from, url.to)) : null;
      }
      if (n.name === "Autolink") {
        const url = n.getChild("URL");
        return url ? bareTarget(state.sliceDoc(url.from, url.to)) : null;
      }
      if (n.name === "URL") {
        // A link's URLs belong to it, except in a reference link's label, where nothing is the
        // destination: a URL there is a bare link, as live preview shows it (LIVE-06).
        const owner = n.parent;
        if (owner?.name === "Autolink" || ((owner?.name === "Link" || owner?.name === "Image") && linkUrl(owner))) continue;
        return bareTarget(state.sliceDoc(n.from, n.to));
      }
    }
  }
  return null;
}

/**
 * ↑ on the first visual row of the body moves to the inline title (EDIT-15). Only a
 * single empty caret qualifies, and an open [[ completion keeps ↑ for its list; a
 * wrapped first line still moves up inside itself first.
 */
function focusTitleFromTop(host: EditorHost): Command {
  return (view) => {
    const { state } = view;
    const main = state.selection.main;
    if (view.composing || state.selection.ranges.length > 1 || !main.empty) return false;
    if (completionStatus(state) === "active" || state.doc.lineAt(main.head).number !== 1) return false;
    const here = view.coordsAtPos(main.head, main.assoc || -1);
    const top = view.coordsAtPos(0, 1);
    if (here && top && Math.abs(here.top - top.top) > view.defaultLineHeight / 2) return false;
    return host.focusTitle();
  };
}

/** Mod-Enter: follow the link under the caret; elsewhere CodeMirror's default (insert a blank line) runs. */
function openLinkAtCursor(host: EditorHost): Command {
  return (view) => {
    const link = linkAt(view.state, view.state.selection.main.head);
    if (!link) return false;
    host.openLink(link);
    return true;
  };
}

// ── Keymap ───────────────────────────────────────────────────────────────

/** An editor command the user can rebind (SET-06). */
export interface EditorShortcut {
  /** Stable: the user's keys are stored under it (settings.shortcuts). */
  id: string;
  label: MessageKey;
  labelParams?: Record<string, number>;
  /** Default keys (EDIT-05). */
  keys: readonly string[];
  command: (host: EditorHost) => Command;
}

/** The rebindable editor commands, in the order the shortcut settings list them. */
export const EDITOR_SHORTCUTS: readonly EditorShortcut[] = [
  { id: "toggle-bold", label: "cmdBold", keys: ["Mod-Shift-b"], command: () => toggleBold },
  { id: "toggle-italic", label: "cmdItalic", keys: ["Mod-i"], command: () => toggleItalic },
  { id: "toggle-strikethrough", label: "cmdStrikethrough", keys: ["Mod-Shift-x"], command: () => toggleStrikethrough },
  { id: "toggle-highlight", label: "cmdHighlight", keys: ["Mod-Shift-h"], command: () => toggleHighlight },
  { id: "insert-link", label: "cmdInsertLink", keys: ["Mod-k"], command: () => insertLink },
  { id: "cycle-task", label: "cmdToggleTask", keys: ["Mod-l"], command: () => cycleTasks },
  ...[1, 2, 3, 4, 5, 6].map(
    (level): EditorShortcut => ({
      id: `heading-${level}`,
      label: "cmdHeading",
      labelParams: { level },
      keys: [`Mod-${level}`],
      command: () => setHeading(level),
    }),
  ),
  { id: "paragraph", label: "cmdParagraph", keys: ["Mod-0"], command: () => setHeading(0) },
  { id: "open-link", label: "cmdOpenLink", keys: ["Mod-Enter"], command: openLinkAtCursor },
];

/**
 * The rebindable editor commands' keys (EDIT-05, SET-06), matched like the global shortcuts
 * (utils/keys.ts) and read through host.shortcutKeys at every press, so a settings change
 * applies at once. Runs ahead of every keymap (precedence slot 1 of ARCHITECTURE §10.1); a
 * command that declines (Mod-Enter off a link) leaves the key to them.
 */
export function editorShortcuts(host: EditorHost): Extension {
  const bound = EDITOR_SHORTCUTS.map((s) => ({ id: s.id, keys: s.keys, run: s.command(host) }));
  return Prec.high(
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (isComposing(event)) return false;
        const hit = bound.find((s) => (host.shortcutKeys(s.id) ?? s.keys).some((k) => matchShortcut(event, k)));
        return hit ? hit.run(view) : false;
      },
    }),
  );
}

/** ↑ on the first row → host.focusTitle (fixed; the other editing keys are editorShortcuts). */
export function editingKeymap(host: EditorHost): readonly KeyBinding[] {
  return [{ key: "ArrowUp", run: focusTitleFromTop(host) }];
}

/** Enter / Shift-Enter for list and quote markup (precedence slot 4 of ARCHITECTURE §10.1). */
export const markupEnterKeymap: readonly KeyBinding[] = [{ key: "Enter", run: continueMarkup, shift: insertSoftBreak }];

/** Tab / Shift-Tab (precedence slot 8; replaces CodeMirror's indentWithTab per EDIT-04). */
export const listTabKeymap: readonly KeyBinding[] = [{ key: "Tab", run: indentListOrInsertTab, shift: outdentListOrLines }];

