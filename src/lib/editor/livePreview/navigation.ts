/**
 * Arrow keys across block widgets (LIVE-11, LIVE-12). CodeMirror's vertical
 * motion skips a block widget that replaces lines (a rendered table, an image
 * alone on its line), so ↑ and ↓ from a neighbouring line jumped over it. Here
 * a move that would leave its line toward such a widget puts the caret on the
 * widget's nearest source line instead, which reveals it; with Shift the
 * selection extends there.
 */
import { EditorSelection, Prec, type Extension, type SelectionRange } from "@codemirror/state";
import { BlockType, keymap, type Command, type EditorView } from "@codemirror/view";

/** The caret position inside the block widget `range` would move into, or null when it would not. */
function intoWidget(view: EditorView, range: SelectionRange, forward: boolean): number | null {
  const { doc } = view.state;
  const line = doc.lineAt(range.head);
  const n = line.number + (forward ? 1 : -1);
  if (n < 1 || n > doc.lines) return null;
  const block = view.lineBlockAt(doc.line(n).from);
  if (block.type !== BlockType.WidgetRange) return null;
  // On a wrapped line the default motion may still have a row to go to within the line.
  const moved = view.moveVertically(range, forward);
  if (doc.lineAt(moved.head).number === line.number && moved.head !== range.head) {
    const here = view.coordsAtPos(range.head);
    const there = view.coordsAtPos(moved.head);
    if (here && there && (forward ? there.top > here.top + 1 : there.top < here.top - 1)) return null;
  }
  // Entering from above lands on the widget's first source line, from below on its last.
  const target = doc.lineAt(forward ? block.from : block.to);
  return target.from + Math.min(range.head - line.from, target.length);
}

function move(forward: boolean, extend: boolean): Command {
  return (view) => {
    if (view.composing) return false;
    const { state } = view;
    let hit = false;
    const ranges = state.selection.ranges.map((range) => {
      // ↓ on a selection collapses it first (the default); only carets move into a widget.
      if (!extend && !range.empty) return range;
      const head = intoWidget(view, range, forward);
      if (head === null) return range;
      hit = true;
      return extend ? EditorSelection.range(range.anchor, head) : EditorSelection.cursor(head);
    });
    if (!hit) return false;
    view.dispatch({
      selection: EditorSelection.create(ranges, state.selection.mainIndex),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  };
}

/** ↑ / ↓ (with Shift: extend) into an adjacent block widget; ahead of the default line motion. */
export const widgetKeymap: Extension = Prec.high(
  keymap.of([
    { key: "ArrowUp", run: move(false, false), shift: move(false, true) },
    { key: "ArrowDown", run: move(true, false), shift: move(true, true) },
  ]),
);
