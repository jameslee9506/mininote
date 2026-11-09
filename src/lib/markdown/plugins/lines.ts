/**
 * Source lines (TECHNIQUES §9, NAV-05): block elements carry `data-line`, the
 * 0-based source line they start on, so the reading view can scroll to a line
 * the editor names (a search hit, a heading link). Lines count from the top of
 * the file, frontmatter included, because every rule parses the full text.
 *
 * markdown-it renders a fence's attributes on its `<code>` and an indented code
 * block's on its `<pre>`. Raw HTML can forge the attribute; that only misplaces
 * a scroll (task toggles re-check their line in the editor).
 */
import type { MarkdownIt, StateCore } from "markdown-it";

const BLOCKS = new Set([
  "paragraph_open",
  "heading_open",
  "blockquote_open",
  "list_item_open",
  "table_open",
  "tr_open",
  "hr",
  "fence",
  "code_block",
]);

function sourceLines(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.map && BLOCKS.has(token.type)) token.attrSet("data-line", String(token.map[0]));
  }
}

export function sourceLinePlugin(md: MarkdownIt): void {
  md.core.ruler.push("source_lines", sourceLines);
}
