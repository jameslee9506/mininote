/**
 * Pure link-resolution rules shared by the editor (live preview, completion),
 * the reading view and the stores. Obsidian-compatible "best match":
 * exact vault path → path relative to the source note → unique/closest basename.
 * Matching is case-insensitive and Unicode-NFC-insensitive.
 */
import type { VaultPath } from "../types";
import { basename, decodeLinkPath, dirname, join, key, normalizeRel } from "../utils/path";

export interface LinkIndexEntry {
  path: VaultPath;
  isNote: boolean;
  /** key(path) */
  pathKey: string;
  /** key(path without .md/.markdown) for notes; pathKey otherwise. */
  barePathKey: string;
}

export interface LinkIndex {
  entries: readonly LinkIndexEntry[];
  byPath: Map<string, LinkIndexEntry>;
  /** Notes keyed by key(stem) ("Note" for "a/Note.md"); other files by key(full name). */
  byName: Map<string, LinkIndexEntry[]>;
}

const NOTE_EXT = /\.(md|markdown)$/i;

function stripNoteExt(s: string): string {
  return s.replace(NOTE_EXT, "");
}

export function buildLinkIndex(files: readonly { path: VaultPath; isNote: boolean }[]): LinkIndex {
  const entries: LinkIndexEntry[] = [];
  const byPath = new Map<string, LinkIndexEntry>();
  const byName = new Map<string, LinkIndexEntry[]>();
  for (const f of files) {
    const pathKey = key(f.path);
    const e: LinkIndexEntry = {
      path: f.path,
      isNote: f.isNote,
      pathKey,
      barePathKey: f.isNote ? stripNoteExt(pathKey) : pathKey,
    };
    entries.push(e);
    byPath.set(pathKey, e);
    const nameKey = f.isNote ? stripNoteExt(key(basename(f.path))) : key(basename(f.path));
    const list = byName.get(nameKey);
    if (list) list.push(e);
    else byName.set(nameKey, [e]);
  }
  return { entries, byPath, byName };
}

export interface WikiParts {
  /** Target path/name ("" for same-note links such as [[#Heading]]). */
  target: string;
  /** Heading/block part after the first "#", without the "#". */
  subpath: string | null;
  /** Display text after "|". */
  alias: string | null;
}

/** Splits the inside of "[[…]]" into target, #subpath and |alias. */
export function parseWikiInner(inner: string): WikiParts {
  let rest = inner;
  let alias: string | null = null;
  const bar = rest.indexOf("|");
  if (bar >= 0) {
    alias = rest.slice(bar + 1).trim() || null;
    rest = rest.slice(0, bar);
  }
  let subpath: string | null = null;
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    subpath = rest.slice(hash + 1).trim() || null;
    rest = rest.slice(0, hash);
  }
  return { target: rest.trim(), subpath, alias };
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** True for "https://…", "mailto:…", "file:…" etc. (Windows drive letters like "C:\" are not schemes). */
export function isExternalHref(href: string): boolean {
  return SCHEME.test(href) && !/^[a-z]:[\\/]/i.test(href);
}

function cleanTarget(t: string): string {
  let s = t.normalize("NFC").trim().replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  if (s.startsWith("/")) s = s.replace(/^\/+/, "");
  return s;
}

function lookupExact(index: LinkIndex, rel: string): LinkIndexEntry | undefined {
  const k = key(rel);
  return index.byPath.get(k) ?? (NOTE_EXT.test(k) ? undefined : index.byPath.get(`${k}.md`));
}

function pickClosest(cands: LinkIndexEntry[], from: VaultPath | null): LinkIndexEntry {
  const fromDirKey = from === null ? null : key(dirname(from));
  return [...cands].sort((a, b) => {
    if (fromDirKey !== null) {
      const sa = key(dirname(a.path)) === fromDirKey ? 0 : 1;
      const sb = key(dirname(b.path)) === fromDirKey ? 0 : 1;
      if (sa !== sb) return sa - sb;
    }
    const da = a.path.split("/").length;
    const db = b.path.split("/").length;
    if (da !== db) return da - db;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.pathKey < b.pathKey ? -1 : a.pathKey > b.pathKey ? 1 : 0;
  })[0];
}

/**
 * Resolves a wikilink target (already stripped of "#…" and "|…") seen in note `from`.
 * Returns the matching file's VaultPath or null when unresolved.
 */
export function resolveWikiTarget(target: string, from: VaultPath | null, index: LinkIndex): VaultPath | null {
  const t = cleanTarget(target);
  if (t === "") return null;

  const exact = lookupExact(index, t);
  if (exact) return exact.path;

  if (from !== null) {
    const rel = normalizeRel(join(dirname(from), t));
    if (rel) {
      const hit = lookupExact(index, rel);
      if (hit) return hit.path;
    }
  }

  const tKey = key(t);
  const last = basename(tKey);
  const cands = [...(index.byName.get(stripNoteExt(last)) ?? []), ...(index.byName.get(last) ?? [])];
  if (cands.length === 0) return null;
  const unique = [...new Set(cands)];
  const wantNote = NOTE_EXT.test(last) || !last.includes(".");
  const bareT = stripNoteExt(tKey);
  const filtered = unique.filter((e) => {
    if (wantNote && !e.isNote && !NOTE_EXT.test(last)) {
      // "[[photo]]" must not resolve to "photo.png"; only exact full names match non-notes.
      if (key(basename(e.path)) !== last) return false;
    }
    if (!t.includes("/")) return true;
    return e.barePathKey === bareT || e.barePathKey.endsWith(`/${bareT}`) || e.pathKey.endsWith(`/${tKey}`);
  });
  if (filtered.length === 0) return null;
  return pickClosest(filtered, from).path;
}

/**
 * Resolves a markdown link/image destination seen in note `from`.
 * Returns null for external URLs or when nothing matches.
 */
export function resolveMarkdownHref(href: string, from: VaultPath | null, index: LinkIndex): VaultPath | null {
  if (isExternalHref(href)) return null;
  let s = href.trim();
  const hash = s.indexOf("#");
  if (hash >= 0) s = s.slice(0, hash);
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  const decoded = decodeLinkPath(s);
  if (decoded === "") return null;
  const rel = decoded.startsWith("/")
    ? normalizeRel(decoded.slice(1))
    : normalizeRel(join(from === null ? "" : dirname(from), decoded));
  if (rel) {
    const hit = lookupExact(index, rel);
    if (hit) return hit.path;
  }
  return resolveWikiTarget(decoded, from, index);
}

/** Shortest unambiguous wikilink text for `target`: "Note", or "folder/Note" when the name is shared. */
export function wikiLinkText(target: VaultPath, index: LinkIndex): string {
  const entry = index.byPath.get(key(target));
  const isNote = entry ? entry.isNote : NOTE_EXT.test(target);
  const name = basename(target).normalize("NFC");
  const stem = isNote ? stripNoteExt(name) : name;
  const same = index.byName.get(key(stem)) ?? [];
  if (same.length <= 1) return stem;
  return isNote ? stripNoteExt(target.normalize("NFC")) : target.normalize("NFC");
}
