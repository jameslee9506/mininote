/**
 * The block dialect both views read. The editor's half is `Dialect` in
 * editor/syntax.ts; keep them in sync. What a line is never depends on a line
 * typed after it, and a line belongs to a quote or a list item only through its
 * own markup:
 * - No setext headings: "---" under a line of text is a rule, "-" and "=" are text.
 * - No lazy continuation: a line without ">" ends the quote, and a line indented
 *   less than a list item's text ends the item, with or without a blank line.
 */
import type { MarkdownIt, StateBlock } from "markdown-it";

/**
 * A terminator only: it never starts a block. markdown-it asks the terminators
 * of a paragraph (or a link reference) about every following line, and those of
 * a quote about every following line without ">". Tables ask the quote's
 * terminators about their rows, which this rule leaves alone.
 */
function lazyLine(state: StateBlock, line: number, _endLine: number, silent: boolean): boolean {
  if (!silent) return false;
  if (state.parentType === "blockquote") return true;
  if (state.parentType === "paragraph" || state.parentType === "reference") return state.sCount[line] < state.blkIndent;
  return false;
}

export function dialectPlugin(md: MarkdownIt): void {
  md.disable("lheading");
  md.block.ruler.before("paragraph", "lazy_line", lazyLine, { alt: ["paragraph", "reference", "blockquote"] });
}
