/** Autosave timing (SAVE-01, SAVE-08, SAVE-11) and small promise helpers for the stores. */

/** Notes larger than this many bytes open in source mode and save on a slower schedule (SAVE-11). */
export const LARGE_NOTE_BYTES = 2 * 1024 * 1024;
export const LARGE_DEBOUNCE_MS = 2000;
export const LARGE_MAX_WAIT_MS = 10_000;

/**
 * Delay until the next save: `debounceMs` after the latest edit, but never later
 * than `maxWaitMs` after the first unsaved edit (`firstDirtyAt`).
 */
export function saveDelay(now: number, firstDirtyAt: number, debounceMs: number, maxWaitMs: number): number {
  return Math.max(0, Math.min(debounceMs, firstDirtyAt + maxWaitMs - now));
}

const RETRY_MS = [1000, 2000, 5000];
const RETRY_STEADY_MS = 10_000;

/** Back-off after the `failures`-th consecutive failed save: 1 s, 2 s, 5 s, then every 10 s. */
export function retryDelay(failures: number): number {
  return RETRY_MS[Math.max(0, failures - 1)] ?? RETRY_STEADY_MS;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for `p` for at most `ms`. Resolves true when it settled in time, false on timeout; never rejects. */
export function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  return Promise.race([p.then(() => true, () => true), timeout]).finally(() => clearTimeout(timer));
}
