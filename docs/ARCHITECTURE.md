# mininote — Architecture

mininote is a lightweight, local-first Markdown notes app in the spirit of Obsidian. A *vault* is any folder of `.md` files with sub-folders. The UI is monotone and nearly text-free (`docs/DESIGN.md`). Documents save themselves while you type.

## 0. How to read this document

This document fixes **structure, contracts and protocols**. `docs/research/REQUIREMENTS.md` fixes **behavior details and edge cases**, under IDs such as `SAVE-06`, including the `[critic]` items. `docs/research/TECHNIQUES.md` explains how to build the hard parts.

Where they disagree, REQUIREMENTS.md wins, unless §0.2 below says otherwise.

### 0.1 Scope of the current build

The current build covers every P0 requirement, plus these P1 items:
- VAULT-05, VAULT-08
- TREE-10, TREE-11, TREE-13, TREE-19
- EDIT-05 (all shortcuts), EDIT-06, EDIT-07 (URL paste), EDIT-08, EDIT-09 (replace), EDIT-12, EDIT-14, EDIT-16, EDIT-18
- LIVE-02 (highlight), LIVE-11, LIVE-12, LIVE-13
- SAVE-09, SAVE-11
- NAV-02 (Hangul extras, already in `utils/fuzzy.ts`), NAV-03, NAV-06
- SRCH-01, SRCH-02
- SET-02, SET-06, SET-07, SET-08, PLAT-05, PLAT-12

**Deferred** to the next round:
- SAVE-06 P1 (three-way merge); the conflict copy is the P0 behavior
- LINK-04 (heading suggestions)
- LINK-07 (rewrite links on rename)
- LINK-08 (heading slugs)
- READ-08 (CJK-friendly emphasis)
- PLAT-11
- All P2 items: tabs, snapshots, outline, and so on

### 0.2 Decisions on the open questions

| Question | Decision |
|---|---|
| Wikilinks | P0, including `[[` completion. |
| Dirty buffer plus external change | Conflict copy `<stem> (conflict YYYYMMDD-HHmmss).<ext>` next to the note. The suffix is not localized. |
| Delete | Files go to the OS trash without confirmation. `settings.confirmDelete` (default off) adds one. Folders and permanent deletes always confirm. |
| Attachments | Default `attachments/` at the vault root (`attachmentLocation: "folder"`). |
| Tree contents | Every visible file is listed, so a folder reads as it is on disk; a link (symlink) to a file is listed as that file (TREE-18, §6.8). Images and unsupported files are muted. Code and plain-text files open in a read-only code view (TREE-17, §10.4); any other file that is not a note or an image opens to a notice that its type is not supported (TREE-16). |
| Reading view | P0 (Mod+E). |
| Editor spacing | DESIGN.md §3.2: the reading view's pair gaps and gutters; a blank line is a body line, and the one right below a block stands where a paragraph typed on it would. |
| Markdown dialect | One block dialect in both views (§10.1, §11): no setext headings and no lazy continuation lines. |
| Editing defaults | Indent with a tab character. Spellcheck off by default. |
| Back/forward keys | Mod-Alt-←/→ everywhere, Mod-[ / Mod-] on macOS, Alt-←/→ on Windows/Linux, mouse buttons 3/4. These override CodeMirror's defaults. |
| IME | No extra time window after `compositionend`. `isComposing(e)` (`isComposing \|\| keyCode === 229`) covers WebKit's late Enter. A keydown with `keyCode` 229 never reaches the editor's keymaps (§10.1). |
| New-note base name | `t("untitled")`: "Untitled". |

## 1. Stack and why

| Layer | Choice | Reason |
|---|---|---|
| Shell | **Tauri 2** (Rust) | Windows, macOS, and Linux from one codebase. The OS webview keeps bundles around 10 MB and idle memory low (Electron uses about 150 MB). Rust provides native filesystem access, trash, and watching. |
| UI | **Svelte 5** (runes) + TypeScript + Vite | Compiles to direct DOM updates with a tiny runtime, so typing and tree updates stay cheap. |
| Editor | **CodeMirror 6** | Incremental Lezer parser and viewport-only rendering handle multi-MB notes. It is the same engine as Obsidian's live preview. |
| Code view | The same CodeMirror view + **`@codemirror/legacy-modes`** | Code files are shown read-only with syntax colors (§10.4). The stream modes of CodeMirror 5 cover some fifty languages in one small package without dependencies of its own, each loaded when first needed. |
| Reading view | **markdown-it** + **DOMPurify** | Fast and extensible. Sanitizing is mandatory, because injected script could reach Tauri IPC. |
| Settings | Own Rust commands (`settings_load` / `settings_update`) | Atomic JSON in the app-config dir, written as patches that every window hears (§7). `tauri-plugin-store` writes non-atomically and silently drops unparsable files. |
| Plugins | `single-instance`, `process`, `updater`, `dialog`, `opener`, `window-state` | No `fs` plugin. Every file operation is a vault-scoped custom command. `updater` and `process` only replace the app bundle and restart (§6.7). |

## 2. Process model

```
┌──────────────── Rust (src-tauri) ─────────────────┐      ┌──────────── Webview (src) ─────────────┐
│ vault.rs    each window's root, epoch, path guard │      │ ipc/       typed invoke + events       │
│             (one window per folder), asset scope  │      │ state/     runes stores (settings,     │
│ fs_ops.rs   list / read / atomic write / rename   │◄────►│            vault, editor, ui, commands)│
│             trash / delete / binary / reveal      │ IPC  │ editor/    CodeMirror 6 + live preview │
│ watcher.rs  notify debouncer → "vault:changed"    │─────►│ markdown/  markdown-it reading view,   │
│ search.rs   full-text scan, cancellable           │      │            link resolution             │
│ store.rs    settings JSON (patches), recovery     │      │ components/ Svelte UI                  │
│ windows.rs  new windows, restore list, focus      │      │                                        │
│ lib.rs      plugins, menu, exit-flush protocol    │      │ (one webview per window)               │
└───────────────────────────────────────────────────┘      └────────────────────────────────────────┘
```

- Each window is its own webview running the whole frontend, with a vault of its own (§6.1). Windows share the settings document (§7) and nothing else.
- The frontend never touches the filesystem directly.
- Every path crossing IPC is **vault-relative** with `/` separators (`VaultPath`).
- Rust joins it onto the active root and rejects anything that could escape: `..`, absolute or prefix components, and a path that goes through a symlink. A link that leads to a regular file is itself a file of the vault (§6.8).
- Every vault-scoped command carries the **vault epoch**. Rust rejects stale epochs with `no_vault`, so a late write meant for vault A can never land in vault B.
- Rust finds the vault of a command through the window that sent it (its label). Events about one vault go to its window only (`emit_to`), and the frontend listens with `getCurrentWebviewWindow().listen()`: a global `listen()` also hears the events sent to other windows (Tauri delivers every event to listeners whose target is `Any`).

## 3. Directory map

```
src/
  main.ts                    mount(App) + global CSS
  App.svelte                 shell: layout, global shortcuts, startup, close/exit flush
  styles/                    tokens.css · base.css · markdown.css · editor.css · code.css · index.css
  lib/
    types.ts                 shared data contracts (mirrors Rust DTOs)
    i18n.ts                  t(key) — English UI strings
    appCommands.ts           concrete command list (shortcuts + palette)
    ipc/commands.ts          typed wrappers for every Rust command (epoch injected)
    ipc/events.ts            vault:changed, app:flush-request
    utils/                   path · names · codeFiles · fonts · fuzzy · platform · keys · timing
    state/                   settings · vault · editor · ui · commands · updater (*.svelte.ts), tree.ts, settingsSync.ts
    editor/                  setup · theme · syntax · commands · arrows · complete · paste · search panel
                             · ime.ts · host.ts (bridge interface) · shared.ts · livePreview/*
                             · code/* (the read-only code view: languages, state, highlight, modes/)
    markdown/                render.ts (+ plugins/) · resolve.ts
    components/              Svelte components (§9)
src-tauri/src/
  lib.rs  error.rs  vault.rs  fs_ops.rs  watcher.rs  search.rs  store.rs  windows.rs
docs/
  ARCHITECTURE.md  DESIGN.md  releasing.md  research/ (OSS analyses, REQUIREMENTS.md, TECHNIQUES.md)
scripts/prepare-release.mjs  validates the versions and writes the updater overlay for release builds (§6.7)
.github/workflows/release.yml  a version tag → draft GitHub release with installers, updater archives and latest.json
```

## 4. Paths, names, Unicode (PLAT-06, PLAT-07, TREE-07)

- **`VaultPath`**:
  - relative, `/`-separated, no leading or trailing slash; the root is `""`;
  - **byte-identical to what Rust listed**, never normalized, so it round-trips to the filesystem (macOS names may be NFD);
  - the **identity** for caches, history, recovery copies and the open note.
- **Lookup and matching** use `key()` (NFC, no-break spaces folded, lower-case). This covers the switcher, search, link resolution, "is this name taken?" and case-insensitive collisions. NFC-typed Hangul matches NFD file names.
- **Valid names** (`utils/names.ts › validateName`):
  - trimmed, with no control characters and none of `\ / : * ? " < > |`;
  - no leading `.`, no trailing `.` or space;
  - not a Windows reserved name;
  - **at most 255 UTF-8 bytes**, extension included;
  - notes additionally reject `# ^ [ ] |`, which break wikilinks.
  - These rules apply to names *we* create. Existing files with other names are still listed and openable.
- **Unique names:** `Untitled.md`, `Untitled 1.md`, … are checked against siblings with `key()`. A copy keeps its file's name where that is free, and is numbered the same way where it is not (`utils/names.ts › copyName`, TREE-19).
- **Absolute paths** (asset URLs, reveal, copy) come from `toAbsolute(root, rel)`, which uses the root's own separator; `toNative(root, rel)` spells a vault path alone that way (the copied relative path, TREE-09).

## 5. IPC contract

Rust commands take snake_case parameters, and JS sends camelCase. Every error is serialized as `{ kind, message }`. The kinds are listed in `IpcErrorKind`: `no_vault`, `root_unavailable`, `invalid_path`, `not_found`, `exists`, `conflict`, `read_only`, `not_utf8`, `too_large`, `trash_failed`, `io`. JS rethrows each as an `IpcError`.

Every command marked "scoped" also takes `epoch: u64`, either as an argument or in the `x-epoch` header for raw-body commands, and fails with `no_vault` when it does not match. The frontend sends the current epoch, except for work done for one note: each note controller keeps the epoch it was created in and sends that one (`currentEpoch()` in `ipc/commands.ts`), so a save, read or recovery copy that outlives a vault switch fails with `no_vault` instead of reaching the new vault (PLAT-08).

