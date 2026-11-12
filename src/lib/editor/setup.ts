/**
 * Builds EditorStates for notes and reconfigures the live view (ARCHITECTURE
 * §10.1). Every state gets the same extension stack; per-note options sit in
 * module-level compartments, so a view can swap states and still reconfigure.
 */
import { Compartment, EditorState, Facet, Transaction } from "@codemirror/state";
import type { Extension, Range, StateEffect, Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, drawSelection, dropCursor, keymap } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
  indentSelection,
  toggleBlockComment,
  toggleComment,
  toggleTabFocusMode,
} from "@codemirror/commands";
import { commonmarkLanguage, deleteMarkupBackward, markdown } from "@codemirror/lang-markdown";
import { forceParsing, indentUnit, syntaxHighlighting, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import type { SyntaxNode } from "@lezer/common";
import { GFM } from "@lezer/markdown";
import type { EditorHost } from "./host";
import { External, invalidateResolutions, refreshEffect } from "./shared";
import { markdownExtensions } from "./syntax";
import { editingKeymap, editorShortcuts, listTabKeymap, markupEnterKeymap } from "./commands";
import { completionBindings, wikiCompletion } from "./complete";
import { imeKeys } from "./ime";
import { pasteAndDrop } from "./paste";
import { findKeymap, findPanel } from "./searchPanel";
import { editorTheme, highlightRetags, liveHighlight, sourceHighlight } from "./theme";
import { livePreview } from "./livePreview";

export { External, refreshEffect } from "./shared";

export interface EditorOptions {
  /** Obsidian-style live preview (false = source mode). */
  livePreview: boolean;
  spellcheck: boolean;
  readOnly?: boolean;
}

/** Notes larger than this (UTF-8) always open in source mode (SAVE-11). */
const LARGE_NOTE_BYTES = 2 * 1024 * 1024;
/** Characters parsed past the viewport before painting, so styling never trails the text (LIVE-16). */
const PARSE_AHEAD = 2500;
const PARSE_BUDGET_MS = 100;

// ── Compartments (one set for every state) ───────────────────────────────

const previewMode = new Compartment();
const spellcheckMode = new Compartment();
const readOnlyMode = new Compartment();

/** The host a state was created with, so a reconfigure can rebuild live preview for it. */
const hostFacet = Facet.define<EditorHost, EditorHost | null>({ combine: (values) => values[0] ?? null });

const sourceMode: Extension = syntaxHighlighting(sourceHighlight);
const liveModes = new WeakMap<EditorHost, Extension>();

function liveMode(host: EditorHost): Extension {
  let ext = liveModes.get(host);
  if (!ext) {
    ext = [livePreview(host), syntaxHighlighting(liveHighlight)];
    liveModes.set(host, ext);
  }
  return ext;
}

/** True when the text takes more than `limit` bytes as UTF-8 (each UTF-16 unit is 1–3 bytes). */
function utf8Exceeds(chunks: Iterable<string>, length: number, limit: number): boolean {
  if (length > limit) return true;
  if (length * 3 <= limit) return false;
  let bytes = 0;
  for (const s of chunks) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      bytes += c < 0x80 ? 1 : c < 0x800 || (c >= 0xd800 && c <= 0xdfff) ? 2 : 3;
    }
    if (bytes > limit) return true;
  }
  return false;
}

function wantsLive(opts: EditorOptions, large: boolean): boolean {
  return opts.livePreview && !large;
}

/** Size checks per document: a Text never changes, and options re-apply far more often than it does. */
const largeDocs = new WeakMap<Text, boolean>();

function isLarge(doc: Text): boolean {
  let large = largeDocs.get(doc);
  if (large === undefined) {
    large = utf8Exceeds(doc.iter(), doc.length, LARGE_NOTE_BYTES);
    largeDocs.set(doc, large);
  }
  return large;
}

/** Code is never spellchecked (EDIT-14); live preview may mark code too, which is harmless. */
const noSpellMark = Decoration.mark({ attributes: { spellcheck: "false" } });
const noSpellLine = Decoration.line({ attributes: { spellcheck: "false" } });

function codeSpellcheckRanges(view: EditorView): DecorationSet {
  const out: Range<Decoration>[] = [];
  const lines = new Set<number>();
  const { doc } = view.state;
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "InlineCode") {
          if (node.to > node.from) out.push(noSpellMark.range(node.from, node.to));
          return false;
        }
        if (node.name === "FencedCode" || node.name === "CodeBlock") {
          for (let pos = Math.max(node.from, from); pos <= Math.min(node.to, to); ) {
            const line = doc.lineAt(pos);
            if (!lines.has(line.from)) {
              lines.add(line.from);
              out.push(noSpellLine.range(line.from));
            }
            pos = line.to + 1;
          }
          return false;
        }
      },
    });
  }
  return Decoration.set(out, true);
}

