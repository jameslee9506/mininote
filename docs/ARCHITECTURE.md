# mininote — Architecture

mininote is a lightweight, local-first Markdown notes app in the spirit of Obsidian. A *vault* is any folder of `.md` files with sub-folders. The UI is monotone and nearly text-free (`docs/DESIGN.md`). Documents save themselves while you type.

## 0. How to read this document

This document fixes **structure, contracts and protocols**. `docs/research/REQUIREMENTS.md` fixes **behavior details and edge cases**, under IDs such as `SAVE-06`, including the `[critic]` items. `docs/research/TECHNIQUES.md` explains how to build the hard parts.

Where they disagree, REQUIREMENTS.md wins, unless §0.2 below says otherwise.

### 0.1 Scope of the current build

The current build covers every P0 requirement, plus these P1 items:
- VAULT-05
- TREE-10, TREE-11, TREE-13
- EDIT-05 (all shortcuts), EDIT-06, EDIT-07 (URL paste), EDIT-08, EDIT-09 (replace), EDIT-12, EDIT-14, EDIT-16
- LIVE-02 (highlight), LIVE-11, LIVE-12, LIVE-13
- SAVE-09, SAVE-11
- NAV-02 (Hangul extras, already in `utils/fuzzy.ts`), NAV-03, NAV-06
- SRCH-01, SRCH-02
- SET-02, SET-06, PLAT-05, PLAT-12

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
| Tree contents | Images are listed (muted). Other non-Markdown files are hidden. |
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
| Reading view | **markdown-it** + **DOMPurify** | Fast and extensible. Sanitizing is mandatory, because injected script could reach Tauri IPC. |
| Settings | Own Rust commands (`settings_load` / `settings_save`) | Atomic JSON in the app-config dir. `tauri-plugin-store` writes non-atomically and silently drops unparsable files. |
| Plugins | `single-instance`, `process`, `updater`, `dialog`, `opener`, `window-state` | No `fs` plugin. Every file operation is a vault-scoped custom command. `updater` and `process` only replace the app bundle and restart (§6.7). |

## 2. Process model

```
┌──────────────── Rust (src-tauri) ─────────────────┐      ┌──────────── Webview (src) ─────────────┐
│ vault.rs    root, epoch, path guard, asset scope  │      │ ipc/       typed invoke + events       │
│ fs_ops.rs   list / read / atomic write / rename   │◄────►│ state/     runes stores (settings,     │
│             trash / delete / binary / reveal      │ IPC  │            vault, editor, ui, commands)│
│ watcher.rs  notify debouncer → "vault:changed"    │─────►│ editor/    CodeMirror 6 + live preview │
│ search.rs   full-text scan, cancellable           │      │ markdown/  markdown-it reading view,   │
│ store.rs    settings JSON, recovery copies        │      │            link resolution             │
│ lib.rs      plugins, menu, exit-flush protocol    │      │ components/ Svelte UI                  │
└───────────────────────────────────────────────────┘      └────────────────────────────────────────┘
```

- The frontend never touches the filesystem directly.
- Every path crossing IPC is **vault-relative** with `/` separators (`VaultPath`).
- Rust joins it onto the active root and rejects anything that could escape: `..`, absolute or prefix components, and symlinked components.
- Every vault-scoped command carries the **vault epoch**. Rust rejects stale epochs with `no_vault`, so a late write meant for vault A can never land in vault B.

## 3. Directory map

