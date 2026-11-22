/**
 * The font settings: the code font (SET-07), one monospaced family for everything shown
 * as code, and the text and heading fonts (SET-09) of the document. The pure rules (a
 * typed name cleaned, the CSS values) and the canvas probe that tells which families are
 * installed.
 */

/**
 * Well-known monospaced families, in the order the settings offer them. Only the
 * installed ones are listed there; any other installed monospaced family can be typed.
 */
export const MONO_FONT_CANDIDATES: readonly string[] = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "Consolas",
  "Cascadia Code",
  "Cascadia Mono",
  "JetBrains Mono",
  "Fira Code",
  "Fira Mono",
  "Source Code Pro",
  "IBM Plex Mono",
  "Hack",
  "Inconsolata",
  "Iosevka",
  "Roboto Mono",
  "Geist Mono",
  "Monaspace Neon",
  "Commit Mono",
  "Maple Mono",
  "Victor Mono",
  "Intel One Mono",
  "Berkeley Mono",
  "MonoLisa",
  "Input Mono",
  "Anonymous Pro",
  "Space Mono",
  "Red Hat Mono",
  "D2Coding",
  "NanumGothicCoding",
  "Sarasa Mono K",
  "Noto Sans Mono",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Droid Sans Mono",
  "Lucida Console",
  "Andale Mono",
  "PT Mono",
  "Courier New",
];

/**
 * Well-known serif families for the text and the headings: those of macOS, Windows and
 * Linux, popular downloads, and Korean ones. The settings list the installed ones; any
 * other installed family can be typed. A listed serif falls back to the system's serif.
 */
export const SERIF_FONT_CANDIDATES: readonly string[] = [
  "Athelas",
  "Baskerville",
  "Big Caslon",
  "Bodoni 72",
  "Charter",
  "Cochin",
  "Didot",
  "Georgia",
  "Hoefler Text",
  "Iowan Old Style",
  "Palatino",
  "Times New Roman",
  "Book Antiqua",
  "Cambria",
  "Constantia",
  "Garamond",
  "Palatino Linotype",
  "Sitka Text",
  "DejaVu Serif",
  "Liberation Serif",
  "Noto Serif",
  "EB Garamond",
  "IBM Plex Serif",
  "Libre Baskerville",
  "Literata",
  "Lora",
  "Merriweather",
  "Playfair Display",
  "PT Serif",
  "Source Serif 4",
  "Source Serif Pro",
  "AppleMyungjo",
  "Batang",
  "NanumMyeongjo",
  "MaruBuri",
  "RIDIBatang",
  "Noto Serif KR",
  "Noto Serif CJK KR",
];

/** As SERIF_FONT_CANDIDATES, for sans-serif families. A listed one falls back to the system's font. */
export const SANS_FONT_CANDIDATES: readonly string[] = [
  "Avenir",
  "Avenir Next",
  "Futura",
  "Gill Sans",
  "Helvetica",
  "Helvetica Neue",
  "Lucida Grande",
  "Optima",
  "Seravek",
  "Aptos",
  "Calibri",
  "Candara",
  "Corbel",
  "Segoe UI",
  "Tahoma",
  "Arial",
  "Trebuchet MS",
  "Verdana",
  "Cantarell",
  "DejaVu Sans",
  "Liberation Sans",
  "Noto Sans",
  "Ubuntu",
  "Fira Sans",
  "IBM Plex Sans",
  "Inter",
  "Lato",
  "Open Sans",
  "Roboto",
  "Source Sans 3",
  "Source Sans Pro",
  "Apple SD Gothic Neo",
  "Malgun Gothic",
  "NanumGothic",
  "NanumSquare",
  "Pretendard",
  "Spoqa Han Sans Neo",
  "SUIT",
  "Noto Sans KR",
  "Noto Sans CJK KR",
];

/** The stored text or heading font that is the system's serif stack (`--font-serif`), not one family. */
export const SERIF = "serif";
/** The stored heading font that is the system's font (`--font-text`), whatever the text font is. */
export const SANS_SERIF = "sans-serif";

/** Longest family name kept, in characters. */
const FONT_NAME_MAX = 80;

const SERIF_KEYS: ReadonlySet<string> = new Set(SERIF_FONT_CANDIDATES.map((f) => f.toLowerCase()));
const SANS_KEYS: ReadonlySet<string> = new Set(SANS_FONT_CANDIDATES.map((f) => f.toLowerCase()));

/**
 * A stored or typed family name, cleaned: one family (the text before a comma), without
 * quotes, backslashes or control characters, single-spaced. Whatever is left is safe
 * inside a quoted CSS string. "" means the default.
 */