const codeSpellcheckOff = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = codeSpellcheckRanges(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.decorations = codeSpellcheckRanges(u.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

/** EDIT-01: the OS never rewrites text; spellcheck follows the setting (EDIT-14). */
const spellcheckOn: Extension = [
  EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "off", autocapitalize: "off", writingsuggestions: "false" }),
  codeSpellcheckOff,
];
const spellcheckOff: Extension = EditorView.contentAttributes.of({
  spellcheck: "false",
  autocorrect: "off",
  autocapitalize: "off",
  writingsuggestions: "false",
});

/** A non-editable view cannot take focus by itself; tabindex keeps selection, copy and find working. */
const readOnlyOn: Extension = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  EditorView.contentAttributes.of({ tabindex: "0" }),
];
const readOnlyOff: Extension = [];

// ── Static parts ─────────────────────────────────────────────────────────

/**
 * commonmark + GFM, not markdownLanguage: its ~sub~/^sup^/:emoji: can misread Korean range notation (ARCHITECTURE §10.1).
 * URL paste over a selection is paste.ts's stricter handler (EDIT-07: a single URL only).
 */
const markdownSupport = markdown({
  base: commonmarkLanguage,
  extensions: [GFM, ...markdownExtensions, highlightRetags],
  addKeymap: false,
  codeLanguages: [],
  completeHTMLTags: false,
  pasteURLAsLink: false,
});

/**
 * lang-markdown embeds lang-html, whose input handler auto-closes tags typed in
 * an HTML block. The editor inserts only what was typed (EDIT-01, EDIT-06), so
 * ">" and "/" there take the default path first.
 */
const plainHtmlTyping = EditorView.inputHandler.of((view, from, to, text, insert) => {
  if ((text !== ">" && text !== "/") || from !== to || view.composing || view.state.readOnly) return false;
  for (let n: SyntaxNode | null = syntaxTree(view.state).resolveInner(from, -1); n; n = n.parent) {
    if (n.name === "HTMLBlock" || n.name === "HTMLTag") {
      view.dispatch(insert());
      return true;
    }
  }
  return false;
});

/** Only "(" and "[" pair (EDIT-06), so "[[" gives "[[]]". */
const closeBracketsConfig = EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "["] } }]);

/**
 * CodeMirror defaults minus keys this app reuses or forbids (PLAT-10, EDIT-04).
 * indentSelection sits on Mod-Alt-\: on Windows that is Ctrl+Alt, i.e. AltGr, which
 * types "\" on German, French, Nordic and similar layouts.
 */
const REMOVED_DEFAULTS = new Set<unknown>([
  indentLess,
  indentMore,
  indentSelection,
  toggleComment,
  toggleBlockComment,
  toggleTabFocusMode,
]);
const defaultBindings = defaultKeymap.filter((binding) => !REMOVED_DEFAULTS.has(binding.run));

/**
 * Parses past the viewport synchronously after a state swap or scroll (WebKit has no
 * requestIdleCallback). Shared with the code view, whose text must not trail its colors either.
 */
export const parseAhead = ViewPlugin.fromClass(
  class {
    private queued = false;
    private dead = false;
    constructor(readonly view: EditorView) {
      this.schedule();
    }
    update(u: ViewUpdate) {
      if (u.viewportChanged) this.schedule();
    }
    destroy() {
      this.dead = true;
    }
    private schedule() {
      if (this.queued) return;
      this.queued = true;
      // A microtask runs after the current update (or setState) and before the next paint.
      queueMicrotask(() => {
        this.queued = false;
        const { view } = this;
        if (this.dead || view.composing) return;
        const upto = Math.min(view.state.doc.length, view.viewport.to + PARSE_AHEAD);
        if (!syntaxTreeAvailable(view.state, upto)) forceParsing(view, upto, PARSE_BUDGET_MS);
      });
    }
  },
);

/** Views waiting for a refresh until their IME composition ends. */
const refreshAfterComposition = new WeakSet<EditorView>();

const compositionWatcher = EditorView.domEventObservers({
  compositionend(_event, view) {
    if (!refreshAfterComposition.has(view)) return;
    // CodeMirror finishes the composition after this event; a new one may start right away.
    requestAnimationFrame(() => {
      if (!refreshAfterComposition.has(view) || view.composing) return;
      refreshAfterComposition.delete(view);
      view.dispatch({ effects: refreshEffect.of(null) });
    });
  },
});

