/**
 * Wrapped rows of a code line start under the line's own text, not at the left edge:
 * each indented line in view carries its indentation in columns (`--mn-indent`), which
 * code.css turns into a hanging indent.
 */
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";

/** A deeper indentation hangs no further, so a wrapped row always keeps room for text. */
export const MAX_HANG_COLUMNS = 32;

/** Columns the leading whitespace of `text` spans (a tab runs to the next tab stop); 0 for a blank line. */
export function indentColumns(text: string, tabSize: number): number {
  let columns = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 9) columns += tabSize - (columns % tabSize);
    else if (ch === 32) columns++;
    else return columns;
  }
  return 0;
}

const hangs = new Map<number, Decoration>();

function hang(columns: number): Decoration {
  let deco = hangs.get(columns);
  if (!deco) {
    deco = Decoration.line({ attributes: { class: "cm-wrap-indent", style: `--mn-indent:${columns}` } });
    hangs.set(columns, deco);
  }
  return deco;
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { doc, tabSize } = view.state;
  // Two visible ranges can lie on one very long line, which is still decorated once.
  let done = -1;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = doc.lineAt(pos);
      if (line.from > done) {
        done = line.from;
        const columns = Math.min(indentColumns(line.text, tabSize), MAX_HANG_COLUMNS);
        if (columns > 0) builder.add(line.from, line.from, hang(columns));
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export const wrapIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
