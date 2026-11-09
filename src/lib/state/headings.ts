/**
 * Positions for jumps into a note (NAV-05): the heading of a `[[note#Heading]]` or
 * `[text](#heading)` link, and a search hit inside its line (SRCH-01).
 * Heading slugs (LINK-08) are deferred, so text is matched loosely: NFC, case,
 * punctuation and whitespace are ignored, and slug forms ("my-heading") match too.
 */

/**
 * The first occurrence of `needle` in the line `text`: exact first, then ignoring case,
 * as the vault search matches. The search reports NFC text, so a decomposed (NFD) line
 * is tried with the decomposed needle too. UTF-16 offsets into `text`; null when absent.
 */
export function findInLine(text: string, needle: string): { from: number; to: number } | null {
  if (needle === "") return null;
  const forms = [...new Set([needle, needle.normalize("NFD")])];
  for (const n of forms) {
    const i = text.indexOf(n);
    if (i >= 0) return { from: i, to: i + n.length };
  }
  for (const n of forms) {
    try {
      // A regex search keeps offsets right where lower-casing would change the length.
      const m = new RegExp(n.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&"), "iu").exec(text);
      if (m) return { from: m.index, to: m.index + m[0].length };
    } catch {
      // not searchable as a pattern: no match
    }
  }
  return null;
}

const FRONTMATTER_OPEN = /^---[ \t]*$/;
const FRONTMATTER_CLOSE = /^(---|\.\.\.)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const NOT_SETEXT_TEXT = /^ {0,3}(?:[-*+>#]|\d{1,9}[.)])(?:[ \t]|$)/;

function norm(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const slug = (s: string) => norm(s).replace(/ /g, "-");

/**
 * 0-based line of the first heading in `text` (LF) matching `subpath`, or null.
 * The whole subpath is tried first ("C# notes"), then its last "#" part, for
 * nested subpaths ("A#B"). Fenced code and frontmatter are skipped.
 */
export function findHeadingLine(text: string, subpath: string): number | null {
  const whole = norm(subpath);
  if (whole === "") return null;
  const line = scan(text, whole, slug(subpath));
  if (line !== null) return line;
  const parts = subpath.split("#").filter((p) => p.trim() !== "");
  const last = parts.length > 1 ? parts[parts.length - 1] : "";
  return norm(last) === "" ? null : scan(text, norm(last), slug(last));
}

function scan(text: string, wantNorm: string, wantSlug: string): number | null {
  const lines = text.split("\n");

  let i = 0;
  if (FRONTMATTER_OPEN.test(lines[0] ?? "")) {
    for (let k = 1; k < lines.length; k++) {
      if (FRONTMATTER_CLOSE.test(lines[k])) {
        i = k + 1;
        break;
      }
    }
  }

  let fence: string | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (fence !== null) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    let heading: string | null = null;
    const atx = ATX.exec(line);
    if (atx) heading = atx[1] ?? "";
    else if (
      i + 1 < lines.length &&
      line.trim() !== "" &&
      !NOT_SETEXT_TEXT.test(line) &&
      SETEXT_UNDERLINE.test(lines[i + 1])
    )
      heading = line;
    if (heading !== null && (norm(heading) === wantNorm || slug(heading) === wantSlug)) return i;
  }
  return null;
}
