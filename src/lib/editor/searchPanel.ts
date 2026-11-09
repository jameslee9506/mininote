/**
 * The minimal find/replace panel (EDIT-09), replacing CodeMirror's default
 * panel and its text labels: one unlabeled input with icon buttons, pinned at
 * the top right, and a replace row that toggles.
 *
 * Keys: Enter / Shift-Enter next / previous (Mod-G, F3 too); Escape closes and
 * keeps the match selected; Mod-F focuses the find input and selects its text
 * (from the text, a short selection re-seeds it first); Mod-H (Mod-Alt-F on
 * macOS) opens replace; the chevron button toggles the replace row.
 * In the replace input, Enter replaces and moves on, Mod-Enter replaces all.
 * Every handler ignores IME composition. No matches: the input text turns faint.
 */
import type { Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import type { KeyBinding, Panel, ViewUpdate } from "@codemirror/view";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  selectNextOccurrence,
  selectSelectionMatches,
  setSearchQuery,
} from "@codemirror/search";
import { t } from "../i18n";
import { hasMod, isComposing } from "../utils/platform";
import { FIND_PANEL_OFFSET } from "./theme";

/** Debounce for re-checking "any match?" after edits, so typing in a big note stays cheap. */
const MATCH_CHECK_MS = 150;
/** Selections longer than this do not seed the query (CodeMirror's own limit). */
const SEED_MAX = 100;

const SVG_NS = "http://www.w3.org/2000/svg";
/** 16×16 stroke paths in the style of Icon.svelte. */
const ICONS = {
  toggle: ["M6.5 4.5 10 8l-3.5 3.5"],
  previous: ["M8 13V3", "M4 7l4-4 4 4"],
  next: ["M8 3v10", "M4 9l4 4 4-4"],
  close: ["m4.5 4.5 7 7M11.5 4.5l-7 7"],
  replaceAll: ["M11.75 4.5 4.75 11.5 1.5 8.25", "m14.5 7-4.75 4.75-1-1"],
} as const;

