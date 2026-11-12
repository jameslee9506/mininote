/**
 * Active vault: listing, derived tree/index, tree UI state, file operations and
 * watcher integration. See docs/ARCHITECTURE.md §7–8.
 *
 * Paths from the listing are identities (byte-identical, never normalized);
 * user- or watcher-supplied spellings are matched to them with key().
 */
import { untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { ListResult, TreeNode, VaultChangedPayload, VaultInfo, VaultPath } from "../types";
import { buildLinkIndex, resolveMarkdownHref, resolveWikiTarget, wikiLinkText, type LinkIndex } from "../markdown/resolve";
import {
  binaryWrite,
  dirCreate,
  isIpcError,
  noteCreate,
  pathDelete,
  pathExists,
  pathRename,
  pathReveal,
  pathTrash,
  vaultList,
  vaultOpen,
} from "../ipc/commands";
import { onVaultChanged } from "../ipc/events";
import { t } from "../i18n";
import { buildTree, compareNodes, EMPTY_LISTING, flattenVisible, type TreeRow } from "./tree";
import { basename, dirname, isSameOrAncestor, join, key, nfc, normalizeRel, rebase, toAbsolute } from "../utils/path";
import { fileKindOf, pastedImageName, titleOf, uniqueName, validateName } from "../utils/names";
import { within } from "./autosave";
import { editor, SWITCH_FLUSH_MS } from "./editor.svelte";
import { settings } from "./settings.svelte";
import { noteTargetPath } from "./targets";
import { ui } from "./ui.svelte";

export type { TreeRow } from "./tree";

/** Watcher bursts re-list after this debounce… */
const REFRESH_DEBOUNCE_MS = 150;
/** …and at most once per this interval (PERF-05); huge vaults wait 2× their last listing time. */
const REFRESH_MIN_GAP_MS = 250;
const LARGE_VAULT_ENTRIES = 20_000;
/** Vault open waits this long for the restored note before returning (it keeps loading after). */
const RESTORE_WAIT_MS = 500;
/** Name attempts before giving up on "exists" races. */
const NAME_ATTEMPTS = 20;

type Timer = ReturnType<typeof setTimeout>;

const isNotePath = (p: VaultPath) => fileKindOf(p) === "note";

class VaultStore {
  /** Active vault, or null when none is open (Welcome screen). */
  info = $state.raw<VaultInfo | null>(null);
  /** One vault is being replaced by another (`info` is briefly null meanwhile). */
  switching = $state(false);
  /** Raw listing from `vault_list` (replaced wholesale on refresh). */
  listing = $state.raw<ListResult>(EMPTY_LISTING);
  /** The listing stopped at the entry cap: rows missing from it prove nothing (VAULT-01). */
  truncated = $derived(this.listing.truncated);

  /** Derived tree + node map (root node has path ""). */
  data = $derived(buildTree(this.listing));
  tree = $derived(this.data.root);
  nodes = $derived(this.data.nodes);
  /** All notes in listing order (quick switcher, link index). */
  notes = $derived([...this.data.nodes.values()].filter((n) => n.fileKind === "note"));
  /** Notes and images in the same order: what `[[` completion offers (LINK-04). */
  linkables = $derived([...this.data.nodes.values()].filter((n) => n.fileKind === "note" || n.fileKind === "image"));
  /** Link index over notes and images: a link never resolves to another kind of file (TREE-16). */
  linkIndex: LinkIndex = $derived(buildLinkIndex(this.linkables.map((n) => ({ path: n.path, isNote: n.fileKind === "note" }))));

  /** Expanded folder paths (persisted per vault in the session). */
  expanded = new SvelteSet<VaultPath>();
  /** Tree selection (file or folder) — independent from the open note. */
  selected = $state<VaultPath | null>(null);
  /** Path whose tree row is in inline-rename mode. */
  renaming = $state<VaultPath | null>(null);
  /**
   * A new folder being named (TREE-05): the tree shows a draft row as the first child
   * of `parent`, pre-filled with `name`. Nothing exists on disk until commitFolder().
   */
  creating = $state<{ parent: VaultPath; name: string } | null>(null);
  /** Flattened visible rows for the virtualized FileTree. */
  rows: TreeRow[] = $derived(flattenVisible(this.tree, this.expanded));
  /** Bumped when FileTree should scroll `selected` into view. */
  revealTick = $state(0);

  #subscribed = false;
  #everOpened = false;
  /** Serializes open/close so two vault switches never interleave. */
  #chain: Promise<unknown> = Promise.resolve();
  /** The listing in progress (refreshes never overlap)… */
  #listing: Promise<void> = Promise.resolve();
  /** …and the one queued behind it, which every new caller shares. */
  #queued: Promise<boolean> | null = null;
  #refreshTimer: Timer | null = null;
  #refreshWaiters: (() => void)[] = [];
  #lastListStart = 0;
  #lastListMs = 0;
  /** A vault_list call is running; its result may still show a path a watcher event just removed. */
  #listInFlight = false;
  #truncationNoticed = false;
  /** The folder create in progress and the draft it commits: a second Enter on that draft changes nothing. */
  #folderCommit: { draft: VaultStore["creating"]; promise: Promise<VaultPath | null> } | null = null;
  /** A reveal that waits for its row to be listed (TREE-03). */
  #pendingReveal: VaultPath | null = null;
  /** The selection a listing dropped because its path vanished; an external rename of it restores it. */
  #lostSelection: VaultPath | null = null;

  /**
   * Opens `root` as the vault: vaultOpen → vaultList → restore session
   * (expanded, lastFile via editor.open) → settings.rememberVault → subscribe
   * to vault:changed (once). Returns false (and toasts errVault) on failure;
   * a missing lastVault at startup is forgotten silently (VAULT-02).
   */
  open = (root: string): Promise<boolean> => untrack(() => this.#serial(() => this.#open(root)));

  /** Back to the Welcome screen (flush editor first). */
  close = (): Promise<void> =>
    untrack(() =>
      this.#serial(async () => {
        if (!this.info) return;
        await this.#teardown();
        settings.update({ lastVault: null });
      }),
    );

  /** Re-lists the vault; drops a `selected`/`renaming` path that disappeared. */
  refresh = (): Promise<void> => untrack(() => this.#refresh().then(() => {}));

  /** Toggles (or forces) a folder's expanded state and persists the session. */
  toggle = (path: VaultPath, expand?: boolean): void =>
    untrack(() => {
      if (path === "") return;
      const open = expand ?? !this.expanded.has(path);
      if (open === this.expanded.has(path)) return;
      if (open) {
        if (this.nodes.get(path)?.kind !== "dir") return;
        this.expanded.add(path);
      } else this.expanded.delete(path); // collapsing also clears folders that are gone
      this.#persistExpanded();
    });

  /** Collapses every folder (sidebar header icon) and persists the session. */
  collapseAll = (): void =>
    untrack(() => {
      if (this.expanded.size === 0) return;
      this.expanded.clear();
      this.#persistExpanded();
    });

  /**
   * Expands all ancestors of `path`, selects it and bumps revealTick. Skipped while
   * an inline rename or folder draft is active; waits for the row when it is not listed yet.
   */
  revealInTree = (path: VaultPath): void =>
    untrack(() => {
      if (this.renaming !== null || this.creating !== null || path === "") return;
      if (!this.nodes.has(path)) {
        this.#pendingReveal = path;
        return;
      }
      this.#pendingReveal = null;
      let changed = false;
      for (let d = dirname(path); d !== ""; d = dirname(d)) {
        if (this.expanded.has(d)) continue;
        this.expanded.add(d);
        changed = true;
      }
      if (changed) this.#persistExpanded();
      this.selected = path;
      this.#lostSelection = null;
      this.revealTick++;
    });

  /**
   * Creates a note named `name` (default t("untitled"), made unique) inside `dir`
   * (default newNoteDir()). Opens it (unless open === false) in editing mode with
   * the caret at the start of the body. Returns the new path.
   */
  createNote = (opts?: { dir?: VaultPath; name?: string; content?: string; open?: boolean }): Promise<VaultPath | null> =>
    untrack(() => this.#createNote(opts ?? {}));

  /**
   * Creates the note an unresolved link / switcher query points to:
   * "Folder/Page" → "Folder/Page.md" from the vault root (folders created);
   * a bare "Page" → newNoteDir(). Opens it. Returns the path.
   */
  createNoteFromLink = (target: string): Promise<VaultPath | null> => untrack(() => this.#createNoteFromLink(target));

  /**
   * Where the note for an unresolved link / switcher query would live:
   * "Folder/Page" → "Folder/Page.md" from the vault root (existing folders reused
   * by key()); a bare "Page" → newNoteDir()/Page.md. Null when a segment is invalid.
   * With `from` (the linking note), "./" and "../" resolve against its folder and a
   * bare name lands next to it (LINK-05).
   */
  linkTargetPath = (target: string, from?: VaultPath | null): VaultPath | null => {
    const linkDir = from === undefined || from === null ? null : dirname(from);
    return noteTargetPath(target, {
      linkDir,
      bareDir: linkDir ?? this.newNoteDir(),
      existing: (dir, nameKey, kind) => {
        const hit = this.#childByKey(dir, nameKey, kind);
        return hit ? basename(hit.path) : null;
      },
    });
  };

  /**
   * Starts naming a new folder inside `dir` (default newNoteDir()): expands it and sets
   * `creating` with a free default name ("New folder", "New folder 1"…). Touches no
   * disk (TREE-05: folders are created only on commit). The promise is already settled.
   */
  createFolder = (dir?: VaultPath): Promise<void> =>
    untrack(() => {
      this.#createFolder(dir);
      return Promise.resolve();
    });

  /**
   * Commits the folder draft as `name`: validates, refuses a taken name, calls dirCreate,
   * refreshes, then selects and reveals the new folder and clears `creating`. An empty
   * name cancels (TREE-05). On an invalid or taken name it toasts and keeps `creating`,
   * so the row stays open. Returns the new folder's path, or null.
   */
  commitFolder = (name: string): Promise<VaultPath | null> =>
    untrack(() => {
      // One create per draft. A newer draft (started in another folder meanwhile) commits on its
      // own and never receives an older draft's answer, which its row would take as its own.
      const draft = this.creating;
      const running = this.#folderCommit;
      if (running !== null && running.draft === draft) return running.promise;
      const promise = this.#commitFolder(name).finally(() => {
        if (this.#folderCommit?.promise === promise) this.#folderCommit = null;
      });
      this.#folderCommit = { draft, promise };
      return promise;
    });

  /** Drops the folder draft (Esc, blur, right-click): nothing was created. */
  cancelFolder = (): void =>
    untrack(() => {
      this.creating = null;
    });

  /**
   * Renames to `newName` (full name; for notes pass the title — ".md" is appended
   * when missing). Validates (utils/names), rejects case-insensitive collisions
   * except case-only renames of itself, flushes the editor if affected, calls
   * pathRename, notifies editor.onPathMoved, keeps expanded/selected consistent.
   * Toasts and returns null on failure. A virtual note only changes its target path.
   */
  rename = (path: VaultPath, newName: string): Promise<VaultPath | null> => untrack(() => this.#rename(path, newName));

  /** Moves `path` into folder `destDir` ("" = root). Refuses self/descendant targets and collisions. */
  move = (path: VaultPath, destDir: VaultPath): Promise<VaultPath | null> => untrack(() => this.#move(path, destDir));

  /**
   * Deletes `path` (ARCHITECTURE §8.3): confirm (folders always, files only when
   * settings.confirmDelete) → flush → freeze saves under the path → pathTrash →
   * on success editor.onPathRemoved + refresh; on "trash_failed" confirm a
   * permanent delete → pathDelete; on failure/cancel unfreeze. Returns true when deleted.
   * An optional guard is rechecked after waits, before any destructive IPC call.
   */
  remove = (path: VaultPath, guard?: () => boolean): Promise<boolean> => untrack(() => this.#remove(path, guard));

  revealInOs = (path: VaultPath): Promise<void> =>
    untrack(async () => {
      if (!this.info) return;
      try {
        await pathReveal(path);
      } catch (e) {
        console.error("vault: reveal failed", e);
        ui.notify(t("errGeneric"));
      }
    });

  /** Writes an image attachment for `notePath` (unique "Pasted image …" name) and returns its VaultPath. */
  writeAttachment = (notePath: VaultPath | null, data: Uint8Array, ext: string): Promise<VaultPath | null> =>
    untrack(() => this.#writeAttachment(notePath, data, ext));

  resolveWiki = (target: string, from: VaultPath | null): VaultPath | null => resolveWikiTarget(target, from, this.linkIndex);

  resolveHref = (href: string, from: VaultPath | null): VaultPath | null => resolveMarkdownHref(href, from, this.linkIndex);

  linkTextFor = (path: VaultPath): string => wikiLinkText(path, this.linkIndex);

  /**
   * Folder for "current" new-note location: the selected folder, else the
   * selected file's folder, else the open note's folder, else "".
   */
  activeDir = (): VaultPath => {
    const sel = this.selected === null ? undefined : this.nodes.get(this.selected);
    if (sel) return sel.kind === "dir" ? sel.path : sel.parent;
    const open = editor.path;
    if (open !== null) {
      const dir = dirname(open);
      if (dir === "" || this.nodes.get(dir)?.kind === "dir") return dir;
    }
    return "";
  };

  /** Folder where Mod-N creates notes, honoring settings.newNoteLocation. */
  newNoteDir = (): VaultPath => (settings.values.newNoteLocation === "root" ? "" : this.activeDir());

  /** Folder for new attachments of `notePath`, honoring settings.attachmentLocation. */
  attachmentDir = (notePath: VaultPath | null): VaultPath => {
    const location = settings.values.attachmentLocation;
    if (location === "same") return notePath === null ? "" : dirname(notePath);
    if (location === "root") return "";
    // The configured folder, reusing existing folder names by key() (no case twins on Linux).
    const rel = normalizeRel(settings.values.attachmentFolder.trim());
    let dir: VaultPath = "";
    for (const seg of rel ? rel.split("/") : []) {
      const hit = this.#childByKey(dir, key(seg), "dir");
      dir = join(dir, hit ? basename(hit.path) : nfc(seg));
    }
    return dir;
  };

  absPath = (path: VaultPath): string => toAbsolute(this.info?.root ?? "", path);

  /** asset:// URL for displaying a vault file in the webview. */
  assetUrl = (path: VaultPath): string => convertFileSrc(this.absPath(path));

  node = (path: VaultPath): TreeNode | undefined => this.nodes.get(path);

  /**
   * The listed path for a spelling of `path`: the exact path, else segment by
   * segment with key() (an exact sibling name wins). Null when it is not listed.
   */
  findExisting = (path: VaultPath): VaultPath | null => {
    if (path === "") return null;
    if (this.nodes.has(path)) return path;
    let dir: VaultPath = "";
    for (const seg of path.split("/")) {
      if (seg === "") return null;
      const exact = this.nodes.get(join(dir, seg));
      const hit = exact && exact.parent === dir ? exact : this.#childByKey(dir, key(seg));
      if (!hit) return null;
      dir = hit.path;
    }
    return dir;
  };

  /** Re-points expanded folders, the selection and an inline rename after `from` moved to `to`. */
  remapTreeState = (from: VaultPath, to: VaultPath): void => untrack(() => this.#remapTreeState(from, to));

  // ── Open / close ─────────────────────────────────────────────────────────

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #open(root: string): Promise<boolean> {
    if (this.info && this.info.root === root) return true;
    // While one vault replaces another the shell shows nothing, not a flash of the Welcome screen.
    this.switching = this.info !== null;
    try {
      return await this.#replace(root);
    } finally {
      this.switching = false;
    }
  }

  async #replace(root: string): Promise<boolean> {
    const startup = !this.#everOpened && root === settings.values.lastVault;
    this.#everOpened = true;
    this.#subscribe();
    // VAULT-05: the old vault's saves are flushed (or kept in recovery copies) before switching.
    if (this.info) await this.#teardown();
    let info: VaultInfo;
    try {
      info = await vaultOpen(root);
    } catch (e) {
      console.error("vault: open failed", e);
      this.#openFailed(startup);
      return false;
    }
    this.info = info;
    this.#truncationNoticed = false;
    this.#lastListMs = 0;
    if (!(await this.#refresh()) || this.info !== info) {
      if (this.info === info) await this.#teardown();
      this.#openFailed(startup);
      return false;
    }
    // VAULT-03: restore expanded folders (missing ones dropped) and the last open file, with
    // its selection, scroll position and edit/reading mode.
    const session = settings.session(info.root);
    const complete = !this.truncated;
    for (const p of session.expanded) if (!complete || this.nodes.get(p)?.kind === "dir") this.expanded.add(p);
    if (this.expanded.size !== session.expanded.length) this.#persistExpanded();
    settings.rememberVault(info.root);
    const last = session.lastFile;
    if (last !== null && (this.nodes.has(last) || !complete))
      await within(editor.open(last, { position: session.last }), RESTORE_WAIT_MS);
    return true;
  }

  #openFailed(startup: boolean): void {
    if (startup) settings.update({ lastVault: null });
    else ui.notify(t("errVault"));
  }

  async #teardown(): Promise<void> {
    await editor.reset();
    if (this.#refreshTimer !== null) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = null;
    const waiters = this.#refreshWaiters;
    this.#refreshWaiters = [];
    for (const w of waiters) w();
    this.info = null;
    this.listing = EMPTY_LISTING;
    this.expanded.clear();
    this.selected = null;
    this.renaming = null;
    this.creating = null;
    this.#pendingReveal = null;
    this.#lostSelection = null;
  }

  /** Installs the vault:changed and window focus listeners once for the app's lifetime. */
  #subscribe(): void {
    if (this.#subscribed) return;
    this.#subscribed = true;
    onVaultChanged((p) => void this.#onChanged(p)).catch((e) => console.error("vault: watcher subscription failed", e));
    window.addEventListener("focus", () => this.#onFocus());
  }

  // ── Listing ──────────────────────────────────────────────────────────────

  #refresh(): Promise<boolean> {
    if (this.#queued) return this.#queued;
    const run = this.#listing.then(() => {
      this.#queued = null;
      return this.#list();
    });
    this.#queued = run;
    this.#listing = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  async #list(): Promise<boolean> {
    const info = this.info;
    if (!info) return false;
    this.#lastListStart = Date.now();
    const started = performance.now();
    let res: ListResult;
    this.#listInFlight = true;
    try {
      res = await vaultList();
    } catch (e) {
      if (this.info === info) console.error("vault: listing failed", e);
      return false;
    } finally {
      this.#listInFlight = false;
    }
    if (this.info !== info) return false;
    this.#lastListMs = performance.now() - started;
    this.listing = res;
    if (res.truncated && !this.#truncationNoticed) {
      // VAULT-01: silently missing notes would look like data loss.
      this.#truncationNoticed = true;
      ui.notify(t("errTruncated"));
    }
    if (this.selected !== null && !this.nodes.has(this.selected)) {
      this.#lostSelection = this.selected;
      this.selected = null;
    }
    if (this.renaming !== null && !this.nodes.has(this.renaming)) this.renaming = null;
    const draft = this.creating;
    if (draft !== null && draft.parent !== "" && this.nodes.get(draft.parent)?.kind !== "dir") this.creating = null;
    const pending = this.#pendingReveal;
    if (pending !== null && this.nodes.has(pending)) this.revealInTree(pending);
    editor.onListingChanged();
    return true;
  }

  /** Throttled refresh for watcher bursts and focus; resolves once a listing taken after the call landed. */
  #requestRefresh(): Promise<void> {
    return new Promise((resolve) => {
      this.#refreshWaiters.push(resolve);
      if (this.#refreshTimer !== null) return;
      const huge = this.truncated || this.listing.paths.length > LARGE_VAULT_ENTRIES;
      const gap = huge ? Math.max(REFRESH_MIN_GAP_MS, 2 * this.#lastListMs) : REFRESH_MIN_GAP_MS;
      const delay = Math.max(REFRESH_DEBOUNCE_MS, this.#lastListStart + gap - Date.now());
      this.#refreshTimer = setTimeout(() => {
        this.#refreshTimer = null;
        const waiters = this.#refreshWaiters;
        this.#refreshWaiters = [];
        void this.#refresh().finally(() => {
          for (const w of waiters) w();
        });
      }, delay);
    });
  }

  // ── External changes (§8.2) ──────────────────────────────────────────────

  async #onChanged(p: VaultChangedPayload): Promise<void> {
    const info = this.info;
    if (!info) return;
    const live = editor.livePaths();
    /** Live notes at or under `path`, exact first, then by key() (watcher spellings may differ). */
    const liveAt = (path: VaultPath): VaultPath[] => {
      if (path === "") return live;
      const k = key(path);
      return live.filter((lp) => isSameOrAncestor(path, lp) || key(lp) === k || key(lp).startsWith(`${k}/`));
    };
    const changed = new Set<VaultPath>();
    const removed = new Set<VaultPath>();
    const created: VaultPath[] = [];
    const renames: [VaultPath, VaultPath][] = [];
    /** Live notes spelled differently from a created/modified path with the same key(). */
    const respelled = new Set<VaultPath>();
    let structural = false;
    let rescan = false;
    for (const c of p.changes) {
      if (c.kind === "create" || c.kind === "modify")
        for (const lp of liveAt(c.path)) if (!isSameOrAncestor(c.path, lp)) respelled.add(lp);
      switch (c.kind) {
        case "modify": {
          // Content changes never re-list, except images: TREE-15 reloads them by mtime.
          const kind = fileKindOf(c.path);
          if (kind === "note") {
            if (liveAt(c.path).length > 0) changed.add(c.path);
          } else if (kind === "image") structural = true;
          break;
        }
        case "create":
          structural = true;
          if (isNotePath(c.path)) {
            created.push(c.path);
            if (liveAt(c.path).length > 0) changed.add(c.path);
          }
          break;
        case "remove":
          // A path the listing never showed (another app's lock or temp file) has no row to remove,
          // so it re-lists nothing (§6.4), unless a listing that may still include it is running.
          if (c.path === "" || this.#listInFlight || this.findExisting(c.path) !== null || liveAt(c.path).length > 0)
            structural = true;
          for (const lp of liveAt(c.path)) removed.add(lp);
          break;
        case "rename":
          structural = true;
          if (c.to !== undefined) renames.push([c.path, c.to]);
          else for (const lp of liveAt(c.path)) removed.add(lp);
          break;
        default:
          // "any": a rescan (path "") or a name change whose other side is unknown.
          structural = true;
          if (c.path === "") rescan = true;
          else for (const lp of liveAt(c.path)) removed.add(lp);
      }
    }
    for (const path of changed) void editor.onExternalChange(path);
    if (!structural) return;
    await this.#requestRefresh();
    if (this.info !== info) return;
    for (const [from, to] of renames) await this.#followRename(from, to, info);
    if (this.info !== info) return;
    if (respelled.size > 0) await this.#followRespellings(respelled, info);
    if (this.info !== info) return;
    // SAVE-07: a removal is confirmed by reading the note's current path (a save-by-rename
    // editor or our own case-only rename leaves it in place); a create of the same text is a move.
    const now = editor.livePaths();
    const candidates = created.filter((c) => !now.includes(c));
    for (const lp of rescan ? now : [...removed].filter((x) => now.includes(x))) void editor.onExternalChange(lp, candidates);
  }

  async #followRename(from: VaultPath, to: VaultPath, info: VaultInfo): Promise<void> {
    const affected = editor.livePaths().filter((lp) => isSameOrAncestor(from, lp));
    if (affected.length > 0 && key(from) !== key(to) && (await pathExists(from).catch(() => false))) {
      if (this.info !== info) return;
      // A save-by-rename editor (vim) wrote a new file at the old path: that is a modify of `from`.
      for (const lp of affected) void editor.onExternalChange(lp);
      return;
    }
    if (this.info !== info) return; // another vault meanwhile: these paths are not its own
    editor.onPathMoved(from, to);
    this.#remapTreeState(from, to);
  }

  /**
   * On a case- or normalization-insensitive volume, an external rename that only changes
   * spelling ("a.md" → "A.md", or a folder) arrives as creates (or modify + create), never
   * as a rename, because the old spelling still resolves. A live note that the listing no
   * longer shows under its spelling, but whose spelling still resolves to the listed one,
   * follows the stored name, segment by segment, so a respelled folder carries its tree state.
   */
  async #followRespellings(paths: Iterable<VaultPath>, info: VaultInfo): Promise<void> {
    if (this.truncated) return; // a missing row proves nothing
    for (const lp of paths) {
      if (this.nodes.has(lp) || editor.isVirtual(lp) || !editor.livePaths().includes(lp)) continue;
      const actual = this.findExisting(lp);
      if (actual === null || actual === lp || key(actual) !== key(lp)) continue;
      const sameEntry = await pathExists(lp).catch(() => false);
      if (this.info !== info) return;
      // Re-checked after the await: an earlier step may already have carried this note along.
      if (!sameEntry || this.nodes.has(lp) || !editor.livePaths().includes(lp) || this.findExisting(lp) !== actual) continue;
      const a = lp.split("/");
      const b = actual.split("/");
      for (let i = 0; i < a.length && i < b.length; i++) {
        if (a[i] === b[i]) continue;
        const from = [...b.slice(0, i), a[i]].join("/");
        const to = b.slice(0, i + 1).join("/");
        // Same entry (pathExists above): a save in flight under the old spelling wrote this very file.
        editor.onPathMoved(from, to, true);
        this.#remapTreeState(from, to);
      }
    }
  }

  /** TREE-12: watchers miss changes on network volumes, so focus re-checks the open note and re-lists. */
  #onFocus(): void {
    if (!this.info) return;
    const open = editor.path;
    if (open !== null && editor.kind === "note" && !editor.virtual) void editor.onExternalChange(open);
    void this.#requestRefresh();
  }

  // ── File operations (§8.3) ───────────────────────────────────────────────

  async #createNote(opts: { dir?: VaultPath; name?: string; content?: string; open?: boolean }): Promise<VaultPath | null> {
    if (!this.info) return null;
    const dir = opts.dir ?? this.newNoteDir();
    const base = nfc((opts.name ?? t("untitled")).trim().replace(/\.(md|markdown)$/i, "").trim());
    if (validateName(`${base}.md`, { note: true }) !== null) {
      ui.notify(t("errNameInvalid"));
      return null;
    }
    const taken = this.#siblingKeys(dir);
    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
      const name = uniqueName(base, "md", (k) => taken.has(k));
      const path = join(dir, name);
      try {
        await noteCreate(path, opts.content ?? "");
      } catch (e) {
        if (isIpcError(e, "exists")) {
          taken.add(key(name));
          continue;
        }
        console.error("vault: create note failed", e);
        ui.notify(t("errCreate", { name: titleOf(name, "note") }));
        return null;
      }
      await this.#refresh();
      const actual = this.findExisting(path) ?? path;
      if (opts.open !== false) await editor.open(actual, { focus: "start" });
      return actual;
    }
    ui.notify(t("errCreate", { name: base }));
    return null;
  }

  async #createNoteFromLink(target: string): Promise<VaultPath | null> {
    if (!this.info) return null;
    const path = this.linkTargetPath(target);
    if (path === null) {
      ui.notify(t("errNameInvalid"));
      return null;
    }
    let actual = this.findExisting(path);
    let created = false;
    if (actual === null) {
      try {
        await noteCreate(path, "");
        created = true;
      } catch (e) {
        if (!isIpcError(e, "exists")) {
          console.error("vault: create note failed", e);
          ui.notify(t("errCreate", { name: titleOf(nfc(basename(path)), "note") }));
          return null;
        }
      }
      await this.#refresh();
      actual = this.findExisting(path) ?? path;
    }
    await editor.open(actual, { focus: created ? "start" : "editor" });
    return actual;
  }

  #createFolder(dir?: VaultPath): void {
    if (!this.info) return;
    const parent = dir ?? this.newNoteDir();
    if (parent !== "" && this.nodes.get(parent)?.kind !== "dir") return;
    if (this.creating?.parent === parent) return; // already naming one here: keep what was typed
    const taken = this.#siblingKeys(parent);
    const name = uniqueName(t("newFolderName"), "", (k) => taken.has(k));
    let changed = false;
    for (let d = parent; d !== ""; d = dirname(d)) {
      if (this.expanded.has(d)) continue;
      this.expanded.add(d);
      changed = true;
    }
    if (changed) this.#persistExpanded();
    this.creating = { parent, name };
  }

  async #commitFolder(raw: string): Promise<VaultPath | null> {
    const info = this.info;
    const draft = this.creating;
    if (!info || draft === null) return null;
    const name = nfc(raw.replace(/[\r\n\t]+/g, " ").trim());
    if (name === "") {
      this.creating = null; // an empty name cancels and creates nothing
      return null;
    }
    if (validateName(name, { note: false }) !== null) {
      ui.notify(t("errNameInvalid"));
      return null;
    }
    if (this.#siblingKeys(draft.parent).has(key(name))) {
      ui.notify(t("errNameExists"));
      return null;
    }
    const path = join(draft.parent, name);
    try {
      await dirCreate(path);
    } catch (e) {
      if (this.info !== info || isIpcError(e, "no_vault")) return null;
      if (isIpcError(e, "exists")) {
        ui.notify(t("errNameExists"));
        void this.#refresh(); // something the listing did not show yet
        return null;
      }
      console.error("vault: create folder failed", e);
      ui.notify(t("errCreate", { name }));
      if (this.creating === draft) this.creating = null;
      return null;
    }
    await this.#refresh();
    // A newer draft replaced this one meanwhile: the folder exists, but this draft's row is gone,
    // and a success would make it hand the keyboard to the tree, away from the newer draft's input.
    if (this.info !== info || this.creating !== draft) return null;
    this.creating = null;
    const actual = this.findExisting(path) ?? path;
    this.revealInTree(actual);
    return actual;
  }

  async #rename(path: VaultPath, newName: string): Promise<VaultPath | null> {
    const info = this.info;
    if (!info || path === "") return null;
    const node = this.nodes.get(path);
    const virtual = node === undefined && editor.isVirtual(path);
    if (!node && !virtual) return null;
    const oldName = basename(path);
    const isNote = node ? node.fileKind === "note" : true;
    let name = nfc(newName.replace(/[\r\n\t]+/g, " ").trim());
    if (isNote) {
      // TREE-06: a typed ".md" is dropped; the note keeps its own extension.
      const dot = oldName.lastIndexOf(".");
      const ext = dot > 0 ? oldName.slice(dot) : ".md";
      name = `${name.replace(/\.(md|markdown)$/i, "").trim()}${ext}`;
    }
    if (validateName(name, { note: isNote }) !== null) {
      ui.notify(t("errNameInvalid"));
      return null;
    }
    if (name === nfc(oldName)) return path; // unchanged, or a different Unicode form only
    const dir = dirname(path);
    const to = join(dir, name);
    // Unsaved text of a note the listing does not show (virtual, or its file vanished) counts as taken too.
    if (
      (key(name) !== key(oldName) && this.#siblingKeys(dir, path).has(key(name))) ||
      editor.unsavedAt(to, path)
    ) {
      ui.notify(t("errNameExists"));
      return null;
    }
    if (virtual) {
      // EDIT-15: a virtual note only changes its target path, unless typing created its file meanwhile.
      await within(editor.flushUnder(path), SWITCH_FLUSH_MS);
      if (this.info !== info) return null; // another vault meanwhile: nothing here is about it
      if (editor.isVirtual(path)) {
        if (editor.busyUnder(path)) {
          // Its first save is still creating the file at the old path.
          ui.notify(t("errRename", { name: this.#label(path) }));
          return null;
        }
        editor.onPathMoved(path, to);
        return to;
      }
    }
    return this.#movePath(path, to, "errRename", info);
  }

  async #move(path: VaultPath, destDir: VaultPath): Promise<VaultPath | null> {
    const info = this.info;
    if (!info || path === "") return null;
    if (!this.nodes.has(path)) return null;
    if (dirname(path) === destDir || isSameOrAncestor(path, destDir)) return null;
    if (destDir !== "" && this.nodes.get(destDir)?.kind !== "dir") return null;
    const name = basename(path);
    const to = join(destDir, name);
    if (this.#siblingKeys(destDir).has(key(name)) || editor.unsavedAt(to, path)) {
      ui.notify(t("errNameExists"));
      return null;
    }
    return this.#movePath(path, to, "errMove", info);
  }

  /**
   * Rename or move: flush → freeze → IPC → re-point editor and tree state → refresh → adopt the stored name.
   * Everything stays in `info`, the vault the operation started in (PLAT-08): the IPC carries its epoch,
   * and once another vault replaced it (its notes disposed by the switch) nothing more is done.
   */
  async #movePath(from: VaultPath, to: VaultPath, errKey: "errRename" | "errMove", info: VaultInfo): Promise<VaultPath | null> {
    const label = this.#label(from);
    await within(editor.flushUnder(from), SWITCH_FLUSH_MS);
    if (this.info !== info) return null;
    await within(editor.freeze(from), SWITCH_FLUSH_MS);
    if (this.info !== info) return null;
    if (editor.busyUnder(from)) {
      // Both waits are capped: a write still in flight could land after the rename and recreate `from`.
      editor.unfreeze(from);
      ui.notify(t(errKey, { name: label }));
      return null;
    }
    try {
      await pathRename(from, to, info.epoch);
    } catch (e) {
      if (this.info !== info) return null;
      editor.unfreeze(from);
      console.error("vault: rename failed", e);
      ui.notify(isIpcError(e, "exists") ? t("errNameExists") : t(errKey, { name: label }));
      return null;
    }
    if (this.info !== info) return null;
    editor.onPathMoved(from, to);
    this.#remapTreeState(from, to);
    editor.unfreeze(to);
    await this.#refresh();
    if (this.info !== info) return null;
    // PLAT-06: HFS+ stores NFD whatever we asked for; adopt the name the listing reports.
    const actual = this.findExisting(to) ?? to;
    if (actual !== to) {
      editor.onPathMoved(to, actual);
      this.#remapTreeState(to, actual);
    }
    return actual;
  }

  async #remove(path: VaultPath, guard?: () => boolean): Promise<boolean> {
    // Everything stays in `info`, the vault the delete started in (PLAT-08): the IPC carries its
    // epoch, and once another vault replaced it (its notes disposed by the switch) nothing more is done.
    const info = this.info;
    if (!info || path === "" || guard?.() === false) return false;
    const node = this.nodes.get(path);
    if (!node && !editor.isVirtual(path)) return false;
    const isDir = node?.kind === "dir";
    const label = this.#label(path);
    if (isDir || settings.values.confirmDelete) {
      const message = isDir ? t("confirmDeleteFolder", { name: label }) : t("confirmDelete", { name: label });
      if (!(await ui.confirm(message)) || this.info !== info) return false;
    }
    // TREE-08: the trashed copy holds the latest text, and no save may run after the delete.
    if (guard?.() === false) return false;
    await within(editor.flushUnder(path), SWITCH_FLUSH_MS);
    if (this.info !== info || guard?.() === false) return false;
    await within(editor.freeze(path), SWITCH_FLUSH_MS);
    if (this.info !== info) return false;
    if (guard?.() === false) {
      editor.unfreeze(path);
      return false;
    }
    if (editor.busyUnder(path)) {
      // Both waits are capped: a write still in flight could land after the trash and bring the file back.
      editor.unfreeze(path);
      ui.notify(t("errTrash", { name: label }));
      return false;
    }
    if (!node && editor.isVirtual(path)) {
      editor.onPathRemoved(path); // nothing on disk
      return true;
    }
    let deleted = false;
    try {
      await pathTrash(path, info.epoch);
      deleted = true;
    } catch (e) {
      if (this.info !== info) return false;
      if (isIpcError(e, "not_found")) deleted = true;
      else if (isIpcError(e, "trash_failed")) {
        const permanently = await ui.confirm(t("confirmDeletePermanently", { name: label }));
        if (this.info !== info) return false;
        if (permanently && guard?.() !== false) {
          try {
            await pathDelete(path, info.epoch);
            deleted = true;
          } catch (e2) {
            if (this.info !== info) return false;
            if (isIpcError(e2, "not_found")) deleted = true;
            else {
              console.error("vault: delete failed", e2);
              ui.notify(t("errTrash", { name: label }));
            }
          }
        }
      } else {
        console.error("vault: trash failed", e);
        ui.notify(t("errTrash", { name: label }));
      }
    }
    if (this.info !== info) return false;
    if (!deleted) {
      editor.unfreeze(path);
      return false;
    }
    editor.onPathRemoved(path);
    let pruned = false;
    for (const p of [...this.expanded]) {
      if (!isSameOrAncestor(path, p)) continue;
      this.expanded.delete(p);
      pruned = true;
    }
    if (pruned) this.#persistExpanded();
    this.selected = null; // TREE-08
    this.#lostSelection = null;
    if (this.renaming !== null && isSameOrAncestor(path, this.renaming)) this.renaming = null;
    if (this.creating !== null && isSameOrAncestor(path, this.creating.parent)) this.creating = null;
    await this.#refresh();
    return true;
  }

  async #writeAttachment(notePath: VaultPath | null, data: Uint8Array, ext: string): Promise<VaultPath | null> {
    // Every attempt goes to the vault the write started in (PLAT-08), never to one opened meanwhile.
    const info = this.info;
    if (!info) return null;
    const raw = ext.replace(/^\./, "").toLowerCase();
    const e = /^[a-z0-9]{1,10}$/.test(raw) ? raw : "png";
    const dir = this.attachmentDir(notePath);
    const base = pastedImageName(e, new Date()).slice(0, -(e.length + 1));
    const taken = this.#siblingKeys(dir);
    for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
      const name = uniqueName(base, e, (k) => taken.has(k));
      const path = join(dir, name);
      try {
        await binaryWrite(path, data, info.epoch);
      } catch (err) {
        if (this.info !== info) return null;
        if (isIpcError(err, "exists")) {
          taken.add(key(name));
          continue;
        }
        console.error("vault: attachment failed", err);
        ui.notify(t("errAttachment"));
        return null;
      }
      // Listed before the markdown is inserted, so the image resolves right away.
      await this.#refresh();
      if (this.info !== info) return null;
      return this.findExisting(path) ?? path;
    }
    ui.notify(t("errAttachment"));
    return null;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  #children(dir: VaultPath): readonly TreeNode[] {
    return this.nodes.get(dir)?.children ?? [];
  }

  /** The child named `nameKey` (by key()); among case or form twins, the one shown first. */
  #childByKey(dir: VaultPath, nameKey: string, kind?: "dir" | "file"): TreeNode | undefined {
    let hit: TreeNode | undefined;
    for (const c of this.#children(dir)) {
      if (kind !== undefined && c.kind !== kind) continue;
      if (key(c.name) === nameKey && (hit === undefined || compareNodes(c, hit) < 0)) hit = c;
    }
    return hit;
  }

  /** key() of every name in `dir` (optionally ignoring one entry): collision checks ignore case and form. */
  #siblingKeys(dir: VaultPath, except?: VaultPath): Set<string> {
    const keys = new Set<string>();
    for (const c of this.#children(dir)) if (c.path !== except) keys.add(key(c.name));
    return keys;
  }

  #label(path: VaultPath): string {
    const node = this.nodes.get(path);
    if (node) return node.kind === "dir" ? node.name : node.title;
    return titleOf(nfc(basename(path)), fileKindOf(path));
  }

  #persistExpanded(): void {
    const root = this.info?.root;
    if (root) settings.updateSession(root, { expanded: [...this.expanded] });
  }

  #remapTreeState(from: VaultPath, to: VaultPath): void {
    if (from === to) return;
    const moved: [VaultPath, VaultPath][] = [];
    for (const p of this.expanded) {
      const q = rebase(p, from, to);
      if (q !== null && q !== p) moved.push([p, q]);
    }
    if (moved.length > 0) {
      for (const [p] of moved) this.expanded.delete(p);
      for (const [, q] of moved) this.expanded.add(q);
      this.#persistExpanded();
    }
    if (this.selected !== null) {
      const q = rebase(this.selected, from, to);
      if (q !== null) this.selected = q;
    } else if (this.#lostSelection !== null) {
      // The listing already dropped the selection because its old path vanished.
      const q = rebase(this.#lostSelection, from, to);
      if (q !== null) {
        this.selected = q;
        this.#lostSelection = null;
      }
    }
    if (this.renaming !== null) {
      const q = rebase(this.renaming, from, to);
      if (q !== null) this.renaming = q;
    }
    if (this.creating !== null) {
      const q = rebase(this.creating.parent, from, to);
      if (q !== null) this.creating.parent = q; // in place: the draft row keeps what was typed
    }
    if (this.#pendingReveal !== null) this.#pendingReveal = rebase(this.#pendingReveal, from, to) ?? this.#pendingReveal;
  }
}

export const vault = new VaultStore();
