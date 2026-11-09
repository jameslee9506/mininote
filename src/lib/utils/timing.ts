/** Timing helpers. */

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
  /** Runs the pending call now (if any). */
  flush(): void;
  pending(): boolean;
}

/** Trailing debounce. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  const run = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    if (args) fn(...args);
  };
  const d = ((...args: A) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, ms);
  }) as Debounced<A>;
  d.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  d.flush = () => {
    if (timer) {
      clearTimeout(timer);
      run();
    }
  };
  d.pending = () => timer !== null;
  return d;
}

export const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
