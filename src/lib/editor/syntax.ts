/**
 * Lezer markdown extensions: [[wikilinks]] / ![[embeds]], ==highlight== and the
 * app's block dialect (no setext headings, no lazy continuation lines).
 * Node names are a CONTRACT used by live preview, completion and commands:
 *   WikiLink, WikiEmbed            — whole construct (embed includes the leading "!")
 *   WikiLinkMark                   — "[[", "![[", "|", "]]"
 *   WikiLinkTarget, WikiLinkAlias  — the parts around "|"  (target may contain "#heading")
 *   Highlight, HighlightMark       — "==text==" and its "==" marks
 */
import type { DelimiterType, InlineContext, LeafBlockParser, MarkdownConfig } from "@lezer/markdown";
import { Tag, tags } from "@lezer/highlight";

/** Highlighting tags so source mode can style these constructs too. */
export const wikiLinkTag = Tag.define(tags.link);
export const highlightTag = Tag.define(tags.content);

const BRACKET_OPEN = 91; // [
const BRACKET_CLOSE = 93; // ]
const BANG = 33; // !
const PIPE = 124; // |
const NEWLINE = 10;
const EQUALS = 61; // =

export const WikiLink: MarkdownConfig = {
  defineNodes: [
    { name: "WikiLink", style: wikiLinkTag },
    { name: "WikiEmbed", style: wikiLinkTag },
    { name: "WikiLinkMark", style: tags.processingInstruction },
    { name: "WikiLinkTarget" },
    { name: "WikiLinkAlias" },
  ],
  parseInline: [
    {
      name: "WikiLink",
      // Before the standard Link/Image parsers so "[[" / "![[" are not taken as links.
      before: "Link",
      parse(cx: InlineContext, next: number, pos: number): number {
        let open: number;
        if (next === BANG && cx.char(pos + 1) === BRACKET_OPEN && cx.char(pos + 2) === BRACKET_OPEN) open = pos + 3;
        else if (next === BRACKET_OPEN && cx.char(pos + 1) === BRACKET_OPEN) open = pos + 2;
        else return -1;

        let close = -1;
        let bar = -1;
        for (let i = open; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === NEWLINE) return -1;
          if (c === BRACKET_OPEN && cx.char(i + 1) === BRACKET_OPEN) return -1;
          if (c === BRACKET_CLOSE) {
            if (cx.char(i + 1) !== BRACKET_CLOSE) return -1;
            close = i;
            break;
          }
          if (c === PIPE && bar < 0) bar = i;
        }
        if (close < 0) return -1;
        const targetEnd = bar < 0 ? close : bar;
        if (cx.slice(open, targetEnd).trim() === "" && cx.slice(open, close).indexOf("#") < 0) return -1;

        const children = [cx.elt("WikiLinkMark", pos, open)];
        if (targetEnd > open) children.push(cx.elt("WikiLinkTarget", open, targetEnd));
        if (bar >= 0) {
          children.push(cx.elt("WikiLinkMark", bar, bar + 1));
          if (close > bar + 1) children.push(cx.elt("WikiLinkAlias", bar + 1, close));
        }
        children.push(cx.elt("WikiLinkMark", close, close + 2));
        return cx.addElement(cx.elt(open - pos === 3 ? "WikiEmbed" : "WikiLink", pos, close + 2, children));
      },
    },
  ],
};

const HighlightDelim: DelimiterType = { resolve: "Highlight", mark: "HighlightMark" };
const PUNCT = /[\p{P}\p{S}]/u;

export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight", style: { "Highlight/...": highlightTag } },
    { name: "HighlightMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      after: "Emphasis",
      // Same flanking rules as GFM strikethrough.
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== EQUALS || cx.char(pos + 1) !== EQUALS || cx.char(pos + 2) === EQUALS) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = PUNCT.test(before);
        const pAfter = PUNCT.test(after);
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        );
      },
    },
  ],
};

/**
 * Ends a paragraph at a lazy line: one that does not continue every open quote and list
 * item. `depth` counts the containers a line continues; Lezer's own setext parser reads
 * it the same way. The paragraph is finished as a blank line would finish it (a task, a
 * table, a link reference or a plain paragraph), and the line starts a block further out.
 */
const lazyLineParser: LeafBlockParser = {
  nextLine(cx, line, leaf) {
    if ((line as unknown as { depth: number }).depth >= cx.depth) return false;
    for (const parser of leaf.parsers) if (parser !== lazyLineParser && parser.finish(cx, leaf)) return true;
    const end = leaf.start + leaf.content.length;
    cx.addLeafElement(leaf, cx.elt("Paragraph", leaf.start, end, cx.parser.parseInline(leaf.content, leaf.start)));
    return true;
  },
  finish: () => false,
};

/**
 * The block dialect both views read (the reading view's half is markdown/plugins/dialect.ts;
 * keep them in sync). What a line is never depends on a line typed after it, and a line
 * belongs to a quote or a list item only through its own markup:
 * - No setext headings. A "-" or "=" typed under a line of text would turn that text into
 *   a heading while a list or a rule is being written. "---" under text is a rule.
 * - No lazy continuation. A line without ">" is outside the quote, and a line indented
 *   less than a list item's text is outside the item, so leaving a quote or a list needs
 *   no blank line (EDIT-03).
 */
export const Dialect: MarkdownConfig = {
  remove: ["SetextHeading"],
  // First among the leaf parsers: a lazy line ends the block before any of them reads it.
  parseBlock: [{ name: "LazyLine", before: "LinkReference", leaf: () => lazyLineParser }],
};

/** Extensions to pass to `markdown({ extensions })`, after GFM. */
export const markdownExtensions: MarkdownConfig[] = [WikiLink, Highlight, Dialect];
