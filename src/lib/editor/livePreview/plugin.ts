/**
 * The live-preview ViewPlugin: inline/line decorations over the visible ranges,
 * the pointer hold (TECHNIQUES §1.3), focus tracking, link and checkbox clicks
 * (§1.9) and hanging-indent measurement. Every dispatch happens from a DOM
 * event, a timer or a frame callback, never inside an update.
 */
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, type SelectionRange, type StateEffect, type Text } from "@codemirror/state";
import { ViewPlugin, type DecorationSet, type EditorView, type PluginValue, type ViewUpdate } from "@codemirror/view";
import type { EditorHost } from "../host";
import { refreshEffect } from "../shared";
import { hasMod } from "../../utils/platform";
import { buildDecorations, type HangSource } from "./decorations";
import { hangWidth, measureHangs, syncHangMetrics, type HangRequest } from "./indent";
import { eventElement, followLink, followOnRelease, linkAt, linkUnderPointer } from "./links";
import { focusField, freezeField, mapSelection, rebuild, reportOnce, revealSelection, setFocus, setPointerHold } from "./state";
import { noteLineHeight } from "./widgets";

/** Shared between the plugin and the focusChangeEffect callback (which gets no view). */
export interface ViewRef {
  view: EditorView | null;
}

/** Focus is inside the editor but outside the content, e.g. in the find panel (LIVE-01). */
export function panelFocused(view: EditorView): boolean {
  const active = view.root.activeElement;
  return !!active && active !== view.contentDOM && view.dom.contains(active) && view.dom.ownerDocument.hasFocus();
}

function isCompose(u: ViewUpdate): boolean {
  return u.transactions.some((tr) => tr.isUserEvent("input.type.compose"));
}

function forcesRebuild(u: ViewUpdate): boolean {
  return u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshEffect) || e.is(rebuild)));
}

