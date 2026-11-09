/**
 * Pure helpers for live preview: block classification (DESIGN §3.2), reveal
 * tests, link targets and table alignment. No DOM, no CodeMirror view.
 */

/** Block types written to `data-blk` / `data-prev` on a block's first line (`li` is a list item). */
export type BlockKind =
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "p"
  | "ul"
  | "ol"
  | "li"
  | "quote"
  | "code"
  | "table"
  | "hr"
  | "html"
  | "fm";

const KINDS: Record<string, BlockKind> = {
  ATXHeading1: "h1",
  ATXHeading2: "h2",
  ATXHeading3: "h3",
  ATXHeading4: "h4",
  ATXHeading5: "h5",
  ATXHeading6: "h6",
  SetextHeading1: "h1",
  SetextHeading2: "h2",
  Paragraph: "p",
  LinkReference: "p",
  BulletList: "ul",
  OrderedList: "ol",
  Blockquote: "quote",
  FencedCode: "code",
  CodeBlock: "code",
  Table: "table",
  HorizontalRule: "hr",
  HTMLBlock: "html",
  CommentBlock: "html",
  ProcessingInstructionBlock: "html",
};

/** Kind of a Lezer block node; anything unknown counts as a paragraph. */
export function blockKind(nodeName: string): BlockKind {
  return KINDS[nodeName] ?? "p";
}

/** Minimal shape of a selection range (CodeMirror's SelectionRange satisfies it). */
export interface SelRange {
  readonly from: number;
  readonly to: number;
  readonly anchor: number;
  readonly head: number;
  readonly empty: boolean;
}

/** LIVE-01: true when any range touches [from, to], both ends inclusive. */
export function touches(ranges: readonly SelRange[], from: number, to: number): boolean {
  for (const r of ranges) if (r.from <= to && r.to >= from) return true;
  return false;
}

/**
 * Block-widget reveal (LIVE-01 [critic]): a caret anywhere in [from, to], a
 * selection end strictly inside it, or a selection lying within it (Shift+Home on
 * a revealed image line selects exactly [from, to]; the text being selected must
 * not vanish behind the widget). A selection with an end outside the block (a drag
 * across it, Select All) keeps it rendered, and so does one covering the whole
 * document when `docLength` is given (Select All on a note that is only this block).
 */
export function endsInside(ranges: readonly SelRange[], from: number, to: number, docLength?: number): boolean {
  for (const r of ranges) {
    if (r.empty) {
      if (r.head >= from && r.head <= to) return true;
    } else if ((r.anchor > from && r.anchor < to) || (r.head > from && r.head < to)) {
      return true;
    } else if (r.from >= from && r.to <= to && !(r.from === 0 && r.to === docLength)) {
      return true;
    }
  }
  return false;
}

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/i;

/** True when a wikilink target names an image file (`![[photo.png]]`). */
export function isImageTarget(target: string): boolean {
  return IMAGE_EXT.test(target.trim());
}

/** Destination of `[t](dest)` / `![a](dest)` as written: `<a b.png>` loses its angle brackets. */
export function linkDestination(url: string): string {
  const s = url.trim();
  return s.length >= 2 && s.startsWith("<") && s.endsWith(">") ? s.slice(1, -1) : s;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EMAIL = /^[^\s@/<>]+@[^\s@/<>]+\.[^\s@/<>]+$/;

/** Href for an autolink or a bare GFM URL: `www.x` gets https, an e-mail address gets mailto. */
export function autolinkHref(text: string): string {
  const s = linkDestination(text);
  if (SCHEME.test(s)) return s;
  if (/^www\./i.test(s)) return `https://${s}`;
  if (EMAIL.test(s)) return `mailto:${s}`;
  return s;
}

export type Align = "left" | "center" | "right";

/** Column alignments of a GFM delimiter row such as `| :-- | :-: | --: |`. */
export function tableAlignments(delimiterRow: string): (Align | null)[] {
  let s = delimiterRow.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => {
    const c = cell.trim();
    const left = c.startsWith(":");
    const right = c.endsWith(":") && c.length > 1;
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
}

/** First word of a fenced code block's info string, shortened for the faint label. */
export function fenceLabel(info: string): string {
  const word = info.trim().split(/\s+/)[0] ?? "";
  return word.slice(0, 24);
}

/** FNV-1a 32-bit hash, used as a compact cache key for widget heights. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
