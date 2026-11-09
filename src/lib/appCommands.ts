/**
 * The concrete global command list (ARCHITECTURE §9.1: shortcuts + command
 * palette) and the app-level actions it shares with the shell and the Welcome
 * screen: opening a vault, and the close/quit flush (§8.4).
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { tick } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { t } from "./i18n";
import { appExitReady } from "./ipc/commands";
import { commands, type Command } from "./state/commands.svelte";
import { editor } from "./state/editor.svelte";
import { canDiscardNewNote, type NewNoteSnapshot } from "./state/newNote";
import { settings } from "./state/settings.svelte";
import { ui } from "./state/ui.svelte";
import { vault } from "./state/vault.svelte";
import type { VaultPath } from "./types";
import { isMac } from "./utils/platform";

// ── Vault opening ──────────────────────────────────────────────────────────

/** Recent vault roots that failed to open this session; the Welcome list dims them (VAULT-02). */
export const unavailableVaults = new SvelteSet<string>();

/**
 * Opens `root` as the vault and records whether it was reachable. vault.open
 * reports failures itself, except the automatic reopen of the last vault at
 * startup, which fails silently and forgets only `lastVault` (VAULT-02).
 */
export async function openVault(root: string): Promise<boolean> {
  let ok = false;
  try {
    ok = await vault.open(root);
  } catch (e) {
    console.error("open vault failed", e); // a bug: vault.open handles its expected failures
    ui.notify(t("errVault"));
  }
  if (ok) unavailableVaults.delete(root);
  else unavailableVaults.add(root);
  return ok;
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

/** Flushes, then lets the backend exit (Ctrl+Q on Windows/Linux, and `app:flush-request`). */
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

let newNoteDraft: NewNoteSnapshot | null = null;
let discardingNewNote: NewNoteSnapshot | null = null;

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
 * New note (TREE-04): created on disk, then opened with the caret at the start of its body.
 * Focus is released first (DS-4); the editor gets it back when nothing opens.
 */
export async function newNote(opts?: { dir?: VaultPath }): Promise<VaultPath | null> {
  const epoch = vault.info?.epoch;
  newNoteDraft = null;
  await releaseFocus();
  let created: VaultPath | null = null;
  try {
    created = await vault.createNote(opts);
  } finally {
    if (created === null) refocusEditor();
  }
  if (created !== null && editor.path === created && vault.info?.epoch === epoch) newNoteDraft = noteSnapshot();
  return created;
}

/** Escape in the title/body cancels only the untouched note just created by newNote(). */
export function discardNewNote(title?: string): boolean {
  const draft = newNoteDraft;
  if (!draft || ui.modal !== null || ui.menu !== null || ui.confirmDialog !== null) return false;
  const eligible = (): boolean =>
    newNoteDraft === draft &&
    !editor.loading &&
    !editor.readOnly &&
    canDiscardNewNote(draft, noteSnapshot(), editor.getText(), title);
  if (!eligible() || draft.path === null) return false;
  if (discardingNewNote === draft) return true;
  const path = draft.path;
  discardingNewNote = draft;
  void safe(async () => {
    try {
      if ((await vault.remove(path, eligible)) && newNoteDraft === draft) newNoteDraft = null;
    } finally {
      if (discardingNewNote === draft) discardingNewNote = null;
    }
  })();
  return true;
}

/** New folder (TREE-05): a draft row in the tree, which must be on screen; nothing is written until its name is committed. */
export async function newFolder(dir?: VaultPath): Promise<void> {
  showFilesPanel();
  await vault.createFolder(dir);
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
  if (settings.values.inlineTitle) {
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
      run: quitApp,
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