export function previewPlugin(host: EditorHost, ref: ViewRef) {
  class LivePreview implements PluginValue {
    decorations: DecorationSet;
    /** The reveal selection behind `decorations` (kept as a snapshot while held). */
    private sel: readonly SelectionRange[];
    private held = false;
    private focusTimer = 0;
    private frame = 0;
    private readonly timers = new Set<number>();
    /** The primary button is down (a pointer hold must not end before it is released). */
    private buttonDown = false;
    private destroyed = false;
    private hangRequests: HangRequest[] = [];
    /** The document the pending hang requests were built from. */
    private hangDoc: Text | null = null;
    private readonly hangs: HangSource = {
      get: hangWidth,
      request: (key, from, to) => {
        this.hangRequests.push({ key, from, to });
      },
    };

    constructor(readonly view: EditorView) {
      ref.view = view;
      this.sel = revealSelection(view.state);
      this.decorations = this.build(view.state, this.sel);
      window.addEventListener("mouseup", this.onWindowMouseUp, true);
      window.addEventListener("dragend", this.onWindowMouseUp, true);
      window.addEventListener("blur", this.onWindowBlur);
      view.dom.addEventListener("focusin", this.onFocusMove);
      view.dom.addEventListener("focusout", this.onFocusMove);
      // A new state starts unfocused; the view may already have focus (note switch).
      this.later(() => this.syncFocus());
    }

    update(u: ViewUpdate): void {
      // Font metrics are read only after a measure: a fresh view state (note switch)
      // reports CodeMirror's defaults until then, which would flush the indent cache.
      let metricsChanged = false;
      if (u.geometryChanged) {
        noteLineHeight(u.view.defaultLineHeight);
        metricsChanged = syncHangMetrics(u.view);
      }
      const treeChanged = syntaxTree(u.startState) !== syntaxTree(u.state);
      const composing = u.view.composing || isCompose(u);

      if (composing || u.state.field(freezeField)) {
        // Held: map only. Newly visible lines still get decorations, built from the
        // snapshot so no reveal state changes (never while composing).
        this.sel = mapSelection(this.sel, u.changes);
        this.decorations = this.decorations.map(u.changes);
        if (!composing && (u.viewportChanged || treeChanged || metricsChanged)) {
          this.decorations = this.build(u.state, this.sel);
        }
        this.held = true;
        return;
      }

      const focusChanged = u.startState.field(focusField, false) !== u.state.field(focusField, false);
      if (
        this.held ||
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        focusChanged ||
        treeChanged ||
        metricsChanged ||
        forcesRebuild(u)
      ) {
        this.held = false;
        this.sel = revealSelection(u.state);
        this.decorations = this.build(u.state, this.sel);
      }
    }

    destroy(): void {
      this.destroyed = true;
      for (const id of this.timers) clearTimeout(id);
      clearTimeout(this.focusTimer);
      cancelAnimationFrame(this.frame);
      window.removeEventListener("mouseup", this.onWindowMouseUp, true);
      window.removeEventListener("dragend", this.onWindowMouseUp, true);
      window.removeEventListener("blur", this.onWindowBlur);
      this.view.dom.removeEventListener("focusin", this.onFocusMove);
      this.view.dom.removeEventListener("focusout", this.onFocusMove);
    }

    private build(state: EditorState, sel: readonly SelectionRange[]): DecorationSet {
      this.hangRequests = [];
      this.hangDoc = state.doc;
      const deco = buildDecorations({ state, ranges: this.view.visibleRanges, sel, host, hang: this.hangs });
      if (this.hangRequests.length) this.requestHangMeasure();
      return deco;
    }

    /** Measures new list prefixes in the next read phase (one request per plugin; CodeMirror dedupes by key). */
    private requestHangMeasure(): void {
      this.view.requestMeasure({
        key: this,
        // Positions are only valid for the document they were collected from (a note
        // switch or a mapped composition change makes them stale).
        read: (view) => (this.destroyed || view.state.doc !== this.hangDoc ? 0 : measureHangs(view, this.hangRequests)),
        write: (stored) => {
          if (stored > 0) this.later(() => this.dispatch([rebuild.of(null)]));
        },
      });
    }

    // ── dispatching ──

    /** Runs `fn` after the current task (never inside an update). */
    private later(fn: () => void): void {
      const id = window.setTimeout(() => {
        this.timers.delete(id);
        if (!this.destroyed) fn();
      }, 0);
      this.timers.add(id);
    }

    /** Dispatches effects unless a composition is running; compositionend catches up (EDIT-11). */
    private dispatch(effects: StateEffect<unknown>[]): void {
      if (this.destroyed || effects.length === 0 || this.view.compositionStarted) return;
      this.view.dispatch({ effects });
    }

    private actualFocus(): boolean {
      return this.view.hasFocus || panelFocused(this.view);
    }

    private syncFocus(): void {
      const focused = this.actualFocus();
      if (this.view.state.field(focusField, false) !== focused) this.dispatch([setFocus.of(focused)]);
    }

    private releaseHold(): void {
      if (this.view.state.field(freezeField, false)) this.dispatch([setPointerHold.of(false)]);
    }

    // ── DOM events ──

    /**
     * mouseup, or dragend when a native drag of selected text took over the gesture: the
     * hold ends right away, a task later so CodeMirror's own mouseup handling goes first.
     */
    private readonly onWindowMouseUp = (e: MouseEvent): void => {
      if (e.button !== 0) return;
      this.buttonDown = false;
      if (!this.view.state.field(freezeField, false)) return;
      this.later(() => {
        if (!this.buttonDown) this.releaseHold();
      });
    };

    private readonly onWindowBlur = (): void => {
      this.buttonDown = false;
      this.releaseHold();
    };

    /** Focus moving inside the editor (content ↔ find panel) or out of it. */
    private readonly onFocusMove = (): void => {
      clearTimeout(this.focusTimer);
      this.focusTimer = window.setTimeout(() => this.syncFocus(), 10);
    };

    /** Event observer: runs before every mousedown handler, so before CodeMirror moves the selection. */
    holdPointer(e: MouseEvent): void {
      if (e.button !== 0) return;
      this.buttonDown = true;
      if (this.view.compositionStarted || this.view.state.field(freezeField, false)) return;
      this.view.dispatch({ effects: setPointerHold.of(true) });
    }

    /** One rebuild after composition, from a frame callback (never inside an update). */
    afterComposition(): void {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        if (this.destroyed || this.view.compositionStarted) return;
        const effects: StateEffect<unknown>[] = [rebuild.of(null)];
        if (this.view.state.field(freezeField, false) && !this.buttonDown) effects.push(setPointerHold.of(false));
        const focused = this.actualFocus();
        if (this.view.state.field(focusField, false) !== focused) effects.push(setFocus.of(focused));
        this.view.dispatch({ effects });
      });
    }

    /** Checkbox toggles and link clicks; returning true stops CodeMirror from moving the selection. */
    handleMouseDown(e: MouseEvent, view: EditorView): boolean {
      if (e.button !== 0) return false;
      const el = eventElement(e);
      if (!el) return false;

      const box = el.closest(".cm-task");
      if (box && view.contentDOM.contains(box)) {
        if (!view.state.readOnly) toggleTask(view, box);
        return true;
      }

      // Mod-click follows a link in any state.
      if (hasMod(e)) {
        const found = linkUnderPointer(view, e);
        if (!found) return false;
        followLink(host, found.target);
        return true;
      }

      // Only rendered links carry these classes; a revealed link edits normally.
      const rendered = el.closest(".cm-link, .cm-wikilink");
      if (!rendered || !view.contentDOM.contains(rendered) || e.shiftKey) return false;
      const found = linkAt(view.state, view.posAtDOM(rendered));
      if (!found) return false;
      if (e.altKey) {
        // Alt-click edits the link: one caret inside it, which reveals it (never an extra cursor).
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? found.from;
        view.dispatch({ selection: EditorSelection.cursor(pos), userEvent: "select.pointer" });
        view.focus();
        return true;
      }
      followOnRelease(e, host, found.target);
      return true;
    }
  }

  return ViewPlugin.fromClass(LivePreview, {
    decorations: (plugin) => plugin.decorations,
    eventObservers: {
      mousedown(e) {
        this.holdPointer(e);
      },
      compositionend() {
        this.afterComposition();
      },
    },
    eventHandlers: {
      mousedown(e, view) {
        try {
          return this.handleMouseDown(e, view);
        } catch (err) {
          reportOnce("mousedown", err);
          return false;
        }
      },
    },
  });
}

/** Flips exactly one character (`x` ↔ space) as a normal, undoable edit; the selection stays (LIVE-05). */
function toggleTask(view: EditorView, box: Element): void {
  const pos = view.posAtDOM(box);
  const text = view.state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(text)) return;
  view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: text[1] === " " ? "x" : " " }, userEvent: "input" });
}
