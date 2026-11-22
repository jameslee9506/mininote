/**
 * Shared data types. This file is a CONTRACT between the Rust backend, the
 * IPC layer, the stores and the UI — change it deliberately.
 */

/**
 * A vault-relative path with "/" separators, exactly as the backend returned
 * it (NOT Unicode-normalized, so it round-trips to the filesystem).
 * The vault root itself is "".
 */
export type VaultPath = string;

export type EntryKind = "dir" | "file";

export interface VaultInfo {
  /** Absolute, canonical path of the vault root with OS-native separators. */
  root: string;
  /** Last path component of the root. */
  name: string;
  /**
   * Incremented by every `vault_open`. Every vault-scoped command carries it
   * (ipc/commands.ts does this automatically) and Rust rejects stale ones, so
   * nothing started for a previous vault can touch the new one.
   */
  epoch: number;
}

/**
 * The backend's flat listing (`vault_list`), one column per field so that a big
 * vault crosses IPC as a few flat arrays: entry `i` is `paths[i]`, `kinds[i]`
 * and `mtimes[i]`.
 */
export interface ListResult {
  /** Breadth-first: every folder comes before its contents. */
  paths: VaultPath[];
  /** One character per entry: "d" for a folder, "f" for a file. */
  kinds: string;
  /** Modification time of notes and images in whole ms since the Unix epoch; 0 for everything else. */
  mtimes: number[];
  /**
   * The listed images that are links (symlinks), each with the absolute path of the file it
   * leads to. The asset protocol serves that file, and no link (TREE-18).
   */
  realPaths: Record<VaultPath, string>;
  /** True when the backend stopped early because the vault is enormous. */
  truncated: boolean;
}

/**
 * What a file opens as: a note in the editor, an image in its viewer, a PDF in its
 * viewer (TREE-20), a code or plain-text file in the read-only code view (TREE-17).
 * Every other file is "other" and only says that its type is not supported (TREE-16).
 */
export type FileKind = "note" | "image" | "pdf" | "code" | "other";

export interface TreeNode {
  path: VaultPath;
  /** Last path component, NFC-normalized for display and matching. */
  name: string;
  /** Display title: notes drop their ".md" extension; others equal `name`. */
  title: string;
  kind: EntryKind;
  /** null for directories. */
  fileKind: FileKind | null;
  /** Lower-case extension without the dot; "" for directories. */
  ext: string;
  /** Whole ms since the Unix epoch for notes and images (the listing's); 0 otherwise. */
  mtime: number;
  /** Parent directory path ("" for top-level entries). */
  parent: VaultPath;
  /** 0 for top-level entries. The root node has depth -1. */
  depth: number;
  /**
   * Children in listing order, null for files. Read them through `sortedChildren`
   * (state/tree.ts) wherever order matters: it sorts a folder when first shown.
   */
  children: TreeNode[] | null;
}

/** What a file looked like when we last read or wrote it (save-time conflict check). */
export interface Baseline {
  /** ms since the Unix epoch. */
  mtime: number;
  size: number;
  /** Stable 64-bit content hash (hex) computed by Rust; decides when mtime is coarse. */
  hash: string;
}

export interface FileContent extends Baseline {
  /** UTF-8 text with a leading BOM removed. Line endings are preserved as-is. */
  content: string;
  /** The file started with a UTF-8 BOM (restore it on save). */
  bom: boolean;
  /** The file is not writable (open the note read-only). */
  readOnly: boolean;
  /**
   * When the file was created, in ms since the Unix epoch; null where the volume records
   * no such date. The inline title shows it on macOS and Windows, where a save keeps it
   * (SAVE-04, EDIT-15).
   */
  created: number | null;
}

export type WriteResult = Baseline;

/** Unsaved text kept in the app-data folder after a failed save/close (SAVE-10). */
export interface RecoveryCopy {
  path: VaultPath;
  content: string;
  /** Baseline of the file the text was based on (null if the file did not exist). */
  baseline: Baseline | null;
  /** ms since the Unix epoch. */
  savedAt: number;
}

export type ChangeKind = "create" | "modify" | "remove" | "rename" | "any";

export interface VaultChange {
  kind: ChangeKind;
  path: VaultPath;
  /** Only for kind === "rename": the destination path. */
  to?: VaultPath;
}

/** Payload of the `vault:changed` event (already debounced/batched by Rust). */
export interface VaultChangedPayload {
  changes: VaultChange[];
}

export interface SearchMatch {
  /** 0-based line number in the file. */
  line: number;
  /** The (possibly trimmed) line text shown as a snippet. */
  text: string;
  /** [start, end) UTF-16 offsets into `text` for each hit. */
  ranges: [number, number][];
}

