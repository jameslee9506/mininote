import { describe, expect, it } from "vitest";
import { canBind, chordOf, formatShortcut, isReserved, matchShortcut, normalizeSpec, sameKeySet, sanitizeShortcuts, specOf } from "./keys";

/** A keyboard event as the webview reports it. */
function press(init: Partial<KeyboardEvent>): KeyboardEvent {
  return { key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init } as KeyboardEvent;
}

/** The spec the recorder stores for `e`. */
function recorded(e: KeyboardEvent, mac: boolean): string | null {
  const c = chordOf(e, mac);
  return c && c.key !== "" ? specOf(c) : null;
}

describe("shortcut keys", () => {
  it("normalizes specs and rejects malformed ones", () => {
    expect(normalizeSpec("Shift-Mod-F")).toBe("Mod-Shift-f");
    expect(normalizeSpec("Alt-Mod-ArrowLeft")).toBe("Mod-Alt-ArrowLeft");
    expect(normalizeSpec("Mod--")).toBe("Mod--");
    expect(normalizeSpec("Mod-\\")).toBe("Mod-\\");
    expect(normalizeSpec("F2")).toBe("F2");
    expect(normalizeSpec("Cmd-e")).toBeNull();
    expect(normalizeSpec("Mod-Mod-e")).toBeNull();
    expect(normalizeSpec("Mod-")).toBeNull();
    expect(normalizeSpec("")).toBeNull();
  });

  it("matches what it records, on either platform", () => {
    for (const mac of [true, false]) {
      const mod = mac ? { metaKey: true } : { ctrlKey: true };
      const events = [
        press({ key: "E", code: "KeyE", shiftKey: true, ...mod }),
        // Hangul input: the jamo on the key falls back to the physical key.
        press({ key: "\u3137", code: "KeyE", ...mod }),
        press({ key: "!", code: "Digit1", shiftKey: true, ...mod }),
        press({ key: " ", code: "Space", ...mod }),
        press({ key: "F5", code: "F5" }),
      ];
      for (const e of events) {
        const spec = recorded(e, mac);
        expect(spec).not.toBeNull();
        expect(matchShortcut(e, spec!, mac)).toBe(true);
      }
      expect(recorded(events[0], mac)).toBe("Mod-Shift-e");
      expect(recorded(events[1], mac)).toBe("Mod-e");
      expect(recorded(events[2], mac)).toBe("Mod-Shift-1");
      expect(recorded(events[3], mac)).toBe("Mod-Space");
      expect(matchShortcut(events[0], "Mod-e", mac)).toBe(false);
      // AZERTY types "&" on the 1 key: the heading shortcut still matches.
      expect(matchShortcut(press({ key: "&", code: "Digit1", ...mod }), "Mod-1", mac)).toBe(true);
    }
    // Option+E types a dead key on macOS; the chord still names the physical key.
    expect(recorded(press({ key: "Dead", code: "KeyE", altKey: true, metaKey: true }), true)).toBe("Mod-Alt-e");
    expect(recorded(press({ key: "Shift", code: "ShiftLeft", shiftKey: true, metaKey: true }), true)).toBeNull();
    // The Windows key never takes part in a shortcut.
    expect(chordOf(press({ key: "e", code: "KeyE", metaKey: true }), false)).toBeNull();
  });

  it("accepts only chords that leave typing alone", () => {
    const chord = (spec: string) => {
      const [mods, key] = spec.includes("+") ? spec.split("+") : ["", spec];
      return { key, mod: mods.includes("M"), shift: mods.includes("S"), alt: mods.includes("A"), ctrl: mods.includes("C") };
    };
    for (const mac of [true, false]) {
      expect(canBind(chord("M+e"), mac)).toBe(true);
      expect(canBind(chord("MS+/"), mac)).toBe(true);
      expect(canBind(chord("M+Enter"), mac)).toBe(true);
      expect(canBind(chord("F5"), mac)).toBe(true);
      expect(canBind(chord("e"), mac)).toBe(false);
      expect(canBind(chord("S+e"), mac)).toBe(false);
      expect(canBind(chord("Enter"), mac)).toBe(false);
      expect(canBind(chord("M+Unidentified"), mac)).toBe(false);
    }
    expect(canBind(chord("A+e"), true)).toBe(false);
    expect(canBind(chord("A+e"), false)).toBe(true);
    expect(canBind(chord("C+e"), true)).toBe(true);
    expect(canBind(chord("C+e"), false)).toBe(false);
  });

  it("keeps the system's and the editor's own keys", () => {
    expect(isReserved("Mod-c", true)).toBe(true);
    expect(isReserved("Shift-Mod-Z", false)).toBe(true);
    expect(isReserved("Mod-q", true)).toBe(true);
    expect(isReserved("Mod-q", false)).toBe(false);
    expect(isReserved("Mod-y", false)).toBe(true);
    expect(isReserved("Mod-y", true)).toBe(false);
    expect(isReserved("Mod-e", true)).toBe(false);
  });

  it("sanitizes stored shortcuts", () => {
    const raw = {
      "toggle-view": ["Shift-Mod-P", "Mod-Shift-p", "e", "Mod-c", "Cmd-x", 3],
      "new-note": [],
      "bad id": ["Mod-k"],
      ["__proto__"]: ["Mod-k"],
      save: "Mod-s",
    };
    expect(sanitizeShortcuts(raw, false)).toEqual({ "toggle-view": ["Mod-Shift-p"], "new-note": [] });
    expect(sanitizeShortcuts(null, false)).toEqual({});
    expect(sanitizeShortcuts(["Mod-k"], false)).toEqual({});
  });

  it("compares key lists as sets", () => {
    expect(sameKeySet(["Mod-b", "Mod-\\"], ["Mod-\\", "Mod-b"])).toBe(true);
    expect(sameKeySet(["Shift-Mod-N"], ["Mod-Shift-n"])).toBe(true);
    expect(sameKeySet(["Mod-b"], ["Mod-b", "Mod-\\"])).toBe(false);
    expect(sameKeySet([], [])).toBe(true);
  });

  it("formats shortcuts per platform", () => {
    expect(formatShortcut("Mod-Shift-f", true)).toBe("⌘⇧F");
    expect(formatShortcut("Mod-Shift-f", false)).toBe("Ctrl+Shift+F");
    expect(formatShortcut("Mod-Enter", false)).toBe("Ctrl+↵");
    expect(formatShortcut("Ctrl-Mod-Backspace", true)).toBe("⌃⌘⌫");
    expect(formatShortcut("F2", false)).toBe("F2");
  });
});
