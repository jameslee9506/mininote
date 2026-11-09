/**
 * Pure helpers for vault-relative paths ("/"-separated, root = "").
 * Paths are never normalized for storage; use `nfc`/`key` only for display and matching.
 */
import type { VaultPath } from "../types";

/** Joins segments with "/", skipping empty ones. */
export function join(...parts: string[]): VaultPath {
  return parts
    .flatMap((p) => p.split("/"))
    .filter((s) => s.length > 0)
    .join("/");
}

/** "a/b/c.md" → "a/b"; "c.md" → "". */
export function dirname(p: VaultPath): VaultPath {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

/** "a/b/c.md" → "c.md". */
export function basename(p: VaultPath): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Lower-case extension without the dot ("" when none; dotfiles have none). */
export function extname(p: VaultPath): string {
  const name = basename(p);
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** File name without its last extension: "note.md" → "note"; ".env" → ".env". */
export function stem(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}

/** True when `p` is strictly inside `ancestor` ("" is the ancestor of every non-root path). */
export function isAncestor(ancestor: VaultPath, p: VaultPath): boolean {
  if (ancestor === "") return p !== "";
  return p.length > ancestor.length && p.startsWith(ancestor) && p[ancestor.length] === "/";
}

export function isSameOrAncestor(ancestor: VaultPath, p: VaultPath): boolean {
  return ancestor === p || isAncestor(ancestor, p);
}

/** If `p` is `from` or inside it, returns the path with the `from` prefix replaced by `to`. */
export function rebase(p: VaultPath, from: VaultPath, to: VaultPath): VaultPath | null {
  if (p === from) return to;
  if (!isAncestor(from, p)) return null;
  return join(to, p.slice(from === "" ? 0 : from.length + 1));
}

/**
 * Normalizes a user/link-supplied relative path: "\" → "/", drops "." segments,
 * resolves "..". Returns null if it would escape the vault root.
 */
export function normalizeRel(p: string): VaultPath | null {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/** Relative path from folder `fromDir` to `target`, e.g. ("a/b", "a/c/x.png") → "../c/x.png". */
export function relativeTo(fromDir: VaultPath, target: VaultPath): string {
  const a = fromDir === "" ? [] : fromDir.split("/");
  const b = target === "" ? [] : target.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

/** Builds an absolute OS path from the vault root, using the root's separator style. */
export function toAbsolute(root: string, rel: VaultPath): string {
  if (rel === "") return root;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const base = root.endsWith(sep) ? root.slice(0, -1) : root;
  return base + sep + (sep === "/" ? rel : rel.split("/").join(sep));
}

/** Unicode NFC (macOS may hand us NFD Hangul). */
export function nfc(s: string): string {
  return s.normalize("NFC");
}

/**
 * Comparison key: NFC + lower-case, no-break spaces folded to spaces. Use it to
 * FIND entries ("same name?", link lookup) — never as an identity for caches or
 * history, which use the exact stored path (A.md and a.md can coexist on ext4).
 */
export function key(s: string): string {
  return s.normalize("NFC").replace(/[  ]/g, " ").toLowerCase();
}

/** Encodes a relative path for a markdown link destination (spaces and parens). */
export function encodeLinkPath(p: string): string {
  return p.replace(/%/g, "%25").replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Decodes a markdown link destination: strips <…>, percent-decodes when valid. */
export function decodeLinkPath(p: string): string {
  let s = p.trim();
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
