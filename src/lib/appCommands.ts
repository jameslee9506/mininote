/**
 * The concrete global command list (ARCHITECTURE §9.1: shortcuts + command
 * palette) and the app-level actions it shares with the shell and the Welcome
 * screen: opening a vault or another window, and the close/quit flush (§8.4).
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { tick } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { t } from "./i18n";
import { appExitReady, appQuit, vaultForget, windowNew } from "./ipc/commands";
import { commands, type Command } from "./state/commands.svelte";
import { editor } from "./state/editor.svelte";
import { canDiscardNewNote, type NewNoteSnapshot } from "./state/newNote";
import { fresh } from "./state/newNote.svelte";
import { settings } from "./state/settings.svelte";
import { ui } from "./state/ui.svelte";
import { vault } from "./state/vault.svelte";
import type { StepKind } from "./state/fileSteps";
import type { VaultPath } from "./types";
import { matchShortcut } from "./utils/keys";
import { dirname } from "./utils/path";
import { isMac } from "./utils/platform";

// ── Vault opening ──────────────────────────────────────────────────────────

/** Recent vault roots that failed to open this session; the Welcome list dims them (VAULT-02). */
export const unavailableVaults = new SvelteSet<string>();

/**
 * Opens `root` as this window's vault (or brings forward the window that has it,
 * VAULT-07) and records whether it was reachable. vault.open reports failures
 * itself, except the automatic reopen at `startup`, which fails silently and
 * forgets only `lastVault` (VAULT-02). `file` names a file of the folder to show (PLAT-14).
 */
export async function openVault(root: string, opts?: { startup?: boolean; file?: string | null }): Promise<boolean> {
  let ok = false;
  try {
    ok = await vault.open(root, opts);
  } catch (e) {
    console.error("open vault failed", e); // a bug: vault.open handles its expected failures
    ui.notify(t("errVault"));
  }
  if (ok) unavailableVaults.delete(root);
  else unavailableVaults.add(root);
  return ok;
}

/**
 * Shows what the command line asked this window for while it was running (PLAT-14): the
 * folder `root` as its vault and, in it, the file named `file`. An overlay closes when what
 * is under it changes, so that the file is seen; a window that only comes forward keeps its own.
 */
export async function openRequest(root: string, file: string | null): Promise<void> {
  if (file !== null || vault.info?.root !== root) clearOverlays();
  await openVault(root, { file });
}

/**
 * Takes `root` off the recent vaults, with its session (VAULT-05); no file is touched. The list
 * has changed by the time the call returns, so a menu drawn right after it shows no such vault.
 * A window that has the folder open then closes it and shows Welcome: the backend tells it
 * (`vault:forgotten`, `closeForgottenVault`).
 */
export async function forgetVault(root: string): Promise<void> {
  settings.forgetVault(root);
  unavailableVaults.delete(root);
  try {
    await vaultForget(root);
  } catch (e) {
    console.error("forget vault failed", e);
    ui.notify(t("errGeneric"));
  }
}

/**
 * This window's vault left the recent vaults (`vault:forgotten`, VAULT-05): it closes as it does
 * for another vault, its saves flushed or kept in recovery copies, and the window shows Welcome.
 * An overlay over the vault closes with it. A window that shows another vault by now keeps it.
 *
 * The vault is forgotten here twice. Before it closes, so that Welcome never lists it: the other
 * window's change of the list may not have arrived yet. And after, because closing writes the
 * vault's session once more (VAULT-03), which must not outlive its place on the list (VAULT-04).
 */
export async function closeForgottenVault(root: string): Promise<void> {
  if (vault.info?.root === root) {
    clearOverlays();
    settings.forgetVault(root);
  }
  if (await vault.close(root)) settings.forgetVault(root);
}

/** Opens another window, on the Welcome screen, to show another folder (VAULT-07). */
export async function newWindow(): Promise<void> {
  try {
    await windowNew();
  } catch (e) {
    console.error("new window failed", e);
    ui.notify(t("errGeneric"));
  }
}