export interface SearchFileResult {
  path: VaultPath;
  /** True when the query also matches the file name. */
  nameMatch: boolean;
  matches: SearchMatch[];
}

export interface SearchResponse {
  results: SearchFileResult[];
  /** True when result limits cut the response short. */
  truncated: boolean;
}

export type ThemeMode = "system" | "light" | "dark";
/** How the tree draws a folder (SET-08): in outline like the files, solid in gray, or solid in a color. */
export type IconTheme = "outline" | "filled" | "color";
/** "live" = Obsidian-style live preview; "source" = plain highlighted markdown. */
export type EditorMode = "live" | "source";
/** Per-session toggle (Mod-E): edit with CodeMirror or read rendered HTML. */
export type ViewMode = "edit" | "read";

export interface Settings {
  /** Content (editor + reading view) font size in px. Default 15. */
  fontSize: number;
  /**
   * The monospaced family of everything shown as code: code files, code blocks, inline
   * code. "" uses the default stack (SET-07).
   */
  codeFont: string;
  /** Max content column width in px; 0 means full width. Default 720. */
  lineWidth: number;
  theme: ThemeMode;
  /** The tree's icon set (SET-08). Default "filled". */
  iconTheme: IconTheme;
  editorMode: EditorMode;
  spellcheck: boolean;
  /** Show the editable file name above the document. */
  inlineTitle: boolean;
  /** Where Mod-N creates notes: the active folder, or the vault root. */
  newNoteLocation: "current" | "root";
  /** Where pasted/dropped images go: next to the note, the vault root, or one vault folder. */
  attachmentLocation: "same" | "root" | "folder";
  /** Vault-relative folder used when attachmentLocation === "folder" (created on demand). */
  attachmentFolder: string;
  /** Ask before moving files/folders to the trash. */
  confirmDelete: boolean;
  /** Window layout: each window keeps its own, and the last one changed is what new windows start with. */
  sidebarVisible: boolean;
  sidebarWidth: number;
  /**
   * The user's shortcuts (SET-06): command id → canonical key specs ("Mod-Shift-p"),
   * replacing that command's default keys; [] unbinds it. Other commands keep their defaults.
   */
  shortcuts: Record<string, string[]>;
  /** Absolute vault paths, most recent first (max 10). */
  recentVaults: string[];
  /** The vault opened last. The first window reopens it while no window list was saved yet (`WindowStartup`). */
  lastVault: string | null;
}

/** Per-vault UI session, persisted alongside settings keyed by vault root. */
export interface VaultSession {
  expanded: VaultPath[];
  lastFile: VaultPath | null;
  /** Recently opened files, most recent first (max 50) — the quick switcher's empty state. */
  recent: VaultPath[];
  /** Where the user left `lastFile` (VAULT-03): selection, scroll and view mode. */
  last?: { anchor: number; head: number; scrollTop: number; mode: ViewMode };
}

/**
 * A change to the settings document (`settings_update`): the settings a window changed, and the
 * vault sessions it replaced, by vault root (null removes one).
 */
export interface SettingsPatch {
  settings?: Partial<Settings>;
  sessions?: Record<string, VaultSession | null>;
}

/**
 * Payload of `settings:changed`: a patch as the backend applied it, sent to every window in the
 * order applied. `origin` is the label of the window that wrote it.
 */
export interface SettingsChangedPayload extends SettingsPatch {
  origin: string;
}

/**
 * What a window opens (`window_startup`): when its page starts (VAULT-07), and again whenever
 * `window:open` says the command line asked it for something (PLAT-14).
 */
export interface WindowStartup {
  /** The folder to open as its vault: the one this window had open when the app last ran, or the one asked for. */
  vault: string | null;
  /** The file to show in that folder: its name there, in the spelling the command line gave it. */
  file: string | null;
  /** No window list was saved yet (an older version ran last): reopen `Settings.lastVault`. */
  last: boolean;
}

/**
 * Whether the `mininote` command is in the shell's PATH and starts this app (`cli_status`,
 * PLAT-14); null where the app cannot put it there.
 */
export type CliStatus = boolean | null;

/** Error object every rejected `invoke` carries (serialized by Rust). */
export type IpcErrorKind =
  | "no_vault"
  | "root_unavailable"
  | "invalid_path"
  | "not_found"
  | "exists"
  | "conflict"
  | "read_only"
  | "not_utf8"
  | "too_large"
  | "trash_failed"
  | "io";

export interface IpcErrorPayload {
  kind: IpcErrorKind;
  message: string;
}
