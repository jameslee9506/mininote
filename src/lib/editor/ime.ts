/**
 * Keys the input method already handled (EDIT-11).
 *
 * A keydown with keyCode 229 means the IME consumed the key and applied its own
 * edit before the event was dispatched; nothing else may act on it. CodeMirror
 * only ignores keys between `compositionstart` and `compositionend`, and WKWebView
 * (macOS) fires neither for Hangul: a syllable arrives as `insertText`, then
 * `insertReplacementText` for each jamo. Backspace on a syllable in progress is
 * the IME taking one jamo off (U+D55C "han" becomes U+D558 "ha"), reported as key
 * "Backspace" with keyCode 229. Left to the keymap, that key would delete the
 * rest of the syllable as well.
 *
 * The event is stopped on the editor's root in the capture phase, so no handler
 * inside the editor (keymaps, the find panel) sees it. It is never cancelled:
 * the IME's edit has been made, and `preventDefault` could interfere with dead
 * keys on other engines.
 */
import { ViewPlugin, type EditorView } from "@codemirror/view";

/** `keyCode` of a keydown the input method handled (the DOM's "Process" key). */
const IME_KEY_CODE = 229;

function stopImeKey(event: KeyboardEvent): void {
  if (event.keyCode === IME_KEY_CODE) event.stopPropagation();
}

export const imeKeys = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      view.dom.addEventListener("keydown", stopImeKey, true);
    }
    destroy(): void {
      this.view.dom.removeEventListener("keydown", stopImeKey, true);
    }
  },
);
