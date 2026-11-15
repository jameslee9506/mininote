/**
 * Which settings keys (or session roots) a window may take over from another window's change
 * (ARCHITECTURE §7). Every window writes only what it changed, as a patch, and the backend sends
 * each applied patch to every window in the order it applied them, the writer included.
 *
 * A key this window changed keeps its local value until its own write comes back: a change of
 * another window that arrives before that echo was applied before this window's write, which
 * overrides it on disk, so taking it over would leave this window out of step with the file.
 */
export class SyncLedger {
  /** Changed here, not written yet. */
  #unsent = new Set<string>();
  /** Written, the echo still to come: id → writes in flight. */
  #inFlight = new Map<string, number>();

  /** A local change of `id`. */
  touch(id: string): void {
    this.#unsent.add(id);
  }

  /** Starts a write: the ids it carries, now in flight. */
  send(): string[] {
    const ids = [...this.#unsent];
    this.#unsent.clear();
    for (const id of ids) this.#inFlight.set(id, (this.#inFlight.get(id) ?? 0) + 1);
    return ids;
  }

  /** One of this window's writes came back applied. */
  landed(ids: Iterable<string>): void {
    for (const id of ids) {
      const n = (this.#inFlight.get(id) ?? 0) - 1;
      if (n > 0) this.#inFlight.set(id, n);
      else this.#inFlight.delete(id);
    }
  }

  /** A write failed: its ids are unsent again, written with the next one. */
  failed(ids: readonly string[]): void {
    this.landed(ids);
    for (const id of ids) this.#unsent.add(id);
  }

  /** Whether another window's change of `id` may replace the local value. */
  adopts(id: string): boolean {
    return !this.#unsent.has(id) && !this.#inFlight.has(id);
  }
}
