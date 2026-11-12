/** File-name rules shared by the tree, inline title and note creation. */
import type { FileKind } from "../types";
import { extname, key } from "./path";

export const NOTE_EXTS = ["md", "markdown"] as const;
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"] as const;

/**
 * What a file name (or a path: its last segment) names, by its extension: a note,
 * an image, or another file. The tree lists every file; only notes and images open
 * in a view of their own (TREE-15, TREE-16).
 */
export function fileKindOf(name: string): FileKind {
  const e = extname(name);
  if ((NOTE_EXTS as readonly string[]).includes(e)) return "note";
  if ((IMAGE_EXTS as readonly string[]).includes(e)) return "image";
  return "other";
}

/** Display title: notes drop ".md"/".markdown"; everything else keeps its name. */
export function titleOf(name: string, kind: FileKind | null): string {
  if (kind !== "note") return name;
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

/**
 * The full name a file other than a note gets when renamed to `name` (TREE-06): a
 * name typed without an extension keeps the old one, so a rename never drops it by
 * accident; a typed extension is taken as it is.
 */
export function withKeptExtension(name: string, oldName: string): string {
  const dot = oldName.lastIndexOf(".");
  if (dot <= 0 || name.endsWith(".") || extname(name) !== "") return name;
  return name + oldName.slice(dot);
}

export type NameError = "empty" | "invalid" | "reserved" | "too_long" | "hidden";

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
const ILLEGAL_IN_NOTE = /[#^[\]|]/;

const utf8 = new TextEncoder();

/** Most filesystems cap a single name at 255 bytes (Hangul takes 3 bytes per syllable). */
export const MAX_NAME_BYTES = 255;

/**
 * Validates a bare name (no folders), including its extension. `note: true`
 * additionally rejects characters that break [[wikilinks]]. Callers should trim first.
 */
export function validateName(name: string, opts: { note: boolean }): NameError | null {
  if (name.length === 0) return "empty";
  if (utf8.encode(name).length > MAX_NAME_BYTES) return "too_long";
  if (name.startsWith(".")) return "hidden";
  if (ILLEGAL.test(name) || name.endsWith(".") || name.endsWith(" ")) return "invalid";
  if (opts.note && ILLEGAL_IN_NOTE.test(name)) return "invalid";
  if (RESERVED.test(name)) return "reserved";
  return null;
}

/**
 * First free name among "base.ext", "base 1.ext", "base 2.ext", … where
 * `taken(key)` reports whether a sibling with that comparison key exists.
 * `ext` is given without the dot ("" for folders).
 */
export function uniqueName(base: string, ext: string, taken: (nameKey: string) => boolean): string {
  const suffix = ext ? `.${ext}` : "";
  for (let i = 0; ; i++) {
    const name = i === 0 ? `${base}${suffix}` : `${base} ${i}${suffix}`;
    if (!taken(key(name))) return name;
  }
}

/** "Pasted image 20261108093012.png" — Obsidian-compatible attachment naming. */
export function pastedImageName(ext: string, now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `Pasted image ${stamp}.${ext}`;
}
