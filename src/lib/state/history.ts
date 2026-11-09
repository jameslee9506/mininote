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

  constructor(readonly limit = 100) {}

  get canBack(): boolean {
    return this.#index > 0;
  }

  get canForward(): boolean {
    return this.#index < this.#items.length - 1;
  }

  /** The entry for what is shown now (after a removal: the nearest earlier survivor). */
  get current(): HistoryEntry | null {
    return this.#items[this.#index] ?? null;
  }

  /** Records a visit: drops the forward entries; revisiting the current path only updates it. */
  push(entry: HistoryEntry): void {
    if (this.current?.path === entry.path) {
      this.#items[this.#index] = entry;
      return;
    }
    this.#items = this.#items.slice(0, this.#index + 1);
    this.#items.push(entry);
    if (this.#items.length > this.limit) this.#items.splice(0, this.#items.length - this.limit);
    this.#index = this.#items.length - 1;
  }

  /** The adjacent entry in direction `dir` (-1 back, 1 forward), or null. */
  neighbor(dir: -1 | 1): HistoryEntry | null {
    return this.#items[this.#index + dir] ?? null;
  }

  /** Makes `entry` (by identity) the current one; false when it is no longer in the history. */
  moveTo(entry: HistoryEntry): boolean {
    const i = this.#items.indexOf(entry);
    if (i < 0) return false;
    this.#index = i;
    return true;
  }

  /**
   * Drops matching entries. The current position moves to the nearest surviving
   * entry at or before it, and neighbors that became identical are merged.
   */
  remove(match: (e: HistoryEntry) => boolean): void {
    const kept: HistoryEntry[] = [];
    let index = -1;
    this.#items.forEach((e, i) => {
      if (match(e)) return;
      if (kept.length === 0 || kept[kept.length - 1].path !== e.path) kept.push(e);
      if (i <= this.#index) index = kept.length - 1;
    });
    this.#items = kept;
    this.#index = index;
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
  }

  /** Paths, oldest first (for tests and debugging). */
  paths(): VaultPath[] {
    return this.#items.map((e) => e.path);
  }
}