```
src/
  main.ts                    mount(App) + global CSS
  App.svelte                 shell: layout, global shortcuts, startup, close/exit flush
  styles/                    tokens.css · base.css · markdown.css · editor.css · index.css
  lib/
    types.ts                 shared data contracts (mirrors Rust DTOs)
    i18n.ts                  t(key) — English UI strings
    appCommands.ts           concrete command list (shortcuts + palette)
    ipc/commands.ts          typed wrappers for every Rust command (epoch injected)
    ipc/events.ts            vault:changed, app:flush-request
    utils/                   path · names · fuzzy · platform · keys · timing
    state/                   settings · vault · editor · ui · commands · updater (*.svelte.ts), tree.ts
    editor/                  setup · theme · syntax · commands · complete · paste · search panel
                             · ime.ts · host.ts (bridge interface) · shared.ts · livePreview/*
    markdown/                render.ts (+ plugins/) · resolve.ts
    components/              Svelte components (§9)
src-tauri/src/
  lib.rs  error.rs  vault.rs  fs_ops.rs  watcher.rs  search.rs  store.rs
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
- **Unique names:** `Untitled.md`, `Untitled 1.md`, … are checked against siblings with `key()`.
- **Absolute paths** (asset URLs, reveal) come from `toAbsolute(root, rel)`, which uses the root's own separator.

## 5. IPC contract

Rust commands take snake_case parameters, and JS sends camelCase. Every error is serialized as `{ kind, message }`. The kinds are listed in `IpcErrorKind`: `no_vault`, `root_unavailable`, `invalid_path`, `not_found`, `exists`, `conflict`, `read_only`, `not_utf8`, `too_large`, `trash_failed`, `io`. JS rethrows each as an `IpcError`.

Every command marked "scoped" also takes `epoch: u64`, either as an argument or in the `x-epoch` header for raw-body commands, and fails with `no_vault` when it does not match. The frontend sends the current epoch, except for work done for one note: each note controller keeps the epoch it was created in and sends that one (`currentEpoch()` in `ipc/commands.ts`), so a save, read or recovery copy that outlives a vault switch fails with `no_vault` instead of reaching the new vault (PLAT-08).

| Command | Args | Returns | Notes |
|---|---|---|---|
| `vault_open` | `path` (absolute) | `VaultInfo` | Steps: (1) canonicalize with dunce; (2) require a directory; (3) set the root (recording whether it is a mount point, §6.1), `epoch += 1`, and clear the self-write registry; (4) allow the asset-protocol scope for the directory (recursive); (5) restart the watcher; (6) prune this vault's recovery copies that are older than 30 days and whose note no longer exists (SAVE-10). Errors: `not_found` (also for a file), `invalid_path` (relative or non-UTF-8 path), `io`. |
| `vault_list` (scoped) | – | `ListResult` | §6.3. |
| `note_read` (scoped) | `path` | `FileContent` | Strips a UTF-8 BOM (`bom: true`). Reports `readOnly` (the writability test `note_write` uses, §6.2 step 3), plus the baseline `{mtime,size,hash}` taken from stats around the read; a change while reading triggers a re-read (SAVE-06 "partial files"). Errors: `not_found`, `not_utf8`, `too_large` (over 20 MB). |
| `note_write` (scoped, **raw body**) | body = UTF-8 bytes (BOM included if wanted); headers `x-path` (URI-encoded), `x-expected` (JSON baseline or empty), `x-epoch` | `WriteResult` | §6.2. The `x-expected` check covers external changes since the baseline: a changed file gives `conflict`, a vanished one `not_found`. With an empty `x-expected` there is no baseline check, and missing parent folders **inside** the root are recreated. Either way the target is re-checked right before it is replaced: a file that appeared or changed during the write gives `conflict`, one that vanished `not_found`. Also returns `read_only` and `root_unavailable`. |
| `note_create` (scoped) | `path, content` | `WriteResult` | Exclusive create, creating missing parents inside the root. Error: `exists`. Used for new notes and conflict copies. |
| `dir_create` (scoped) | `path` | – | Creates parents. Error: `exists`. |
| `path_rename` (scoped) | `from, to` | – | Files and folders. Creates `to`'s parent. Error: `exists`, unless it is a case- or normalization-only rename of the same entry (done via a temp name, with rollback). A free `to` is checked again right before every rename attempt (Windows retries included), so an entry that appeared meanwhile gives `exists` and nothing moves. Refuses the root, and refuses a folder into itself or a descendant (`invalid_path`). Records both paths in the self-write registry. |
| `path_trash` (scoped) | `path` | – | `trash` crate. On macOS it uses `DeleteMethod::NsFileManager`, because the default AppleScript method prompts for Automation rights. Error: `trash_failed`. Refuses the root. |
| `path_delete` (scoped) | `path` | – | Permanent, recursive. Called only after confirmation. Refuses the root. |
| `path_exists` (scoped) | `path` | `bool` | |
| `path_reveal` (scoped) | `path` | – | Opener plugin `reveal_item_in_dir`, called from Rust. |
| `binary_write` (scoped, **raw body**) | body = bytes; headers `x-path`, `x-epoch` | – | New file only (`exists`), creating parents. Used for pasted and dropped images. |
| `search_text` (scoped) | `query, caseSensitive, limit` | `SearchResponse` | §6.5. |
| `recovery_write` (scoped) | `path, content, baseline` | – | Writes `{path, content, baseline, savedAt}` as JSON at `app_data/recovery/<fnv(root)>/<fnv(path)>.json`. Atomic. Newest wins. |
| `recovery_get` (scoped) | `path` | `RecoveryCopy \| null` | |
| `recovery_clear` (scoped) | `path` | – | |
| `settings_load` | – | `string \| null` | Reads `app_config/settings.json`. If it is unparsable JSON, renames it to `settings.corrupt-<ms>.json` and returns null. |
| `settings_save` | `json` | – | Atomic write. Rejects text that does not parse as JSON. |
| `app_exit_ready` | – | – | §6.6. |

| Event (Rust → JS) | Payload | When |
|---|---|---|
| `vault:changed` | `VaultChangedPayload` | Debounced batches (about 200 ms) of changes inside the root. Hidden paths, our temp files and self-writes are excluded. A notify `Rescan` flag, an event on the vault folder itself, or a batch of more than 1000 changes becomes one `{kind:"any", path:""}`: re-list and re-check every open or cached note. |
| `app:flush-request` | `null` | The app wants to quit: custom Cmd+Q, the last window closing, or an `ExitRequested`. |

## 6. Backend design (src-tauri)

### 6.1 State and path guard (`vault.rs`, PLAT-08)

- `VaultState` is managed with `app.manage`:

  ```
  VaultState {
      root: RwLock<Option<Root>>,  // Root { path: PathBuf, mount_point: bool }
      epoch: AtomicU64,
      watcher: Mutex<Option<Debouncer>>,
      registry: Mutex<SelfWrites>,
      search_gen: AtomicU64,
      exit_ready: AtomicBool,
      exit_pending: AtomicBool,   // the 4 s exit fallback is armed only once
      open_lock: Mutex<()>,       // serializes vault_open
  }
  ```

  Never hold a lock across file I/O.
- `check(epoch)`: fails with `no_vault` if there is no root or the epoch differs. If the root directory itself is missing (an unmounted volume), it fails with `root_unavailable` and nothing is ever created at that location.
  - On Unix, `vault_open` records whether the root is a mount point (on another device than its parent). Such a root that sits on its parent's device again is the bare folder of an unmounted volume, and `check` fails with `root_unavailable` too (VAULT-06). Device numbers are not stored, so a remount works; on Windows, or without a readable parent, nothing changes.
- `resolve(rel) -> PathBuf`:
  1. Split on `/` and reject empty, `.` and `..` components, NUL, and absolute or prefix components.
  2. On **Windows only**, also reject `\`, `:` and other characters that are invalid there. On Unix those characters are legal parts of a name.
  3. Join onto the root, then reject the result if **any existing component is a symlink or junction**: check `symlink_metadata` on each prefix that exists.
- `to_rel(abs)` strips the root and joins components with `/`. Entries that are not valid UTF-8 are skipped from listings.
- Operations that modify (`path_rename`, `path_trash`, `path_delete`) refuse `rel == ""`.

### 6.2 Writes (`fs_ops.rs`, SAVE-04/05)

- All commands are `async`, with blocking work in `tauri::async_runtime::spawn_blocking`.
- `mtime` is reported as ms since the epoch (f64). `hash` is FNV-1a 64-bit as 16 hex characters, stable across runs.
- **`note_write` algorithm:**
  1. `check` the epoch, then resolve the path.
  2. If `x-expected` is set:
     - a missing file gives `not_found`;
     - otherwise, compare the current size and mtime with the expected values; if they match but the mtime has no sub-second part, also compare the hash. A difference gives `conflict`.
  3. If the target exists and is not writable, return `read_only`: the Unix mode bits, the Windows read-only attribute or the macOS locked flag say so, or a write-open is refused (ownership, ACLs, read-only mounts or shares). The probe neither creates nor truncates, and a file merely held open elsewhere does not count. `note_read` reports `readOnly` with the same test.
  4. Missing parent folders inside the root are created (`create_dir_all`), but never the root itself.
  5. Create the temp file `.mn~<pid>-<counter>.tmp` in the same folder. Give it the original's group, and its owner where allowed (Unix, best effort; first, because a chown can clear set-id bits), then the original's permissions (Unix) and creation time (`FileTimes::set_created` on macOS and Windows). Then write the bytes and `sync_all`.
  6. Rename the temp over the target. On Windows, retry on raw OS errors 5/32/33 after 10, 20, 40, 80 and 160 ms. Right before every attempt, re-stat the target: if it appeared or changed since step 2 (size, mtime, inode on Unix; the hash too when the mtime is coarse and a baseline was given), stop with `conflict`; if it vanished, with `not_found`.
  7. If the folder refuses the temp file but the target is writable, fall back to writing in place: the step 6 re-check, then truncate, write, fsync.
  8. On error, remove the temp file. The target is never left truncated.
  9. If the file now at the target is still our temp file (same size, and same inode on Unix), record `abs → (size, mtime, hash)` in the self-write registry and return its baseline. Otherwise another program replaced it right after the rename: return the baseline of our version (from the temp file) and record nothing, so the next save's check and the watcher see theirs as a change.
- **Self-write registry:** an LRU of about 512 entries. Only overwrites by `note_write` and renames are recorded (renames record both paths and the case-rename temp name), each with the time it was made. Creates (`note_create`, `binary_write`, `dir_create`, a `note_write` that made a new file or found it replaced) still reach the frontend, whose tree needs them, and they forget any older record for the path. The watcher drops a `create` or `modify` event when the file's current size and mtime (and hash, when the mtime is coarse) still match the record. It also drops the `remove` echo of a rename source recorded in the last 5 s; after that, a delete of that path is real.
- **Case or normalization-only rename:** tried directly first; when the stored name did not change, go through the visible temp name `<stem>.mn-tmp-<n>.<ext>` (PLAT-07: a hidden temp left by a crash would be invisible) and roll back if the second step fails.
- **Stale temp files** (ours, older than one hour) are deleted when `vault_list` walks their folder.

### 6.3 Listing (`vault_list`, TREE-01, VAULT-01)

- `walkdir` with `follow_links(false)`.
- Skips names starting with `.`, plus symlinks and junctions.
- On Windows, also skips entries with the Hidden or System attribute.
- Lists directories, notes (`md`, `markdown`) and images (`png jpg jpeg gif webp svg bmp avif`).
- An unreadable sub-folder is skipped, not fatal.
- Capped at 100 000 entries (`truncated`).

### 6.4 Watcher (`watcher.rs`, TREE-12)

- `notify-debouncer-full`:
  - 200 ms;
  - recursive;
  - `Config::with_follow_symlinks(false)` (check the 0.7 API);
  - started by `vault_open`, after dropping the previous debouncer.
- Event mapping: `Create` → `create`; data `Modify` → `modify`; `Name(Both)` with two paths → `rename` with `to`; `Remove` → `remove`; the `Rescan` flag → `{any, ""}`.
  - A single-sided name change, or a `remove` of a path that exists again, is classified by what exists when the batch is handled: `create` if the path exists, else `remove`.
  - A paired rename from a hidden or temp file to a note is `create(to)`; from a note to a hidden or outside path is `remove(from)`; a rename whose source exists again (vim's save) is `modify(from)` plus `create(to)`.
  - Symlinks, files that are neither notes nor images, and folder metadata changes are dropped.
- **Drop rules:** events outside the root, any hidden component, our temp files, and registry matches.
- Deduplicate per batch, then `app.emit("vault:changed", …)`.
- The callback captures the root and epoch it was started for, and drops batches once a newer vault is open.

### 6.5 Full-text search (`search.rs`, SRCH-01/02)

- **Cancellation.** Each call bumps `search_gen`. The loop returns early (`truncated: true`) as soon as a newer generation exists.
- **Query.**
  - Whitespace-separated terms, or `"quoted phrases"`, NFC-normalized.
  - A file matches when **every term** occurs in its content or name.
  - Case-insensitive mode lowercases per character, with a map back to the original positions that tolerates length-changing case folds.
  - Hangul is matched at character level, as plain substrings.
- **Files.** Notes only, using the `vault_list` rules. Files over 2 MB are skipped, as are cloud placeholders (SRCH-01 [critic]).
- **Output.**
  - Up to 20 matching lines per file (lines containing any term), and up to `limit` files.
  - Snippets longer than 240 characters are trimmed around the first hit with `…`.
  - `ranges` are UTF-16 offsets into the snippet.
  - Ordering: files with `nameMatch` first, then by match count, then by path.

### 6.6 App lifecycle (`lib.rs`, SAVE-02, PLAT-05, PLAT-10)

- **Plugins, in this order:**
  1. `single-instance` (desktop only): unminimizes, shows and focuses `main`.
  2. `process` and `updater` (desktop only): the restart and the signed app updates of §6.7.
  3. `dialog`
  4. `opener`
  5. `window-state`, restoring size, position and maximized only (restoring visibility would show the hidden window before the first paint, PLAT-03)
  6. `mininote-navigation` (inline): the webview may only navigate within the app's own origin (`tauri://localhost`, `http(s)://tauri.localhost`, `about:blank`, and the dev server in dev builds), as defense in depth for READ-04 / PLAT-13
