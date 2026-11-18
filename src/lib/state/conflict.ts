/** Conflict-copy naming (SAVE-06): "<stem> (conflict YYYYMMDD-HHmmss).<ext>" in at most 255 UTF-8 bytes. */
import { MAX_NAME_BYTES, truncateBytes } from "../utils/names";

const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s).length;

/** Local time as "YYYYMMDD-HHmmss" (the suffix is never localized). */
export function conflictStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` + `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Name of a conflict copy of the file `name` (extension included, kept as is).
 * `n > 0` appends " n" for collisions. The stem is written in NFC and shortened
 * so the whole name fits the 255-byte limit (TREE-07).
 */
export function conflictCopyName(name: string, now: Date, n = 0): string {
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).normalize("NFC");
  const ext = dot > 0 ? name.slice(dot) : "";
  const suffix = ` (conflict ${conflictStamp(now)})${n > 0 ? ` ${n}` : ""}${ext}`;
  return truncateBytes(stem, Math.max(0, MAX_NAME_BYTES - bytes(suffix))) + suffix;
}