/** Asks for a folder with the native dialog and opens it as the vault. */
export async function openFolderDialog(): Promise<void> {
  let picked: string | null;
  try {
    picked = await openDialog({ directory: true, multiple: false });
  } catch (e) {
    console.error("folder dialog failed", e);
    ui.notify(t("errVault"));
    return;
  }
  if (picked) await openVault(picked);
}

// ── Close and quit (ARCHITECTURE §8.4, SAVE-02, SAVE-10) ───────────────────

/** A backstop over flushOrRecover's own caps (2 s flush, then about 1 s of recovery writes). */
const EDITOR_EXIT_TIMEOUT_MS = 3200;
/** Keeps the whole sequence under the backend's 4 s exit fallback. */
const SETTINGS_TIMEOUT_MS = 600;

/** Runs `fn`, turning a synchronous throw into a rejection. */
function attempt(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return fn();
  } catch (e) {
    return Promise.reject(e);
  }
}

/** True when `p` fulfils within `ms`; false when it rejects or takes longer. Never rejects. */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true, () => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

let exitFlush: Promise<void> | null = null;

/**
 * Close/quit sequence: flush every dirty note (2 s cap) → recovery copies for
 * whatever is still unsaved (about 1 s cap) → flush settings. Never rejects and
 * always finishes within about 4 s, so closing can never hang. Concurrent callers share one run.
 */
export function flushBeforeExit(): Promise<void> {
  exitFlush ??= (async () => {
    await settlesWithin(attempt(editor.flushOrRecover), EDITOR_EXIT_TIMEOUT_MS);
    await settlesWithin(attempt(settings.flush), SETTINGS_TIMEOUT_MS);
  })().finally(() => {
    exitFlush = null;
  });
  return exitFlush;
}

/** Flushes this window, then tells the backend, which exits once every window has (`app:flush-request`). */
export async function quitApp(): Promise<void> {
  await flushBeforeExit();
  try {
    await appExitReady();
  } catch (e) {
    // Destroying the last window still ends the app.
    console.error("app_exit_ready failed", e);
    await getCurrentWindow()
      .destroy()
      .catch(() => {});
  }
}

/** Quit (Ctrl+Q on Windows/Linux): the backend asks every window to flush first (ARCHITECTURE §6.6). */
async function requestQuit(): Promise<void> {
  try {
    await appQuit();
  } catch (e) {
    console.error("app_quit failed", e);
    await quitApp();
  }
}

// ── Commands ───────────────────────────────────────────────────────────────

const hasVault = (): boolean => vault.info !== null;
const hasFile = (): boolean => hasVault() && editor.path !== null;
const hasNote = (): boolean => hasFile() && editor.kind === "note";
/** An open file that exists on disk (virtual notes have no file yet). */
const hasRealFile = (): boolean => hasFile() && !editor.virtual;

/** Closes transient overlays before a command changes what the main area shows. */
function clearOverlays(): void {
  ui.closeModal();
  ui.hideMenu();
}

/** The sidebar with its file tree (a search in progress gives way to it). */
function showFilesPanel(): void {
  if (!settings.values.sidebarVisible) ui.toggleSidebar();
  ui.showFiles();
}

// ── New note and folder (shared by the commands, the sidebar header and the tree menus) ──

let discardingNewNote: NewNoteSnapshot | null = null;
/** The discard a click in the sidebar started (leaveNewNote): over once the note's name is free again. */
let leaving: Promise<void> = Promise.resolve();

function noteSnapshot(): NewNoteSnapshot {
  return { epoch: vault.info?.epoch ?? null, path: editor.path, revision: editor.revision };
}

/**
 * Nothing keeps keyboard focus while a note is created and opened, so keys typed meanwhile
 * never land in the previous note or its title (DS-4). An overlay closed just before restores
 * its focus when it unmounts, so this runs after that.
 */
async function releaseFocus(): Promise<void> {
  await tick();
  editor.blur();
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.blur();
}

/** The editor takes focus back when nothing else has it (an action that released it opened nothing). */
function refocusEditor(): void {
  const active = document.activeElement;
  if (active === null || active === document.body) editor.focusEditor();
}

