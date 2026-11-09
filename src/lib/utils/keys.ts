/**
 * Shortcut specs look like CodeMirror's: "Mod-Shift-f", "Mod-Alt-ArrowLeft", "F2", "Mod-\\".
 * Letters are matched by physical key when the produced character is not ASCII, so
 * shortcuts keep working while a Korean input source is active. The digit row always
 * names its digit, as CodeMirror's keymaps do: AZERTY's Ctrl+& is Mod-1, and Shift+1
 * is Shift-1, not "!".
 *
 * The canonical spelling (what settings store and compare, SET-06) orders the
 * modifiers Ctrl, Mod, Alt, Shift. `Mod` is ⌘ on macOS and Ctrl elsewhere;
 * `Ctrl` is macOS's Control key next to ⌘ and never matches elsewhere.
 */
import { isMac } from "./platform";

/** Normalized base key of a keyboard event ("a"…"z", "0"…"9", ",", "\\", "Space", "ArrowLeft", "Enter", "F2", …). */
export function eventKeyName(e: KeyboardEvent): string {
  const k = e.key;
  if (e.code === "Space" || k === " ") return "Space";
  if (e.code.startsWith("Digit")) return e.code.slice(5);
  if (k.length === 1 && k.charCodeAt(0) < 128 && !e.altKey) return k.toLowerCase();
  if (e.code.startsWith("Key")) return e.code.slice(3).toLowerCase();
  const codeMap: Record<string, string> = {
    Backslash: "\\",
    Comma: ",",
    Period: ".",
    Slash: "/",
    BracketLeft: "[",
    BracketRight: "]",
    Minus: "-",
    Equal: "=",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
  };
  if (codeMap[e.code]) return codeMap[e.code];
  return k;
}

/** A key with its modifiers, in spec terms. */
export interface Chord {
  /** Base key as eventKeyName reports it; "" while only modifiers are down. */
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** macOS's Control key next to ⌘ (Mod). */
  ctrl: boolean;
}

const MODIFIERS = new Set(["Ctrl", "Mod", "Alt", "Shift"]);

/** Splits a spec; null when it has no key, or a part before the key is not a modifier or repeats one. */
function parse(spec: string): Chord | null {
  // "Mod-\\" → the key itself may be "-" or "\\"; split on "-" except a trailing one.
  const parts = spec.endsWith("--") ? [...spec.slice(0, -2).split("-"), "-"] : spec.split("-");
  const key = parts.pop() ?? "";
  const mods = new Set(parts);
  if (key === "" || mods.size !== parts.length || parts.some((p) => !MODIFIERS.has(p))) return null;
  return {
    key: key.length === 1 ? key.toLowerCase() : key,
    mod: mods.has("Mod"),
    shift: mods.has("Shift"),
    alt: mods.has("Alt"),
    ctrl: mods.has("Ctrl"),
  };
}

/** The canonical spec of a chord with a key. */
export function specOf(c: Chord): string {
  return [c.ctrl && "Ctrl", c.mod && "Mod", c.alt && "Alt", c.shift && "Shift", c.key].filter(Boolean).join("-");
}

/** The canonical spelling of `spec` ("Shift-Mod-F" → "Mod-Shift-f"), or null when it is malformed. */
export function normalizeSpec(spec: string): string | null {
  const c = parse(spec);
  return c ? specOf(c) : null;
}

/** e.key of the modifier keys themselves: pressing one alone only builds up a chord. */
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper", "Fn", "FnLock", "CapsLock"]);

/**
 * The chord a keydown or keyup reports (key "" for a modifier key). Null while the
 * Windows/Super key is down, which never takes part in a shortcut (see matchShortcut).
 */
export function chordOf(e: KeyboardEvent, mac = isMac): Chord | null {
  if (!mac && e.metaKey) return null;
  return {
    key: MODIFIER_KEYS.has(e.key) ? "" : eventKeyName(e),
    mod: mac ? e.metaKey : e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    ctrl: mac && e.ctrlKey,
  };
}

export function matchShortcut(e: KeyboardEvent, spec: string, mac = isMac): boolean {
  const s = parse(spec);
  if (!s) return false;
  const mod = mac ? e.metaKey : e.ctrlKey;
  const ctrlExtra = mac ? e.ctrlKey : false;
  if (s.mod !== mod || s.shift !== e.shiftKey || s.alt !== e.altKey) return false;
  if (s.ctrl !== ctrlExtra) return false;
  if (!mac && e.metaKey) return false;
  return eventKeyName(e) === s.key;
}

