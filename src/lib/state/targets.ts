/**
 * Where the note named by an unresolved link or a switcher query lives
 * (LINK-05, NAV-01). Pure: the caller supplies the listing lookup.
 */
import type { VaultPath } from "../types";
import { fileKindOf, validateName } from "../utils/names";
import { extname, join, key, nfc, normalizeRel } from "../utils/path";

/**
 * Extensions of local files that are neither notes nor images (LINK-01: documents,
 * media, archives, executables; their opener is P1).
 */
const OTHER_FILE_EXTS = new Set([
  ...["pdf", "txt", "csv", "tsv", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp"],
  ...["hwp", "hwpx", "epub", "heic", "heif", "tif", "tiff", "ico"],
  ...["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "mid", "midi"],
  ...["mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv"],
  ...["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "dmg", "iso"],
  ...["exe", "msi", "bat", "cmd", "ps1", "sh", "command", "app", "lnk", "url", "jar", "apk", "deb", "rpm"],
]);

/**
 * Whether an unresolved link target may open as a new note (LINK-05): not when it
 * names an image or another known kind of file (`[[Q3.pdf]]`, `[x](a.zip)`). An
 * unknown "extension" stays a note title (`Meeting 2024.01`, LINK-03).
 */
export function mayBecomeNote(target: string): boolean {
  const name = target.trim();
  return fileKindOf(name) !== "image" && !OTHER_FILE_EXTS.has(extname(name));
}

export interface TargetOptions {
  /**
   * Folder of the linking note, or null for a typed query (switcher). Links may
   * use "./", "../" and a leading "/"; queries reject them.
   */
  linkDir: VaultPath | null;
  /** Folder that receives a bare name such as "Page". */
  bareDir: VaultPath;
  /** Stored name of the existing child of `dir` with this key() and kind, or null. */
  existing(dir: VaultPath, nameKey: string, kind: "dir" | "file"): string | null;
}

const NOTE_EXT = /\.(md|markdown)$/i;

/**
 * VaultPath of the note `target` names: "Folder/Page" from the vault root, a bare
 * "Page" in `bareDir`. Existing folders (and an existing note) are matched with
 * key() and keep their stored names; new segments are NFC and must pass TREE-07.
 * Returns null for an invalid target or one that leaves the vault.
 */
export function noteTargetPath(target: string, opts: TargetOptions): VaultPath | null {
  const s = target.trim();
  if (s === "") return null;

  let segs: string[];
  if (opts.linkDir !== null) {
    const t = s.replace(/\\/g, "/");
    const relative = t.startsWith("./") || t.startsWith("../");
    const base = t.startsWith("/") ? "" : relative ? opts.linkDir : t.includes("/") ? "" : opts.bareDir;
    const rel = normalizeRel(join(base, t));
    if (rel === null || rel === "") return null;
    segs = rel.split("/");
  } else {
    if (s.startsWith("/")) return null;
    const parts = s.split("/").map((p) => p.trim());
    if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
    segs = parts.length > 1 || opts.bareDir === "" ? parts : [...opts.bareDir.split("/"), ...parts];
  }

  let dir: VaultPath = "";
  for (const raw of segs.slice(0, -1)) {
    const seg = raw.trim();
    const stored = opts.existing(dir, key(seg), "dir");
    if (stored !== null) {
      dir = join(dir, stored);
      continue;
    }
    const name = nfc(seg);
    if (validateName(name, { note: false }) !== null) return null;
    dir = join(dir, name);
  }

  const title = segs[segs.length - 1].trim().replace(NOTE_EXT, "").trim();
  if (title === "") return null;
  const name = `${nfc(title)}.md`;
  const stored = opts.existing(dir, key(name), "file");
  if (stored !== null) return join(dir, stored);
  if (validateName(name, { note: true }) !== null) return null;
  return join(dir, name);
}