/**
 * New note (TREE-04): created on disk, then opened with the caret in its title, where its name
 * shows as a placeholder (in its body where the title is hidden). `fresh` holds it for as long
 * as nothing is typed in it. Focus is released first (DS-4); the editor gets it back when
 * nothing opens.
 */
export async function newNote(opts?: { dir?: VaultPath }): Promise<VaultPath | null> {
  await leaving;
  // The note made a moment ago, with nothing typed in it, is the new note already: asking
  // again brings the caret back to its title. It makes way when another folder is asked for.
  const blank = fresh.blank ? editor.path : null;
  if (blank !== null) {
    if (dirname(blank) === (opts?.dir ?? vault.newNoteDir())) {
      await editor.open(blank, { focus: "title" });
      return blank;
    }
    fresh.note = null;
    await vault.discard(blank);
  }
  const epoch = vault.info?.epoch;
  fresh.note = null;
  await releaseFocus();
  let created: VaultPath | null = null;
  try {
    created = await vault.createNote(opts);
  } finally {
    if (created === null) refocusEditor();
  }
  if (created !== null && editor.path === created && vault.info?.epoch === epoch) fresh.note = noteSnapshot();
  return created;
}

/**
 * Escape in the title/body cancels only the untouched note just created by newNote(). From the
 * body, a title typed for it keeps it: its rename may still be on its way.
 */
export function discardNewNote(title?: string): boolean {
  const draft = fresh.note;
  if (!draft || ui.modal !== null || ui.menu !== null || ui.confirmDialog !== null) return false;
  const eligible = (): boolean =>
    fresh.note === draft &&
    !editor.loading &&
    !editor.readOnly &&
    (title !== undefined || !fresh.titled) &&
    canDiscardNewNote(draft, noteSnapshot(), editor.getText(), title);
  if (!eligible() || draft.path === null) return false;
  if (discardingNewNote === draft) return true;
  const path = draft.path;
  discardingNewNote = draft;
  void safe(async () => {
    try {
      // Never kept, so no undo brings it back (TREE-21).
      if ((await vault.remove(path, { guard: eligible, record: false })) && fresh.note === draft) fresh.note = null;
    } finally {
      if (discardingNewNote === draft) discardingNewNote = null;
    }
  })();
  return true;
}

/**
 * A click in the sidebar leaves the new note that has nothing typed in it, title or text, and
 * that note goes to the trash with no question (TREE-04). A file the click opens is shown
 * first: the editor then drops a note it no longer shows, and no open is cut short.
 */
export function leaveNewNote(): void {
  const draft = fresh.note;
  if (draft === null || draft.path === null || !fresh.blank || discardingNewNote === draft) return;
  const path = draft.path;
  leaving = safe(async () => {
    await editor.settled();
    // Not a note of another vault, and not one the user came back to and typed in meanwhile.
    if (fresh.note !== draft || vault.info?.epoch !== draft.epoch) return;
    if (editor.path === path && !fresh.blank) return;
    fresh.note = null;
    await vault.discard(path);
  })();
}

/** New folder (TREE-05): a draft row in the tree, which must be on screen; nothing is written until its name is committed. */
export async function newFolder(dir?: VaultPath): Promise<void> {
  showFilesPanel();
  await vault.createFolder(dir);
}

// ── Undo and redo of a file operation (TREE-21) ────────────────────────────

/**
 * The system's undo or redo key, as a step of the file operations: Mod+Z, Mod+Shift+Z, and
 * Ctrl+Y where that is redo. The keys are the text's wherever text is edited (and reserved,
 * SET-06), so they are no command of the registry, which would take them everywhere: the tree
 * asks while it has the keyboard, and the shell while nothing is shown.
 */
export function fileStepKey(e: KeyboardEvent): StepKind | null {
  if (matchShortcut(e, "Mod-z")) return "undo";
  if (matchShortcut(e, "Mod-Shift-z") || (!isMac && matchShortcut(e, "Mod-y"))) return "redo";
  return null;
}

/** Takes back the last file operation, or does again the one taken back last. */
export function runFileStep(kind: StepKind): void {
  void safe(() => (kind === "undo" ? vault.undo() : vault.redo()))();
}

