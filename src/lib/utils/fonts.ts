/**
 * The code font setting (SET-07): one monospaced family for everything shown as code.
 * The pure rules (a typed name cleaned, the CSS value) and the canvas probe that
 * tells which families are installed and monospaced.
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

/** Longest family name kept, in characters. */
const FONT_NAME_MAX = 80;

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

/** The `--font-mono` value for a code font: the family, then the default stack; null for the default alone. */
export function monoFontValue(codeFont: string): string | null {
  return codeFont === "" ? null : `"${codeFont}", var(--font-mono-default)`;
}

/** Large enough that two fonts' metrics never round to the same width. */
const PROBE_SIZE = 72;
const PROBE_TEXT = "mmmmmmmmmmlliWW@#0O";
/** A missing family shows as one of these; a family that measures like both is not installed. */
const GENERIC_FAMILIES = ["monospace", "serif"];

/**
 * A test for "this family is installed and monospaced", or null where text cannot be
 * measured. A family counts as installed when its text measures differently from at
 * least one generic fallback, and as monospaced when "i" and "M" advance alike.
 */
export function monoFontProbe(): ((family: string) => boolean) | null {
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
    const font = `${quoted}, monospace`;
    return Math.abs(width(font, "iiiiiiiiii") - width(font, "MMMMMMMMMM")) < 0.5;
  };
}

/** The candidates that are installed and monospaced here, in their listed order. */
export function installedMonoFonts(): string[] {
  const usable = monoFontProbe();
  return usable ? MONO_FONT_CANDIDATES.filter(usable) : [];
}
