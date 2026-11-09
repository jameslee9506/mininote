/**
 * Editor chrome (type, caret, selection, find panel, completion list) and the
 * monotone syntax highlighting. Construct styling for live preview belongs to
 * livePreview/ and styles/editor.css, and this file is built not to fight it:
 *
 * - Syntax-highlight spans are the innermost elements (`syntaxHighlighting`
 *   runs at Prec.high), so any color set here beats live preview's own marks.
 * - Live mode therefore gets `liveHighlight`: weights, italics, muted strike,
 *   and faint *revealed* marks only. Source mode gets the fuller `sourceHighlight`.
 * - `highlightRetags` moves list markers, code fences and setext underlines to
 *   `sourceMarkTag`, which only source mode colors, so live preview's
 *   transparent-glyph tricks (bullets, fences) keep working.
 */
import { EditorView } from "@codemirror/view";
import { HighlightStyle } from "@codemirror/language";
import { styleTags, Tag, tags } from "@lezer/highlight";
import type { MarkdownConfig } from "@lezer/markdown";
import { highlightTag, wikiLinkTag } from "./syntax";

/** Syntax marks that only source mode colors; live preview draws or hides them itself. */
export const sourceMarkTag = Tag.define();

/**
 * Parser props for `markdown({ extensions })`. Node names are unchanged; only
 * highlight tags move. Wikilinks also pass their tag down to target and alias,
 * so source mode can style the visible text (by default only the innermost tag counts).
 */
export const highlightRetags: MarkdownConfig = {
  props: [
    styleTags({
      ListMark: sourceMarkTag,
      "FencedCode/CodeMark FencedCode/CodeInfo": sourceMarkTag,
      "SetextHeading1/HeaderMark SetextHeading2/HeaderMark": sourceMarkTag,
      "WikiLink/... WikiEmbed/...": wikiLinkTag,
    }),
  ],
};

const FAINT = "var(--c-text-faint)";
const MUTED = "var(--c-text-muted)";

/** Rules both modes share. Order matters: later rules win on spans that carry several tags. */
const common = [
  {
    tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5],
    fontWeight: "var(--fw-heading)",
    color: "var(--c-text-strong)",
  },
  { tag: tags.heading6, fontWeight: "var(--fw-heading)", color: MUTED },
  { tag: tags.strong, fontWeight: "var(--fw-strong)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecorationLine: "line-through", color: MUTED },
  { tag: highlightTag, backgroundColor: "var(--c-bg-mark)" },
];

/** Live preview: never colors what live preview hides or draws (bullets, fences, links, rules). */
export const liveHighlight = HighlightStyle.define([
  ...common,
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
  { tag: tags.comment, color: FAINT },
  { tag: tags.processingInstruction, color: FAINT, textDecorationLine: "none" },
  // Inherit, so a setext underline takes live preview's color instead of the heading's.
  { tag: sourceMarkTag, color: "inherit", fontWeight: "inherit" },
]);

/** Source mode (EDIT-16): plain Markdown with styling only. */
export const sourceHighlight = HighlightStyle.define([
  ...common,
  { tag: tags.monospace, fontFamily: "var(--font-mono)", fontSize: "0.88em" },
  { tag: tags.quote, color: MUTED },
  {
    tag: tags.link,
    textDecorationLine: "underline",
    textDecorationThickness: "1px",
    textDecorationColor: "var(--c-border-strong)",
    textUnderlineOffset: "2px",
  },
  { tag: tags.url, color: MUTED, textDecorationLine: "none" },
  { tag: [tags.string, tags.labelName], color: MUTED },
  { tag: [tags.contentSeparator, tags.comment], color: FAINT },
  { tag: [tags.processingInstruction, sourceMarkTag], color: FAINT, textDecorationLine: "none" },
]);

/** Gap between the floating find panel and the top of the visible document. */
export const FIND_PANEL_OFFSET = 8;

