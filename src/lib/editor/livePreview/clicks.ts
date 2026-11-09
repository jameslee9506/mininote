/**
 * Multi-click selection under live preview (LIVE-01). A double or triple click
 * selects the word or line at the caret the first click placed, not at the
 * pointer: that click's release reveals the syntax marks around the caret, which
 * shifts the text under the still pointer, so CodeMirror's own reading of the
 * second click could land a character or two off (on the `**` before a bold
 * word, say). Dragging on extends by words or lines as usual.
 */
import { EditorSelection, findClusterBreak, type EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView, type MouseSelectionStyle } from "@codemirror/view";

/** The run of characters of one category around `pos`: CodeMirror's double-click group. */
function groupAt(state: EditorState, pos: number, bias: -1 | 1): SelectionRange {
  const categorize = state.charCategorizer(pos);
  const line = state.doc.lineAt(pos);
  const linePos = pos - line.from;
  if (line.length === 0) return EditorSelection.cursor(pos);
  if (linePos === 0) bias = 1;
  else if (linePos === line.length) bias = -1;
  let from = linePos;
  let to = linePos;
  if (bias < 0) from = findClusterBreak(line.text, linePos, false);
  else to = findClusterBreak(line.text, linePos);
  const cat = categorize(line.text.slice(from, to));
  while (from > 0) {
    const prev = findClusterBreak(line.text, from, false);
    if (categorize(line.text.slice(prev, from)) !== cat) break;
    from = prev;
  }
  while (to < line.length) {
    const next = findClusterBreak(line.text, to);
    if (categorize(line.text.slice(to, next)) !== cat) break;
    to = next;
  }
  return EditorSelection.undirectionalRange(from + line.from, to + line.from);
}

/** The line around `pos` with its line break: CodeMirror's triple-click range. */
function lineAround(state: EditorState, pos: number): SelectionRange {
  const line = state.doc.lineAt(pos);
  return EditorSelection.undirectionalRange(line.from, line.to < state.doc.length ? line.to + 1 : line.to);
}

function rangeFor(state: EditorState, pos: number, bias: -1 | 1, type: 2 | 3): SelectionRange {
  return type === 2 ? groupAt(state, pos, bias) : lineAround(state, pos);
}

/** Pointer travel that turns a multi-click into a drag. */
const DRAG_PX = 10;

export const multiClickSelection = EditorView.mouseSelectionStyle.of((view, event): MouseSelectionStyle | null => {
  if (event.button !== 0 || event.detail < 2 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return null;
  const { state } = view;
  const main = state.selection.main;
  // Only after a plain click that placed one caret on the pointed line; anything else is CodeMirror's.
  if (!main.empty || state.selection.ranges.length > 1) return null;
  const pointed = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  if (state.doc.lineAt(pointed).number !== state.doc.lineAt(main.head).number) return null;
  const type = event.detail === 2 ? 2 : 3;
  let start = rangeFor(state, main.head, main.assoc < 0 ? -1 : 1, type);
  return {
    update(u) {
      if (u.docChanged) start = start.map(u.changes);
      return false;
    },
    get(e) {
      // Near the click the start range stands. Farther away the gesture is a drag over the
      // layout as it is now, and the group or line under the pointer joins the start.
      if (Math.abs(e.clientX - event.clientX) < DRAG_PX && Math.abs(e.clientY - event.clientY) < DRAG_PX) {
        return EditorSelection.create([start]);
      }
      const cur = view.posAndSideAtCoords({ x: e.clientX, y: e.clientY }, false);
      const range = rangeFor(view.state, cur.pos, cur.assoc, type);
      const from = Math.min(start.from, range.from);
      const to = Math.max(start.to, range.to);
      return EditorSelection.create([from < range.from ? EditorSelection.range(from, to) : EditorSelection.range(to, from)]);
    },
  };
});
