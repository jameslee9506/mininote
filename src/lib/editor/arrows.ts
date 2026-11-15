/**
 * Typed arrows (EDIT-18): a sequence that spells an arrow becomes the arrow character
 * when its last character is typed.
 *
 *   ->  →     <-  ←     <->  ↔     =>  ⇒     <=>  ⇔
 *
 * This is the one place where the editor replaces what was typed (EDIT-01), so it stays narrow:
 * - Only typing triggers it. Pasted, dropped and existing text is never changed, and nothing
 *   happens while an input method composes (EDIT-11).
 * - The typed character goes in first, as typed. The arrow replaces the sequence in a second
 *   transaction that is an undo step of its own: one undo gives the characters back, and
 *   they stay.
 * - Text that is not prose keeps its characters: code (also behind a backtick that is not
 *   closed yet), HTML, frontmatter, URLs and link destinations, a wikilink's target (a file
 *   name), and a sequence behind a backslash escape.
 * - A longer shaft is not an arrow: "-->" ends an HTML comment, and "==>" would take a
 *   highlight's "==". "<=" alone is "less than or equal" and stays.
 */
import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import type { EditorState, Extension, Line, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { frontmatterRange } from "./livePreview/frontmatter";

/**
 * Sequence and arrow, longest first: the first sequence the text ends with wins.
 * U+2190 + ">" is "<->" typed in one go, whose "<-" has just become the left arrow.
 */
const ARROWS: readonly (readonly [sequence: string, arrow: string])[] = [
  ["<->", "\u2194"], // ↔
  ["\u2190>", "\u2194"], // ← and ">": ↔
  ["<=>", "\u21D4"], // ⇔
  ["->", "\u2192"], // →
  ["=>", "\u21D2"], // ⇒
  ["<-", "\u2190"], // ←
];
/** The longest sequence plus the character in front of it. */
const LOOKBEHIND = 4;
/** Nodes whose text is literal: code, HTML, URLs (a link's destination too) and escaped characters. */
const LITERAL = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "HTMLTag",
  "CommentBlock",
  "Comment",
  "ProcessingInstructionBlock",
  "ProcessingInstruction",
  "URL",
  "Escape",
]);

const PARSE_BUDGET_MS = 50;

interface TypedArrow {
  arrow: string;
  /** Length of the sequence it replaces, at the end of the text. */
  length: number;
}

/** The arrow that the end of `text` spells, or null. */
function arrowAtEnd(text: string): TypedArrow | null {
  for (const [sequence, arrow] of ARROWS) {
    if (!text.endsWith(sequence)) continue;
    const shaft = sequence[0];
    if ((shaft === "-" || shaft === "=") && text[text.length - sequence.length - 1] === shaft) return null;
    return { arrow, length: sequence.length };
  }
  return null;
}

/** End of the next run of exactly `length` backticks at or after `from`, or -1. */
function closingRun(text: string, from: number, length: number): number {
  for (let i = text.indexOf("`", from); i >= 0; i = text.indexOf("`", i)) {
    let end = i;
    while (text[end] === "`") end++;
    if (end - i === length) return end;
    i = end;
  }
  return -1;
}

/**
 * True when `text` ends in a code span that is still being typed: a backtick run that no
 * later run of the same length closes (CommonMark's pairing; "\`" opens nothing). Backticks
 * are not paired on input (EDIT-06), so the parser sees no code there yet.
 */
function inOpenCodeSpan(text: string): boolean {
  for (let i = 0; i < text.length; ) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let end = i;
    while (text[end] === "`") end++;
    const closed = closingRun(text, end, end - i);
    if (closed < 0) return true;
    i = closed;
  }
  return false;
}

/**
 * True when `text` ends in the target of a wikilink, closed or still being typed: a "[["
 * with no "]", "|" or "#" after it, which is where the completion reads a file name. A
 * heading after "#" and an alias after "|" are prose.
 */
function inWikilinkTarget(text: string): boolean {
  const open = text.lastIndexOf("[[");
  return open >= 0 && !/[\]|#]/.test(text.slice(open));
}

function literalAt(tree: Tree, pos: number, side: -1 | 1): boolean {
  for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) if (LITERAL.has(n.name)) return true;
  return false;
}

/** True when the sequence at [from, to) on `line` is not prose and stays as typed. */
function staysTyped(state: EditorState, line: Line, from: number, to: number): boolean {
  const before = line.text.slice(0, from - line.from);
  if (inWikilinkTarget(before) || inOpenCodeSpan(before)) return true;
  const frontmatter = frontmatterRange(state.doc);
  if (frontmatter && from < frontmatter.to) return true;
  // Not parsed this far (a very large note): the text stays, rather than guessing what it is.
  const tree = ensureSyntaxTree(state, to, PARSE_BUDGET_MS);
  return !tree || literalAt(tree, from, 1) || literalAt(tree, to, -1);
}

/** The arrow for the sequence that ends at `head`, with the start of that sequence, or null. */
function arrowBefore(state: EditorState, head: number): { from: number; arrow: string } | null {
  const line = state.doc.lineAt(head);
  const hit = arrowAtEnd(state.sliceDoc(Math.max(line.from, head - LOOKBEHIND), head));
  if (!hit) return null;
  const from = head - hit.length;
  return staysTyped(state, line, from, head) ? null : { from, arrow: hit.arrow };
}

/**
 * The transaction to apply after `typed`, a transaction that typed a character: it puts
 * an arrow in place of each sequence that character completed, at every caret. Null
 * when it completed none. The context is read from the text as it is after `typed`,
 * so a character that closes an HTML tag or a link counts.
 */
export function arrowReplacement(typed: Transaction): Transaction | null {
  const { state } = typed;
  const typedAt = new Set<number>();
  typed.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
    if (inserted.length > 0) typedAt.add(toB);
  });
  let found = false;
  const spec = state.changeByRange((range) => {
    const hit = range.empty && typedAt.has(range.head) ? arrowBefore(state, range.head) : null;
    if (!hit) return { range };
    found = true;
    return {
      changes: { from: hit.from, to: range.head, insert: hit.arrow },
      range: EditorSelection.cursor(hit.from + hit.arrow.length),
    };
  });
  if (!found) return null;
  return state.update(spec, { annotations: isolateHistory.of("full"), userEvent: "input.type", scrollIntoView: true });
}

/**
 * The input handler: both transactions go out in one update, so the sequence is never
 * painted. A character that an input method produced is left to it (EDIT-11).
 */
export const arrowTyping: Extension = EditorView.inputHandler.of((view, _from, _to, text, insert) => {
  if ((text !== ">" && text !== "-") || view.composing || view.state.readOnly) return false;
  const typed = insert();
  if (typed.isUserEvent("input.type.compose")) return false;
  const arrows = arrowReplacement(typed);
  if (!arrows) return false;
  view.dispatch([typed, arrows]);
  return true;
});