const staticExtensions: Extension = [
  imeKeys,
  plainHtmlTyping,
  markdownSupport,
  closeBracketsConfig,
  closeBrackets(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorView.lineWrapping,
  indentUnit.of("\t"),
  EditorState.tabSize.of(4),
  EditorState.allowMultipleSelections.of(true),
  // Mod-click follows links; Alt-click adds a cursor (EDIT-12).
  EditorView.clickAddsSelectionRange.of((event) => event.altKey),
  findPanel(),
  parseAhead,
  compositionWatcher,
  editorTheme,
];

const hostExtensions = new WeakMap<EditorHost, Extension>();

/** Keymaps in ARCHITECTURE §10.1 order (earlier = higher precedence), plus the host-bound parts. */
function hostParts(host: EditorHost): Extension {
  let ext = hostExtensions.get(host);
  if (!ext) {
    ext = [
      editorShortcuts(host),
      keymap.of(editingKeymap(host)),
      keymap.of(completionBindings),
      keymap.of(closeBracketsKeymap),
      keymap.of(markupEnterKeymap),
      keymap.of([{ key: "Backspace", run: deleteMarkupBackward }]),
      keymap.of(defaultBindings),
      keymap.of(historyKeymap),
      keymap.of(listTabKeymap),
      keymap.of(findKeymap),
      wikiCompletion(host),
      pasteAndDrop(host),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && u.transactions.some((tr) => tr.docChanged && !tr.annotation(External))) host.onDocChanged(u.state);
      }),
    ];
    hostExtensions.set(host, ext);
  }
  return ext;
}

// ── API ──────────────────────────────────────────────────────────────────

/** A fresh state for `doc` with the full extension stack (see ARCHITECTURE §10). */
export function createEditorState(doc: string, host: EditorHost, opts: EditorOptions): EditorState {
  const large = utf8Exceeds([doc], doc.length, LARGE_NOTE_BYTES);
  const state = EditorState.create({
    doc,
    extensions: [
      hostParts(host),
      hostFacet.of(host),
      previewMode.of(wantsLive(opts, large) ? liveMode(host) : sourceMode),
      spellcheckMode.of(opts.spellcheck ? spellcheckOn : spellcheckOff),
      readOnlyMode.of(opts.readOnly ? readOnlyOn : readOnlyOff),
      staticExtensions,
    ],
  });
  largeDocs.set(state.doc, large);
  return state;
}

/**
 * Applies changed options to a live view via compartments (no state rebuild).
 * Cheap when nothing changed (the size check is cached per document), so it can
 * run after every state swap or settings change. A state built elsewhere (the code
 * view's, `code/state.ts`) has none of these compartments and no options: it is left alone.
 */
export function reconfigureEditor(view: EditorView, opts: EditorOptions): void {
  const { state } = view;
  if (previewMode.get(state) === undefined) return;
  const host = state.facet(hostFacet);
  const effects: StateEffect<unknown>[] = [];
  const preview = host && opts.livePreview && !isLarge(state.doc) ? liveMode(host) : sourceMode;
  if (previewMode.get(state) !== preview) effects.push(previewMode.reconfigure(preview));
  const spell = opts.spellcheck ? spellcheckOn : spellcheckOff;
  if (spellcheckMode.get(state) !== spell) effects.push(spellcheckMode.reconfigure(spell));
  const readOnly = opts.readOnly ? readOnlyOn : readOnlyOff;
  if (readOnlyMode.get(state) !== readOnly) effects.push(readOnlyMode.reconfigure(readOnly));
  if (effects.length > 0) view.dispatch({ effects });
}

/**
 * Dispatches refreshEffect so live-preview decorations recompute; waits for the end of an IME
 * composition. Cached states of other notes re-resolve their links and images on their next update.
 */
export function refreshDecorations(view: EditorView): void {
  invalidateResolutions();
  if (view.composing) {
    refreshAfterComposition.add(view);
    return;
  }
  refreshAfterComposition.delete(view);
  view.dispatch({ effects: refreshEffect.of(null) });
}

const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** The smallest single change turning `a` into `b`: common prefix and suffix kept, surrogate pairs never split. */
function minimalChange(a: string, b: string): { from: number; to: number; insert: string } {
  const max = Math.min(a.length, b.length);
  let start = 0;
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(a.charCodeAt(start - 1))) start--;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  if (endA < a.length && isLowSurrogate(a.charCodeAt(endA))) {
    endA++;
    endB++;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

/**
 * Replaces the document with `text` using one minimal change (common prefix/suffix),
 * annotated External and kept out of undo history — preserves cursor and scroll.
 * The caller waits for the end of an IME composition (`view.composing`) first.
 */
export function replaceDocMinimal(view: EditorView, text: string): void {
  const current = view.state.doc.toString();
  if (current === text) return;
  view.dispatch({
    changes: minimalChange(current, text),
    annotations: [External.of(true), Transaction.addToHistory.of(false)],
  });
}
