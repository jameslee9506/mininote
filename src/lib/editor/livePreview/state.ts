/**
 * State shared by the two decoration sources (ARCHITECTURE §10.2): editor
 * focus, the pointer hold and the frontmatter range. Effects are dispatched
 * from DOM handlers in plugin.ts, never from inside an update.
 */
import { StateEffect, StateField, type ChangeDesc, type EditorState, type SelectionRange } from "@codemirror/state";
import { frontmatterRange, type FrontmatterRange } from "./frontmatter";

/** The editor content or its find panel has focus. */
export const setFocus = StateEffect.define<boolean>();
/** Primary button held over the content; released on mouseup. */
export const setPointerHold = StateEffect.define<boolean>();
/** Internal no-op that makes both decoration sources rebuild (compositionend, measured indents). */
export const rebuild = StateEffect.define<null>();

/** Focus as last reported by EditorView.focusChangeEffect or the panel focus check. */
export const focusField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocus)) value = e.value;
    return value;
  },
});

/**
 * The pointer hold (TECHNIQUES §1.3): while the primary button is down over the
 * content, decorations are mapped instead of rebuilt, so a drag never selects text
 * that moves under the pointer. It ends on mouseup, on any document change and on
 * focus loss. Keyboard moves never hold: a caret that lands on a construct reveals
 * it at once (LIVE-01).
 */
export const freezeField = StateField.define<boolean>({
  create: () => false,
  update(held, tr) {
    for (const e of tr.effects) {
      if (e.is(setPointerHold)) held = e.value;
      else if (e.is(setFocus) && !e.value) held = false;
    }
    if (tr.docChanged) held = false;
    // A keyboard move ends a hold too (one can outlive a cancelled native drag).
    else if (held && tr.selection && tr.isUserEvent("select") && !tr.isUserEvent("select.pointer")) held = false;
    return held;
  },
});

/** Frontmatter range, recomputed only when a change can affect it. */
export const fmField = StateField.define<FrontmatterRange | null>({
  create: (state) => frontmatterRange(state.doc),
  update(value, tr) {
    if (!tr.docChanged) return value;
    if (value && !tr.changes.touchesRange(0, value.to)) return value;
    return frontmatterRange(tr.newDoc);
  },
});

const NONE: readonly SelectionRange[] = [];

/** Ranges that reveal syntax: the selection while focused, nothing otherwise (LIVE-01). */
export function revealSelection(state: EditorState): readonly SelectionRange[] {
  return state.field(focusField, false) ? state.selection.ranges : NONE;
}

/** Maps a reveal snapshot through document changes (an empty snapshot stays identical). */
export function mapSelection(sel: readonly SelectionRange[], changes: ChangeDesc): readonly SelectionRange[] {
  return sel.length === 0 || changes.empty ? sel : sel.map((r) => r.map(changes));
}

const reported = new Set<string>();

/** Logs a builder failure once per construct, so a broken note stays editable as plain text. */
export function reportOnce(what: string, err: unknown): void {
  if (reported.has(what)) return;
  reported.add(what);
  console.error(`[livePreview] ${what} failed`, err);
}
