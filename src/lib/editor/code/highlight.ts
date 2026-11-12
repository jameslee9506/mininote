/**
 * Syntax colors of the code view: CodeMirror's default highlight style, tag for tag,
 * with each color as a `--c-syn-*` token (tokens.css). The light values are the
 * default's own and the dark ones their counterparts, so one style serves both themes.
 * One addition: standard names (built-in functions) take the local-variable color, as
 * the stream modes mark many of them.
 */
import { HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";

export const codeHighlight = HighlightStyle.define([
  { tag: tags.meta, color: "var(--c-syn-meta)" },
  { tag: tags.link, textDecoration: "underline" },
  { tag: tags.heading, textDecoration: "underline", fontWeight: "var(--fw-strong)" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "var(--fw-strong)" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.keyword, color: "var(--c-syn-keyword)" },
  { tag: [tags.atom, tags.bool, tags.url, tags.contentSeparator, tags.labelName], color: "var(--c-syn-atom)" },
  { tag: [tags.literal, tags.inserted], color: "var(--c-syn-number)" },
  { tag: [tags.string, tags.deleted], color: "var(--c-syn-string)" },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: "var(--c-syn-escape)" },
  { tag: tags.definition(tags.variableName), color: "var(--c-syn-def)" },
  { tag: [tags.local(tags.variableName), tags.standard(tags.variableName)], color: "var(--c-syn-local)" },
  { tag: [tags.typeName, tags.namespace], color: "var(--c-syn-type)" },
  { tag: tags.className, color: "var(--c-syn-class)" },
  { tag: [tags.special(tags.variableName), tags.macroName], color: "var(--c-syn-macro)" },
  { tag: tags.definition(tags.propertyName), color: "var(--c-syn-property)" },
  { tag: tags.comment, color: "var(--c-syn-comment)" },
  { tag: tags.invalid, color: "var(--c-syn-invalid)" },
]);