export function sanitizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  const name = value
    .split(",")[0]
    .replace(/\s+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/["'\\\u0000-\u001f\u007f]/g, "")
    .trim();
  return Array.from(name).slice(0, FONT_NAME_MAX).join("").trim();
}

/** A stored heading font, cleaned: a generic family (SERIF, SANS_SERIF) in lower case, else as sanitizeFontFamily. */
export function sanitizeHeadingFont(value: unknown): string {
  const name = sanitizeFontFamily(value);
  const generic = name.toLowerCase();
  return generic === SERIF || generic === SANS_SERIF ? generic : name;
}

/** A stored text font, cleaned as a heading font, except that SANS_SERIF, the text's default, is the default. */
export function sanitizeTextFont(value: unknown): string {
  const name = sanitizeHeadingFont(value);
  return name === SANS_SERIF ? "" : name;
}

/** The `--font-mono` value for a code font: the family, then the default stack; null for the default alone. */
export function monoFontValue(codeFont: string): string | null {
  return codeFont === "" ? null : `"${codeFont}", var(--font-mono-default)`;
}

/**
 * The `--font-content` value for a text font; null for the default, the system's font. A
 * family is followed by the system's stack of its kind, so a character it lacks (Hangul in
 * a Latin font) is drawn in a face of the same kind: a serif's in the system's serif.
 */
export function textFontValue(textFont: string): string | null {
  if (textFont === "") return null;
  if (textFont === SERIF) return "var(--font-serif)";
  return `"${textFont}", ${fallbackOf(textFont, "var(--font-text)")}`;
}

/**
 * The `--font-heading` value for a heading font; null for the default, the text font. A
 * family is followed as in textFontValue, and one of unknown kind by the text font.
 */
export function headingFontValue(headingFont: string): string | null {
  if (headingFont === "") return null;
  if (headingFont === SERIF) return "var(--font-serif)";
  if (headingFont === SANS_SERIF) return "var(--font-text)";
  return `"${headingFont}", ${fallbackOf(headingFont, "var(--font-content)")}`;
}

/** The system's stack of a listed family's kind; `unknown` for a family that is not listed. */
function fallbackOf(family: string, unknown: string): string {
  const key = family.toLowerCase();
  if (SERIF_KEYS.has(key)) return "var(--font-serif)";
  if (SANS_KEYS.has(key)) return "var(--font-text)";
  return unknown;
}

/** Large enough that two fonts' metrics never round to the same width. */
const PROBE_SIZE = 72;
const PROBE_TEXT = "mmmmmmmmmmlliWW@#0O";
/** A missing family shows as one of these; a family that measures like both is not installed. */
const GENERIC_FAMILIES = ["monospace", "serif"];

/**
 * A test for "this family is installed" (and, with `mono`, monospaced), or null where text
 * cannot be measured. A family counts as installed when its text measures differently from
 * at least one generic fallback, and as monospaced when "i" and "M" advance alike.
 */
function probe(mono: boolean): ((family: string) => boolean) | null {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  const width = (font: string, text: string): number => {
    ctx.font = `${PROBE_SIZE}px ${font}`;
    return ctx.measureText(text).width;
  };
  const generic = GENERIC_FAMILIES.map((fallback) => width(fallback, PROBE_TEXT));
  return (family) => {
    const name = sanitizeFontFamily(family);
    if (name === "") return false;
    const quoted = `"${name}"`;
    if (!GENERIC_FAMILIES.some((fallback, i) => width(`${quoted}, ${fallback}`, PROBE_TEXT) !== generic[i])) return false;
    if (!mono) return true;
    const font = `${quoted}, monospace`;
    return Math.abs(width(font, "iiiiiiiiii") - width(font, "MMMMMMMMMM")) < 0.5;
  };
}

/** A test for "this family is installed", or null where text cannot be measured. */
export function fontProbe(): ((family: string) => boolean) | null {
  return probe(false);
}

/** A test for "this family is installed and monospaced", or null where text cannot be measured. */
export function monoFontProbe(): ((family: string) => boolean) | null {
  return probe(true);
}

/** The monospaced candidates that are installed here, in their listed order. */
export function installedMonoFonts(): string[] {
  const usable = monoFontProbe();
  return usable ? MONO_FONT_CANDIDATES.filter(usable) : [];
}

/** The serif and sans-serif candidates that are installed here, in alphabetical order. */
export function installedTextFonts(): string[] {
  const installed = fontProbe();
  if (!installed) return [];
  return [...SERIF_FONT_CANDIDATES, ...SANS_FONT_CANDIDATES].filter(installed).sort((a, b) => a.localeCompare(b, "en"));
}