const MAX_QUERY_CHARS = 200;

/**
 * First non-empty line of the current selection, trimmed and capped: the search pre-fill.
 * The editor's own selection first (the DOM one lags behind after the palette closes),
 * then the page's (reading view).
 */
function selectionQuery(): string {
  const text = editor.selectedText() || (window.getSelection()?.toString() ?? "");
  const line = text.split(/\r\n?|\n/).find((l) => l.trim() !== "") ?? "";
  return Array.from(line.trim()).slice(0, MAX_QUERY_CHARS).join("");
}

/** Wraps a command body so an unexpected failure surfaces as one error toast. */
function safe(fn: () => unknown): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (e) {
      console.error("command failed", e);
      ui.notify(t("errGeneric"));
    }
  };
}

function renameActive(): void {
  const path = editor.path;
  if (path === null) return;
  clearOverlays();
  // A PDF fills its pane and shows no inline title: it is renamed in the tree.
  if (settings.values.inlineTitle && editor.kind !== "pdf") {
    ui.focusTitle();
    return;
  }
  showFilesPanel();
  vault.revealInTree(path);
  vault.renaming = path;
}

/**
 * Engine keys the webview never acts on (PLAT-13): reload in every engine (Ctrl+F5 is "Mod-F5"
 * where Mod is Ctrl; the keyboard's Refresh key reloads WebView2, whose browser accelerator keys
 * stay on), and print and save-page, which stay inert once the user moves the palette or Save
 * off them (SET-06). A command the user binds to one of them still runs: it comes first.
 */
const ENGINE_KEYS = [
  "F5",
  "Shift-F5",
  "Mod-r",
  "Mod-Shift-r",
  isMac ? "Ctrl-F5" : "Mod-F5",
  "BrowserRefresh",
  "Shift-BrowserRefresh",
  "Mod-BrowserRefresh",
  "Mod-p",
  "Mod-s",
];
/** History keys (NAV-03): macOS keeps Option+arrows for word moves. The first one shows in the palette. */
const BACK_KEYS = [isMac ? "Mod-[" : "Alt-ArrowLeft", "Mod-Alt-ArrowLeft"];
const FORWARD_KEYS = [isMac ? "Mod-]" : "Alt-ArrowRight", "Mod-Alt-ArrowRight"];