const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;
const NAMED_KEYS = new Set([
  "Space",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

/**
 * True when `c` may become a shortcut (SET-06): a function key, or a printable or
 * editing key held with Mod, with Control on macOS, or with Alt elsewhere. Shift or
 * Option alone would take a typed character away (PLAT-10), and a bare key typing,
 * editing or moving the caret.
 */
export function canBind(c: Chord, mac = isMac): boolean {
  if (c.ctrl && !mac) return false;
  if (FUNCTION_KEY.test(c.key)) return true;
  if (!/^\S$/u.test(c.key) && !NAMED_KEYS.has(c.key)) return false;
  return c.mod || (mac ? c.ctrl : c.alt);
}

/**
 * Keys nothing may take over: clipboard, undo and select-all (the webview and the
 * editor need them), find and its next/previous keys (fixed, EDIT-09), and keys
 * the system or the macOS app menu handles before the app could.
 */
const RESERVED = ["Mod-a", "Mod-c", "Mod-v", "Mod-x", "Mod-z", "Mod-Shift-z", "Mod-f", "Mod-g", "Mod-Shift-g", "F3", "Shift-F3"];
/** Menu items (Quit, Hide, Hide Others, Minimize, Full Screen), replace, and window cycling (PLAT-10). */
const RESERVED_MAC = ["Mod-q", "Mod-h", "Mod-Alt-h", "Mod-m", "Ctrl-Mod-f", "Mod-Alt-f", "Mod-`"];
/** Redo, replace, and closing the window. */
const RESERVED_OTHER = ["Mod-y", "Mod-h", "Alt-F4"];

export function isReserved(spec: string, mac = isMac): boolean {
  const s = normalizeSpec(spec);
  return s !== null && (RESERVED.includes(s) || (mac ? RESERVED_MAC : RESERVED_OTHER).includes(s));
}

/** More keys per command are dropped, so a hand-edited file cannot grow the key scan without bound. */
const MAX_KEYS = 8;

/**
 * Coerces stored user shortcuts (SET-01): command id → distinct canonical specs.
 * Malformed specs, keys canBind rejects and reserved keys are dropped; [] (unbound) stays.
 */
export function sanitizeShortcuts(raw: unknown, mac = isMac): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [id, keys] of Object.entries(raw)) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || !Array.isArray(keys)) continue;
    const specs = new Set<string>();
    for (const k of keys) {
      const c = typeof k === "string" ? parse(k) : null;
      if (c && canBind(c, mac) && !isReserved(specOf(c), mac)) specs.add(specOf(c));
    }
    out[id] = [...specs].slice(0, MAX_KEYS);
  }
  return out;
}

/** True when both lists hold the same shortcuts, whatever their order or spelling. */
export function sameKeySet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a.map(normalizeSpec));
  const sb = new Set(b.map(normalizeSpec));
  return sa.size === sb.size && [...sa].every((k) => sb.has(k));
}

const MAC_SYMBOLS: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃" };
const KEY_LABELS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↵",
  Escape: "Esc",
};
const MAC_KEY_LABELS: Record<string, string> = { Backspace: "⌫", Delete: "⌦", Tab: "⇥" };

/** Human-readable chord: "⌘⇧F" on macOS, "Ctrl+Shift+F" elsewhere; only the modifiers while `key` is "". */
export function formatChord(c: Chord, mac = isMac): string {
  const keyLabel = (mac ? MAC_KEY_LABELS[c.key] : undefined) ?? KEY_LABELS[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  const mods: string[] = [];
  if (c.ctrl) mods.push("Ctrl");
  if (c.mod) mods.push("Mod");
  if (c.alt) mods.push("Alt");
  if (c.shift) mods.push("Shift");
  if (mac) return mods.map((m) => MAC_SYMBOLS[m]).join("") + keyLabel;
  return [...mods.map((m) => (m === "Mod" ? "Ctrl" : m)), keyLabel].filter(Boolean).join("+");
}

/** Human-readable shortcut: "⌘⇧F" on macOS, "Ctrl+Shift+F" elsewhere. */
export function formatShortcut(spec: string, mac = isMac): string {
  const c = parse(spec);
  return c ? formatChord(c, mac) : spec;
}