/** Chrome only. Colors and sizes come from tokens.css, so dark mode needs no second theme. */
export const editorTheme = EditorView.theme({
  "&": {
    color: "var(--c-text)",
    backgroundColor: "transparent",
    // Keeps the panel's and tooltips' z-index local, below the overlay sidebar and modals.
    isolation: "isolate",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-text)",
    fontSize: "var(--fs-content)",
    lineHeight: "var(--lh-content)",
    // Auto-height editor: the ancestor .doc-scroll scrolls, and nothing here may clip the caret.
    overflow: "visible",
  },
  ".cm-content": { padding: "0", caretColor: "var(--c-caret)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor, .cm-dropCursor": { borderLeft: "1.5px solid var(--c-caret)", marginLeft: "-0.75px" },
  ".cm-selectionBackground": { background: "var(--c-selection)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { background: "var(--c-selection)" },

  ".cm-searchMatch": { backgroundColor: "var(--c-bg-mark)", borderRadius: "2px" },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--c-bg-mark)",
    outline: "1px solid var(--c-text-faint)",
  },

  // The find panel floats at the top right; its container takes no space (no reflow on open).
  ".cm-panels": { backgroundColor: "transparent", color: "inherit", zIndex: "var(--z-popover)" },
  ".cm-panels-top": { borderBottom: "none", height: "0" },
  ".cm-panel.cm-mn-find": {
    position: "absolute",
    top: `${FIND_PANEL_OFFSET}px`,
    right: "0",
    width: "min(340px, 100%)",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "4px",
    backgroundColor: "var(--c-bg-elev)",
    border: "1px solid var(--c-border)",
    borderRadius: "var(--radius-m)",
    boxShadow: "var(--shadow-elev)",
    fontFamily: "var(--font-text)",
    fontSize: "var(--fs-ui)",
    lineHeight: "var(--lh-ui)",
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  ".cm-mn-find-row": { display: "flex", alignItems: "center", gap: "2px" },
  ".cm-mn-find-input": {
    flex: "1",
    minWidth: "0",
    height: "28px",
    padding: "0 6px",
    border: "none",
    borderRadius: "var(--radius-s)",
    backgroundColor: "transparent",
    color: "var(--c-text)",
  },
  ".cm-mn-find-input.cm-mn-find-none": { color: "var(--c-text-faint)" },
  ".cm-mn-find-spacer": { flex: "none", width: "28px" },
  ".cm-mn-find-toggle svg": { transition: "transform var(--dur-fast)" },
  ".cm-mn-find-toggle[aria-expanded=true] svg": { transform: "rotate(90deg)" },
  // .icon-btn sets a display, which would otherwise beat the hidden attribute.
  ".cm-mn-find [hidden]": { display: "none !important" },

  ".cm-tooltip": {
    zIndex: "var(--z-popover)",
    backgroundColor: "var(--c-bg-elev)",
    color: "var(--c-text)",
    border: "1px solid var(--c-border)",
    borderRadius: "var(--radius-m)",
    boxShadow: "var(--shadow-elev)",
    fontFamily: "var(--font-text)",
    fontSize: "var(--fs-ui)",
    lineHeight: "var(--lh-ui)",
    userSelect: "none",
    WebkitUserSelect: "none",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "inherit",
    minWidth: "240px",
    maxWidth: "min(480px, 90vw)",
    maxHeight: "calc(var(--row-h) * 10 + 8px)",
    padding: "4px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    height: "var(--row-h)",
    padding: "0 8px",
    lineHeight: "var(--row-h)",
    borderRadius: "var(--radius-s)",
    cursor: "default",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    background: "var(--c-bg-active)",
    color: "var(--c-text-strong)",
  },
  ".cm-tooltip-autocomplete-disabled ul li[aria-selected]": { background: "var(--c-bg-hover)" },
  ".cm-completionLabel": { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" },
  ".cm-completionDetail": {
    flex: "none",
    maxWidth: "45%",
    marginLeft: "auto",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontStyle: "normal",
    fontSize: "var(--fs-ui-small)",
    color: MUTED,
  },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    fontWeight: "600",
    color: "var(--c-text-strong)",
  },
});