| Command | Args | Returns | Notes |
|---|---|---|---|
| `vault_open` | `path` (absolute) | `VaultInfo` | Opens the folder as the calling window's vault. Steps: (1) canonicalize with dunce; (2) require a directory; (3) unless another window has the folder open (§6.1), set the root (recording whether it is a mount point), take a new epoch, and clear the self-write registry; (4) allow the asset-protocol scope for the directory (recursive); (5) restart the watcher; (6) prune this vault's recovery copies that are older than 30 days and whose note no longer exists (SAVE-10); (7) update the window list (§6.6). Errors: `not_found` (also for a file), `invalid_path` (relative or non-UTF-8 path), `exists` (another window has it open, and that window comes forward), `io`. |
| `vault_close` | – | – | The calling window has no vault any more (back to Welcome, after the frontend flushed): every request for the old epoch fails with `no_vault`, its watcher stops, and another window may open the folder. Updates the window list. |
| `vault_focus` | `path` (absolute) | `bool` | True when another window has the folder open as its vault; that window comes forward (VAULT-07). A path that does not canonicalize gives false, and `vault_open` reports what is wrong with it. |
| `vault_list` (scoped) | – | `ListResult` | §6.3: one column per field, `{ paths, kinds, mtimes, realPaths, truncated }`. |
| `note_read` (scoped) | `path` | `FileContent` | Strips a UTF-8 BOM (`bom: true`). Reports `readOnly` (the writability test `note_write` uses, §6.2 step 3), plus the baseline `{mtime,size,hash}` taken from stats around the read; a change while reading triggers a re-read (SAVE-06 "partial files"). Also reads a code file for its viewer (TREE-17). A link is read as the file it leads to (§6.8). Errors: `not_found`, `not_utf8`, `too_large` (over 20 MB). |
| `note_write` (scoped, **raw body**) | body = UTF-8 bytes (BOM included if wanted); headers `x-path` (URI-encoded), `x-expected` (JSON baseline or empty), `x-epoch` | `WriteResult` | §6.2. The `x-expected` check covers external changes since the baseline: a changed file gives `conflict`, a vanished one `not_found`. With an empty `x-expected` there is no baseline check, and missing parent folders **inside** the root are recreated. Either way the target is re-checked right before it is replaced: a file that appeared or changed during the write gives `conflict`, one that vanished `not_found`. Through a link, the file it leads to is replaced and the link stays; a link that leads nowhere gives `not_found` (§6.8). Also returns `read_only` and `root_unavailable`. |
| `note_create` (scoped) | `path, content` | `WriteResult` | Exclusive create, creating missing parents inside the root. Error: `exists`. Used for new notes and conflict copies. |
| `dir_create` (scoped) | `path` | – | Creates parents. Error: `exists`. |
| `path_rename` (scoped) | `from, to` | – | Files and folders. Creates `to`'s parent. Error: `exists`, unless it is a case- or normalization-only rename of the same entry (done via a temp name, with rollback). A free `to` is checked again right before every rename attempt (Windows retries included), so an entry that appeared meanwhile gives `exists` and nothing moves. Refuses the root, and refuses a folder into itself or a descendant (`invalid_path`). A link is renamed itself, and re-pointed when it moves to another folder (§6.8). Records both paths in the self-write registry. |
| `path_copy` (scoped) | `from, to` | – | Copies the file `from` into the new file `to` (TREE-19), creating `to`'s parent. Never over an entry that is there (`exists`), and never a folder. The content is streamed, whatever its kind and size, and a failed copy leaves no partial file. The copy has a new file's permissions plus its source's execute bits. A link is copied as the file it leads to, into a regular file (§6.8). |
| `path_trash` (scoped) | `path` | – | `trash` crate. On macOS it uses `DeleteMethod::NsFileManager`, because the default AppleScript method prompts for Automation rights. A link is trashed itself, never its file. Error: `trash_failed`. Refuses the root. |
| `path_delete` (scoped) | `path` | – | Permanent, recursive. A link is removed itself, never its file. Called only after confirmation. Refuses the root. |
| `path_exists` (scoped) | `path` | `bool` | |
| `path_reveal` (scoped) | `path` | – | Opener plugin `reveal_item_in_dir`, called from Rust. |
| `binary_write` (scoped, **raw body**) | body = bytes; headers `x-path`, `x-epoch` | – | New file only (`exists`), creating parents. Used for pasted and dropped images. |
| `search_text` (scoped) | `query, caseSensitive, limit` | `SearchResponse` | §6.5. |
| `recovery_write` (scoped) | `path, content, baseline` | – | Writes `{path, content, baseline, savedAt}` as JSON at `app_data/recovery/<fnv(root)>/<fnv(path)>.json`. Atomic. Newest wins. |
| `recovery_get` (scoped) | `path` | `RecoveryCopy \| null` | |
| `recovery_clear` (scoped) | `path` | – | |
| `settings_load` | – | `string \| null` | Reads `app_config/settings.json`. If it is unparsable JSON, renames it to `settings.corrupt-<ms>.json` and returns null. |
| `settings_update` | `patch: SettingsPatch` | – | Merges `{ settings?, sessions? }` into the document under one lock: each setting replaces its key, each session its vault root's (`null` removes it). Atomic write; an existing file that is not a JSON object, or cannot be read, is set aside first. Then emits `settings:changed` (§7). |
| `window_new` | – | – | Opens another window on the Welcome screen, over the calling one (§6.6). |
| `window_startup` | – | `WindowStartup` | `{ vault, last }`: the folder the calling window opens when its page starts (given out once), or `last: true` for the first window while no window list was saved yet (§6.6). A page that starts again in a window gets the vault that window has open. |
| `app_quit` | – | – | Ctrl+Q on Windows and Linux: the flush protocol of §6.6, as the macOS Quit item. |
| `app_exit_ready` | – | – | The calling window has flushed for a quit (§6.6). |

| Event (Rust → JS) | Payload | When |
|---|---|---|
| `vault:changed` | `VaultChangedPayload` | To the window whose vault changed: debounced batches (about 200 ms) of changes inside the root. Hidden paths, our temp files and self-writes are excluded. A notify `Rescan` flag, an event on the vault folder itself, or a batch of more than 1000 changes becomes one `{kind:"any", path:""}`: re-list and re-check every open or cached note. |
| `app:flush-request` | `null` | To every window: the app wants to quit (custom Cmd+Q, Ctrl+Q, or an `ExitRequested`). |
| `settings:changed` | `SettingsChangedPayload` | To every window, the writer included: a patch `settings_update` applied, with the writer's label as `origin`, in the order applied (§7). |

## 6. Backend design (src-tauri)

### 6.1 State and path guard (`vault.rs`, PLAT-08, VAULT-07)

- Each window has a `VaultState`, kept by `Vaults` (managed with `app.manage`) under the window's label and created by its first command:

  ```
  Vaults {
      windows: Mutex<HashMap<label, Arc<VaultState>>>,  // also serializes taking a folder
      epochs: AtomicU64,          // every epoch, whatever the window: one never repeats
  }
  VaultState {
      root: RwLock<Option<Root>>,  // Root { path: PathBuf, mount_point: bool }
      epoch: AtomicU64,
      watcher: Mutex<Option<Debouncer>>,
      registry: Mutex<SelfWrites>,
      search_gen: AtomicU64,
      open_lock: Mutex<()>,       // serializes this window's vault_open and vault_close
  }
  ```

  Never hold a lock across file I/O. Lock order: the `Vaults` map, then a state's own locks.
- Commands take the calling `WebviewWindow`, and `blocking(&window, …)` runs their work with that window's state. A closed window's state is dropped (its watcher stops); work still running for it finishes against it, unreachable.
- **One window per folder.** Under the map's lock, `vault_open` takes a folder only when no other window's root is the same canonical path; otherwise that window comes forward and the call fails with `exists`. Nested or overlapping folders may be open in two windows: each sees the other's writes as external changes (§8.2), as with any other app. One folder in two windows would share its session and its recovery copies.
- `check(epoch)`: fails with `no_vault` if there is no root or the epoch differs. If the root directory itself is missing (an unmounted volume), it fails with `root_unavailable` and nothing is ever created at that location.
  - On Unix, `vault_open` records whether the root is a mount point (on another device than its parent). Such a root that sits on its parent's device again is the bare folder of an unmounted volume, and `check` fails with `root_unavailable` too (VAULT-06). Device numbers are not stored, so a remount works; on Windows, or without a readable parent, nothing changes.