function icon(paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  const attrs: Record<string, string> = {
    width: "16",
    height: "16",
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
  };
  for (const [name, value] of Object.entries(attrs)) svg.setAttribute(name, value);
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** A label-less icon button that never takes focus, so typing focus stays in the input. */
function iconButton(label: string, paths: readonly string[], onClick: () => void, extraClass = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-btn cm-mn-find-btn ${extraClass}`.trim();
  button.tabIndex = -1;
  button.setAttribute("aria-label", label);
  button.appendChild(icon(paths));
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", onClick);
  return button;
}

function textInput(label: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "cm-mn-find-input";
  input.setAttribute("aria-label", label);
  input.spellcheck = false;
  input.autocomplete = "off";
  for (const [name, value] of [
    ["autocorrect", "off"],
    ["autocapitalize", "off"],
    ["writingsuggestions", "false"],
  ])
    input.setAttribute(name, value);
  return input;
}

function spacer(): HTMLElement {
  const el = document.createElement("span");
  el.className = "cm-mn-find-spacer";
  el.setAttribute("aria-hidden", "true");
  return el;
}

/** The open panel of each view (one at most). */
const panels = new WeakMap<EditorView, FindPanel>();
/** Views whose next panel opens with the replace row (set just before openSearchPanel). */
const openWithReplace = new WeakSet<EditorView>();

class FindPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private readonly findInput: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly replaceRow: HTMLElement;
  private readonly toggleButton: HTMLButtonElement;
  /** The query the inputs show (kept in sync with the editor's search state). */
  private query: SearchQuery;
  private replaceShown: boolean;
  private matchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.replaceShown = openWithReplace.has(view) && !view.state.readOnly;
    openWithReplace.delete(view);

    this.findInput = textInput(t("ariaFind"));
    this.findInput.value = this.query.search;
    this.replaceInput = textInput(t("ariaReplace"));
    this.replaceInput.value = this.query.replace;
    for (const input of [this.findInput, this.replaceInput]) input.addEventListener("input", this.commit);

    this.toggleButton = iconButton(t("ariaReplace"), ICONS.toggle, () => this.toggleReplace(), "cm-mn-find-toggle");
    const findRow = document.createElement("div");
    findRow.className = "cm-mn-find-row";
    findRow.append(
      this.toggleButton,
      this.findInput,
      iconButton(t("ariaPrevious"), ICONS.previous, () => findPrevious(view)),
      iconButton(t("ariaNext"), ICONS.next, () => findNext(view)),
      iconButton(t("ariaClose"), ICONS.close, () => closeSearchPanel(view)),
    );

    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "cm-mn-find-row";
    this.replaceRow.append(
      spacer(),
      this.replaceInput,
      iconButton(t("ariaReplaceAll"), ICONS.replaceAll, () => replaceAll(view)),
      spacer(),
      spacer(),
    );

    this.dom = document.createElement("div");
    this.dom.className = "cm-mn-find";
    this.dom.setAttribute("role", "search");
    this.dom.append(findRow, this.replaceRow);
    this.dom.addEventListener("keydown", this.onKeyDown);

    panels.set(view, this);
    this.syncReplaceRow();
    this.checkMatches();
  }

  mount(): void {
    if (this.replaceShown && this.findInput.value !== "") this.focusInput(this.replaceInput);
    else this.focusInput(this.findInput);
  }

  update(u: ViewUpdate): void {
    let queryChanged = false;
    for (const tr of u.transactions) {
      for (const e of tr.effects) {
        if (e.is(setSearchQuery) && !e.value.eq(this.query)) {
          this.showQuery(e.value);
          queryChanged = true;
        }
      }
    }
    if (u.state.readOnly !== u.startState.readOnly) this.syncReplaceRow();
    if (queryChanged) this.checkMatches();
    else if (u.docChanged) this.scheduleMatchCheck();
  }

  destroy(): void {
    if (this.matchTimer !== null) clearTimeout(this.matchTimer);
    if (panels.get(this.view) === this) panels.delete(this.view);
  }

  hasFocus(): boolean {
    return this.dom.contains(this.view.root.activeElement);
  }

  /** Mod-F from the text: re-seed from a short selection, then focus and select the input. */
  refocus(): void {
    const { state } = this.view;
    const sel = state.selection.main;
    if (!sel.empty && sel.to - sel.from <= SEED_MAX) {
      const text = state.sliceDoc(sel.from, sel.to);
      const query = this.withSearch(this.query.literal ? text : text.replace(/\n/g, "\\n"));
      if (!query.eq(this.query)) {
        this.query = query;
        this.findInput.value = query.search;
        this.view.dispatch({ effects: setSearchQuery.of(query) });
        this.checkMatches();
      }
    }
    this.focusInput(this.findInput);
  }

  /**
   * Mod-F inside the panel (EDIT-09): back to the find input with its text selected.
   * No re-seeding: the editor selection is just the current match by then.
   */
  selectFind(): void {
    this.focusInput(this.findInput);
  }

  /** Shows the replace row; focus goes to it once there is something to find. */
  showReplace(): void {
    if (this.view.state.readOnly) {
      this.focusInput(this.findInput);
      return;
    }
    this.replaceShown = true;
    this.syncReplaceRow();
    this.focusInput(this.findInput.value !== "" ? this.replaceInput : this.findInput);
  }

  toggleReplace(): void {
    if (this.view.state.readOnly) return;
    this.replaceShown = !this.replaceShown;
    this.syncReplaceRow();
    this.focusInput(this.replaceShown ? this.replaceInput : this.findInput);
  }

  private focusInput(input: HTMLInputElement): void {
    input.focus();
    input.select();
  }

  private withSearch(search: string): SearchQuery {
    const q = this.query;
    return new SearchQuery({
      search,
      replace: this.replaceInput.value,
      caseSensitive: q.caseSensitive,
      literal: q.literal,
      regexp: q.regexp,
      wholeWord: q.wholeWord,
    });
  }

  /** Input events (including IME composition updates) re-query; nothing jumps until Enter. */
  private readonly commit = (): void => {
    const query = this.withSearch(this.findInput.value);
    if (query.eq(this.query)) return;
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    this.checkMatches();
  };

  private showQuery(query: SearchQuery): void {
    this.query = query;
    this.findInput.value = query.search;
    this.replaceInput.value = query.replace;
  }

  private syncReplaceRow(): void {
    const readOnly = this.view.state.readOnly;
    const shown = this.replaceShown && !readOnly;
    this.replaceRow.hidden = !shown;
    this.toggleButton.hidden = readOnly;
    this.toggleButton.setAttribute("aria-expanded", String(shown));
    if (!shown && this.view.root.activeElement === this.replaceInput) this.focusInput(this.findInput);
  }

  /** Faint input text when a valid query has no match at all (no match count is ever shown). */
  private checkMatches(): void {
    if (this.matchTimer !== null) {
      clearTimeout(this.matchTimer);
      this.matchTimer = null;
    }
    const q = this.query;
    const none = q.valid && q.getCursor(this.view.state).next().done === true;
    this.findInput.classList.toggle("cm-mn-find-none", none);
  }

  private scheduleMatchCheck(): void {
    if (this.matchTimer !== null) clearTimeout(this.matchTimer);
    this.matchTimer = setTimeout(() => {
      this.matchTimer = null;
      this.checkMatches();
    }, MATCH_CHECK_MS);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (isComposing(e)) return;
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault();
      return;
    }
    if (e.key !== "Enter" || e.altKey) return;
    if (e.target === this.findInput) {
      e.preventDefault();
      if (!hasMod(e)) (e.shiftKey ? findPrevious : findNext)(this.view);
    } else if (e.target === this.replaceInput) {
      e.preventDefault();
      if (hasMod(e)) replaceAll(this.view);
      else if (e.shiftKey) findPrevious(this.view);
      else replaceNext(this.view);
    }
  };
}

/** Opens the panel, or acts on the open one (see the module comment). */
function openFind(view: EditorView, replace: boolean): boolean {
  const panel = panels.get(view);
  if (!panel) {
    if (replace && !view.state.readOnly) openWithReplace.add(view);
    else openWithReplace.delete(view);
    openSearchPanel(view);
    openWithReplace.delete(view);
    return true;
  }
  if (replace) panel.showReplace();
  else if (panel.hasFocus()) panel.selectFind();
  else panel.refocus();
  return true;
}

/** Opens find (or find and replace) from outside the editor, e.g. Mod-F in reading view. */
export function openFindPanel(view: EditorView, replace = false): boolean {
  return openFind(view, replace);
}

/** True while focus is inside the find panel (the editor then counts as focused, LIVE-01). */
export function findPanelFocused(view: EditorView): boolean {
  return panels.get(view)?.hasFocus() ?? false;
}

/** Keeps a match or the caret clear of the floating panel when scrolled into view. */
const panelScrollMargin = EditorView.scrollMargins.of((view) => {
  const panel = panels.get(view);
  return panel ? { top: panel.dom.offsetHeight + 2 * FIND_PANEL_OFFSET } : null;
});

/** Search state with the custom panel. */
export function findPanel(): Extension {
  return [
    search({
      top: true,
      createPanel: (view) => new FindPanel(view),
      scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: "nearest", yMargin: 48 }),
    }),
    panelScrollMargin,
  ];
}

/**
 * Find keys (precedence slot 9 of ARCHITECTURE §10.1). CodeMirror's searchKeymap
 * is not used: its Mod-Alt-G opens a go-to-line panel with a text label (PLAT-10).
 */
export const findKeymap: readonly KeyBinding[] = [
  { key: "Mod-f", run: (view) => openFind(view, false), scope: "editor search-panel", preventDefault: true },
  { key: "Mod-h", mac: "Mod-Alt-f", run: (view) => openFind(view, true), scope: "editor search-panel", preventDefault: true },
  { key: "F3", run: findNext, shift: findPrevious, scope: "editor search-panel", preventDefault: true },
  { key: "Mod-g", run: findNext, shift: findPrevious, scope: "editor search-panel", preventDefault: true },
  { key: "Escape", run: closeSearchPanel, scope: "editor search-panel" },
  { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
  { key: "Mod-Shift-l", run: selectSelectionMatches },
];
