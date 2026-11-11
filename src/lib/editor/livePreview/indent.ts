/**
 * Hanging indents for wrapped list lines (LIVE-13). The prefix before an item's
 * text (indentation, marker, task box) has a proportional-font width that CSS
 * cannot know, so it is measured once per distinct prefix and cached for every
 * note. The line then gets `text-indent: <width> hanging` (editor.css), which
 * leaves the first row, and therefore tab stops, untouched.
 */
import { BlockType, type EditorView } from "@codemirror/view";

export interface HangRequest {
  key: string;
  /** Start of the prefix (after any quote markers). */
  from: number;
  /** Start of the item's text. */
  to: number;
}

const MAX_ENTRIES = 400;
const widths = new Map<string, number>();
let metrics = "";

/** CodeMirror's height-oracle values before a fresh view state's first measure. */
const UNMEASURED_LINE_HEIGHT = 14;
const UNMEASURED_CHAR_WIDTH = 7;

/**
 * Drops cached widths when the editor's font changed. Only the font size is a
 * setting (the families are fixed tokens), and the body line height
 * (--lh-content × --fs-content, constant across sampled lines) follows it. It is
 * never keyed on defaultCharacterWidth: that is the average glyph width of
 * whichever short line CodeMirror sampled last, so with a proportional font it
 * changes with the text (scrolling, every note switch). Returns true when widths
 * were dropped.
 */
export function syncHangMetrics(view: EditorView): boolean {
  const lineHeight = view.defaultLineHeight;
  // Before its first measure a fresh state reports defaults that say nothing about the font.
  if (lineHeight === UNMEASURED_LINE_HEIGHT && view.defaultCharacterWidth === UNMEASURED_CHAR_WIDTH) return false;
  const m = String(Math.round(lineHeight * 10));
  if (m === metrics) return false;
  const first = metrics === "";
  metrics = m;
  // Widths measured before the first sync were taken with these same fonts.
  if (first || widths.size === 0) return false;
  widths.clear();
  return true;
}

/** Cached width in px, or undefined when the prefix has not been measured yet. */
export function hangWidth(key: string): number | undefined {
  return widths.get(key);
}

/** Measures pending prefixes; call from a measure `read` phase. Returns how many were stored. */
export function measureHangs(view: EditorView, requests: readonly HangRequest[]): number {
  let stored = 0;
  for (const r of requests) {
    if (widths.has(r.key) || r.to > view.state.doc.length) continue;
    // A line replaced by a block widget (an image alone on a list item's line) has
    // no text: its coordinates are the widget's edges, not the prefix's width.
    if (view.lineBlockAt(r.from).type === BlockType.WidgetRange) continue;
    const start = view.coordsAtPos(r.from, 1);
    const end = view.coordsAtPos(r.to, -1);
    // On one row the two boxes overlap vertically, whatever their heights (indentation is
    // text, a task box is as high as its line); a prefix that wraps has no width to hang.
    if (!start || !end || end.top >= start.bottom || start.top >= end.bottom) continue;
    if (widths.size >= MAX_ENTRIES) widths.clear();
    widths.set(r.key, Math.max(0, Math.round((end.left - start.left) * 10) / 10));
    stored++;
  }
  return stored;
}