- `resolve(rel) -> PathBuf`:
  1. Split on `/` and reject empty, `.` and `..` components, NUL, and absolute or prefix components.
  2. On **Windows only**, also reject `\`, `:` and other characters that are invalid there. On Unix those characters are legal parts of a name.
  3. Join onto the root, then reject the result if it **goes through a symlink or junction**: check `symlink_metadata` on each existing prefix before the last component. The last component may itself be a link (§6.8).
- `to_rel(abs)` strips the root and joins components with `/`. Entries that are not valid UTF-8 are skipped from listings.
- Operations that modify (`path_rename`, `path_trash`, `path_delete`) refuse `rel == ""`.

### 6.2 Writes (`fs_ops.rs`, SAVE-04/05)

- All commands are `async`, with blocking work in `tauri::async_runtime::spawn_blocking`.
- `mtime` is reported as ms since the epoch (f64). `hash` is FNV-1a 64-bit as 16 hex characters, stable across runs.
- **`note_write` algorithm:**
  1. `check` the epoch, then resolve the path. If a link is there, the file it leads to takes the path's place in every step below (§6.8).
  2. If `x-expected` is set:
     - a missing file gives `not_found`;
     - otherwise, compare the current size and mtime with the expected values; if they match but the mtime has no sub-second part, also compare the hash. A difference gives `conflict`.
  3. If the target exists and is not writable, return `read_only`: the Unix mode bits, the Windows read-only attribute or the macOS locked flag say so, or a write-open is refused (ownership, ACLs, read-only mounts or shares). The probe neither creates nor truncates, and a file merely held open elsewhere does not count. `note_read` reports `readOnly` with the same test.
  4. Missing parent folders inside the root are created (`create_dir_all`), but never the root itself.
  5. Create the temp file `.mn~<pid>-<counter>.tmp` in the same folder. Give it the original's group, and its owner where allowed (Unix, best effort; first, because a chown can clear set-id bits), then the original's permissions (Unix) and creation time (`FileTimes::set_created` on macOS and Windows). Then write the bytes and `sync_all`.
  6. Rename the temp over the target. On Windows, retry on raw OS errors 5/32/33 after 10, 20, 40, 80 and 160 ms. Right before every attempt, re-stat the target: if it appeared or changed since step 2 (size, mtime, inode on Unix; the hash too when the mtime is coarse and a baseline was given), stop with `conflict`; if it vanished, with `not_found`.
  7. If the folder refuses the temp file but the target is writable, fall back to writing in place: the step 6 re-check, then truncate, write, fsync.
  8. On error, remove the temp file. The target is never left truncated.
  9. If the file now at the target is still our temp file (same size, and same inode on Unix), record `abs → (size, mtime, hash)` in the self-write registry (for a link, under its own path and its file's) and return its baseline. Otherwise another program replaced it right after the rename: return the baseline of our version (from the temp file) and record nothing, so the next save's check and the watcher see theirs as a change.
- **Self-write registry:** an LRU of about 512 entries. Only overwrites by `note_write` and renames are recorded (renames record both paths and the case-rename temp name), each with the time it was made. Creates (`note_create`, `binary_write`, `dir_create`, `path_copy`, a `note_write` that made a new file or found it replaced) still reach the frontend, whose tree needs them, and they forget any older record for the path. The watcher drops a `create` or `modify` event when the file's current size and mtime (and hash, when the mtime is coarse) still match the record. It also drops the `remove` echo of a rename source recorded in the last 5 s; after that, a delete of that path is real.
- **Case or normalization-only rename:** tried directly first; when the stored name did not change, go through the visible temp name `<stem>.mn-tmp-<n>.<ext>` (PLAT-07: a hidden temp left by a crash would be invisible) and roll back if the second step fails.
- **Stale temp files** (ours, older than one hour) are deleted when `vault_list` walks their folder.

### 6.3 Listing (`vault_list`, TREE-01, VAULT-01, PERF-01)

- **Breadth-first, one level at a time.** A level's folders are read with `std::fs::read_dir` on up to 8 threads (the machine's parallelism, at least 2), each taking the next unread folder. A link is never followed into a folder. A level keeps the order of the folders it came from, and each folder the order its entries were read in, so thread timing never changes a complete listing, and every folder comes before its contents.
- Skips names starting with `.`, and anything that is neither a folder nor a regular file. A link (symlink) counts as the regular file it leads to, and is skipped when it leads to a folder or nowhere (§6.8).
- On Windows, also skips entries with the Hidden or System attribute.
- Lists every folder and regular file. Notes are `md` and `markdown`, images `png jpg jpeg gif webp svg bmp avif`; the frontend classifies the rest as code files (TREE-17) or other files (`utils/names.ts › fileKindOf`).
- **Metadata only where it is used.** The folder read already says what an entry is (and on Windows carries its attributes), so only notes and images are statted, for their mtime: the switcher's order and image reloads. A link is statted too, to see what it leads to.
- An unreadable sub-folder is listed without children, not fatal.
- Capped at 100 000 entries (`truncated`). The cap cuts the deepest level being read, so a huge root such as a home folder still shows its upper levels whole.
- **Wire format.** One column per field: `paths`, `kinds` (one `d` or `f` per entry), `mtimes` (whole ms; 0 for folders) and `truncated`. 100 000 entries cross IPC as three flat arrays, not 100 000 objects. `realPaths` is a small map beside them: the file behind each image that is a link (§6.8).

### 6.4 Watcher (`watcher.rs`, TREE-12)

- `notify-debouncer-full`:
  - 200 ms;
  - recursive;
  - `Config::with_follow_symlinks(false)` (check the 0.7 API);
  - started by `vault_open`, after dropping the previous debouncer.
- Event mapping: `Create` → `create`; data `Modify` → `modify`; `Name(Both)` with two paths → `rename` with `to`; `Remove` → `remove`; the `Rescan` flag → `{any, ""}`.
  - A single-sided name change, or a `remove` of a path that exists again, is classified by what exists when the batch is handled: `create` if the path exists, else `remove`.
  - A paired rename between two paths of one class (folders, notes and images, other files) is `rename`. Across classes it is `remove(from)` plus `create(to)`: another app's atomic save through a visible temp file (`a.md.tmp` → `a.md`) reaches a live note as a create, as before. From a hidden file it is `create(to)`; to a hidden or outside path, `remove(from)`. A rename whose source exists again (vim's save) is `modify(from)` plus `create(to)`.
  - Links that lead to a folder or nowhere, folder metadata changes and content changes of files other than notes, images and code files are dropped. A link that leads to a file is told like a file, and hears of its file's changes (§6.8). Code files are told by name (`fs_ops::is_code_name`, the lists of the frontend's `utils/codeFiles.ts`, §10.4). A path that came and went within a batch is a `remove`, which the frontend ignores for paths it never listed (§8.2).
  - The file-ID cache that pairs renames on macOS and Windows holds folders, notes and images only, and no links; another file's rename arrives as a remove and a create, which re-list the tree all the same.
- **Drop rules:** events outside the root, any hidden component, our temp files, and registry matches.
- Deduplicate per batch, then `app.emit_to(EventTarget::webview_window(label), "vault:changed", …)`: the paths are relative to this vault, so only its window hears them.
- The callback captures the root, the epoch and the window it was started for, and drops batches once that window has another vault, none, or is gone.

### 6.5 Full-text search (`search.rs`, SRCH-01/02)

- **Cancellation.** Each call bumps `search_gen`. The loop returns early (`truncated: true`) as soon as a newer generation exists.
- **Query.**
  - Whitespace-separated terms, or `"quoted phrases"`, NFC-normalized.
  - A file matches when **every term** occurs in its content or name.
  - Case-insensitive mode lowercases per character, with a map back to the original positions that tolerates length-changing case folds.
  - Hangul is matched at character level, as plain substrings.
- **Files.** Notes only, using the `vault_list` rules: a link to a note is searched as the note it leads to (§6.8). Files over 2 MB are skipped, as are cloud placeholders (SRCH-01 [critic]).
- **Output.**
  - Up to 20 matching lines per file (lines containing any term), and up to `limit` files.
  - Snippets longer than 240 characters are trimmed around the first hit with `…`.
  - `ranges` are UTF-16 offsets into the snippet.
  - Ordering: files with `nameMatch` first, then by match count, then by path.

### 6.6 App lifecycle (`lib.rs`, `windows.rs`, SAVE-02, PLAT-05, PLAT-10, VAULT-08)

- **Plugins, in this order:**
  1. `single-instance` (desktop only): unminimizes, shows and focuses the window focused last (else the first one).
  2. `process` and `updater` (desktop only): the restart and the signed app updates of §6.7.
  3. `dialog`
  4. `opener`
  5. `window-state`, restoring size, position and maximized only (restoring visibility would show the hidden window before the first paint, PLAT-03), per window label
  6. `mininote-navigation` (inline): the webview may only navigate within the app's own origin (`tauri://localhost`, `http(s)://tauri.localhost`, `about:blank`, and the dev server in dev builds), as defense in depth for READ-04 / PLAT-13
- **Windows (VAULT-08).** The first window, `main`, comes from tauri.conf.json, whose entry is also the template of every other window (`WebviewWindowBuilder::from_config` under another label). The others are `w2`, `w3`…, a label never given out twice while the app runs; the capability in `capabilities/default.json` covers `main` and `w*`. Every window starts hidden (`visible: false`), and its frontend shows it after the first paint.
  - `window_new` opens one on the Welcome screen, at the calling window's size, one step (28 logical px) down and to the right, back near the top-left corner of its screen when that would leave the work area; maximized beside a maximized window, placed by the OS beside a full-screen one. That place replaces whatever the window-state plugin restored for the label.
  - **Window list.** `app_config/windows.json` holds `{ windows: [{ label, vault }] }`, the windows with a vault, `main` first. It is rewritten (off the main thread, only when it changed) after every `vault_open` and `vault_close`, and when a window closes while others stay open. Once the app is exiting it stays as it is, and so does the last window to close: that ends the app, and the window comes back next time.
  - **Restore.** In `setup`, the list's `main` entry (else its first) becomes what `main` opens, and every other entry is created again under its label, so the window-state plugin puts it back at its size and place; new labels start above the highest restored one. At most 16 windows, each label and each folder once, absolute folders only. With no list (an older version ran last), `main` gets `last: true` and reopens `settings.lastVault`. A folder that does not open leaves its window on Welcome, silently (VAULT-02), and drops out of the list at its next write.
  - `Focused(true)` events record the window focused last; `Destroyed` drops the window's vault state and startup entry.
- **Exit flush.**
  - On `RunEvent::ExitRequested { api, code, .. }`: a restart request (`code == RESTART_EXIT_CODE`, §6.7) passes untouched, because Tauri ignores `prevent_exit` for it. Otherwise, if not every window has flushed yet (`ready` is false) and a window is open, call `api.prevent_exit()` and emit `app:flush-request` to every window. An exit that passes freezes the window list.
  - At the same time, start (once per quit, even when the request repeats) a 4000 ms fallback thread that sets `ready` and calls `app.exit(code)`. Every window answers every request, with or without an open vault.
  - `app_exit_ready` records the calling window as flushed; the app exits once every open window has (a window closed meanwhile no longer counts). Called without a pending request (a window that quit on its own), it requests the flush of the others first.
