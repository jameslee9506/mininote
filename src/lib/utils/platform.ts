/** Platform detection and input helpers. */
import type { MessageKey } from "../i18n";

const ua = typeof navigator !== "undefined" ? `${navigator.platform} ${navigator.userAgent}` : "";

export const isMac = /Mac|iPhone|iPad/.test(ua);
export const isWindows = /Win/.test(ua);
export const isLinux = !isMac && !isWindows;

/** ⌘ on macOS, Ctrl elsewhere. */
export function hasMod(e: KeyboardEvent | MouseEvent): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/**
 * True while an IME (e.g. Hangul) composition is in progress. Every custom
 * key handler must bail out on this before acting on Enter/Escape/Tab/arrows.
 */
export function isComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

export function revealLabelKey(): MessageKey {
  return isMac ? "revealMac" : isWindows ? "revealWin" : "revealLinux";
}