/** Registers every global command (call once at startup; re-registering replaces by id). */
export function registerAppCommands(): void {
  const list: Command[] = [
    {
      id: "new-note",
      label: "cmdNewNote",
      keys: ["Mod-n"],
      when: hasVault,
      run: safe(() => {
        clearOverlays();
        return newNote();
      }),
    },
    {
      id: "new-folder",
      label: "cmdNewFolder",
      keys: ["Mod-Shift-n"],
      when: hasVault,
      run: safe(() => {
        clearOverlays();
        return newFolder();
      }),
    },
    {
      // TREE-03: also the sidebar header's icon.
      id: "collapse-all",
      label: "collapseAll",
      when: hasVault,
      run: () => vault.collapseAll(),
    },
    {
      id: "quick-switcher",
      label: "cmdQuickSwitcher",
      keys: ["Mod-o"],
      when: hasVault,
      run: () => ui.openModal("switcher"),
    },
    {
      id: "command-palette",
      label: "cmdCommandPalette",
      keys: ["Mod-p"],
      hidden: true,
      run: () => ui.openModal("palette"),
    },
    {
      id: "search",
      label: "cmdSearch",
      keys: ["Mod-Shift-f"],
      when: hasVault,
      run: () => {
        const query = selectionQuery();
        clearOverlays();
        ui.showSearch(query);
      },
    },
    {
      id: "toggle-view",
      label: "cmdToggleView",
      keys: ["Mod-e"],
      when: hasNote,
      run: safe(() => {
        clearOverlays();
        editor.toggleViewMode();
      }),
    },
    {
      id: "toggle-sidebar",
      label: "cmdToggleSidebar",
      keys: ["Mod-b", "Mod-\\"],
      when: hasVault,
      run: () => ui.toggleSidebar(),
    },
    {
      id: "settings",
      label: "cmdSettings",
      keys: ["Mod-,"],
      run: () => ui.openModal("settings"),
    },
    {
      id: "save",
      label: "cmdSave",
      keys: ["Mod-s"],
      when: hasVault,
      run: safe(() => editor.flush()),
    },
    {
      id: "back",
      label: "cmdBack",
      keys: BACK_KEYS,
      fixedKeys: ["BrowserBack"],
      when: () => hasVault() && editor.canBack,
      run: safe(() => {
        clearOverlays();
        return editor.back();
      }),
    },
    {
      id: "forward",
      label: "cmdForward",
      keys: FORWARD_KEYS,
      fixedKeys: ["BrowserForward"],
      when: () => hasVault() && editor.canForward,
      run: safe(() => {
        clearOverlays();
        return editor.forward();
      }),
    },
    {
      id: "rename-active",
      label: "cmdRenameActive",
      keys: ["F2"],
      inInputs: false,
      // Without the inline title, renaming falls back to the tree row, which a virtual note lacks.
      when: () => hasFile() && !editor.readOnly && (settings.values.inlineTitle || !editor.virtual),
      run: safe(renameActive),
    },
    {
      id: "toggle-editor-mode",
      label: "cmdToggleEditorMode",
      when: hasVault,
      run: () => settings.update({ editorMode: settings.values.editorMode === "live" ? "source" : "live" }),
    },
    {
      id: "open-vault",
      label: "cmdOpenVault",
      run: safe(openFolderDialog),
    },
    {
      // VAULT-07: another window, on the Welcome screen. ⌥⌘N is Mail's new window, beside ⌘N and
      // ⇧⌘N for a new note and folder. Ctrl+Alt+N would be AltGr+N, which types a character on
      // many Windows layouts, so elsewhere it is Ctrl+M, OneNote's new window.
      id: "new-window",
      label: "cmdNewWindow",
      keys: [isMac ? "Mod-Alt-n" : "Mod-m"],
      run: newWindow,
    },
    {
      // VAULT-08: as the window's close button, so the window flushes first (§8.4); the last
      // window to close ends the app. macOS closes through the Window menu's Close Window and its ⌘W.
      id: "close-window",
      label: "cmdCloseWindow",
      keys: isMac ? [] : ["Mod-w"],
      fixed: isMac,
      run: safe(() => getCurrentWindow().close()),
    },
    {
      // TREE-11: from anywhere, focus the tree at the open file's row, revealing it.
      id: "focus-files",
      label: "cmdFocusFiles",
      keys: ["Mod-Shift-e"],
      when: hasVault,
      run: () => {
        clearOverlays();
        if (editor.path !== null) vault.revealInTree(editor.path);
        ui.focusTree();
      },
    },
    {
      id: "close-note",
      label: "cmdCloseNote",
      when: hasFile,
      run: safe(() => {
        clearOverlays();
        return editor.close();
      }),
    },
    {
      id: "reveal-active",
      label: "cmdRevealActive",
      when: hasRealFile,
      run: safe(() => (editor.path === null ? undefined : vault.revealInOs(editor.path))),
    },
    {
      id: "delete-active",
      label: "cmdDeleteActive",
      when: hasRealFile,
      run: safe(() => {
        clearOverlays();
        return editor.path === null ? undefined : vault.remove(editor.path);
      }),
    },
    {
      id: "quit",
      label: "cmdQuit",
      // macOS quits through the app menu's custom Quit item and its ⌘Q (ARCHITECTURE §6.6).
      keys: isMac ? [] : ["Mod-q"],
      fixed: isMac,
      run: requestQuit,
    },
    {
      // Matching is enough: the registry cancels the key. Hidden and fixed, so the label never shows.
      // Last, so a command the user binds to one of these keys runs instead.
      id: "engine-keys",
      label: "cmdSave",
      keys: ENGINE_KEYS,
      hidden: true,
      fixed: true,
      run: () => {},
    },
  ];
  commands.register(list);
}
