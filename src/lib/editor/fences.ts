/**
 * Typed code fences (EDIT-19): the third backtick of a fence that opens a code block brings
 * the block's closing fence with it, and the caret goes to an empty line between the two.
 *
 *   ```          ```
 *           →    |
 *                ```
 *
 * These are characters the user did not type (EDIT-01), so it stays narrow:
 * - Only typing triggers it. Pasted, dropped and existing text is never changed, and nothing
 *   happens while an input method composes (EDIT-11).
 * - The backtick goes in first, as typed. The rest follows in a second transaction that is
 *   an undo step of its own: one undo leaves the fence alone, with the caret behind it.
 * - Only a fence that opens a block, and has nothing after it on its line, gets one. A
 *   fence that closes a block is one already; a longer fence, an info string and "~~~" are
 *   left to whoever types them.
 * - With several carets nothing is added: the fence at one may be what closes another's.
 */
import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import type { Extension, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { listLinePrefix } from "./commands";
import { frontmatterRange } from "./livePreview/frontmatter";

const FENCE = "```";
const PARSE_BUDGET_MS = 50;

/**
 * The transaction to apply after `typed`, a transaction that typed a backtick: it adds the
 * closing fence of the block that backtick opened, on the second line below, and puts the
 * caret on the line between. Null when the backtick opened no block.
 *
 * Both new lines continue the fence's quote and list item (the indentation Shift-Enter
 * gives), or the closing fence would stand outside them and open a block of its own. The
 * context is read from the text as it is after `typed`: whether three backticks are a
 * fence, and which one, is the parser's answer.
 */
export function fenceClosing(typed: Transaction): Transaction | null {
  const { state } = typed;
  const { main, ranges } = state.selection;
  if (ranges.length !== 1 || !main.empty) return null;
  const head = main.head;
  let typedHere = false;
  typed.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
    if (inserted.length > 0 && toB === head) typedHere = true;
  });
  if (!typedHere) return null;

  const line = state.doc.lineAt(head);
  const offset = head - line.from;
  const prefix = listLinePrefix(line.text);
  if (line.text.slice(prefix.contentStart, offset) !== FENCE || line.text.slice(offset).trim() !== "") return null;
  const frontmatter = frontmatterRange(state.doc);
  if (frontmatter && head <= frontmatter.to) return null;

  // Not parsed this far (a very large note): the text stays, rather than guessing what it is.
  const tree = ensureSyntaxTree(state, line.to, PARSE_BUDGET_MS);
  const mark = tree?.resolveInner(head, -1);
  const block = mark?.parent;
  const from = line.from + prefix.contentStart;
  // The block starts at its opening fence: a closing fence, and three backticks that are text, fail here.
  if (!mark || !block || mark.name !== "CodeMark" || mark.from !== from || mark.to !== head) return null;
  if (block.name !== "FencedCode" || block.from !== from) return null;

  const lead = state.lineBreak + prefix.continuation;
  return state.update({
    changes: { from: line.to, insert: lead + lead + FENCE },
    // The line break counts as one character in the document, whatever lineBreak is.
    selection: EditorSelection.cursor(line.to + 1 + prefix.continuation.length),
    annotations: isolateHistory.of("full"),
    userEvent: "input.type",
    scrollIntoView: true,
  });
}

/**
 * The input handler: both transactions go out in one update, so the open block is never
 * painted over the rest of the note. A character that an input method produced is left to
 * it (EDIT-11).
 */
export const fenceTyping: Extension = EditorView.inputHandler.of((view, _from, _to, text, insert) => {
  if (text !== "`" || view.composing || view.state.readOnly) return false;
  const typed = insert();
  if (typed.isUserEvent("input.type.compose")) return false;
  const closing = fenceClosing(typed);
  if (!closing) return false;
  view.dispatch([typed, closing]);
  return true;
});
