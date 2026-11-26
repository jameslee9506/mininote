/**
 * The notes changed last (NAV-10), pure. A note's time is the listing's, which is only as new
 * as the listing: a content change never re-lists (§8.2). So the times of this window's own
 * saves are kept beside it until a listing reports them.
 */
import type { TreeNode, VaultPath } from "../types";
import { compareNodes } from "./tree";

/** The modification time each save of this window left, in whole ms since the Unix epoch, by path. */
export type SavedTimes = ReadonlyMap<VaultPath, number>;

export interface RecentNote {
  node: TreeNode;
  /** When the note was changed last, in whole ms since the Unix epoch. */
  mtime: number;
}

/** `times` with a save of `path` that left the modification time `mtime` (a write result's, in ms). */
export function withSave(times: SavedTimes, path: VaultPath, mtime: number): SavedTimes {
  const whole = Math.trunc(mtime);
  if ((times.get(path) ?? 0) >= whole) return times;
  return new Map(times).set(path, whole);
}

/**
 * `times` without what a new listing made needless: a path it does not have (renamed, moved,
 * deleted), and a save whose time it reports, or a later one. The same map when nothing goes.
 */
export function unlisted(times: SavedTimes, nodes: ReadonlyMap<VaultPath, TreeNode>): SavedTimes {
  let kept: Map<VaultPath, number> | null = null;
  for (const [path, mtime] of times) {
    const node = nodes.get(path);
    if (node !== undefined && node.mtime < mtime) continue;
    kept ??= new Map(times);
    kept.delete(path);
  }
  return kept ?? times;
}

/**
 * The `limit` notes changed last, the newest first; notes of one time in the tree's order.
 * A note whose time is unknown (0) is left out.
 */
export function recentNotes(notes: readonly TreeNode[], times: SavedTimes, limit: number): RecentNote[] {
  const dated: RecentNote[] = [];
  for (const node of notes) {
    const mtime = Math.max(node.mtime, times.get(node.path) ?? 0);
    if (mtime > 0) dated.push({ node, mtime });
  }
  dated.sort((a, b) => b.mtime - a.mtime || compareNodes(a.node, b.node));
  return dated.slice(0, limit);
}

/** Midnight of the day `now` is in, local time, in ms since the Unix epoch. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** How a time shows in the list: as a time of day on the current day, else as a date, with its year when that is another one. */
export type TimeStyle = "time" | "day" | "date";

/** The style for `mtime`, with `today` the midnight that began the current day. */
export function timeStyle(mtime: number, today: number): TimeStyle {
  if (startOfDay(mtime) === today) return "time";
  return new Date(mtime).getFullYear() === new Date(today).getFullYear() ? "day" : "date";
}
