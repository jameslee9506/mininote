/** Back/forward navigation history (NAV-03), keyed by exact VaultPath. */
import type { VaultPath } from "../types";
import { rebase } from "../utils/path";

export interface HistoryEntry {
  path: VaultPath;
  /** The note had no file when visited (LINK-05): revisiting reopens it as virtual while still missing. */
  virtual: boolean;
}

export class NavHistory {
  #items: HistoryEntry[] = [];
  #index = -1;
  /**
   * The entry that was shown is gone, and nothing is shown in its place (TREE-08): the position
   * is the gap it left, after `#index` (its nearest earlier survivor) and before the entries
   * that came after it. Going back opens that survivor.
   */
  #gap = false;

  constructor(readonly limit = 100) {}

  get canBack(): boolean {
    return this.#gap ? this.#index >= 0 : this.#index > 0;
  }

  get canForward(): boolean {
    return this.#index < this.#items.length - 1;
  }

  /** The entry for what is shown now; null when its file was removed. */
  get current(): HistoryEntry | null {
    return this.#gap ? null : (this.#items[this.#index] ?? null);
  }

  /** Records a visit: drops the forward entries; revisiting the current path only updates it. */
  push(entry: HistoryEntry): void {
    // In a gap, the entry before it is revisited the same way: it is not recorded twice in a row.
    if (this.#items[this.#index]?.path === entry.path) {
      this.#items[this.#index] = entry;
      this.#gap = false;
      return;
    }
    this.#items = this.#items.slice(0, this.#index + 1);
    this.#items.push(entry);
    if (this.#items.length > this.limit) this.#items.splice(0, this.#items.length - this.limit);
    this.#index = this.#items.length - 1;
    this.#gap = false;
  }

  /** The adjacent entry in direction `dir` (-1 back, 1 forward), or null. */
  neighbor(dir: -1 | 1): HistoryEntry | null {
    return this.#items[this.#index + (this.#gap && dir === -1 ? 0 : dir)] ?? null;
  }

  /** Makes `entry` (by identity) the current one; false when it is no longer in the history. */
  moveTo(entry: HistoryEntry): boolean {
    const i = this.#items.indexOf(entry);
    if (i < 0) return false;
    this.#index = i;
    this.#gap = false;
    return true;
  }

  /**
   * Drops matching entries, and merges neighbors that became identical. When the current
   * entry is one of them, no other takes its place: the position is the gap it leaves,
   * with the nearest surviving entries before and after it as its neighbors.
   */
  remove(match: (e: HistoryEntry) => boolean): void {
    const kept: HistoryEntry[] = [];
    let index = -1;
    let gap = this.#gap;
    this.#items.forEach((e, i) => {
      if (match(e)) {
        if (i === this.#index) gap = true;
        return;
      }
      if (kept.length === 0 || kept[kept.length - 1].path !== e.path) kept.push(e);
      if (i <= this.#index) index = kept.length - 1;
    });
    this.#items = kept;
    this.#index = index;
    this.#gap = gap;
  }

  /** Re-points entries after a rename or move of `from` (a file or a folder prefix). Entries keep their identity. */
  remap(from: VaultPath, to: VaultPath): void {
    for (const e of this.#items) {
      const p = rebase(e.path, from, to);
      if (p !== null) e.path = p;
    }
    this.remove(() => false);
  }

  /** The note at `path` now has a file. */
  markReal(path: VaultPath): void {
    for (const e of this.#items) if (e.path === path) e.virtual = false;
  }

  clear(): void {
    this.#items = [];
    this.#index = -1;
    this.#gap = false;
  }

  /** Paths, oldest first (for tests and debugging). */
  paths(): VaultPath[] {
    return this.#items.map((e) => e.path);
  }
}