- **macOS menu.** Tao never raises a preventable exit for the predefined Quit (Tauri #9198), so build the menu explicitly:
  - **App menu:** About, separator, Hide, Hide Others, Show All, separator, and a **custom "Quit mininote" item with `CmdOrCtrl+Q`**. The custom item emits `app:flush-request` and starts the same fallback.
  - **Edit menu:** the predefined Undo, Redo, Cut, Copy, Paste and Select All. They are required for clipboard keys in WKWebView.
  - **Window menu:** Minimize, Zoom, Fullscreen. macOS lists the open windows below them, by title (PLAT-02).
- Windows and Linux have no menu bar. Ctrl+Q there is a frontend command that calls `app_quit`, the same protocol as the macOS Quit item.

### 6.7 App updates (`tauri-plugin-updater`, `tauri-plugin-process`)

- **Configuration.** The committed `tauri.conf.json` has an empty updater block (no endpoint, no key), so development and local builds check nothing. Release builds merge `src-tauri/tauri.updater.conf.json`, an ignored overlay that `scripts/prepare-release.mjs` writes after validating the public key, the versions (package.json, both lockfiles, tauri.conf.json, Cargo.toml) and the tag: `bundle.createUpdaterArtifacts`, the public signing key and the single endpoint `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`. GitHub Releases hosts the manifest and the archives; the app needs no credentials. Pipeline and one-time setup: `docs/releasing.md`.
- **Flow (frontend, `state/updater.svelte.ts`).** `start(flushBeforeExit)` at mount reads the running version and makes one background check (10 s timeout), repeated when the machine comes back online; development builds skip the check. A newer release shows the update button (§9). The click downloads (5 min timeout, whole-percent progress), runs the quit flush of §8.4, installs the signature-verified bundle, flushes again and calls `relaunch()`. Check failures are silent. An install failure toasts `errUpdate` once and keeps the button for a retry; after a successful install only the restart is retried (`restart` phase), never the install. The Tauri `Update` resource is closed after the install and when the store stops.
- **Why the flush runs twice.** Neither step waits for the exit protocol of §6.6: on Windows the plugin launches the installer and exits the process inside `install()`, and Tauri ignores `prevent_exit` for a restart request, so `ExitRequested` with `RESTART_EXIT_CODE` is let through without a flush request.
- **Windows.** Every window runs the check and can show the button. The window that installs flushes itself twice as above; the others flushed when they lost focus to it (§8.1). After the restart the window list brings them back (§6.6).
- **Scope.** Only the application bundle changes: the macOS `.app`, the Windows NSIS or MSI installer in passive mode (the installer relaunches the app), the Linux AppImage. A `.deb` or `.rpm` install has no AppImage to replace, and its check fails quietly. No vault file or setting is touched. No custom IPC command is involved; the plugins' own commands are allowed in `capabilities/default.json` (`updater:allow-check`, `allow-download`, `allow-install`, `process:allow-restart`).

### 6.8 Links (`vault.rs`, `fs_ops.rs`, `watcher.rs`, TREE-18)

A link is a symlink (on Windows also a junction, which always leads to a folder). A link that leads to a regular file is a file of the vault. A link that leads to a folder is never followed.

- **Path guard.** `resolve` rejects a path that goes through a link and accepts one that ends at a link: that link is an entry of a real folder of the vault. Commands act on the entry itself (`symlink_metadata`): `path_rename`, `path_trash` and `path_delete` move or remove the link, `path_exists` sees it, and the exclusive creates (`note_create`, `binary_write`, `dir_create`, the target of `path_copy`) fail on it with `exists`. Only `note_read`, `note_write` and the source of `path_copy` follow it, and only to a regular file. `path_reveal` shows the link's file, because the opener plugin canonicalizes.
- **Listing.** `vault_list` lists a link as a file when `fs::metadata`, which follows, finds a regular file, and gives it that file's mtime. A link to a folder, to nothing or in a circle is skipped. The frontend tells the kind from the link's name, as for any file.
  - For the links the frontend reads or shows (notes, images, code files) the listing also takes the canonical path of the file. The window's `VaultState` keeps them for the watcher (`links`: file → its links), replaced by every listing of the current epoch and cleared with the vault.
  - Image links cross IPC with that path (`realPaths`), and `vault.assetUrl` builds such an image's URL from it. Tauri's asset scope reads a link's target as it is written, so it refuses every link with a relative target; the file itself passes. A file the vault's scope does not cover (in a hidden folder, or outside the vault) is allowed by itself (`allow_file`).
- **Reading.** `note_read` stats and reads through the link: the content, `readOnly` and the baseline are the file's.
- **Writing.** `note_write` resolves the link to its file (`canonicalize`) and runs §6.2 on that file: its metadata for the checks, its folder for the temp file, the rename over it. The link itself is never replaced. Step 6 also checks that the link still leads to that file (`conflict`). A link that leads nowhere gives `not_found`: nothing is created through a link. The registry records the write under the link's path and under the file's.
- **Moving.** A link's relative target is read from the folder the link is in. `path_rename` into another folder creates the new link with the way back to the old folder in front of the target (`docs/x.md`, moved into `notes/`, becomes `../docs/x.md`), checks that it leads to the same file, and then removes the old link. If that cannot be done, nothing moves. An absolute target, a rename within the folder and a link the tree does not list go through the plain rename.
- **Copying.** `path_copy` opens its source through the link and writes that file's content into a new regular file. A copy is never a second link to the same file: an edit of the copy would change the original.
- **Search.** `walk_notes` visits a link to a note as that note, with the file's size and placeholder flags.
- **Watcher.** A link is an entry like a file (`probe`): its creation, removal and renaming are told as a file's. It is not in the file-ID cache, where its ID would be its file's, so its rename arrives as a remove and a create.
  - A change of its *file* names the file. Each event path is therefore also looked up in `links`, and every link to that file gets a `modify`, or a `remove` once it leads nowhere, before deduplication and the drop rules. The lookup is by canonical path, which is the path the watchers report; it also finds a file in a hidden folder, whose own event is dropped.
  - A file outside the vault is not watched. The open note is read again when the window comes forward (§8.2).
  - Echoes: a registry record with a hash (a write) is compared with the metadata of the file the path leads to; one without (a rename) with the entry's own. A write through a link is recorded under both paths, so neither the file's event nor the one passed on to the link reaches the frontend.
- **Frontend.** No store knows a link from a file, except `vault.assetUrl`. Two notes that are one file (a link and its file, or two links to it) each have a controller of their own. A save through one is an external change for the other (§8.2): the watcher tells the links of their file's change, and a cached state is compared with the file whenever it is shown again. A clean one is replaced; unsaved text becomes a conflict copy.

## 7. Frontend state (`src/lib/state/*.svelte.ts`)

The stores are singleton classes with `$state` fields:
- Use `$state.raw` for big collections, and replace rather than mutate.
- **Never** put CodeMirror objects in `$state`.
- Write methods as arrow-function fields.

| Store | Responsibility |
|---|---|
| `settings` | Loads `{ settings, sessions }` through `settings_load` and writes what changed as patches through `settings_update`, debounced and only after loading finishes; other windows' changes come in as described below. Settings are sanitized on load and update, so unknown keys are dropped (SET-01). `shortcuts` holds only the user's changes, command id → keys (§9.1). `VaultSession` holds `expanded`, `lastFile`, `recent`, and `last`: the selection, scroll position and view mode for `lastFile` (VAULT-03), recorded on window blur or hide and before close or quit, and restored when the vault reopens. Applies the CSS variables (the content font size, the code font as `--font-mono`, the widths), `data-theme`, `data-icons`, `data-sidebar` and the window theme. `data-sidebar` is there while the sidebar is shown: `base.css` takes the sidebar's width from `--pane-width` then, and the content padding follows that (PLAT-12). `data-icons` is the icon set (SET-08): `tokens.css` maps it to the tree's folder color and fill, so no component reads that setting. |
| `vault` | This window's `VaultInfo` (a folder open in another window comes forward there, VAULT-07), the raw `listing` and the derived tree, node map, notes list, `linkables` (notes and images, for `[[` completion) and the link index over them (links never resolve to other files, TREE-16), plus tree UI state: `selected`, `renaming`, and `creating`, the new-folder draft (§8.3). File operations follow §8.3. Owns the `vault:changed` subscription (§8.2). Link resolution wraps `markdown/resolve.ts`. `assetUrl` gives an image that is a link on disk the URL of its file (§6.8). |
| `editor` | The open file, view mode, history, autosave engine, external-change reconciliation, the EditorState cache (20 notes and code files; dirty ones are pinned), virtual notes and recovery. A code file has a controller of kind `"code"`: cached and reloaded like a note, never dirty, never written (§10.4). Each controller keeps the vault epoch it was created in (§5). Publishes `lineRequest` `{ path, line, seq }` for every line reveal, which the reading view follows (§11). `blur()` takes focus out of the editor before slow commands (§8.3); `busyUnder` and `unsavedAt` let the vault refuse operations that would race a write or displace unsaved text. Owns the single `EditorView` after `Editor.svelte` attaches it. Implements `EditorHost`. |
| `ui` | Modal, context menu, confirm dialog, toasts, the search query (while it is set, the sidebar shows results instead of the tree), and focus requests. |
| `commands` | Registry used by the global shortcut handler and the command palette. `keysOf(cmd)` gives the keys in effect (the user's, else the defaults); `paused` is set while the shortcut settings record a key (§9.1). |
| `updater` | The update phase (`idle` → `checking` → `available` → `downloading` → `installing` → `restart` / `restarting`), the offered and the running version, and the download percentage. `start(beforeExit)` at mount, `install()` from the button (§6.7). The Tauri `Update` resource stays out of reactive state. |

Calls go one way: `vault` → `editor` for moves, removals and external changes. `editor` → `vault` only for queries and for creating files.

**Settings across windows.** Every window runs these stores for itself, over one settings document.
- A window writes only the settings keys and the vault sessions it changed, one patch per debounced write (`settings_update`); writes from one window never overlap. Rust merges each patch into the file under one lock and sends it to every window, the writer included, as `settings:changed` with the writer's label as `origin`, in the order applied.
- `state/settingsSync.ts` tracks, per key and per session root, what this window changed and has not seen come back. Another window's change replaces a value only when this window has none pending: an incoming change that arrives before this window's own echo was applied before its write, which wins on disk. A failed write is sent again with the next one.
- `sidebarVisible` and `sidebarWidth` are each window's own layout: written like the others (so a new window and the next launch start from the last one changed), never taken over.
- `load()` listens before it reads the file, and replays what arrived meanwhile.
- A session belongs to the one window that has its vault open (§6.1); another window only removes one, when its vault leaves the recent list (VAULT-04).

## 8. Autosave and sync protocol (SAVE-01…11)

### 8.1 Saving

- **Trigger.** The CodeMirror update listener calls `host.onDocChanged()` on `docChanged`, unless the transaction is annotated `External` (reloads and state swaps).
  - Each call schedules a save **400 ms after the last edit, at most 2000 ms after the first unsaved edit**.
  - Notes over 2 MB use 2 s and 10 s instead (SAVE-11).
  - **Saves run during IME composition**, because a save only reads the document.
- **Save job.** A save captures `{ path, text, bom, lineEnding, baseline }` from **that note's own EditorState** when it starts: the view's state for the open note, the cached state for an inactive one. It never reads "the current note" again later.
  - The text is converted back to the note's line ending (`\r\n` when the file used CRLF) and sent with `noteWrite(path, text, { bom, expected: baseline })`.
- **Ordering.** Only one write per path is in flight. Queued saves collapse into one with the latest text.
- **On success:** set `baseline = result`, `lastSaved = text`, and clear `dirty` only if the document did not change during the write (compare a version counter). Then `recoveryClear(path)` if a recovery copy existed.
  - If the note moved during the write (its path changed beyond Unicode normalization), the result describes the old path: the old baseline, which the rename carried over with the file, is kept and the text is written again at the new path. The one exception is a move made only of same-entry respellings (a case-only rename the watcher reported, which `#followRespellings` proved still names the same file): the write reached the note's own file, so its result is adopted as the baseline.
- **On failure:**
  - `conflict` (or `exists` for a first save): run §8.2's dirty path. If its read finds no file and nothing else will retry, fail like any other error below.
  - `not_found`: run SAVE-07's delete rule.
  - `read_only`: the note becomes read-only, its text goes to a recovery copy, and one toast appears.
  - Any other error: retry after 1, 2 and 5 s, then every 10 s, and on every flush. Show one `errSave` toast per run of failures, and write a recovery copy.
  - After 2 s of unsaved changes, `editor.saveStuck` lightens the titles (SAVE-09).
- **`flush()`** cancels timers, saves every dirty note (open and pinned), and awaits the chains, with a 2 s cap on note switch. It is called:
  - before opening another note;
  - before rename, move or trash of the open note or an ancestor;
  - on window blur and when the window becomes hidden;
  - on close and on `app:flush-request`;
  - on Mod+S (with no feedback).

### 8.2 External changes (SAVE-05/06/07)

- **Routing.** The vault store routes `vault:changed` events:
  - any structural change triggers a debounced refresh (about 150 ms, throttled adaptively for huge vaults). A `remove` counts only when its path is listed or live, or a listing is running: another app's temp or lock file that came and went between listings never re-lists the vault;
  - `modify`/`create` of a note or a code file with live state (open or cached) goes to `editor.onExternalChange(path)`.
  - On window **focus**, the open note or code file is re-checked the same way, because watchers miss changes on network volumes, and never see the file of a link that leads out of the vault (§6.8).
  - A code file is never dirty, so of the rules below only the clean ones apply to it: a change reloads its view in place, and a removal closes it. Its reads never overlap (`editor.#refreshCode`): one runs at a time, and a change that arrives meanwhile is read once more after it, so a big file written faster than it can be read still updates; a read that has not answered for 10 s no longer holds back the next. Over 2 MB it is not read again on window focus; the watcher's events are enough. It follows a create of the same text only when it has at least 200 characters (short files have twins), and only among the few created code files that kept its name or its folder.
- **`onExternalChange` reads the file and then:**
  - **Moved meanwhile:** an answer that arrives after the note or code file got another path is about the old path, "not found" above all. It is dropped and the file is read at its new path (three reads at most).
  - **Same text** as the buffer or as `lastSaved` (our own echo, or a line-ending-only change): update the baseline and line-ending style, and stop.
  - **Clean buffer:** reload in place with one minimal change (common prefix and suffix), annotated `External`, `addToHistory: false`, which preserves the selection and scroll. If a composition is active, wait for `compositionend`. Before a reload that would empty a non-empty note, wait until the file has stayed empty for 1 s.
  - **Dirty buffer**, which is a **conflict copy**:
    1. Write the disk version, byte-identical (its own BOM and line endings), with `noteCreate` as `<stem> (conflict YYYYMMDD-HHmmss).<ext>`. Truncate the stem to fit 255 bytes.
    2. Only if that succeeds, save the local text with `expected` = the disk version just copied, so a third version written meanwhile conflicts again instead of being overwritten.
    3. Show one toast naming the copy.
    - Repeated conflicts on the same note within 60 s overwrite that note's newest copy instead of creating more, but only while that copy is still exactly what was written (the overwrite sends the copy's baseline as `expected`) and no live note has it open. A copy that was edited, moved, deleted or opened gets a fresh copy instead. Moves and removals re-point or clear the remembered copy.
    - If the copy fails, leave the original untouched, keep the local text dirty, write it to a recovery copy, and show a toast.
- **Removals and renames.**
  - **`remove`** of a live note, or of an ancestor folder, is confirmed after the refresh: if the path exists again (save-by-rename editors, or our own case-only rename), treat it as a modify. Otherwise, close a clean note and keep a dirty one open; its next save recreates the file.
  - **`rename` with `to`** calls `editor.onPathMoved(from, to)`, unless `from` exists again, in which case it is treated as a modify.
  - **A live note already at a move's destination** (a virtual note, or one whose file vanished) gives way to the moved note: its unsaved text becomes a conflict copy (a recovery copy if that fails), and if it was on screen the moved note is shown in its place. Live notes at the destination without a moved controller of their own re-read their path, so a clean virtual note loads the moved file.
  - **Spelling-only renames** on case- or normalization-insensitive volumes arrive as creates, because the old spelling still resolves. After the refresh, a live note whose spelling is no longer listed, but still exists, follows the listed spelling segment by segment, so a respelled folder carries its tree state too.

### 8.3 In-app file operations (TREE-04…08)

- **`rename` / `move`:** flush the affected open note, then call IPC, then `editor.onPathMoved` (prefix-aware), then remap `expanded`, `selected` and the session, then refresh.
  - A destination where a live note holds unsaved text counts as taken (`errNameExists`), even when the listing does not show it (a virtual note, or one whose file vanished).
  - The flush and the freeze are capped at 2 s each. If a write for the path is still in flight after them, the operation stops with an error toast and unfreezes: the write could land afterwards and recreate the old path. `remove` does the same.
- **`remove`:** confirm per §0.2, then follow these steps:
  1. **Flush.**
  2. **Freeze** saves for the path and its descendants.
  3. `pathTrash`.
  4. On success, `editor.onPathRemoved` (dispose without saving) and refresh. If the removed note was shown, the previous history entry opens, taking keyboard focus only if the editor had it (a delete from the tree keeps the tree's focus, TREE-11).
  5. On `trash_failed`, confirm a permanent delete and use `pathDelete`.
  6. On failure or cancel, unfreeze.
- **`copyInto`** (the tree's paste, TREE-19): flush the copied note, then `pathCopy` under a free name, then refresh, and select and reveal the copy.
  - The name comes from `copyName`: the file's own where it is free in the target folder, else numbered. A name where a live note holds unsaved text counts as taken, as for a rename. On `exists` (an entry the listing did not show yet) the next name is tried.
  - Nothing is frozen and no controller changes: the source stays as it is, and the copy is a new file that nothing has open. It is not opened.
- **New note** (Mod+N, the header icon, the folder menus; `appCommands.newNote`): keyboard focus is released first, after any overlay closed, so keys typed while the note is created reach neither the previous note nor its title. Then `noteCreate` writes a real `Untitled.md` immediately and opens it in editing mode. Once the editor is visible, the caret moves to the start of the body, whether the inline title is shown or hidden. A later navigation cancels the pending focus. If nothing was created, the editor takes focus back. Notes created from the quick switcher also open with the body focused.
  - Esc in the title or body cancels this new note through the normal trash flow while its generated title and empty body are untouched. The creation records its exact path, vault epoch and editor revision, so generated names and numeric suffixes work without making older default-named notes eligible. Editing the body or navigating away ends eligibility; a changed inline title is reverted on Esc instead. Deletion rechecks eligibility after asynchronous waits. Open menus, dialogs, find panels and completions handle Esc first.
- **New folder** (Mod+Shift+N, the header icon, the folder menus; TREE-05): nothing touches the disk until the name is committed.
  1. `vault.createFolder(dir)` expands the folder and sets `vault.creating = { parent, name }` with a free default name (`New folder`, `New folder 1`, …). Calling it again for the same folder keeps the draft and what was typed.
  2. FileTree draws a draft row as the parent's first child, keyed by the `creating` object, which keeps its identity while it lives (a move re-points its `parent` in place). Reveals and tree focus requests are skipped while it is open.
  3. Enter calls `vault.commitFolder(name)`. It validates the name and refuses a taken one with a toast, keeping the row open and marked invalid. Otherwise it calls `dirCreate`, refreshes, clears `creating`, and selects and reveals the new folder. An empty name cancels.
  4. Esc, blur, a click elsewhere, a right-click or the row unmounting call `vault.cancelFolder()` and create nothing. The draft also ends when its parent is removed or disappears from the listing.
- **Unresolved link** (LINK-05): `editor.openVirtual(vault.linkTargetPath(target))` opens an empty buffer. The first edit's save creates the file with `noteCreate`. A recovery copy left for that path comes back as an unsaved, undoable edit only when it has no baseline (its file was never created). A copy based on a file that is gone becomes a conflict copy next to the path instead, and the buffer stays empty.

### 8.4 Quit, close, and recovery (SAVE-02, SAVE-10)

- **Close.** `getCurrentWindow().onCloseRequested(async () => …)` runs these steps, wrapped in try/catch, and the window is always destroyed (its vault is let go, §6.6):
  1. Record the open note's position in the session (VAULT-03), then `Promise.race([editor.flush(), timeout(2000)])`.
  2. On failure or timeout, write a recovery copy for every dirty note (each capped at about 1 s).
  3. `settings.flush()`.
- **Quit.** `onFlushRequest` runs the same steps in every window, each then calling `appExitReady()`; the app exits once all have (§6.6).
- **Update.** The updater runs the same steps before installing a new version and again before restarting into it (§6.7).
- **Opening a note** checks `recoveryGet(path)`:
  - If the file still matches the copy's whole baseline (mtime, size and hash: every empty file has the same size and hash, so a new note at a deleted note's path never takes the old text), restore the recovery text as a dirty buffer, which saves normally.
  - If the file changed too, open from the file and write the recovery text as a conflict copy.
  - The copy is cleared only once the restored text has saved, or its conflict copy has been written: the safety net stays until the text is on disk.

## 9. UI composition

```
App.svelte
├─ Welcome.svelte            (no vault)  open-folder icon button + recent vault names; UpdateButton in the top-right corner
└─ layout (vault open)
   ├─ Sidebar.svelte         header (drag region; new note, new folder, collapse all) · SearchPanel · FileTree (hidden while a query is set) · footer (vault menu: recent vaults, open another folder, new window; gear)
   │   ├─ SearchPanel.svelte the search field, always shown at the top; grouped results while it holds a query
   │   └─ FileTree.svelte    flattened visible rows, virtualized, keyboard nav, copy and paste, DnD, new-folder draft row
   │       └─ TreeRow.svelte guide lines + kind icon + title; inline rename input, or the draft row's name input
   ├─ Resizer.svelte
   └─ Main.svelte            top strip (drag region; sidebar toggle, always shown; nav, copy, view and lock icons; UpdateButton while a release waits) + .doc-scroll
       ├─ InlineTitle.svelte editable file name → rename on commit
       ├─ Editor.svelte      the single EditorView (always mounted while a vault is open): notes, and code files read-only (§10.4)
       ├─ Reader.svelte      rendered HTML (reading view)
       ├─ ImageView.svelte   image files (TREE-15)
       └─ UnsupportedView.svelte any other file: a notice naming its unsupported extension (TREE-16)
├─ QuickSwitcher · CommandPalette · SettingsModal (on Modal.svelte; its shortcuts page is ShortcutSettings.svelte; a last row shows the app version)
├─ UpdateButton.svelte       the update control of §6.7: download tray → percentage → restart arrow
├─ ContextMenu · ConfirmDialog · Toasts   the menu is one panel, and a second one beside it for an item's submenu (TREE-09)
└─ Icon.svelte               inline SVG icon set; a folder is solid where its parent sets --icon-fill (tree rows, by icon set)
```

**Document scrolling.** `.doc-scroll` is the scroll container. Inside it, `.doc-column` (max-width `--content-max`, centered, horizontal padding `--content-pad-x`, which shrinks with the pane, bottom padding `--content-pad-bottom`) holds `InlineTitle` and then `Editor` or `Reader`. The title scrolls with the text. CodeMirror is auto-height and relies on that ancestor scroll. The editor store saves and restores `.doc-scroll.scrollTop` per note.

### 9.1 Keyboard shortcuts (`Mod` = ⌘ on macOS, Ctrl elsewhere)

These are the defaults. Settings → Shortcuts rebinds every global command and the editor commands of EDIT-05 plus Mod-Enter (SET-06); the other keys below are fixed.

| Keys | Action | Scope |
|---|---|---|
| Mod-N / Mod-Shift-N | New note (body focused) / new folder (draft row in the tree, created on Enter, §8.3) | global |
| Mod-Alt-N (macOS) / Mod-M (Windows/Linux) | New window, on the Welcome screen (VAULT-08). ⌥⌘N is Mail's new window; Ctrl+Alt+N would be AltGr+N, which types a character on many Windows layouts, so elsewhere it is OneNote's Ctrl+M | global |
| Esc | Trash the untouched new note while its title is still the generated default (§8.3) | title / editor body, after overlays |
| Mod-O | Quick switcher | global |
| Mod-P | Command palette | global |
| Mod-Shift-F | Focus the sidebar's search field (selected text pre-fills) | global |
| Mod-E | Toggle reading/editing view | global |
| Mod-B / Mod-\ | Toggle sidebar | global |
| Mod-, | Settings | global |
| Mod-S | Save now (no feedback) | global |
| Mod-Alt-←/→; Mod-[ / Mod-] (macOS); Alt-←/→ (Windows/Linux); mouse 3/4 | History back/forward | global |
| F2 | Rename current note (focus inline title); in the focused tree, rename the selected row | global |
| Mod-Shift-E | Focus the file tree at the open note's row, revealing it (TREE-11) | global |
| Mod-C (the system's copy) | Copy the selected row's absolute path (TREE-11) | focused tree, or right after a click on a row |
| Mod-V (the system's paste) | Copy the file copied that way into the folder in focus (TREE-19) | the same, while the clipboard holds that copy |
| Mod-Q (Windows/Linux) | Flush and quit (macOS uses the menu item) | global |
| F5, Mod-R, Mod-Shift-R, Ctrl-F5, the keyboard's Refresh key | Cancelled: never reload the webview (PLAT-13). Every other browser key (Home, Stop, Search…) is cancelled too, and so are Mod-P and Mod-S (WebView2's print and save page) once no command takes them | global |
| Mod-Shift-B / Mod-I / Mod-Shift-X / Mod-Shift-H | Toggle bold / italic / strikethrough / highlight | editor |
| Mod-K | Insert or wrap link `[text](url)` | editor |
| Mod-L | Cycle task: `- x` → `- [ ] x` → `- [x] x` → `- [ ] x` | editor |
| Mod-1…6 / Mod-0 | Set heading level / plain paragraph | editor |
| Mod-Enter | Open the link under the cursor | editor |
| Tab / Shift-Tab | Indent / outdent (list item with its subtree) | editor |
| Enter / Backspace | Continue / remove list & quote markup | editor |
| Mod-F | Find; pressed again in the panel, it focuses the input and selects its text. Mod-H (Mod-Alt-F on macOS) opens replace, and the panel's chevron toggles the replace row. Outside the editor (reading view, tree, blank page) it switches to editing and opens the panel (EDIT-09). In the code view it finds only | editor (+ global fallback) |
| Mod-A; arrows, Page Up/Down, Home/End | Select all; scroll (the code view has no caret to move) | code view |
| ↑ on the first visual line | Move to the inline title, caret at its end (EDIT-15) | editor |
| ↑ / ↓ (also with Shift) next to a rendered table or image | Put the caret on the widget's nearest source line, revealing it; the default motion would skip the widget | editor |
| Alt-click | Add a cursor (Mod-click is reserved for links) | editor |

- **Global handling.** Global shortcuts go through one **capturing** `keydown` listener on `window` that matches the `commands` registry and calls `preventDefault`/`stopPropagation`. Because it captures, it beats CodeMirror's defaults (Mod-[ / Mod-] indent, Alt-arrows).
- **Custom shortcuts (SET-06).**
  - `settings.shortcuts` stores only what the user changed: command id → canonical specs (`Mod-Shift-p`; modifiers in the order Ctrl, Mod, Alt, Shift), where `[]` unbinds. Ids are stable because they are persisted: the registry's command ids, and `EDITOR_SHORTCUTS` in `editor/commands.ts` for the editor commands.
  - Both matchers read the user's keys at every press, so a change applies at once. The registry uses `commands.keysOf(cmd)`. The editor's `editorShortcuts(host)` reads `host.shortcutKeys(id)` (§10.1).
  - `Command.fixedKeys` always apply and show nowhere (BrowserBack/BrowserForward). `Command.fixed` keeps a command out of the settings: the engine-key guard (last in the registry, so a command the user puts on one of its keys wins), and Quit on macOS, which belongs to the app menu.
  - While the recorder listens, `commands.paused` makes the capturing listener return at once. The focused recorder button cancels every key itself: nothing runs or reloads, and Escape cancels recording instead of closing the modal. Tab still moves focus, and the blur ends recording.
  - A recorded key must pass `canBind` (`utils/keys.ts`): a function key, or a key held with Mod, with Control on macOS, or with Alt elsewhere. It must not be reserved: clipboard, undo/redo, select all, find and its next/previous keys, replace, and the macOS app-menu and window keys (Quit, Hide, Minimize, Full Screen, Cmd+\`). A key belongs to one command at most; a taken key is refused with a toast naming its command.
- **Composition.** Every custom key handler returns early on `isComposing(e)`. A Mod-chord that arrives mid-composition is ignored (EDIT-11).
- **Context menu.** The native context menu is suppressed everywhere except over editable text (the editor, inputs) or selected text (PLAT-13). A read-only editor, a locked note or a code file, is not editable: its menu appears over selected text only, and nothing drops into it.
- **Menus** (`ContextMenu.svelte`, `ui.showMenu`). A `MenuEntry` is an action, a separator, or an item with a `submenu` of actions (one level). The submenu is a second fixed panel, measured like the first: beside it, on the side with room. The pointer opens it after a short rest on its item and closes it after a longer one on another item, so the way into it may cross a neighbour; → and Enter open it, ← closes it. An action runs within the click or key press that chose it, so it may write to the clipboard. `showMenu`'s `anchor` is the button whose click opened the menu (the vault name): a press on it, or Space while it has focus, does not dismiss the menu, so the button's own click closes it rather than opening it again (VAULT-05).
- **Copying a row** (`FileTree.svelte`, TREE-11). The tree answers the `copy` event, not a key: Mod-C, the macOS Edit menu and the platform's other copy keys all raise it, and its `clipboardData` needs no permission. The engines send it to the text selection's element, not to the focused one, so the listener captures at the window and decides by focus. It also claims a copy right after a click on a row (`picked`, cleared by the next press or key), because that click may have moved the keyboard into the note it opened, where CodeMirror would copy the caret's line. The menu's Copy items have no such event and call `navigator.clipboard.writeText`.
- **Pasting a row** (`FileTree.svelte`, TREE-19). That copy also remembers its row (`copied`: the vault root, the path, and the text put on the clipboard), and the `paste` event is answered like the `copy` event: captured at the window, decided by focus or `picked`.
  - The paste is the tree's when the clipboard's text is still `copied.text`, in the same vault. A copied file then goes to `vault.copyInto` with `vault.activeDir()` (§8.3); a copied folder, or a file that is no longer listed, does nothing. Either way the event is cancelled and stopped at the window, so CodeMirror never sees it and the path is not typed into the note that has the keyboard.
  - Any other paste passes on untouched, and ends `picked`: it is text for the note.
  - Mod-C and Mod-V do not end `picked` as other keys do, because their `keydown` comes before the event.
- **Opening a folder as the vault** (`FileTree.svelte`, TREE-09, VAULT-05). The folder menu's Open as vault calls `openVault` with the folder's absolute path, taken when the menu opens, as a recent vault in the vault menu does. `vault.open` brings forward the window that has the folder open (VAULT-07), or flushes and replaces this window's vault; `vault_open` canonicalizes the path. The folder is then a vault of its own: its own session, epoch and recovery copies, and a place on the recent list beside the vault it was in.
- **Copying the open file's text** (`Main.svelte`, NAV-09). The strip's copy button is there for a note or a code file. It writes `editor.getText()`, the open controller's document, with `navigator.clipboard.writeText`, within the click, as the menu's Copy items do. The text therefore holds the edits not saved yet and LF line breaks, in the reading view too.
  - The button cancels its `mousedown`, so the keyboard and the selection stay in the text.
  - It is disabled while the document is empty: `editor.hasText()` reads the document's length, asked again whenever `editor.revision` grows.
  - After a copy it shows a check for 1.5 s, kept by the copied path, so only while that file is still the open one. Nothing else reports the success; a refused write is the `errCopy` toast.

### 9.2 Links, anchors, navigation (LINK-01…05)

- A document-level `click` listener prevents default on every `<a>`; the webview never navigates. Components that handle their own links do so first:
  - `http(s):` and `mailto:` go to `openUrl` from plugin-opener;
  - internal targets go to `editor.openLink`.
- **Wikilinks.** A resolved target opens. An unresolved one opens a **virtual** note (§8.3), unless it names an image or another known kind of file (`[[Q3.pdf]]`; `targets.ts › mayBecomeNote`). An unknown "extension" stays a note title (`Meeting 2024.01`).
- **Markdown links.** A relative `.md` link opens the note. A missing note target behaves like an unresolved wikilink (LINK-01, LINK-05), except that an existing file that is not a note or an image (relative to the note, then to the vault root) is never shadowed by a new note: then nothing happens. A `#heading` anchor scrolls to the heading.
- **Positions in another note** (search hits, `[[Note#Heading]]`, `[x](Note.md#h)`) land in either view (NAV-05): the editor moves its caret (a search hit's text is selected, SRCH-01), and the reading view scrolls to the same source line through `editor.lineRequest` (§11).

## 10. Editor (`src/lib/editor`)

### 10.1 Setup

`setup.ts › createEditorState(doc, host, opts)` builds the state:
- **Language:** `markdown({ base: commonmarkLanguage, extensions: [GFM, ...markdownExtensions], addKeymap: false, codeLanguages: [] })`. `commonmarkLanguage`, not `markdownLanguage`: the latter enables `~sub~`, `^sup^` and `:emoji:`, which can misinterpret tildes used to write ranges in Korean text.
- **Block dialect** (`syntax.ts › Dialect`, last in `markdownExtensions`; the reading view's half is `markdown/plugins/dialect.ts`, §11, and the two must stay in sync). What a line is never depends on a line typed after it, and a line belongs to a quote or a list item only through its own markup:
  - *No setext headings.* A `-` or `=` under a line of text is text, and `---` there is a rule. Otherwise the `-` that starts a list would turn the line above into a heading while it is typed.
  - *No lazy continuation.* A line without `>` is outside the quote, and a line indented less than a list item's text is outside the item, so text typed right below a quote or a list is a paragraph of its own and leaving them needs no blank line.
- **Keymap, in precedence order:**
  1. `editorShortcuts(host)`, a `Prec.high` keydown handler for the rebindable editing commands (`EDITOR_SHORTCUTS`). It matches with `utils/keys.ts`, like the global shortcuts, and reads the user's keys through `host.shortcutKeys` at every press; a command that declines (Mod-Enter off a link) falls through. Then `editingKeymap(host)`: ↑ on the first row moves to the inline title
  2. the completion keymap
  3. the closeBrackets keymap (for `(` and `[` only, EDIT-06)
  4. markdown Enter = `insertNewlineContinueMarkupCommand({ nonTightLists: false })`, after own steps (EDIT-03): Enter in front of a marker breaks the line without a second marker; an empty top-level item between two others is removed, so the list stays tight; an empty item with a tab after its marker or box outdents (nested) or leaves the list (top level), as lang-markdown does with spaces; an empty quote line loses its innermost `>`, which leaves the quote the way an empty item leaves a list (lang-markdown waits for two empty quote lines); on a later line of an item (after Shift-Enter), or in an item with a tab after its marker or box, the next marker is copied from the item's first line and following ordered items are renumbered. Shift-Enter inserts a soft break inside a list item or quote
  5. markdown Backspace = `deleteMarkupBackward`
  6. `defaultKeymap` without indentLess / indentMore (Mod-[ / Mod-]), indentSelection (Mod-Alt-\, which is AltGr+\ on Windows layouts), the comment toggles and toggleTabFocusMode
  7. `historyKeymap`
  8. list Tab / Shift-Tab (EDIT-04: indent or outdent the item with its subtree; elsewhere insert a tab / `indentLess`), instead of `indentWithTab`. Tab pads the tab with spaces when the previous sibling's text starts further right (`100. `), so the item nests. Both number the ordered items for their new place (`renumberShifted`): the lists are read from the document as the move leaves it, in a state that is never dispatched, so an item is numbered for the list it really lands in, and the move and the numbers go out as one transaction. When a number changes its width, the tree with the numbers is compared with the tree without them, and the numbers are dropped if a line would change its block
  9. the custom minimal search panel's keymap
- **Other extensions:**
  - `imeKeys` (`ime.ts`): a keydown with `keyCode` 229 was handled by the input method, which has already made its edit, so it is stopped on the editor's root in the capture phase and no keymap sees it. CodeMirror's own guard only covers keys between composition events, and WKWebView fires none for Hangul; without this, Backspace on a syllable in progress removed one jamo (the IME) and then the rest of the syllable (the keymap). EDIT-11;
  - `arrowTyping` (`arrows.ts`, EDIT-18): an input handler that turns a typed arrow sequence (`->`, `<-`, `<->`, `=>`, `<=>`) into its character, the editor's one substitution (EDIT-01). The typed character goes in as the default insert, and the arrow replaces the sequence in a second transaction of the same update, isolated in the history: one undo gives the typed characters back. It declines while an input method composes, and where the text is not prose: code (also behind an unclosed backtick on the line, since backticks are not paired), HTML, frontmatter, URLs and link destinations, wikilink targets, and escaped characters. The context is read from the state after the typed character, so a `>` that closes an HTML tag counts;
  - `history`, `drawSelection`, `dropCursor`, `EditorView.lineWrapping`;
  - `indentUnit.of("\t")`, `tabSize 4`;
  - `allowMultipleSelections`, plus `clickAddsSelectionRange` set to Alt-click;
  - autocomplete (`complete.ts`);
  - paste/drop (`paste.ts`), which also turns a URL pasted over a selection into a link (lang-markdown's `pasteURLAsLink` is off, §10.3);
  - the update listener;
  - the monotone `syntaxHighlighting`.
- **Compartments** cover `livePreview(host)` (disabled for notes over 2 MB; the size check is cached per document and skipped while live preview is off), spellcheck content attributes, and readOnly (`EditorState.readOnly` + `EditorView.editable`). The store and `Editor.svelte` derive each option as a primitive, so an unrelated settings update (a sidebar drag) reconfigures nothing.
- **Other `setup.ts` exports:**
  - `reconfigureEditor(view, opts)`;
  - `refreshDecorations(view)`, which dispatches `refreshEffect` but defers it while composing;
  - `replaceDocMinimal(view, text)`.
- **`EditorHost`** (`host.ts`) is the only bridge to app state.
- **Lezer node names** are fixed in `syntax.ts`: `WikiLink`, `WikiEmbed`, `WikiLinkMark`, `WikiLinkTarget`, `WikiLinkAlias`, `Highlight`, `HighlightMark`.
- **Line-height sampling** (TECHNIQUES §1.7). Any line whose height differs from body text carries a mark decoration over its content: heading text, code lines, frontmatter, table source lines, padded block starts, and whitespace in a padded blank line. This keeps CodeMirror from sampling it for height estimates.

### 10.2 Live preview (`editor/livePreview/`, LIVE-01…16)

- **Reveal.** Raw syntax shows only while the editor (or its find panel) has focus and a selection touches the construct.
  - Inline constructs reveal per element, with inclusive bounds.
  - Line constructs (heading, quote, list marker, task box, hr, escapes) reveal per line.
  - Fenced code reveals per block.
  - Block widgets (images, tables) reveal only when a caret or a selection **end** lies inside them, or a selection lies within them (Shift+Home on a revealed image line), unless that selection covers the whole document.
- **ViewPlugin, over visible ranges only.** It produces mark-hiding replaces, line classes, the checkbox widget, the flow attributes of DESIGN §3.2 and link marks. The flow attributes are `data-blk`, `data-prev`, `data-ctx`, `--mn-blank` and `data-lead` on a block's first line, the same pair on the blank line right below a block (tagged as the paragraph it would become), `--mn-hang` and `--mn-depth` gutters on list lines, and `--mn-quote`, `--mn-quote-list` and `--mn-quote-new` on quote lines. `livePreview/flow.ts` holds the pure container, pair and lead helpers; blank lines get no class and keep a body line's height.
- **Arrow keys into widgets** (`navigation.ts`). CodeMirror's vertical motion skips a block widget that replaces lines, so ↑ and ↓ (and their Shift variants, at `Prec.high`) check whether the move would leave the line toward such a widget and then put the caret on its nearest source line, which reveals it.
- **StateField** builds the image and table **block widgets** (only static decorations shape the height map). It caches regions from the block structure (top-level blocks plus the blocks inside lists and quotes, so nested images and tables render) and derives decorations from that cache plus the selection. A widget's first line may hold only indentation and quote markers: an image or table on a list marker's line stays source. A widget carries its inset (quote depth, list depth) and, read from the current tree when the decorations are composed, the pair attributes of the line it replaces: its block's, or those of the quote that starts on that line.
- **Link destinations** are the first `URL` after the label's closing `]` (`links.ts › linkUrl`), never a bare URL inside the label (`[www.x.com](https://x.com)`). Reference links have none and stay plain text, except a bare URL in their label. Clicks, Mod-Enter, decorations and table cells all use this rule.
- **Frontmatter.** A block that runs past the closing fence (Lezer reads text right after `...` as more of the same paragraph) is walked, not decorated, so what follows the fence renders.
- **Hold rules: decorations are *mapped*, not rebuilt, in these cases:**
  - during IME composition (rebuild once at `compositionend`);
  - while the primary button is down over the content (released at `mouseup` or `dragend`, a task later so CodeMirror's own mouseup handling goes first; immediately on any doc change or window blur). A drag therefore never selects text that moves under the pointer.
  - Keyboard moves never hold: a caret that lands on a heading or inside a construct reveals it in the same update.
- **Multi-click at the caret** (`clicks.ts`, an `EditorView.mouseSelectionStyle`). The release of the first click reveals the marks around the new caret, which shifts the text under the still pointer. A double or triple click therefore selects the word or line at that caret, not at the pointer; dragging on from there extends by words or lines over the layout as it is now.
- **Recompute triggers:** doc, viewport, selection (unless held), focus (via `EditorView.focusChangeEffect`), `refreshEffect`, and syntax-tree progress.
- **Robustness.**
  - Decoration building is wrapped in try/catch, falling back to `Decoration.none`.
  - Widgets implement `eq()` on content only. A table compares its source plus its cells' unresolved wikilink targets, so a listing refresh keeps its DOM (and horizontal scroll) unless a link's state changed.
  - Widgets resolve positions with `posAtDOM` at event time.
  - Widgets build DOM via properties, never `innerHTML` of note text.

**Construct cheat-sheet**

| Construct | Not revealed | Revealed |
|---|---|---|
| Emphasis, strong, strike, highlight, inline code | Marks hidden, text styled (`cm-em`, `cm-strong`, `cm-strike`, `cm-highlight`, `cm-inline-code`) | Raw marks in `--c-text-faint` |
| ATX heading | `#…` and its space hidden. `cm-hN` line class sets the size (em of `--fs-content`), so the caret is the heading's height. An empty heading keeps its `#`. There are no setext headings | Marks shown |
| Bullet `- * +` | Same-width bullet: the mark hides the glyph and `::after` draws `•` at the glyph's end, where the reading view's marker sits. Task items hide the marker | Raw marker when the selection touches the marker |
| Task `[ ]`/`[x]` | `<span class="cm-task" role="checkbox">` widget in place of the marker (bullet or number), the box and the blank after it: one line high, the box centered on it. Mousedown toggles one character and leaves the selection alone. Done items get `cm-task-done` (muted, struck) | Raw marker when touched |
| Quote `>` | Marker and space hidden. `cm-quote` line bars, so wrapped rows keep them; they run through the gaps inside the quote and begin below the gap above it | Raw, per line |
| Blank line | A body line: full height, a body-sized caret, no class. Right below a block (in the document or a quote) it carries that block's gap with a paragraph | Same |
| hr `---` | Text hidden. `cm-hr` line draws a 1px rule at normal line height | Raw |
| Fenced code | `cm-code` lines (`-first`, `-last`). Fence text is transparent and the language appears as a faint right label (`cm-fence`). No syntax colors | Raw muted fences while the selection is inside |
| Link `[t](u)` | `[` and `](u)` hidden. The label is a `cm-link` mark, still real text | Raw |
| Wikilink `[[t\|a]]` | Brackets and `t\|` hidden. The visible text is `cm-wikilink`, plus `cm-unresolved` (dashed) once the listing has loaded | Raw |
| Image alone on a line (LIVE-11), also in a quote or on a list item's continuation line | Block replace with the image (StateField), height reserved from a cached aspect ratio | Source, with the image block below it |
| Image inside text | Source only | Source only |
| Table (LIVE-12) | Block replace with a rendered table (StateField) | Raw pipes on `cm-table` lines |
| Frontmatter (`---` at offset 0 … `---`) | `cm-fm` lines (muted mono). Never parsed as Markdown | Same |
| Escape `\x` | Backslash hidden | Shown when the cursor is on that line |

**Clicks.**
- A plain click on a *rendered* link navigates without moving the cursor. A drag of more than 4 px cancels the navigation.
- Alt-click edits the link.
- On a revealed link, a click edits and Mod-click navigates.

### 10.3 Completion, paste, find

- **`[[` completion** offers the host's notes and images (`host.noteCandidates()`, each with `kind: "note" | "image"`; LINK-04), ranked as in NAV-02: the query splits on whitespace and every token must match the title or, weighted lower, the folder (a token containing `/` matches `folder/title`). Exact matches come first, then the score, the shorter title, the shorter path and collator order. After `![[` images come first, even for an empty query. There is no recency boost yet: the host does not expose the recent list. Images keep their extension in the label and in the link text.
  - Applying a suggestion inserts the shortest unique link text and `]]`, unless `]]` already follows. Inside an existing link only its target is replaced, keeping `#heading` and `|alias`; a table's escaped pipe `\|` ends the target. Typing `#` or `|` never accepts a suggestion.
- **Paste and drop:**
  - A clipboard or dropped image becomes `Pasted image YYYYMMDDHHmmss.<ext>` in the attachment folder of the note it was pasted into, inserted as `![](<relative path, spaces as %20>)`. No dialog. That note is captured at paste time (`host.saveAttachment(data, ext, forNote)`), and the link goes into that note's own EditorState: if another note is shown once the files are written, the link waits until that note is shown again.
  - A clipboard holding exactly one URL (`http(s)://`, `mailto:`, or `www.`, which gets `https://`), pasted over a non-empty selection of plain text on one line (no markup inside it, and not inside code or a link; lang-markdown's check), becomes `[selection](url)` in one undo step. Any other text pastes as is.
  - A dropped tree item becomes `[[link text]]`.
- **Find panel:** one input and no labels. Enter goes to the next match, Shift+Enter to the previous, and Escape closes the panel. Mod-F in the panel re-selects the input's text; the chevron button toggles the replace row. All key handling is IME-guarded. When there are no matches, the input text turns faint.

### 10.4 Code view (`editor/code`, TREE-17)

A code file is shown by the same `EditorView`, in a state of its own kind. The editor store keeps a controller for it as for a note (the state cache, scroll restore, reload on external change, §8.2), of kind `"code"`: its state is read-only, so it is never dirty, and no save path accepts it.

- **What is code** is decided by name in `utils/codeFiles.ts`: a table from extensions, whole file names (`Makefile`, `CMakeLists.txt`) and name prefixes (`Dockerfile.`) to a language id. `text` is the id of files shown without colors. `fileKindOf` (`utils/names.ts`) asks it after the note and image extensions. The backend mirrors the three lists (`fs_ops::is_code_name`) for the watcher (§6.4); `codeFiles.test.ts` reads `fs_ops.rs` and fails when they differ.
- **Languages** (`code/languages.ts`): one loader per id, checked by the compiler against the table.
  - JavaScript, TypeScript, JSX, HTML, CSS and Markdown use the Lezer grammars that lang-markdown already brings.
  - The others are CodeMirror 5 stream modes from `@codemirror/legacy-modes`, plus a few written here (`code/modes/`): PHP, Solidity, GDScript and a GLSL-like shading language; typed `.cfg` files and the text scene and resource formats built on their syntax; and rule lists for Makefile, Elixir, Zig, GraphQL, HCL, batch files and gettext.
  - Each stream mode is a chunk of its own, fetched when a file of that language is first opened and kept for the session. `loadCodeLanguage` never rejects: a file whose language fails to load opens as plain text, and the load is tried again the next time it opens.
  - **No input may stall or fail a mode** (`code/stream.ts › hardened`). The modes were written for an editor's own text; a viewer opens any file. U+2028 and U+2029, which CodeMirror keeps inside a line but a regular expression's `.` does not match, are read as spaces: several modes loop forever on one, or cannot get past it. A tokenizer that throws leaves the rest of its line unstyled, and one that does not advance yields one unstyled character. The modes written here are linear in the length of a line.
- **State** (`code/state.ts › createCodeState(doc, language)`):
  - `EditorState.readOnly` and a non-editable view with `tabindex`, as for a read-only note: selection, copy and find keep working, and the caret is hidden.
  - `lineNumbers()` in a gutter that is not sticky; line wrapping; tab stops of 4 columns.
  - `wrapIndent` (`code/wrap.ts`): each indented line in view carries its indentation in columns, which `code.css` turns into a hanging indent, so wrapped rows start under the line's own text.
  - `syntaxHighlighting(codeHighlight)` (`code/highlight.ts`): CodeMirror's default highlight style with its colors as `--c-syn-*` tokens (DESIGN §6), so dark mode needs no second style.
  - The find panel and its keys (§10.3; replace stays hidden in a read-only state) and Mod-A. No motion keys: the arrow, Page, Home and End keys scroll the document natively.
  - Drops are refused. The editor theme of §10.1 applies, and so does its `parseAhead` plugin for a text of up to 2 million characters; a bigger one is colored by CodeMirror's background parser alone, which never blocks a scroll. A language that fails on the very text gives way to plain text.
  - Nothing of the Markdown stack: no host, no compartments. `reconfigureEditor` returns at once for such a state.
- **Opening** (`editor.#openNote`): the file is read with `note_read` while its language loads, then the state is built, so the text never shows uncolored first. A cached controller is reused while the file's text is unchanged; one built for another kind or language is dropped.
- **A move that changes what the file is** (`editor.#reopenShown`): when the shown file's new name opens differently (a text file renamed to `.md`, a script to another language, any file into or out of an unsupported type), it is shown again as what it is now, at the same selection and scroll position. The check runs after every move, because another file's controller may also have taken the shown file's place. A note shown this way gets its recovery copy checked like any opened note (§8.4). This is not a navigation: it takes no turn in the open sequence, so it never cancels an open the user started, and it gives up when one starts or the file moves again. History and the tree stay as they are. Unsaved note text never leaves its editor this way.
- **Layout** (`Main.svelte`, `code.css`): the document column takes the wider of the text measure and the code measure (`--code-max`). The line numbers hang in the page margin, so the code starts where the inline title does; a gutter wider than the margin moves the code right instead.

## 11. Reading view (`src/lib/markdown`, READ-01…07)

- `render.ts › renderMarkdown(text, ctx)` returns sanitized HTML. It uses one markdown-it instance configured once, with `{ html: true, linkify: true, breaks: true, typographer: false }` and per-render context passed through `env`.
- **Own plugins:**
  - the block dialect (`plugins/dialect.ts`, first): `lheading` is disabled, and a terminator rule ends a quote at a line without `>` and a paragraph or link reference at a line indented less than its list item. It mirrors `Dialect` in `editor/syntax.ts` (§10.1); both sides test the same cases;
  - frontmatter, rendered as `<pre class="frontmatter">`, fences included;
  - fence labels: a fenced block's `<code>` carries `data-lang`, the first word of its info string, drawn as the editor's faint label (`plugins/fences.ts`);
  - wikilinks, rendered as `<a class="internal-link" data-wiki data-subpath>`, with `is-unresolved` when unresolved;
  - image wiki-embeds;
  - `==mark==`;
  - task items: `li.task-list-item`, whose checkbox is a **clickable** element with `data-line` rather than a disabled input. A box is drawn only where the editor's toggle would accept the line: the item's paragraph starts on the marker line, and that line reads `[quotes] <one list marker> [ ]` (`tasks.ts › TASK_LINE` mirrors `isTaskText` in `editor/commands.ts`; keep them in sync). An escaped `\[x]`, an entity `&#91; ]` or a second marker (`- - [ ] x`) stays text;
  - a `loose` class on loose lists, and `has-blocks` on lists whose items directly hold a code block, table, quote, rule, heading or HTML block (their items get the block gap, DESIGN §3.1);
  - a `<div class="table-wrap">` around tables;
  - **table alignment as classes** (`align-left`, `align-center`, `align-right`), because `style` attributes are sanitized away;
  - image `src` resolved through `ctx.resolveImage`, for `![alt](src)` and `![[image]]`;
  - **source lines** (`plugins/lines.ts`, last): `data-line`, the 0-based start line in the full text (frontmatter included), on paragraphs, headings, quotes, list items, tables and table rows, rules, fences (on their `<code>`) and indented code (on its `<pre>`).
- **Linkify** autolinks only what can be opened: `ftp:` and protocol-relative `//` are off. A `www.` schema follows the editor's Lezer `Autolink` rules (lowercase `www.`, at least one more dot, no `_` in the last two labels, trailing punctuation, an unbalanced `)` and a trailing entity left out) and gets `https://`. Fuzzy links stay off, so `README.md` stays text.
- **Sanitizing.** `DOMPurify` with:
  - forbidden tags `style script iframe object embed form link meta base dialog`;
  - forbidden attributes `style popover popovertarget popovertargetaction command commandfor autofocus srcset`;
  - allowed data attributes `data-wiki`, `data-subpath`, `data-line`, `data-lang`;
  - a URI allowlist of `http(s):`, `mailto:`, `asset:`, `http://asset.localhost`, relative URLs, `#`, and `data:image/`;
  - an `afterSanitizeAttributes` hook that removes `svelte-*` classes, so raw HTML cannot borrow a component's scoped styles (READ-04);
  - in the same hook, the `src` of a raw-HTML `<img>` resolved like a Markdown image's (`plugins/images.ts › htmlImageSrc`, READ-05). Raw HTML is no token the renderer could rewrite, so the hook reads the attribute the browser parsed; `renderMarkdown` hands it the context of the render in progress. A source with a scheme stays as written, which also leaves alone the asset URL of a Markdown image.
- **Containment.** `.markdown` has `contain: layout`: it is the containing block and stacking context of fixed and absolute raw-HTML elements, which therefore stay inside the article, under the app's UI, without clipping list markers in the gutter. A raw-HTML table (no `.table-wrap`) scrolls horizontally by itself.
- **`Reader.svelte`** renders into `<article class="markdown">` and delegates clicks: links go through §9.2, and checkboxes call `editor.toggleTaskAtLine`. `markdown.css` implements DESIGN.md §3.1.
  - It follows `editor.lineRequest` (NAV-05): a request for the shown note scrolls the last block whose `data-line` is at or before that line to the top (a fence's `<code>` maps to its `<pre>`), in a `requestAnimationFrame` after the new HTML is in place. A `seq` guard skips requests that were already shown by the editor or an earlier reading view; a request made in reading mode before this view existed is still followed. Requests for another note are dropped. A line above every block shows the start of the note.
- **`resolve.ts`** holds the pure resolution rules shared by the editor and the reader.

## 12. Performance rules (PERF)

- **Listing:** parallel breadth-first folder reads, no stat but for notes and images, one flat column per field (§6.3).
- **Tree:** built in one pass over the listing; a folder's children are sorted only when it is first shown (`tree.ts › sortedChildren`). A virtualized flat list of visible rows with a fixed `--row-h`, keyed `{#each}`.
- **Live preview:** inline work runs over `view.visibleRanges` only, and the StateField walks the block structure only (top-level blocks and the blocks inside lists and quotes), never inline content beyond a paragraph's own children.
- **Quick switcher:** ranks the `notes` array in JS and renders at most 50 rows.
- **Search:** runs in Rust, debounced 200 ms in the UI, and stale responses are dropped.
- **Reading view:** renders only while visible.
- **Code view:** a language's mode is fetched on first use; colors cover the viewport and a little past it, like the note parser (§10.1). Line decorations are built for visible lines only.
- **Layout:** no layout reads inside effects that write.

## 13. Testing policy

The owner wants minimal verification:
- `npm run check` and `cargo check` must be clean.
- `vitest` runs unit tests for pure logic only: utils, resolve, tree, syntax, render plugins, the code view's tables and modes, and small state helpers.
- Rust unit tests cover only the path guard, the listing rules, links (listed, read, written through, moved) and search helpers.
- There are no integration or E2E tests, and the app is not launched to verify.
