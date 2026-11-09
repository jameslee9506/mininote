/**
 * Line endings, BOM and minimal text diffs for note text (EDIT-02, SAVE-06).
 * The editor always works in LF; files keep their own style on save.
 */

export type LineEnding = "\n" | "\r\n" | "\r";

export const BOM = "\uFEFF";

/** The first line ending in `text` (CRLF, LF or CR wins by position), or null when there is none. */
export function detectLineEnding(text: string): LineEnding | null {
  const i = text.search(/[\r\n]/);
  if (i < 0) return null;
  if (text[i] === "\n") return "\n";
  return text[i + 1] === "\n" ? "\r\n" : "\r";
}

/** Converts every CRLF and lone CR to LF (how CodeMirror stores the document). */
export function toLF(text: string): string {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

/** Converts LF text back to a file's own line ending. */
export function fromLF(text: string, eol: LineEnding): string {
  return eol === "\n" ? text : text.replace(/\n/g, eol);
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * The single replacement that turns `a` into `b`, keeping their common prefix and
 * suffix untouched (so selections and scroll survive a reload). Never splits a
 * surrogate pair. Null when the texts are equal.
 */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
  return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) };
}

const encoder = new TextEncoder();
/** ignoreBOM: a leading U+FEFF is text here and must survive the round trip. */
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
/** A high surrogate without its low half, or a low one without its high half (no lookbehind: Safari 15). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Replaces lone surrogates with U+FFFD, as TextEncoder does for raw-body writes.
 * Needed before text travels as a JSON argument (serde rejects lone surrogates).
 */
export function wellFormed(text: string): string {
  return LONE_SURROGATE.test(text) ? decoder.decode(encoder.encode(text)) : text;
}