- **Exit flush.**
  - On `RunEvent::ExitRequested { api, code, .. }`: a restart request (`code == RESTART_EXIT_CODE`, §6.7) passes untouched, because Tauri ignores `prevent_exit` for it. Otherwise, if `exit_ready` is false and the `main` webview window exists, call `api.prevent_exit()` and emit `app:flush-request`.
  - At the same time, start (once, even when the request repeats) a 4000 ms fallback thread that sets `exit_ready` and calls `app.exit(code.unwrap_or(0))`. The frontend answers every request, with or without an open vault.
  - `app_exit_ready` sets `exit_ready` and calls `app.exit(0)`.
- **macOS menu.** Tao never raises a preventable exit for the predefined Quit (Tauri #9198), so build the menu explicitly:
  - **App menu:** About, separator, Hide, Hide Others, Show All, separator, and a **custom "Quit mininote" item with `CmdOrCtrl+Q`**. The custom item emits `app:flush-request` and starts the same fallback.
  - **Edit menu:** the predefined Undo, Redo, Cut, Copy, Paste and Select All. They are required for clipboard keys in WKWebView.
  - **Window menu:** Minimize, Zoom, Fullscreen.
- Windows and Linux have no menu bar. Ctrl+Q there is a frontend command that flushes and then calls `app_exit_ready`.
- The main window starts hidden (`visible: false`). The frontend shows it after the first paint.

### 6.7 App updates (`tauri-plugin-updater`, `tauri-plugin-process`)

- **Configuration.** The committed `tauri.conf.json` has an empty updater block (no endpoint, no key), so development and local builds check nothing. Release builds merge `src-tauri/tauri.updater.conf.json`, an ignored overlay that `scripts/prepare-release.mjs` writes after validating the public key, the versions (package.json, both lockfiles, tauri.conf.json, Cargo.toml) and the tag: `bundle.createUpdaterArtifacts`, the public signing key and the single endpoint `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`. GitHub Releases hosts the manifest and the archives; the app needs no credentials. Pipeline and one-time setup: `docs/releasing.md`.
- **Flow (frontend, `state/updater.svelte.ts`).** `start(flushBeforeExit)` at mount reads the running version and makes one background check (10 s timeout), repeated when the machine comes back online; development builds skip the check. A newer release shows the update button (§9). The click downloads (5 min timeout, whole-percent progress), runs the quit flush of §8.4, installs the signature-verified bundle, flushes again and calls `relaunch()`. Check failures are silent. An install failure toasts `errUpdate` once and keeps the button for a retry; after a successful install only the restart is retried (`restart` phase), never the install. The Tauri `Update` resource is closed after the install and when the store stops.
- **Why the flush runs twice.** Neither step waits for the exit protocol of §6.6: on Windows the plugin launches the installer and exits the process inside `install()`, and Tauri ignores `prevent_exit` for a restart request, so `ExitRequested` with `RESTART_EXIT_CODE` is let through without a flush request.
- **Scope.** Only the application bundle changes: the macOS `.app`, the Windows NSIS or MSI installer in passive mode (the installer relaunches the app), the Linux AppImage. A `.deb` or `.rpm` install has no AppImage to replace, and its check fails quietly. No vault file or setting is touched. No custom IPC command is involved; the plugins' own commands are allowed in `capabilities/default.json` (`updater:allow-check`, `allow-download`, `allow-install`, `process:allow-restart`).

## 7. Frontend state (`src/lib/state/*.svelte.ts`)

The stores are singleton classes with `$state` fields:
- Use `$state.raw` for big collections, and replace rather than mutate.
- **Never** put CodeMirror objects in `$state`.
- Write methods as arrow-function fields.

| Store | Responsibility |
|---|---|
| `settings` | Loads and saves `{ settings, sessions }` through `settings_load`/`settings_save`, debounced and written only after loading finishes. Settings are sanitized on load and update, so unknown keys are dropped (SET-01). `shortcuts` holds only the user's changes, command id → keys (§9.1). `VaultSession` holds `expanded`, `lastFile`, `recent`, and `last`: the selection, scroll position and view mode for `lastFile` (VAULT-03), recorded on window blur or hide and before close or quit, and restored when the vault reopens. Applies the CSS variables, `data-theme` and the window theme. |
| `vault` | Active `VaultInfo`, raw `entries` and the derived tree, node map, notes list, `linkables` (notes and images, for `[[` completion) and link index, plus tree UI state: `selected`, `renaming`, and `creating`, the new-folder draft (§8.3). File operations follow §8.3. Owns the `vault:changed` subscription (§8.2). Link resolution wraps `markdown/resolve.ts`. |
| `editor` | The open file, view mode, history, autosave engine, external-change reconciliation, the EditorState cache (20 notes; dirty ones are pinned), virtual notes and recovery. Each note controller keeps the vault epoch it was created in (§5). Publishes `lineRequest` `{ path, line, seq }` for every line reveal, which the reading view follows (§11). `blur()` takes focus out of the editor before slow commands (§8.3); `busyUnder` and `unsavedAt` let the vault refuse operations that would race a write or displace unsaved text. Owns the single `EditorView` after `Editor.svelte` attaches it. Implements `EditorHost`. |
| `ui` | Modal, context menu, confirm dialog, toasts, the search query (while it is set, the sidebar shows results instead of the tree), and focus requests. |
| `commands` | Registry used by the global shortcut handler and the command palette. `keysOf(cmd)` gives the keys in effect (the user's, else the defaults); `paused` is set while the shortcut settings record a key (§9.1). |
| `updater` | The update phase (`idle` → `checking` → `available` → `downloading` → `installing` → `restart` / `restarting`), the offered and the running version, and the download percentage. `start(beforeExit)` at mount, `install()` from the button (§6.7). The Tauri `Update` resource stays out of reactive state. |

Calls go one way: `vault` → `editor` for moves, removals and external changes. `editor` → `vault` only for queries and for creating files.

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
  - any structural change triggers a debounced refresh (about 150 ms, throttled adaptively for huge vaults). A `remove` counts only when its path is listed or live, or a listing is running: another app's temp or lock file never re-lists the vault;
  - `modify`/`create` of a note with live state (open or cached) goes to `editor.onExternalChange(path)`.
  - On window **focus**, the open note is re-checked the same way, because watchers miss changes on network volumes.
- **`onExternalChange` reads the file and then:**
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
- **New note** (Mod+N, the header icon, the folder menus; `appCommands.newNote`): keyboard focus is released first, after any overlay closed, so keys typed while the note is created reach neither the previous note nor its title. Then `noteCreate` writes a real `Untitled.md` immediately and opens it in editing mode. Once the editor is visible, the caret moves to the start of the body, whether the inline title is shown or hidden. A later navigation cancels the pending focus. If nothing was created, the editor takes focus back. Notes created from the quick switcher also open with the body focused.
  - Esc in the title or body cancels this new note through the normal trash flow while its generated title and empty body are untouched. The creation records its exact path, vault epoch and editor revision, so generated names and numeric suffixes work without making older default-named notes eligible. Editing the body or navigating away ends eligibility; a changed inline title is reverted on Esc instead. Deletion rechecks eligibility after asynchronous waits. Open menus, dialogs, find panels and completions handle Esc first.
- **New folder** (Mod+Shift+N, the header icon, the folder menus; TREE-05): nothing touches the disk until the name is committed.
  1. `vault.createFolder(dir)` expands the folder and sets `vault.creating = { parent, name }` with a free default name (`New folder`, `New folder 1`, …). Calling it again for the same folder keeps the draft and what was typed.
  2. FileTree draws a draft row as the parent's first child, keyed by the `creating` object, which keeps its identity while it lives (a move re-points its `parent` in place). Reveals and tree focus requests are skipped while it is open.
  3. Enter calls `vault.commitFolder(name)`. It validates the name and refuses a taken one with a toast, keeping the row open and marked invalid. Otherwise it calls `dirCreate`, refreshes, clears `creating`, and selects and reveals the new folder. An empty name cancels.
  4. Esc, blur, a click elsewhere, a right-click or the row unmounting call `vault.cancelFolder()` and create nothing. The draft also ends when its parent is removed or disappears from the listing.
- **Unresolved link** (LINK-05): `editor.openVirtual(vault.linkTargetPath(target))` opens an empty buffer. The first edit's save creates the file with `noteCreate`. A recovery copy left for that path comes back as an unsaved, undoable edit only when it has no baseline (its file was never created). A copy based on a file that is gone becomes a conflict copy next to the path instead, and the buffer stays empty.

### 8.4 Quit, close, and recovery (SAVE-02, SAVE-10)

- **Close.** `getCurrentWindow().onCloseRequested(async () => …)` runs these steps, wrapped in try/catch, and the window is always destroyed:
  1. Record the open note's position in the session (VAULT-03), then `Promise.race([editor.flush(), timeout(2000)])`.
  2. On failure or timeout, write a recovery copy for every dirty note (each capped at about 1 s).
  3. `settings.flush()`.
- **Quit.** `onFlushRequest` runs the same steps, then calls `appExitReady()`.
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
   ├─ Sidebar.svelte         header (drag region; new note, new folder, collapse all) · SearchPanel · FileTree (hidden while a query is set) · footer (vault menu, gear)
   │   ├─ SearchPanel.svelte the search field, always shown at the top; grouped results while it holds a query
   │   └─ FileTree.svelte    flattened visible rows, virtualized, keyboard nav, DnD, new-folder draft row
   │       └─ TreeRow.svelte guide lines + kind icon + title; inline rename input, or the draft row's name input
   ├─ Resizer.svelte
   └─ Main.svelte            top strip (drag region; sidebar toggle, always shown; nav, view and lock icons; UpdateButton while a release waits) + .doc-scroll
       ├─ InlineTitle.svelte editable file name → rename on commit
       ├─ Editor.svelte      the single EditorView (always mounted while a vault is open)
       ├─ Reader.svelte      rendered HTML (reading view)
       └─ ImageView.svelte   image files (TREE-15)
├─ QuickSwitcher · CommandPalette · SettingsModal (on Modal.svelte; its shortcuts page is ShortcutSettings.svelte; a last row shows the app version)
├─ UpdateButton.svelte       the update control of §6.7: download tray → percentage → restart arrow
├─ ContextMenu · ConfirmDialog · Toasts
└─ Icon.svelte               inline SVG icon set
```

**Document scrolling.** `.doc-scroll` is the scroll container. Inside it, `.doc-column` (max-width `--content-max`, centered, horizontal padding `--content-pad-x`, bottom padding `--content-pad-bottom`) holds `InlineTitle` and then `Editor` or `Reader`. The title scrolls with the text. CodeMirror is auto-height and relies on that ancestor scroll. The editor store saves and restores `.doc-scroll.scrollTop` per note.

### 9.1 Keyboard shortcuts (`Mod` = ⌘ on macOS, Ctrl elsewhere)

These are the defaults. Settings → Shortcuts rebinds every global command and the editor commands of EDIT-05 plus Mod-Enter (SET-06); the other keys below are fixed.

| Keys | Action | Scope |
|---|---|---|
| Mod-N / Mod-Shift-N | New note (body focused) / new folder (draft row in the tree, created on Enter, §8.3) | global |
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
| Mod-Q (Windows/Linux) | Flush and quit (macOS uses the menu item) | global |
| F5, Mod-R, Mod-Shift-R, Ctrl-F5, the keyboard's Refresh key | Cancelled: never reload the webview (PLAT-13). Every other browser key (Home, Stop, Search…) is cancelled too, and so are Mod-P and Mod-S (WebView2's print and save page) once no command takes them | global |
| Mod-Shift-B / Mod-I / Mod-Shift-X / Mod-Shift-H | Toggle bold / italic / strikethrough / highlight | editor |
| Mod-K | Insert or wrap link `[text](url)` | editor |
| Mod-L | Cycle task: `- x` → `- [ ] x` → `- [x] x` → `- [ ] x` | editor |
| Mod-1…6 / Mod-0 | Set heading level / plain paragraph | editor |
| Mod-Enter | Open the link under the cursor | editor |
| Tab / Shift-Tab | Indent / outdent (list item with its subtree) | editor |
| Enter / Backspace | Continue / remove list & quote markup | editor |
| Mod-F | Find; pressed again in the panel, it focuses the input and selects its text. Mod-H (Mod-Alt-F on macOS) opens replace, and the panel's chevron toggles the replace row. Outside the editor (reading view, tree, blank page) it switches to editing and opens the panel (EDIT-09) | editor (+ global fallback) |
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
- **Context menu.** The native context menu is suppressed everywhere except over the editor content, inputs, or selected text (PLAT-13).

### 9.2 Links, anchors, navigation (LINK-01…05)

- A document-level `click` listener prevents default on every `<a>`; the webview never navigates. Components that handle their own links do so first:
  - `http(s):` and `mailto:` go to `openUrl` from plugin-opener;
  - internal targets go to `editor.openLink`.
- **Wikilinks.** A resolved target opens. An unresolved one opens a **virtual** note (§8.3), unless it names an image or another known kind of file (`[[Q3.pdf]]`; `targets.ts › mayBecomeNote`). An unknown "extension" stays a note title (`Meeting 2024.01`).
- **Markdown links.** A relative `.md` link opens the note. A missing note target behaves like an unresolved wikilink (LINK-01, LINK-05), except that an existing file the listing does not show (relative to the note, then to the vault root) is never shadowed by a new note: then nothing happens. A `#heading` anchor scrolls to the heading.
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
  8. list Tab / Shift-Tab (EDIT-04: indent or outdent the item with its subtree; elsewhere insert a tab / `indentLess`), instead of `indentWithTab`. Tab pads the tab with spaces when the previous sibling's text starts further right (`100. `), so the item nests
  9. the custom minimal search panel's keymap
- **Other extensions:**
  - `imeKeys` (`ime.ts`): a keydown with `keyCode` 229 was handled by the input method, which has already made its edit, so it is stopped on the editor's root in the capture phase and no keymap sees it. CodeMirror's own guard only covers keys between composition events, and WKWebView fires none for Hangul; without this, Backspace on a syllable in progress removed one jamo (the IME) and then the rest of the syllable (the keymap). EDIT-11;
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
  - image `src` resolved through `ctx.resolveImage`;
  - **source lines** (`plugins/lines.ts`, last): `data-line`, the 0-based start line in the full text (frontmatter included), on paragraphs, headings, quotes, list items, tables and table rows, rules, fences (on their `<code>`) and indented code (on its `<pre>`).
- **Linkify** autolinks only what can be opened: `ftp:` and protocol-relative `//` are off. A `www.` schema follows the editor's Lezer `Autolink` rules (lowercase `www.`, at least one more dot, no `_` in the last two labels, trailing punctuation, an unbalanced `)` and a trailing entity left out) and gets `https://`. Fuzzy links stay off, so `README.md` stays text.
- **Sanitizing.** `DOMPurify` with:
  - forbidden tags `style script iframe object embed form link meta base dialog`;
  - forbidden attributes `style popover popovertarget popovertargetaction command commandfor autofocus srcset`;
  - allowed data attributes `data-wiki`, `data-subpath`, `data-line`, `data-lang`;
  - a URI allowlist of `http(s):`, `mailto:`, `asset:`, `http://asset.localhost`, relative URLs, `#`, and `data:image/`;
  - an `afterSanitizeAttributes` hook that removes `svelte-*` classes, so raw HTML cannot borrow a component's scoped styles (READ-04).
- **Containment.** `.markdown` has `contain: layout`: it is the containing block and stacking context of fixed and absolute raw-HTML elements, which therefore stay inside the article, under the app's UI, without clipping list markers in the gutter. A raw-HTML table (no `.table-wrap`) scrolls horizontally by itself.
- **`Reader.svelte`** renders into `<article class="markdown">` and delegates clicks: links go through §9.2, and checkboxes call `editor.toggleTaskAtLine`. `markdown.css` implements DESIGN.md §3.1.
  - It follows `editor.lineRequest` (NAV-05): a request for the shown note scrolls the last block whose `data-line` is at or before that line to the top (a fence's `<code>` maps to its `<pre>`), in a `requestAnimationFrame` after the new HTML is in place. A `seq` guard skips requests that were already shown by the editor or an earlier reading view; a request made in reading mode before this view existed is still followed. Requests for another note are dropped. A line above every block shows the start of the note.
- **`resolve.ts`** holds the pure resolution rules shared by the editor and the reader.

## 12. Performance rules (PERF)

- **Tree:** a virtualized flat list of visible rows with a fixed `--row-h`, keyed `{#each}`.
- **Live preview:** inline work runs over `view.visibleRanges` only, and the StateField walks the block structure only (top-level blocks and the blocks inside lists and quotes), never inline content beyond a paragraph's own children.
- **Quick switcher:** ranks the `notes` array in JS and renders at most 50 rows.
- **Search:** runs in Rust, debounced 200 ms in the UI, and stale responses are dropped.
- **Reading view:** renders only while visible.
- **Layout:** no layout reads inside effects that write.

## 13. Testing policy

The owner wants minimal verification:
- `npm run check` and `cargo check` must be clean.
- `vitest` runs unit tests for pure logic only: utils, resolve, tree, syntax, render plugins, and small state helpers.
- Rust unit tests cover only the path guard and search helpers.
- There are no integration or E2E tests, and the app is not launched to verify.
