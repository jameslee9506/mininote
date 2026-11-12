/**
 * The open document: loading, autosave, external-change reconciliation,
 * history (back/forward), view mode, and the EditorHost implementation.
 * See docs/ARCHITECTURE.md §8 for the exact protocol.
 *
 * Every note with live state has a controller (`Note`) keyed by its exact
 * VaultPath. A save always reads that controller's own EditorState (the view's
 * state while the note is shown, the cached one otherwise), never "whatever the
 * view shows now". Clean controllers form a 20-entry LRU; dirty ones are pinned
 * and keep retrying. Nothing here dispatches into the editor mid-composition
 * except the user's own edits; saves only read.
 */
import { tick, untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { Transaction, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  Baseline,
  FileContent,
  FileKind,
  RecoveryCopy,
  TreeNode,
  ViewMode,
  VaultPath,
  VaultSession,
} from "../types";
import type { EditorHost, LinkTarget, NoteCandidate } from "../editor/host";
import {
  createEditorState,
  External,
  reconfigureEditor,
  refreshDecorations,
  replaceDocMinimal,
  type EditorOptions,
} from "../editor/setup";
import { isTaskLine, toggleTaskAtLine as toggleTaskLine } from "../editor/commands";
import { openFindPanel } from "../editor/searchPanel";
import {
  currentEpoch,
  isIpcError,
  noteCreate,
  noteRead,
  noteWrite,
  pathExists,
  recoveryClear,
  recoveryGet,
  recoveryWrite,
} from "../ipc/commands";
import { isExternalHref, parseWikiInner } from "../markdown/resolve";
import { t } from "../i18n";
import {
  basename,
  decodeLinkPath,
  dirname,
  encodeLinkPath,
  isSameOrAncestor,
  join,
  key,
  nfc,
  normalizeRel,
  rebase,
  relativeTo,
} from "../utils/path";
import { fileKindOf, titleOf } from "../utils/names";
import { LARGE_DEBOUNCE_MS, LARGE_MAX_WAIT_MS, LARGE_NOTE_BYTES, retryDelay, saveDelay, sleep, within } from "./autosave";
import { conflictCopyName } from "./conflict";
import { findHeadingLine, findInLine } from "./headings";
import { NavHistory, type HistoryEntry } from "./history";
import { BOM, detectLineEnding, fromLF, minimalChange, toLF, wellFormed, type LineEnding } from "./lineEndings";
import { mayBecomeNote } from "./targets";
import { settings } from "./settings.svelte";
import { ui } from "./ui.svelte";
import { vault } from "./vault.svelte";

/** Trailing debounce after the last keystroke. */
export const SAVE_DEBOUNCE_MS = 400;
/** Upper bound between the first unsaved change and its save while typing continuously. */
export const SAVE_MAX_WAIT_MS = 2000;
/** EditorStates (undo history, selection, scroll) kept for recently opened notes. */
export const STATE_CACHE_SIZE = 20;
/** A note switch, rename or delete waits at most this long for pending saves (SAVE-02). */
export const SWITCH_FLUSH_MS = 2000;

const CLOSE_FLUSH_MS = 2000;
const RECOVERY_WRITE_MS = 1000;
/** SAVE-09: unsaved this long beyond the normal save schedule (or after a failure) counts as stuck. */
const STUCK_MS = 2000;
/** SAVE-06: repeated conflicts within this window overwrite the newest conflict copy. */
const CONFLICT_STORM_MS = 60_000;
/** SAVE-06: a reload that would empty a non-empty note waits until the file stayed empty this long. */
const EMPTY_GRACE_MS = 1000;
/** SAVE-07: delay before recreating a vanished file, so a pending watcher rename can re-point us first. */
const VANISHED_RETRY_MS = 1000;
const HISTORY_LIMIT = 100;
const RECENT_LIMIT = 50;
const EXTERNAL_SCHEMES = /^(https?|mailto|tel):/i;
/** Two baselines' mtimes are the same within this many ms (Rust's MTIME_EPS_MS). */
const MTIME_EPS_MS = 0.001;

/** Where the user left a note (VAULT-03), as stored in the vault session. */
export type NotePosition = NonNullable<VaultSession["last"]>;

export interface OpenOptions {
  /** Push onto back/forward history (default true; false for back()/forward()). */
  history?: boolean;
  /** 0-based line to reveal and put the cursor on (search results). */
  line?: number;
  /** With `line`: select the first occurrence of this text in that line (the search hit, SRCH-01). */
  select?: string;
  /** Without `line`: restore this selection, scroll position and view mode (VAULT-03 session restore). */
  position?: NotePosition;
  /** Default "editor"; "start" switches to editing and focuses the body's first position after rendering. */
  focus?: "editor" | "start" | "none";
}

type Timer = ReturnType<typeof setTimeout>;
type OpenResult = "ok" | "failed" | "stale";

/** Per-note save controller plus its cached editor state (ARCHITECTURE §8.1). */
interface Note {
  path: VaultPath;
  /** Cached state; while the note is shown, the view's state is authoritative. */
  state: EditorState;
  /** `state` still carries the options it was created with and was never in the view. */
  pristine: boolean;
  /** The file as of our last read or write; null when there is no file yet (virtual or deleted). */
  baseline: Baseline | null;
  bom: boolean;
  eol: LineEnding;
  /** LF text the file holds as far as we know (last saved or loaded). */
  lastSaved: string;
  /** Bumped by every user edit; the note is dirty while it differs from `savedVersion`. */
  version: number;
  savedVersion: number;
  /** First edit not covered by a started save (anchors the max wait). */
  firstDirtyAt: number | null;
  /** First edit not yet confirmed on disk (SAVE-09). */
  unsavedSince: number | null;
  /** Debounce or retry timer. */
  timer: Timer | null;
  stuckTimer: Timer | null;
  inFlight: Promise<void> | null;
  /** A save was requested while one was in flight. */
  again: boolean;
  /** A conflict copy is being written (SAVE-06); saves wait for it. */
  conflicting: Promise<void> | null;
  /** An in-app delete or rename is in progress: no save may start (§8.3). */
  frozen: boolean;
  disposed: boolean;
  failures: number;
  /** The current run of failures has shown its toast. */
  toasted: boolean;
  /**
   * Vault epoch the note belongs to. Every call made for it carries this one, so work
   * that outlives a vault switch fails with "no_vault" instead of reaching the new vault.
   */
  epoch: number;
  /** A recovery copy may exist for this path; the next successful save clears it. */
  recovery: boolean;
  /** Serializes recovery writes and clears for this note. */
  recoveryOp: Promise<void>;
  readOnly: boolean;
  /** No file yet (LINK-05): the first save creates it. */
  virtual: boolean;
  /** Over 2 MB: source mode and slow autosave (SAVE-11). */
  large: boolean;
  scrollTop: number;
  /** LRU stamp. */
  used: number;
  /** External re-reads; a newer read supersedes older ones. */
  readSeq: number;
  /**
   * Bumped by every move except a respelling of the same entry on a case- or normalization-
   * insensitive volume, after which a write to the old spelling still reached the note's file (§8.1).
   */
  moves: number;
  /**
   * Newest conflict copy written for this note (60 s storm rule), with the copy's
   * baseline after our write: it is overwritten only while it is still exactly that.
   */
  conflict: { path: VaultPath; at: number; baseline: Baseline } | null;
}

interface Snapshot {
  path: VaultPath;
  text: string;
  version: number;
  baseline: Baseline | null;
  bom: boolean;
  eol: LineEnding;
  /** The note's `moves` when the save started. */
  moves: number;
}

const dirty = (n: Note): boolean => n.version !== n.savedVersion;
const baselineOf = (b: Baseline): Baseline => ({ mtime: b.mtime, size: b.size, hash: b.hash });
/** Name used in toasts: NFC, notes without their extension. */
const displayName = (path: VaultPath): string => titleOf(nfc(basename(path)), fileKindOf(path));

class EditorStore {
  /** Open file, or null (blank main area). */
  path = $state<VaultPath | null>(null);
  kind = $state<FileKind | null>(null);
  viewMode = $state<ViewMode>("edit");
  /** True while a file is being read. */
  loading = $state(false);
  /** Bumped on every doc change (user or external) so the reading view can re-render. */
  revision = $state(0);
  canBack = $state(false);
  canForward = $state(false);
  /** The open note's file is not writable (opened read-only; faint lock icon). */
  readOnly = $state(false);
  /** Unsaved changes older than 2 s (stuck/failing save): titles render a lighter gray (SAVE-09). */
  saveStuck = $state(false);
  /** The open note is virtual: its file is created by the first edit (LINK-05). */
  virtual = $state(false);
  /** The open note is over 2 MB: no live preview, slower autosave (SAVE-11). */
  tooLarge = $state(false);
  /** Every note whose unsaved changes are stuck (SAVE-09), so tree rows can lighten too. */
  stuck = new SvelteSet<VaultPath>();
  /**
   * Latest line reveal (search result, heading link) for the note at `path`. The
   * editor moves its cursor itself; the reading view watches this to scroll to the
   * same source line. Set in either view mode; `seq` grows with every request.
   */
  lineRequest = $state<{ path: VaultPath; line: number; seq: number } | null>(null);

  #view: EditorView | null = null;
  #scroller: HTMLElement | null = null;
  #notes = new Map<VaultPath, Note>();
  /** The note shown in the editor (also while no view is attached). */
  #current: Note | null = null;
  /** The note whose state the view holds right now (null: blank state or no view). */
  #installed: Note | null = null;
  #history = new NavHistory(HISTORY_LIMIT);
  #openSeq = 0;
  #useSeq = 0;
  #lineSeq = 0;
  #scrollToken = 0;
  #candFiles: readonly TreeNode[] | null = null;
  #candList: NoteCandidate[] = [];
  /*
   * Editor options as primitives: effects that read options() re-run only when one of
   * them really changes, not on every settings.update (each reconfigure may scan the doc).
   */
  #livePreview = $derived(settings.values.editorMode === "live" && !this.tooLarge);
  #spellcheck = $derived(settings.values.spellcheck);
  #viewReadOnly = $derived(this.readOnly || this.kind !== "note");
  /** Removes what attach() installed (window listeners, the options effect). */
  #unlisten: (() => void) | null = null;

  /** Implementation handed to createEditorState() — the editor's window into app state. */
  host: EditorHost = {
    onDocChanged: () => untrack(() => this.#onDocChanged()),
    openLink: (link) => void this.openLink(link),
    noteCandidates: () => untrack(() => this.#candidates()),
    resolveWiki: (target) => untrack(() => vault.resolveWiki(target, this.path)),
    resolveImage: (src, kind) => untrack(() => this.#resolveImage(src, kind)),
    saveAttachment: (data, ext, forNote) => untrack(() => this.#saveAttachment(data, ext, forNote)),
    linkTextFor: (path) => untrack(() => vault.linkTextFor(path)),
    currentPath: () => untrack(() => this.path),
    focusTitle: () =>
      untrack(() => {
        if (!settings.values.inlineTitle || this.path === null || this.kind !== "note") return false;
        ui.focusTitle({ select: false });
        return true;
      }),
    shortcutKeys: (id) => untrack(() => settings.values.shortcuts[id]),
  };

  /**
   * Editor.svelte registers its single EditorView on mount, plus the element that
   * scrolls the document column (title + editor), used to save/restore scroll per note.
   * Also installs window blur / visibilitychange → flush listeners. The current
   * note (if any) is bound into the freshly mounted view, and later options()
   * changes are applied to the view (never mid-composition).
   */
  attach = (view: EditorView, scroller: HTMLElement | null): void =>
    untrack(() => {
      if (view === this.#view) {
        // Same view, new scroller: the view already holds the live state; reinstalling would revert it.
        this.#scroller = scroller;
        return;
      }
      this.#unlisten?.();
      const old = this.#installed;
      if (this.#view && old && !old.disposed) old.state = this.#view.state; // remount without detach
      this.#view = view;
      this.#scroller = scroller;
      this.#installed = null;
      const n = this.#current;
      if (n) {
        this.#install(view, n);
        this.#restoreScroll(n.scrollTop);
      } else view.setState(this.#blank());
      const onBlur = () => {
        this.#rememberPosition();
        void this.flush();
      };
      const onVisibility = () => {
        if (document.visibilityState !== "hidden") return;
        this.#rememberPosition();
        void this.flush();
      };
      window.addEventListener("blur", onBlur);
      document.addEventListener("visibilitychange", onVisibility);
      const unwatch = $effect.root(() => {
        $effect(() => {
          this.options(); // tracked: settings, read-only and size of the open note
          untrack(() => void this.#applyOptions(view));
        });
      });
      this.#unlisten = () => {
        window.removeEventListener("blur", onBlur);
        document.removeEventListener("visibilitychange", onVisibility);
        unwatch();
      };
    });

  /** Editor.svelte unregisters on destroy (flushes first). */
  detach = (): void =>
    untrack(() => {
      const view = this.#view;
      if (!view) return;
      const n = this.#installed;
      if (n && !n.disposed) {
        n.state = view.state;
        n.scrollTop = this.#scroller?.scrollTop ?? n.scrollTop;
      }
      this.#unlisten?.();
      this.#unlisten = null;
      this.#view = null;
      this.#scroller = null;
      this.#installed = null;
      void this.flush();
    });

  /** Current document text (cheap enough to call on demand; never per keystroke). */
  getText = (): string => {
    const n = this.#current;
    return n ? this.#stateOf(n).doc.toString() : "";
  };

  /**
   * Text of the main selection while a note is shown for editing, else "". Read from
   * the editor state, which stays right while the DOM selection is still being
   * restored (a command run from the palette).
   */
  selectedText = (): string =>
    untrack(() => {
      const view = this.#view;
      if (!view || !this.#installed || this.kind !== "note" || this.viewMode !== "edit") return "";
      const { from, to } = view.state.selection.main;
      return view.state.sliceDoc(from, to);
    });

  /**
   * Opens `path`: flush current → read (notes) → swap EditorState (cached state
   * when the disk text still matches, else a fresh one) → update history/recent
   * /session.lastFile → focus per opts. Images and other files only set `kind`:
   * their views read nothing here (TREE-15, TREE-16). Folders do not open.
   * On read failure: toast (errOpen/errNotText/errTooLarge) and keep the
   * previous document bound to its own path. Returns success.
   */
  open = (path: VaultPath, opts?: OpenOptions): Promise<boolean> =>
    untrack(() => this.#open(path, opts ?? {})).then((r) => r === "ok");

  /**
   * Opens a note that does not exist yet (unresolved link target). Shows an empty
   * editor bound to `path`; the first edit creates the file (and parent folders).
   * Navigating away without typing leaves nothing behind.
   */
  openVirtual = (path: VaultPath): Promise<void> => untrack(() => this.#openVirtual(path, {})).then(() => {});

  /** Flushes and shows the blank state. */
  close = (): Promise<void> =>
    untrack(async () => {
      const seq = ++this.#openSeq;
      const prev = this.#current;
      if (prev) await within(this.#flushNote(prev), SWITCH_FLUSH_MS);
      if (seq !== this.#openSeq) return;
      this.#showNothing();
      const root = vault.info?.root;
      if (root) settings.updateSession(root, { lastFile: null, last: undefined });
    });

  /** Saves pending changes now and waits for every in-flight write. */
  flush = (): Promise<void> =>
    untrack(async () => {
      await Promise.all([...this.#notes.values()].map((n) => this.#flushNote(n)));
    });

  /** Like flush(), for the notes at or under `path` (before a rename, move or delete). */
  flushUnder = (path: VaultPath): Promise<void> =>
    untrack(async () => {
      await Promise.all(this.#under(path).map((n) => this.#flushNote(n)));
    });

  /**
   * Close/quit path (ARCHITECTURE §8.4): flush with a 2 s cap; whatever is still
   * unsaved then goes to recovery copies (about 1 s cap). Never throws. First records
   * where the user is in the open note for the next session (VAULT-03), so the
   * settings flush that follows persists it.
   */
  flushOrRecover = (): Promise<void> =>
    untrack(async () => {
      try {
        this.#rememberPosition();
      } catch (e) {
        console.error("editor: remembering the position failed", e);
      }
      await within(this.flush(), CLOSE_FLUSH_MS);
      if ([...this.#notes.values()].some((n) => !n.disposed && dirty(n))) await this.writeRecoveryCopies();
    });

  /** Writes a recovery copy for every note with unsaved changes (each capped at about 1 s). */
  writeRecoveryCopies = (): Promise<void> =>
    untrack(async () => {
      const pending = [...this.#notes.values()].filter((n) => !n.disposed && dirty(n));
      await Promise.all(pending.map((n) => within(this.#writeRecovery(n), RECOVERY_WRITE_MS)));
    });

  back = (): Promise<void> => untrack(() => this.#go(-1));

  forward = (): Promise<void> => untrack(() => this.#go(1));

  toggleViewMode = (): void =>
    untrack(() => {
      if (this.kind !== "note") return;
      this.viewMode = this.viewMode === "edit" ? "read" : "edit";
      if (this.viewMode === "edit")
        void tick().then(() => {
          this.#view?.requestMeasure();
          this.#view?.focus();
        });
    });

  /**
   * Opens the note's find panel from outside the editor (EDIT-09): reading view
   * switches to editing first. Inside the editor, its own Mod-F binding handles it.
   */
  openFind = (): Promise<void> =>
    untrack(async () => {
      if (this.kind !== "note" || !this.#view || !this.#installed) return;
      if (this.viewMode === "read") {
        this.viewMode = "edit";
        await tick(); // the editor slot is visible again
        this.#view?.requestMeasure();
      }
      const view = this.#view;
      if (view && this.#installed && this.kind === "note" && this.viewMode === "edit") openFindPanel(view);
    });

  /** Follows a link from the current note (see ARCHITECTURE §9.2). */
  openLink = (link: LinkTarget): Promise<void> => untrack(() => this.#openLink(link));

  /** Toggles the task checkbox on a 0-based source line (reading-view checkbox clicks). */
  toggleTaskAtLine = (line: number): void =>
    untrack(() => {
      const view = this.#view;
      if (!view || !this.#installed || this.readOnly) return;
      // READ-07: data-line can be forged by raw HTML, so only a real task line toggles.
      if (isTaskLine(view.state, line)) toggleTaskLine(view, line);
    });

  /**
   * A file/folder moved: remap the open path, history, recent list and state cache
   * (prefix-aware). A live note that already had a destination path (a virtual note,
   * or one whose file vanished) gives way to the moved file: its unsaved text is kept
   * as a conflict copy, and if it was on screen the moved note is shown instead.
   * `sameEntry`: only the spelling changed, and the old one was proven to name the same
   * entry (a case-insensitive volume), so a save in flight under it reached the note's file.
   */
  onPathMoved = (from: VaultPath, to: VaultPath, sameEntry = false): void =>
    untrack(() => {
      if (from === to) return;
      const moved: [Note, VaultPath][] = [];
      for (const n of this.#notes.values()) {
        const np = rebase(n.path, from, to);
        if (np !== null && np !== n.path) moved.push([n, np]);
      }
      for (const [n] of moved) this.#notes.delete(n.path);
      let replacement: Note | null = null;
      for (const [n, np] of moved) {
        const clash = this.#notes.get(np);
        if (clash && this.#displace(clash, n)) replacement = n;
        const old = n.path;
        n.path = np;
        if (!sameEntry) n.moves++;
        this.#notes.set(np, n);
        if (this.stuck.delete(old)) this.stuck.add(np);
        if (n.recovery) void this.#moveRecovery(n, old);
      }
      // The 60 s storm rule keeps overwriting a moved conflict copy where it is now, never at its old path.
      for (const n of this.#notes.values()) {
        if (n.conflict) n.conflict.path = rebase(n.conflict.path, from, to) ?? n.conflict.path;
      }
      if (this.path !== null) {
        const np = rebase(this.path, from, to);
        if (np !== null) this.path = np;
      }
      this.#history.remap(from, to);
      for (const [n, np] of moved) if (!n.virtual) this.#history.markReal(np);
      this.#rewriteSession((p) => rebase(p, from, to) ?? p);
      if (replacement) {
        // The note on screen gave way: never leave the view on a disposed controller.
        this.#setShown(replacement.path, "note", replacement);
        this.#bind(replacement);
        this.#restoreScroll(replacement.scrollTop);
        if (!replacement.virtual) this.#remember(replacement.path, true);
      }
      this.#syncStuck();
      // Live notes that were at the destination without a moved controller of their own (a
      // virtual note the moved file now backs) re-read their path: clean ones load the file.
      const movedNotes = new Set(moved.map(([n]) => n));
      for (const n of [...this.#notes.values()])
        if (!movedNotes.has(n) && isSameOrAncestor(to, n.path)) void this.#reconcile(n);
    });

  /**
   * A file/folder is gone (in-app delete): drop its controllers without saving,
   * show the previous history entry (or nothing) if it was open, prune history,
   * recent list and cache.
   */
  onPathRemoved = (path: VaultPath): void => untrack(() => this.#forget((p) => isSameOrAncestor(path, p)));

  /**
   * A note with live state changed on disk (watcher, focus re-check, or a removal
   * to confirm): ignore our own echo, reload when clean, conflict copy when dirty,
   * follow a delete+create move to one of `movedTo` (same text), else apply the
   * external-delete rule (SAVE-05/06/07). `path` is matched exactly, then by key().
   */
  onExternalChange = (path: VaultPath, movedTo?: readonly VaultPath[]): Promise<void> =>
    untrack(() => {
      const n = this.#find(path);
      return n ? this.#reconcile(n, { candidates: movedTo }) : Promise.resolve();
    });

  /**
   * Takes keyboard focus out of the editor right away. A command that shows another
   * note only after async work (Mod+N: create, list, open) calls this first, so keys
   * typed meanwhile go nowhere instead of into the note still on screen.
   */
  blur = (): void =>
    untrack(() => {
      const view = this.#view;
      const active = document.activeElement;
      if (view && active instanceof HTMLElement && view.dom.contains(active)) active.blur();
    });

  /** Focuses the editor; "start"/"end" also move the cursor (default keeps the selection). */
  focusEditor = (at?: "start" | "end"): void =>
    untrack(() => {
      const view = this.#view;
      if (!view || !this.#installed) return;
      if (at) view.dispatch({ selection: { anchor: at === "start" ? 0 : view.state.doc.length }, scrollIntoView: true });
      view.focus();
    });

  /**
   * Editor options derived from settings (reactive reads — usable inside $effect). Each
   * field is a derived primitive, so an effect reading this re-runs only when an option
   * changes, not when an unrelated setting (sidebar width while dragging) is updated.
   */
  options = (): EditorOptions => ({
    livePreview: this.#livePreview,
    spellcheck: this.#spellcheck,
    readOnly: this.#viewReadOnly,
  });

  /** Paths with live editor state: open, cached or pinned (the vault routes watcher events by them). */
  livePaths = (): VaultPath[] => [...this.#notes.keys()];

  /** True while `path` is a virtual note whose file does not exist yet. */
  isVirtual = (path: VaultPath): boolean => this.#notes.get(path)?.virtual === true;

  /**
   * True while a write for `path` or anything under it is still in flight. A rename or
   * delete must not start then: the write could land afterwards and recreate the old path.
   */
  busyUnder = (path: VaultPath): boolean =>
    this.#under(path).some((n) => n.inFlight !== null || n.conflicting !== null);

  /**
   * True when a live note other than those at or under `except` holds unsaved text at
   * `path` or under it (matched by key()). This catches notes the listing does not show
   * (a virtual note, or one whose file vanished), so a rename or move onto one is
   * refused like any existing target (TREE-06) instead of displacing its text.
   */
  unsavedAt = (path: VaultPath, except?: VaultPath): boolean => {
    const k = key(path);
    for (const n of this.#notes.values()) {
      if (n.disposed || !dirty(n) || (except !== undefined && isSameOrAncestor(except, n.path))) continue;
      const nk = key(n.path);
      if (nk === k || nk.startsWith(`${k}/`)) return true;
    }
    return false;
  };

  /**
   * Blocks saves for `path` and everything under it (in-app delete or rename,
   * §8.3) and waits for writes already in flight. Undo with unfreeze().
   */
  freeze = (path: VaultPath): Promise<void> =>
    untrack(async () => {
      const notes = this.#under(path);
      for (const n of notes) {
        n.frozen = true;
        this.#clearTimer(n);
      }
      await Promise.all(
        notes.map(async (n) => {
          for (let i = 0; i < 3; i++) {
            const busy = n.inFlight ?? n.conflicting;
            if (!busy) break;
            await busy;
          }
        }),
      );
    });

  /** Lifts freeze(); pending changes save right away. */
  unfreeze = (path: VaultPath): void =>
    untrack(() => {
      for (const n of this.#under(path)) {
        if (!n.frozen) continue;
        n.frozen = false;
        if (dirty(n)) this.#schedule(n, 0);
      }
    });

  /**
   * Vault close/switch (VAULT-05): flush (bounded), keep anything unsaved in
   * recovery copies, then drop every controller, the history and the open file.
   */
  reset = (): Promise<void> =>
    untrack(async () => {
      ++this.#openSeq;
      await this.flushOrRecover();
      ++this.#openSeq;
      for (const n of [...this.#notes.values()]) this.#drop(n);
      this.#notes.clear();
      this.#history.clear();
      this.#current = null;
      this.#installed = null;
      this.#view?.setState(this.#blank());
      this.path = null;
      this.kind = null;
      this.viewMode = "edit";
      this.loading = false;
      this.readOnly = false;
      this.virtual = false;
      this.tooLarge = false;
      this.lineRequest = null;
      this.stuck.clear();
      this.saveStuck = false;
      this.#syncHistory();
      this.revision++;
    });

  /** The vault listing changed: live preview re-resolves links and images. */
  onListingChanged = (): void => {
    if (this.#view && this.#installed) refreshDecorations(this.#view);
  };

  // ── Opening ──────────────────────────────────────────────────────────────

  async #open(path: VaultPath, opts: OpenOptions): Promise<OpenResult> {
    if (!vault.info) return "failed";
    const node = vault.node(path);
    const kind = fileKindOf(path);
    // Nothing is read for another kind of file, so only a listed one opens: never a folder.
    if (node?.kind === "dir" || (kind === "other" && node === undefined)) return "failed";
    const seq = ++this.#openSeq;
    if (path === this.path && kind === this.kind && (kind !== "note" || this.#current?.path === path)) {
      if (opts.history !== false) this.#history.push({ path, virtual: this.virtual });
      this.#syncHistory();
      if (opts.line !== undefined) this.#revealLine(opts.line, "center", opts.select);
      this.#focus(opts.focus);
      return "ok";
    }
    // Leave the current note: the flush waits at most 2 s; a note that could not
    // be saved stays dirty and pinned in the cache, still retrying (SAVE-02).
    const prev = this.#current;
    if (prev) await within(this.#flushNote(prev), SWITCH_FLUSH_MS);
    if (seq !== this.#openSeq) return "stale";

    if (kind !== "note") {
      this.#setShown(path, kind, null);
      this.#bind(null);
      this.#finishOpen(path, false, opts);
      return "ok";
    }

    this.loading = true;
    try {
      return await this.#openNote(path, opts, seq);
    } finally {
      if (seq === this.#openSeq) this.loading = false;
    }
  }

  async #openNote(path: VaultPath, opts: OpenOptions, seq: number): Promise<OpenResult> {
    const cached = this.#notes.get(path);
    if (cached?.inFlight) await within(cached.inFlight, SWITCH_FLUSH_MS);
    let disk: FileContent;
    let recovery: RecoveryCopy | null;
    try {
      [disk, recovery] = await Promise.all([noteRead(path), recoveryGet(path).catch(() => null)]);
    } catch (e) {
      if (seq !== this.#openSeq) return "stale";
      this.#openFailed(path, e);
      return "failed";
    }
    if (seq !== this.#openSeq) return "stale";

    const text = toLF(disk.content);
    // A file without any line break keeps the style remembered for it (EDIT-02); LF only for new ones.
    const detected = detectLineEnding(disk.content);
    let n = this.#notes.get(path) ?? null;
    const remembered = n?.eol ?? "\n";
    let reconcile = false;
    if (n) {
      const buf = this.#stateOf(n).doc.toString();
      if (text === n.lastSaved || text === buf) {
        this.#adopt(n, disk, detected ?? n.eol);
        if (text === buf) this.#markClean(n, n.version, text);
      } else if (dirty(n)) reconcile = true; // pinned unsaved text vs a changed file: SAVE-06
      else {
        this.#drop(n); // the cached state is stale (EDIT-10)
        n = null;
      }
    }
    if (n) {
      if (recovery) n.recovery = true; // the live buffer is newer; its next save clears the copy
    } else {
      const eol = detected ?? remembered;
      n = this.#createNote(path, text, disk, eol);
      if (recovery) this.#applyRecovery(n, recovery, disk, text, eol);
    }

    this.#setShown(path, "note", n);
    this.#bind(n);
    if (opts.line !== undefined) this.#revealLine(opts.line, "center", opts.select);
    else if (opts.position) this.#restorePosition(n, opts.position);
    else this.#restoreScroll(n.scrollTop);
    this.#finishOpen(path, true, opts);
    if (reconcile) void this.#reconcile(n);
    return "ok";
  }

  async #openVirtual(path: VaultPath, opts: OpenOptions): Promise<OpenResult> {
    if (!vault.info) return "failed";
    const existing = vault.findExisting(path);
    if (existing !== null) return this.#open(existing, opts);
    if (this.#current?.path === path && this.#current.virtual) {
      this.#focus(opts.focus);
      return "ok";
    }
    const seq = ++this.#openSeq;
    const prev = this.#current;
    if (prev) await within(this.#flushNote(prev), SWITCH_FLUSH_MS);
    if (seq !== this.#openSeq) return "stale";
    let n = this.#notes.get(path) ?? null;
    if (!n) {
      // SAVE-10: text typed here before, whose file was never created, comes back as an unsaved edit.
      const rec = await recoveryGet(path).catch(() => null);
      if (seq !== this.#openSeq) return "stale";
      n = this.#notes.get(path) ?? null;
      if (!n) {
        n = this.#createNote(path, "", null, "\n");
        if (rec) this.#applyVirtualRecovery(n, rec);
      }
    }
    if (!n.virtual) return this.#open(path, opts); // its first save created the file meanwhile
    this.viewMode = "edit";
    this.#setShown(path, "note", n);
    this.#bind(n);
    this.#restoreScroll(n.scrollTop);
    if (opts.history !== false) this.#history.push({ path, virtual: true });
    this.#syncHistory();
    this.#focus(opts.focus);
    return "ok";
  }

  #openFailed(path: VaultPath, e: unknown): void {
    const name = displayName(path);
    if (isIpcError(e, "no_vault")) return;
    if (isIpcError(e, "not_utf8")) ui.notify(t("errNotText", { name }));
    else if (isIpcError(e, "too_large")) ui.notify(t("errTooLarge", { name }));
    else ui.notify(t("errOpen", { name }));
    if (isIpcError(e, "not_found")) void vault.refresh();
  }

  /** History, session and tree bookkeeping after a successful open. */
  #finishOpen(path: VaultPath, isNote: boolean, opts: OpenOptions): void {
    if (opts.history !== false) this.#history.push({ path, virtual: false });
    this.#syncHistory();
    this.#remember(path, isNote);
    vault.revealInTree(path);
    this.#focus(opts.focus);
  }

  #focus(focus: OpenOptions["focus"] = "editor"): void {
    if (focus === "start" && this.kind === "note") {
      this.viewMode = "edit";
      const seq = this.#openSeq;
      // The editor can still be hidden after opening from the blank state, an image or reading view.
      void tick().then(() => {
        if (seq === this.#openSeq && this.kind === "note" && this.viewMode === "edit") this.focusEditor("start");
      });
    } else if (focus === "editor" && this.kind === "note" && this.viewMode === "edit") this.#view?.focus();
  }

  /** Reactive fields describing what is shown; set before the view swaps state so the host sees the new path. */
  #setShown(path: VaultPath, kind: FileKind, n: Note | null): void {
    this.path = path;
    this.kind = kind;
    this.readOnly = n?.readOnly ?? false;
    this.virtual = n?.virtual ?? false;
    this.tooLarge = n?.large ?? false;
    this.revision++;
    this.#syncStuck();
  }

  #showNothing(): void {
    this.path = null;
    this.kind = null;
    this.readOnly = false;
    this.virtual = false;
    this.tooLarge = false;
    this.#bind(null);
    this.revision++;
    this.#syncStuck();
  }

  /** Shows `n` (or the blank state): the note leaving the view keeps its state and scroll in the cache. */
  #bind(n: Note | null): void {
    const view = this.#view;
    const out = this.#installed;
    if (view && out && out !== n && !out.disposed) {
      out.state = view.state;
      out.scrollTop = this.#scroller?.scrollTop ?? out.scrollTop;
    }
    this.#current = n;
    if (n) n.used = ++this.#useSeq;
    if (view) {
      if (n === null) {
        view.setState(this.#blank());
        this.#installed = null;
      } else if (out !== n) this.#install(view, n);
    }
    this.#evict();
  }

  #install(view: EditorView, n: Note): void {
    view.setState(n.state);
    this.#installed = n;
    if (!n.pristine) reconfigureEditor(view, this.#optsFor(n));
    n.pristine = false;
    // LIVE-16: parse the visible region before the first paint.
    forceParsing(view, Math.min(view.state.doc.length, view.viewport.to + 2500), 100);
  }

  #blank(): EditorState {
    return createEditorState("", this.host, { livePreview: false, spellcheck: false, readOnly: true });
  }

  #optsFor(n: Note): EditorOptions {
    return {
      livePreview: settings.values.editorMode === "live" && !n.large,
      spellcheck: settings.values.spellcheck,
      readOnly: n.readOnly,
    };
  }

  /** Applies the current options to the note shown in `view` once no composition is active. */
  async #applyOptions(view: EditorView): Promise<void> {
    await this.#compositionIdle(() => this.#view !== view);
    const n = this.#installed;
    if (this.#view === view && n && !n.disposed) reconfigureEditor(view, this.#optsFor(n));
  }

  #createNote(path: VaultPath, text: string, disk: FileContent | null, eol: LineEnding): Note {
    const readOnly = disk?.readOnly ?? false;
    const large = (disk?.size ?? 0) > LARGE_NOTE_BYTES;
    const state = createEditorState(text, this.host, {
      livePreview: settings.values.editorMode === "live" && !large,
      spellcheck: settings.values.spellcheck,
      readOnly,
    });
    const n: Note = {
      path,
      state,
      pristine: true,
      baseline: disk ? baselineOf(disk) : null,
      bom: disk?.bom ?? false,
      eol,
      lastSaved: text,
      version: 0,
      savedVersion: 0,
      firstDirtyAt: null,
      unsavedSince: null,
      timer: null,
      stuckTimer: null,
      inFlight: null,
      again: false,
      conflicting: null,
      frozen: false,
      disposed: false,
      failures: 0,
      toasted: false,
      epoch: currentEpoch(),
      recovery: false,
      recoveryOp: Promise.resolve(),
      readOnly,
      virtual: disk === null,
      large,
      scrollTop: 0,
      used: 0,
      readSeq: 0,
      moves: 0,
      conflict: null,
    };
    this.#notes.set(path, n);
    return n;
  }

  /** §8.4: unsaved text left by a failed save or close. */
  #applyRecovery(n: Note, rec: RecoveryCopy, disk: FileContent, text: string, eol: LineEnding): void {
    const recText = toLF(rec.content);
    if (recText === text) {
      void this.#clearRecovery(n);
      return;
    }
    // The whole baseline (mtime, size, hash) must match (SAVE-10): every empty file has the same
    // size and hash, so a new note at a deleted note's path must not take the old note's text.
    const b = rec.baseline;
    const unchanged =
      b !== null && b.size === disk.size && b.hash === disk.hash && Math.abs(b.mtime - disk.mtime) < MTIME_EPS_MS;
    if (unchanged) {
      // The file is still what the text was based on: restore it as an unsaved, undoable edit.
      this.#restoreUnsaved(n, recText);
      return;
    }
    // The file changed as well: open the file, keep the recovered text as a conflict copy.
    this.#recoveryToConflictCopy(n, fromLF(recText, eol), disk.bom);
  }

  /**
   * SAVE-10 for a note without a file (§8.3): only text typed there before whose file was never
   * created (no baseline) comes back as an unsaved edit. A copy based on a file that is gone now
   * (a deleted note) never fills a new note at its path (§8.4); it is kept as a conflict copy.
   */
  #applyVirtualRecovery(n: Note, rec: RecoveryCopy): void {
    const recText = toLF(rec.content);
    if (recText === "") void this.#clearRecovery(n);
    else if (rec.baseline === null) this.#restoreUnsaved(n, recText);
    else this.#recoveryToConflictCopy(n, recText, false);
  }

  /**
   * Recovered text that cannot go into the note is written next to it as a conflict copy. The
   * recovery copy is cleared only once that copy exists, and not when a newer one replaced it
   * meanwhile (a save of the note failed since): the safety net stays until the text is on disk.
   */
  #recoveryToConflictCopy(n: Note, content: string, bom: boolean): void {
    const path = n.path;
    void this.#writeConflictCopy(n, content, bom, false).then((copy) => {
      if (copy === null) {
        ui.notify(t("errConflictFailed", { name: displayName(path) }));
        return;
      }
      ui.notify(t("errConflict", { name: displayName(copy) }));
      if (n.recovery && n.path === path) return;
      void this.#recoveryOp(n, () => recoveryClear(path, n.epoch).catch(() => {}));
    });
  }

  /** Puts recovered text into a fresh controller as an unsaved, undoable edit; its first save clears the copy. */
  #restoreUnsaved(n: Note, recText: string): void {
    const ch = minimalChange(n.state.doc.toString(), recText);
    if (ch) n.state = n.state.update({ changes: ch }).state;
    n.version++;
    n.firstDirtyAt = n.unsavedSince = Date.now();
    n.recovery = true;
    this.#schedule(n);
    this.#updateStuck(n);
  }

  // ── History ──────────────────────────────────────────────────────────────

  async #go(dir: -1 | 1): Promise<void> {
    for (let guard = 0; guard < HISTORY_LIMIT; guard++) {
      const entry = this.#history.neighbor(dir);
      if (!entry) break;
      const r = await this.#openEntry(entry);
      if (r === "stale") return;
      if (r === "ok") {
        this.#history.moveTo(entry);
        break;
      }
      this.#history.remove((e) => e === entry); // NAV-03: entries for deleted notes are skipped
    }
    this.#syncHistory();
  }

  #openEntry(e: HistoryEntry, focus?: OpenOptions["focus"]): Promise<OpenResult> {
    const listed = vault.node(e.path) !== undefined;
    if (!listed && e.virtual) return this.#openVirtual(e.path, { history: false, focus });
    if (!listed && !vault.truncated) return Promise.resolve("failed");
    return this.#open(e.path, { history: false, focus });
  }

  /**
   * After the open file was removed: the previous history entry, else nothing (TREE-08, SAVE-07).
   * It takes keyboard focus only as the editor had it: a delete from the tree keeps the tree's.
   */
  async #fallback(focus: OpenOptions["focus"]): Promise<void> {
    for (let guard = 0; guard < HISTORY_LIMIT; guard++) {
      const entry = this.#history.current;
      if (!entry) break;
      const r = await this.#openEntry(entry, focus);
      if (r !== "failed") break;
      this.#history.remove((e) => e === entry);
    }
    this.#syncHistory();
  }

  #syncHistory(): void {
    this.canBack = this.#history.canBack;
    this.canForward = this.#history.canForward;
  }

  /** Drops every controller whose path matches, plus history and session entries. */
  #forget(match: (p: VaultPath) => boolean): void {
    let wasShown = this.path !== null && match(this.path);
    // Read before anything is disposed: dropping the shown note empties the view (and its find panel).
    const active = document.activeElement;
    const focus: OpenOptions["focus"] = this.#view && active !== null && this.#view.dom.contains(active) ? "editor" : "none";
    for (const n of [...this.#notes.values()]) {
      if (!match(n.path)) continue;
      if (n === this.#current) wasShown = true;
      this.#drop(n);
    }
    // A removed conflict copy is never overwritten (or recreated) by the 60 s storm rule.
    for (const n of this.#notes.values()) if (n.conflict && match(n.conflict.path)) n.conflict = null;
    this.#history.remove((e) => match(e.path));
    this.#rewriteSession((p) => (match(p) ? null : p));
    this.#syncHistory();
    if (wasShown) {
      ++this.#openSeq;
      this.#showNothing();
      void this.#fallback(focus);
    }
  }

  // ── Session ──────────────────────────────────────────────────────────────

  /**
   * Session lastFile, plus the switcher's recent list for notes (NAV-01). The position
   * stored for the previous lastFile no longer applies (#rememberPosition records anew).
   */
  #remember(path: VaultPath, isNote: boolean): void {
    const root = vault.info?.root;
    if (!root) return;
    const s = settings.session(root);
    const recent = isNote ? [path, ...s.recent.filter((p) => p !== path)].slice(0, RECENT_LIMIT) : s.recent;
    settings.updateSession(root, { lastFile: path, recent, last: s.lastFile === path ? s.last : undefined });
  }

  #rewriteSession(map: (p: VaultPath) => VaultPath | null): void {
    const root = vault.info?.root;
    if (!root) return;
    const s = settings.session(root);
    const recent: VaultPath[] = [];
    for (const p of s.recent) {
      const q = map(p);
      if (q !== null && !recent.includes(q)) recent.push(q);
    }
    const lastFile = s.lastFile === null ? null : map(s.lastFile);
    if (lastFile === s.lastFile && recent.length === s.recent.length && recent.every((p, i) => p === s.recent[i])) return;
    settings.updateSession(root, { recent, lastFile, last: lastFile === null ? undefined : s.last });
  }

  /**
   * VAULT-03: stores where the user is in the open note (selection, scroll, view mode)
   * as the session's `last`, which describes `lastFile`. Called on window blur or hide
   * and before close/quit; cheap when nothing moved.
   */
  #rememberPosition(): void {
    const root = vault.info?.root;
    const n = this.#current;
    if (!root || !n || n.disposed || this.kind !== "note" || this.path !== n.path) return;
    const s = settings.session(root);
    if (s.lastFile !== n.path) return; // virtual notes are never lastFile
    const { anchor, head } = this.#stateOf(n).selection.main;
    const scrollTop = Math.round(n === this.#installed && this.#scroller ? this.#scroller.scrollTop : n.scrollTop);
    const mode = this.viewMode;
    const p = s.last;
    if (p && p.anchor === anchor && p.head === head && p.scrollTop === scrollTop && p.mode === mode) return;
    settings.updateSession(root, { last: { anchor, head, scrollTop, mode } });
  }

  /** VAULT-03: puts back a remembered position, the selection clamped to the current text. */
  #restorePosition(n: Note, pos: NotePosition): void {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const len = this.#stateOf(n).doc.length;
    const clamp = (v: unknown) => Math.min(Math.max(0, Math.floor(num(v))), len);
    const selection = { anchor: clamp(pos.anchor), head: clamp(pos.head) };
    const view = this.#view;
    if (view && this.#installed === n) view.dispatch({ selection });
    else n.state = n.state.update({ selection }).state;
    if (pos.mode === "edit" || pos.mode === "read") this.viewMode = pos.mode;
    n.scrollTop = Math.max(0, num(pos.scrollTop));
    this.#restoreScroll(n.scrollTop);
  }

  // ── Autosave (§8.1) ──────────────────────────────────────────────────────

  #onDocChanged(): void {
    const n = this.#installed;
    if (!n || n.disposed) return;
    n.version++;
    const now = Date.now();
    n.firstDirtyAt ??= now;
    if (n.unsavedSince === null) {
      n.unsavedSince = now;
      this.#updateStuck(n);
    }
    this.revision++;
    // During a run of failures the retry timer keeps its back-off; it saves the latest text.
    if (n.failures === 0 || n.timer === null) this.#schedule(n);
  }

  #schedule(n: Note, delay?: number): void {
    if (n.disposed || n.frozen) return;
    this.#clearTimer(n);
    const [debounce, maxWait] = n.large ? [LARGE_DEBOUNCE_MS, LARGE_MAX_WAIT_MS] : [SAVE_DEBOUNCE_MS, SAVE_MAX_WAIT_MS];
    const now = Date.now();
    const ms = delay ?? saveDelay(now, n.firstDirtyAt ?? now, debounce, maxWait);
    n.timer = setTimeout(() => {
      n.timer = null;
      void this.#save(n);
    }, ms);
  }

  #clearTimer(n: Note): void {
    if (n.timer !== null) clearTimeout(n.timer);
    n.timer = null;
  }

  /** One write per note at a time; requests during a write collapse into one follow-up with the latest text. */
  #save(n: Note): Promise<void> {
    if (n.inFlight) {
      n.again = true;
      return n.inFlight;
    }
    if (n.conflicting) return n.conflicting;
    this.#clearTimer(n);
    if (n.disposed || n.frozen || n.readOnly || !dirty(n)) return Promise.resolve();
    const snap: Snapshot = {
      path: n.path,
      text: this.#stateOf(n).doc.toString(),
      version: n.version,
      baseline: n.baseline,
      bom: n.bom,
      eol: n.eol,
      moves: n.moves,
    };
    n.firstDirtyAt = null;
    // Nothing worth writing: a virtual note still empty (LINK-05), or text the file already holds.
    if ((n.virtual && snap.text === "") || (n.baseline !== null && snap.text === n.lastSaved)) {
      this.#markClean(n, snap.version, snap.text);
      return Promise.resolve();
    }
    const p = this.#write(n, snap).finally(() => {
      n.inFlight = null;
      if (n.again) {
        n.again = false;
        if (dirty(n)) void this.#save(n);
      }
    });
    n.inFlight = p;
    return p;
  }

  async #write(n: Note, snap: Snapshot): Promise<void> {
    const body = fromLF(snap.text, snap.eol);
    let result: Baseline;
    try {
      result =
        snap.baseline === null
          ? await noteCreate(snap.path, wellFormed((snap.bom ? BOM : "") + body), n.epoch)
          : await noteWrite(snap.path, body, { bom: snap.bom, expected: snap.baseline, epoch: n.epoch });
    } catch (e) {
      if (n.disposed) return;
      try {
        await this.#saveFailed(n, snap, e);
      } catch (err) {
        console.error("editor: save failure handling failed", err);
      }
      return;
    }
    if (!n.disposed) this.#saved(n, snap, result);
  }

  #saved(n: Note, snap: Snapshot, result: Baseline): void {
    if (n.moves !== snap.moves && nfc(n.path) !== nfc(snap.path)) {
      // Moved during the write: `result` describes the old path (which this write may even have
      // recreated), not the note's file. Keep the old baseline, which a rename carries over with
      // the file, and write the text again at the new path, as #saveFailed does. Respellings of
      // the same entry alone are no move: the write reached the note's file, `result` is its baseline.
      this.#schedule(n, 0);
      return;
    }
    const created = snap.baseline === null;
    n.baseline = result;
    n.lastSaved = snap.text;
    n.savedVersion = snap.version;
    n.failures = 0;
    n.toasted = false;
    if (dirty(n)) {
      n.unsavedSince = n.firstDirtyAt ?? Date.now();
      if (n.timer === null && !n.again) this.#schedule(n);
    } else n.unsavedSince = null;
    this.#updateStuck(n);
    if (n.recovery) void this.#clearRecovery(n);
    if (created) {
      const wasVirtual = n.virtual;
      n.virtual = false;
      this.#history.markReal(n.path);
      if (n === this.#current) {
        this.virtual = false;
        this.#remember(n.path, true);
        if (wasVirtual) vault.revealInTree(n.path);
      }
      // PLAT-06: adopt the name the listing reports (HFS+ stores NFD whatever we asked for).
      const path = n.path;
      void vault.refresh().then(() => {
        if (n.disposed || n.path !== path) return;
        const actual = vault.findExisting(path);
        if (actual === null || actual === path) return;
        this.onPathMoved(path, actual);
        vault.remapTreeState(path, actual);
        if (n === this.#current) vault.revealInTree(actual);
      });
    }
  }

  async #saveFailed(n: Note, snap: Snapshot, e: unknown): Promise<void> {
    if (n.path !== snap.path) {
      this.#schedule(n, 0); // moved during the write: save again at the new path
      return;
    }
    const kind = isIpcError(e) ? e.kind : "io";
    if (kind === "no_vault") return; // the vault was switched; its recovery copies were written then
    if (kind === "conflict" || kind === "exists") {
      await this.#reconcile(n, { afterFailedSave: true });
      // The read found no file (a file in the way of a missing folder, or a delete race) and
      // nothing is retrying: fail like any other save, with the toast, a recovery copy and back-off.
      if (!n.disposed && !n.frozen && !n.readOnly && dirty(n) && n.timer === null && !n.again && !n.conflicting)
        this.#failed(n, t("errSave", { name: displayName(n.path) }));
      return;
    }
    if (kind === "not_found" && snap.baseline !== null) {
      // SAVE-07: the file (or its folder) vanished; the next save recreates it.
      if (n.baseline === snap.baseline) n.baseline = null;
      this.#schedule(n, VANISHED_RETRY_MS);
      return;
    }
    if (kind === "read_only") {
      this.#setReadOnly(n, true);
      return;
    }
    this.#failed(n, kind === "root_unavailable" ? t("errRootUnavailable") : t("errSave", { name: displayName(n.path) }));
  }

  /** SAVE-08: keep the text dirty, one toast per run of failures, a recovery copy, back-off retry. */
  #failed(n: Note, message: string): void {
    n.failures++;
    if (!n.toasted) {
      n.toasted = true;
      ui.notify(message);
    }
    void this.#writeRecovery(n);
    this.#schedule(n, retryDelay(n.failures));
    this.#updateStuck(n);
  }

  /** The file holds `text` at `version` (no write needed). */
  #markClean(n: Note, version: number, text: string): void {
    n.savedVersion = version;
    n.lastSaved = text;
    if (!dirty(n)) {
      this.#clearTimer(n);
      n.firstDirtyAt = null;
      n.unsavedSince = null;
      n.failures = 0;
      n.toasted = false;
      if (n.recovery) void this.#clearRecovery(n);
    }
    this.#updateStuck(n);
  }

  async #flushNote(n: Note): Promise<void> {
    for (let i = 0; i < 4 && !n.disposed; i++) {
      const busy = n.inFlight ?? n.conflicting;
      if (busy) {
        await busy;
        continue;
      }
      if (n.frozen || n.readOnly || !dirty(n)) return;
      const failures = n.failures;
      await this.#save(n);
      if (n.failures > failures) return; // failed: its own retries continue
    }
  }

  #setReadOnly(n: Note, readOnly: boolean): void {
    if (n.readOnly === readOnly) return;
    n.readOnly = readOnly;
    if (n === this.#current) this.readOnly = readOnly; // attach()'s options effect reconfigures the view
    if (readOnly) {
      // SAVE-08: retrying cannot succeed; keep the unsaved text in a recovery copy.
      this.#clearTimer(n);
      if (dirty(n)) {
        void this.#writeRecovery(n);
        ui.notify(t("errReadOnly", { name: displayName(n.path) }));
      }
    } else if (dirty(n)) this.#schedule(n, 0);
    this.#updateStuck(n);
  }

  // ── External changes (§8.2) ──────────────────────────────────────────────

  async #reconcile(
    n: Note,
    opts: { afterFailedSave?: boolean; candidates?: readonly VaultPath[]; emptyConfirmed?: boolean } = {},
  ): Promise<void> {
    if (n.disposed) return;
    let seq = 0;
    let disk: FileContent | null = null;
    for (let attempt = 0; ; attempt++) {
      if (!opts.afterFailedSave) {
        // Let our own write land first, so its result is known before comparing.
        for (let i = 0; i < 3; i++) {
          const busy = n.inFlight ?? n.conflicting;
          if (!busy) break;
          await within(busy, SWITCH_FLUSH_MS);
        }
      }
      seq = ++n.readSeq;
      disk = null;
      try {
        disk = await noteRead(n.path, n.epoch);
      } catch (e) {
        if (n.disposed || seq !== n.readSeq) return;
        if (!isIpcError(e, "not_found")) {
          if (opts.afterFailedSave) this.#failed(n, t("errSave", { name: displayName(n.path) }));
          return;
        }
      }
      if (n.disposed || seq !== n.readSeq) return;
      // A save that started during the read may already be on disk without `lastSaved` knowing it.
      if (opts.afterFailedSave || (!n.inFlight && !n.conflicting) || attempt >= 2) break;
    }
    if (disk === null) {
      await this.#vanished(n, opts.candidates ?? []);
      return;
    }

    const text = toLF(disk.content);
    const eol = detectLineEnding(disk.content) ?? n.eol;
    const buf = this.#stateOf(n).doc.toString();
    if (text === buf || text === n.lastSaved) {
      // Our own echo, or a line-ending/BOM-only change: adopt the file's metadata and style.
      this.#adopt(n, disk, eol);
      if (text === buf) this.#markClean(n, n.version, text);
      else if (dirty(n) && n.timer === null) this.#schedule(n, 0);
      return;
    }
    if (!dirty(n) && n === this.#installed && this.#view?.composing) {
      await this.#compositionIdle(() => n.disposed || seq !== n.readSeq);
      if (n.disposed || seq !== n.readSeq) return;
    }
    if (dirty(n)) {
      await this.#startConflict(n, disk, text, eol);
      return;
    }
    if (text === "" && buf !== "" && !opts.emptyConfirmed) {
      // Cloud clients briefly leave empty files while syncing; a reload is not undoable.
      await sleep(EMPTY_GRACE_MS);
      if (n.disposed || seq !== n.readSeq) return;
      await this.#reconcile(n, { ...opts, emptyConfirmed: true });
      return;
    }
    this.#reload(n, disk, text, eol);
  }

  /** Clean buffer: apply the file in place with one minimal, unrecorded change (EDIT-10 for cached notes). */
  #reload(n: Note, disk: FileContent, text: string, eol: LineEnding): void {
    this.#adopt(n, disk, eol);
    n.lastSaved = text;
    if (n !== this.#current) {
      this.#drop(n); // an external change discards a cached, clean state
      return;
    }
    const view = this.#view;
    if (view && this.#installed === n) replaceDocMinimal(view, text);
    else {
      const ch = minimalChange(n.state.doc.toString(), text);
      if (ch)
        n.state = n.state.update({
          changes: ch,
          annotations: [External.of(true), Transaction.addToHistory.of(false)],
        }).state;
    }
    n.large = disk.size > LARGE_NOTE_BYTES;
    this.tooLarge = n.large; // attach()'s options effect reconfigures the view when this flips
    this.revision++;
  }

  #startConflict(n: Note, disk: FileContent, text: string, eol: LineEnding): Promise<void> {
    const p: Promise<void> = this.#conflict(n, disk, text, eol).finally(() => {
      if (n.conflicting === p) n.conflicting = null;
    });
    n.conflicting = p;
    return p;
  }

  /**
   * Dirty buffer vs a changed file (SAVE-06, P0): keep the disk version as a
   * byte-identical conflict copy, then save the local text over the file. If the
   * copy fails, the file stays untouched and the local text stays dirty.
   */
  async #conflict(n: Note, disk: FileContent, text: string, eol: LineEnding): Promise<void> {
    this.#clearTimer(n);
    if (text !== "") {
      const copy = await this.#writeConflictCopy(n, disk.content, disk.bom, true);
      if (n.disposed) return;
      if (copy === null) {
        this.#failed(n, t("errConflictFailed", { name: displayName(n.path) }));
        return;
      }
      ui.notify(t("errConflict", { name: displayName(copy) }));
    }
    this.#adopt(n, disk, eol);
    n.lastSaved = text;
    this.#schedule(n, 0); // expected = the disk version just copied: a third version conflicts again
  }

  /**
   * Writes `content` (the file's own line endings) next to the note as
   * "<stem> (conflict …).<ext>", BOM restored. With `storm`, a copy made for this
   * note within 60 s is overwritten instead of adding files, but only while that
   * copy is still exactly what we wrote and nobody has it open. Returns its path.
   */
  async #writeConflictCopy(n: Note, content: string, bom: boolean, storm: boolean): Promise<VaultPath | null> {
    const now = Date.now();
    const body = wellFormed(content);
    const prev = n.conflict;
    if (storm && prev && now - prev.at < CONFLICT_STORM_MS && this.#find(prev.path) === null) {
      try {
        // `expected`: an edited, moved or deleted copy fails (conflict / not_found) and is left alone.
        prev.baseline = baselineOf(await noteWrite(prev.path, body, { bom, expected: prev.baseline, epoch: n.epoch }));
        prev.at = now;
        void vault.refresh();
        return prev.path;
      } catch {
        // fall through to a fresh copy
      }
    }
    const dir = dirname(n.path);
    const name = basename(n.path);
    const date = new Date(now);
    for (let i = 0; i < 20; i++) {
      const copyName = conflictCopyName(name, date, i);
      const copyPath = dir === "" ? copyName : `${dir}/${copyName}`;
      let baseline: Baseline;
      try {
        baseline = await noteCreate(copyPath, (bom ? BOM : "") + body, n.epoch);
      } catch (e) {
        if (isIpcError(e, "exists")) continue;
        console.error("editor: conflict copy failed", e);
        return null;
      }
      if (storm) n.conflict = { path: copyPath, at: now, baseline: baselineOf(baseline) };
      void vault.refresh();
      return copyPath;
    }
    return null;
  }

  /** The file is gone (confirmed by a read). SAVE-07. */
  async #vanished(n: Note, candidates: readonly VaultPath[]): Promise<void> {
    if (n.virtual) return; // it never existed
    // A delete plus a create of the same text in one batch is a move. `version` goes with
    // `buf`: keystrokes typed during the reads below stay unsaved.
    const buf = this.#stateOf(n).doc.toString();
    const version = n.version;
    for (const c of candidates) {
      if (c === n.path || this.#notes.has(c)) continue;
      let other: FileContent;
      try {
        other = await noteRead(c, n.epoch);
      } catch {
        continue;
      }
      if (n.disposed) return;
      const otherText = toLF(other.content);
      if (otherText !== n.lastSaved && otherText !== buf) continue;
      const from = n.path;
      this.onPathMoved(from, c);
      vault.remapTreeState(from, c);
      this.#adopt(n, other, detectLineEnding(other.content) ?? n.eol);
      if (otherText === buf) this.#markClean(n, version, otherText);
      return;
    }
    if (dirty(n)) {
      // Keep the buffer; its next save recreates the file (and missing folders inside the vault).
      n.baseline = null;
      if (n.timer === null && !n.inFlight) this.#schedule(n);
      return;
    }
    const path = n.path;
    this.#forget((p) => p === path);
  }

  /** Adopts the file's metadata and style (EDIT-02: line-ending/BOM-only changes stick). */
  #adopt(n: Note, disk: FileContent, eol: LineEnding): void {
    n.baseline = baselineOf(disk);
    n.eol = eol;
    n.bom = disk.bom;
    if (n.virtual) {
      n.virtual = false;
      this.#history.markReal(n.path);
      if (n === this.#current) this.virtual = false;
    }
    this.#setReadOnly(n, disk.readOnly);
  }

  /** Resolves once no composition is active in the view (or `cancelled()`); EDIT-11. */
  async #compositionIdle(cancelled: () => boolean): Promise<void> {
    while (!cancelled()) {
      const view = this.#view;
      if (!view || !view.composing) return;
      await new Promise<void>((resolve) => {
        const dom = view.contentDOM;
        const done = () => {
          clearTimeout(timer);
          dom.removeEventListener("compositionend", done);
          resolve();
        };
        const timer = setTimeout(done, 200);
        dom.addEventListener("compositionend", done);
      });
      await sleep(0);
    }
  }

  // ── Recovery copies (SAVE-10) ────────────────────────────────────────────

  #recoveryOp(n: Note, op: () => Promise<void>): Promise<void> {
    const p = n.recoveryOp.then(op, op);
    n.recoveryOp = p.catch(() => {});
    return p;
  }

  #writeRecovery(n: Note): Promise<void> {
    n.recovery = true;
    const path = n.path;
    const text = wellFormed(this.#stateOf(n).doc.toString());
    const baseline = n.baseline;
    return this.#recoveryOp(n, () =>
      recoveryWrite(path, text, baseline, n.epoch).catch((e) => console.error("editor: recovery copy failed", e)),
    );
  }

  #clearRecovery(n: Note): Promise<void> {
    n.recovery = false;
    const path = n.path;
    return this.#recoveryOp(n, () => recoveryClear(path, n.epoch).catch(() => {}));
  }

  /** A pinned note with a recovery copy moved: the copy follows its new path. */
  #moveRecovery(n: Note, oldPath: VaultPath): Promise<void> {
    const path = n.path;
    const text = wellFormed(this.#stateOf(n).doc.toString());
    const baseline = n.baseline;
    return this.#recoveryOp(n, async () => {
      try {
        await recoveryWrite(path, text, baseline, n.epoch);
        await recoveryClear(oldPath, n.epoch);
      } catch (e) {
        console.error("editor: moving the recovery copy failed", e);
      }
    });
  }

  // ── Stuck saves (SAVE-09) ────────────────────────────────────────────────

  #updateStuck(n: Note): void {
    if (n.stuckTimer !== null) clearTimeout(n.stuckTimer);
    n.stuckTimer = null;
    let isStuck = false;
    if (!n.disposed && n.unsavedSince !== null && dirty(n)) {
      // Normal typing saves within the max wait; only failures, read-only text or hung writes go past it.
      const limit = n.failures > 0 || n.readOnly ? STUCK_MS : (n.large ? LARGE_MAX_WAIT_MS : SAVE_MAX_WAIT_MS) + STUCK_MS;
      const due = n.unsavedSince + limit - Date.now();
      if (due <= 0) isStuck = true;
      else
        n.stuckTimer = setTimeout(() => {
          n.stuckTimer = null;
          this.#updateStuck(n);
        }, due + 50);
    }
    if (isStuck) this.stuck.add(n.path);
    else this.stuck.delete(n.path);
    this.#syncStuck();
  }

  #syncStuck(): void {
    const s = this.path !== null && this.stuck.has(this.path);
    if (this.saveStuck !== s) this.saveStuck = s;
  }

  // ── Cache ────────────────────────────────────────────────────────────────

  #stateOf(n: Note): EditorState {
    return n === this.#installed && this.#view ? this.#view.state : n.state;
  }

  #find(path: VaultPath): Note | null {
    const exact = this.#notes.get(path);
    if (exact) return exact;
    const k = key(path);
    for (const n of this.#notes.values()) if (key(n.path) === k) return n;
    return null;
  }

  #under(path: VaultPath): Note[] {
    return [...this.#notes.values()].filter((n) => isSameOrAncestor(path, n.path));
  }

  /**
   * Disposes a controller: no timer fires and no in-flight result is applied any more.
   * A view showing it falls back to the blank state, so keystrokes can never go into a
   * disposed buffer that nothing saves; callers then show something else.
   */
  #drop(n: Note): void {
    n.disposed = true;
    this.#clearTimer(n);
    if (n.stuckTimer !== null) clearTimeout(n.stuckTimer);
    n.stuckTimer = null;
    if (this.#notes.get(n.path) === n) this.#notes.delete(n.path);
    if (this.stuck.delete(n.path)) this.#syncStuck();
    if (n === this.#current) this.#current = null;
    if (n === this.#installed) {
      this.#installed = null;
      this.#view?.setState(this.#blank());
    }
  }

  /**
   * `clash` had the path that the moved note `by` now owns. Its unsaved text, if any,
   * is kept as a conflict copy next to that path (a recovery copy if even that fails),
   * then it is disposed. Returns true when it was the note on screen.
   */
  #displace(clash: Note, by: Note): boolean {
    const shown = clash === this.#current || clash === this.#installed;
    if (dirty(clash)) {
      const text = this.#stateOf(clash).doc.toString();
      if (text !== "" && text !== this.#stateOf(by).doc.toString()) {
        const path = clash.path;
        void this.#writeConflictCopy(clash, fromLF(text, clash.eol), clash.bom, false).then((copy) => {
          if (copy !== null) {
            ui.notify(t("errConflict", { name: displayName(copy) }));
            return;
          }
          ui.notify(t("errConflictFailed", { name: displayName(path) }));
          void this.#recoveryOp(clash, () =>
            recoveryWrite(path, text, clash.baseline, clash.epoch).catch((e) => console.error("editor: recovery copy failed", e)),
          );
        });
      }
    }
    this.#drop(clash);
    return shown;
  }

  /** Keeps at most STATE_CACHE_SIZE controllers; busy or dirty ones are pinned. */
  #evict(): void {
    if (this.#notes.size <= STATE_CACHE_SIZE) return;
    const idle = [...this.#notes.values()]
      .filter((n) => n !== this.#current && !dirty(n) && !n.inFlight && !n.conflicting && !n.frozen && n.timer === null)
      .sort((a, b) => a.used - b.used);
    for (const n of idle) {
      if (this.#notes.size <= STATE_CACHE_SIZE) break;
      this.#drop(n);
    }
  }

  // ── Scrolling and positions ──────────────────────────────────────────────

  /** Restores `.doc-scroll` after CodeMirror's first measure, hidden for that frame. */
  #restoreScroll(top: number): void {
    const sc = this.#scroller;
    if (!sc) return;
    const token = ++this.#scrollToken;
    sc.style.visibility = "hidden";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (token === this.#scrollToken && this.#scroller === sc) sc.scrollTop = top;
      sc.style.visibility = "";
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 500); // rAF does not run while the window is hidden
  }

  /**
   * Puts the cursor on a 0-based line and scrolls it into view (NAV-05); with `select`,
   * selects that text's first occurrence in the line (SRCH-01). Also publishes
   * `lineRequest`, which the reading view follows: the hidden editor cannot scroll it.
   */
  #revealLine(line: number, y: "center" | "start", select?: string): void {
    ++this.#scrollToken; // a pending scroll restore must not undo this
    if (this.path !== null) this.lineRequest = { path: this.path, line, seq: ++this.#lineSeq };
    const view = this.#view;
    if (!view || !this.#installed) return;
    const doc = view.state.doc;
    const ln = doc.line(Math.min(Math.max(0, Math.floor(line)), doc.lines - 1) + 1);
    const hit = select ? findInLine(ln.text, select) : null;
    const anchor = ln.from + (hit?.from ?? 0);
    const head = ln.from + (hit?.to ?? 0);
    view.dispatch({ selection: { anchor, head }, effects: EditorView.scrollIntoView(anchor, { y, yMargin: 24 }) });
  }

  #scrollToHeading(subpath: string): void {
    const n = this.#current;
    if (!n) return;
    const line = findHeadingLine(this.#stateOf(n).doc.toString(), subpath);
    if (line !== null) this.#revealLine(line, "start");
  }

  // ── Links (§9.2) ─────────────────────────────────────────────────────────

  async #openLink(link: LinkTarget): Promise<void> {
    if (!vault.info) return;
    const from = this.path;
    if (link.kind === "wiki") {
      const target = link.target.trim();
      if (target === "") {
        if (link.subpath) this.#scrollToHeading(link.subpath);
        return;
      }
      const hit = vault.resolveWiki(target, from);
      if (hit !== null) {
        if ((await this.#show(hit)) && link.subpath) this.#scrollToHeading(link.subpath);
        return;
      }
      if (!mayBecomeNote(target)) return; // a missing image or another kind of file is not a note to create
      await this.#openUnresolved(target, from);
      return;
    }

    const href = link.href.trim();
    if (href === "") return;
    if (href.startsWith("#")) {
      this.#scrollToHeading(decodeLinkPath(href.slice(1)));
      return;
    }
    if (isExternalHref(href)) {
      // LINK-01: only web, mail and phone links leave the app; other schemes do nothing.
      if (EXTERNAL_SCHEMES.test(href)) await openUrl(href).catch(() => ui.notify(t("errGeneric")));
      return;
    }
    // A file literally named "C#.md" wins over reading "#" as an anchor (LINK-01).
    const literal = href.includes("#") ? vault.resolveHref(href.replace(/#/g, "%23"), from) : null;
    const hit = literal ?? vault.resolveHref(href, from);
    const hash = literal === null ? href.indexOf("#") : -1;
    if (hit !== null) {
      const anchor = hash >= 0 ? decodeLinkPath(href.slice(hash + 1)) : "";
      if ((await this.#show(hit)) && anchor) this.#scrollToHeading(anchor);
      return;
    }
    // A missing note target behaves like an unresolved wikilink (LINK-01, LINK-05).
    let dest = hash >= 0 ? href.slice(0, hash) : href;
    const q = dest.indexOf("?");
    if (q >= 0) dest = dest.slice(0, q);
    dest = decodeLinkPath(dest);
    if (dest === "" || !mayBecomeNote(dest)) return;
    // An existing file the listing does not show (a PDF, a folder…) is never shadowed by a new note.
    const seq = this.#openSeq;
    if (await this.#existsOnDisk(dest, from)) return;
    if (seq !== this.#openSeq) return; // another open started meanwhile
    await this.#openUnresolved(dest.startsWith("/") ? dest : `./${dest}`, from);
  }

  /**
   * Whether a link destination names an existing file the listing does not show,
   * relative to the note, then to the vault root (LINK-01). Listed folders do not
   * count: `[Ideas](Ideas)` next to an "Ideas" folder still means the note.
   */
  async #existsOnDisk(dest: string, from: VaultPath | null): Promise<boolean> {
    const tries = dest.startsWith("/")
      ? [normalizeRel(dest.slice(1))]
      : [normalizeRel(join(from === null ? "" : dirname(from), dest)), normalizeRel(dest)];
    for (const p of new Set(tries)) {
      if (p === null || p === "" || vault.node(p)?.kind === "dir") continue;
      if (await pathExists(p).catch(() => false)) return true;
    }
    return false;
  }

  async #openUnresolved(target: string, from: VaultPath | null): Promise<void> {
    const path = vault.linkTargetPath(target, from);
    if (path === null) {
      ui.notify(t("errNameInvalid"));
      return;
    }
    await this.#openVirtual(path, {});
  }

  async #show(path: VaultPath): Promise<boolean> {
    if (path === this.path) return true;
    return (await this.#open(path, {})) === "ok";
  }

  // ── Host helpers ─────────────────────────────────────────────────────────

  /**
   * [[ completion candidates: notes and images (LINK-04), rebuilt only when the vault's
   * list of them changes. Images keep their extension in title and link text (LINK-03).
   */
  #candidates(): readonly NoteCandidate[] {
    const files = vault.linkables;
    if (files !== this.#candFiles) {
      this.#candFiles = files;
      this.#candList = files.map((n) => ({
        path: n.path,
        kind: n.fileKind === "image" ? "image" : "note",
        title: n.title,
        folder: nfc(n.parent),
        linkText: vault.linkTextFor(n.path),
      }));
    }
    return this.#candList;
  }

  #resolveImage(src: string, kind: "wiki" | "href"): string | null {
    const s = src.trim();
    if (s === "") return null;
    if (kind === "href") {
      if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) return s;
      if (isExternalHref(s)) return null;
      const path = vault.resolveHref(s, this.path);
      return path === null ? null : this.#imageUrl(path);
    }
    const target = parseWikiInner(s).target;
    const path = target === "" ? null : vault.resolveWiki(target, this.path);
    return path === null ? null : this.#imageUrl(path);
  }

  /** asset:// URL for a listed image; `?v=<mtime>` reloads it when the file changes (TREE-15). */
  #imageUrl(path: VaultPath): string | null {
    if (fileKindOf(path) !== "image") return null;
    const node = vault.node(path);
    const url = vault.assetUrl(path);
    return node ? `${url}?v=${Math.trunc(node.mtime)}` : url;
  }

  /**
   * EDIT-08: saves an attachment for `note`, the note the paste or drop happened in
   * (never whatever is open by the time a multi-file save reaches this file), and
   * returns its Markdown, linked relative to that note.
   */
  async #saveAttachment(data: Uint8Array, ext: string, note: VaultPath | null): Promise<string | null> {
    const path = await vault.writeAttachment(note, data, ext);
    if (path === null) return null;
    const rel = relativeTo(note === null ? "" : dirname(note), path);
    // EDIT-08: spaces, parentheses, "%", "#" and "?" are percent-encoded; Hangul stays.
    return `![](${encodeLinkPath(rel).replace(/#/g, "%23").replace(/\?/g, "%3F")})`;
  }
}

export const editor = new EditorStore();
