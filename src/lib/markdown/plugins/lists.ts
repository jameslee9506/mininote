/**
 * List spacing support (DESIGN §3.1). markdown-it marks a tight list by hiding
 * the paragraphs of its items; a list with any visible item paragraph is loose
 * and gets `class="loose"`, so CSS never needs `:has()`.
 *
 * After that decision the hidden paragraphs are shown again. A `<p>` without
 * margins looks the same as bare text, and it makes every child of an `li` a
 * block, so the plain pair rules work inside items ("item text + nested list"
 * is `li > p + ul`) and never touch inline elements such as images.
 *
 * A list whose items hold a code block, table, quote, rule, heading or HTML
 * block also gets `class="has-blocks"`: its items are spaced like blocks, so the
 * gap below such a block matches the gap above it (READ-03).
 */
import type { MarkdownIt, StateCore, Token } from "markdown-it";

/** Item children that make an item more than text: anything but a paragraph or a nested list. */
const ITEM_BLOCKS = new Set(["fence", "code_block", "table_open", "blockquote_open", "hr", "heading_open", "html_block"]);

function isListOpen(t: Token): boolean {
  return t.type === "bullet_list_open" || t.type === "ordered_list_open";
}

function isListClose(t: Token): boolean {
  return t.type === "bullet_list_close" || t.type === "ordered_list_close";
}

function looseLists(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const list = tokens[i];
    if (!isListOpen(list)) continue;
    // The children of this list's items (their paragraphs too) sit two levels deeper.
    const childLevel = list.level + 2;
    const paragraphs: Token[] = [];
    let loose = false;
    let blocks = false;
    for (let j = i + 1; j < tokens.length; j++) {
      const tok = tokens[j];
      if (tok.level === list.level && isListClose(tok)) break;
      if (tok.level !== childLevel) continue;
      if (tok.type === "paragraph_open" || tok.type === "paragraph_close") {
        paragraphs.push(tok);
        if (!tok.hidden) loose = true;
      } else if (ITEM_BLOCKS.has(tok.type)) blocks = true;
    }
    if (loose) list.attrJoin("class", "loose");
    if (blocks) list.attrJoin("class", "has-blocks");
    for (const p of paragraphs) p.hidden = false;
  }
}

export function listPlugin(md: MarkdownIt): void {
  md.core.ruler.push("loose_lists", looseLists);
}
