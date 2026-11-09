# Tauri-based Obsidian-like apps: discovery and deep dive

Research only. Every behavior below is described in our own words; no code was copied (Writer Computer is GPL-3.0). Paths are relative to each cloned repo root (`scratchpad/oss/otterly`, `scratchpad/oss/writer-computer`).

## 0. Discovery result

### Chosen

| Role | Repo | License | Snapshot analysed | Signals (2026-11-08) |
| --- | --- | --- | --- | --- |
| **Primary** | **Otterly**: https://github.com/ajkdrag/otterly | MIT | `5124ab4` (2026-11-04, v0.8.0) | 171 stars, about 740 commits, weekly releases, installers for macOS, Windows (NSIS, MSI, portable zip) and Linux (deb, AppImage, AUR) |
| Secondary | **Writer Computer**: https://github.com/joelbqz/writer-computer | GPL-3.0 | `79b744c` (2026-10-28, v0.8.0) | 1,768 stars, about 425 commits (one author), macOS releases |

**Why Otterly.** Of every candidate it is the closest to mininote's stack: Tauri 2, Svelte 5 runes (SvelteKit with the static adapter), TypeScript, Vite and a CodeMirror 6 live-preview editor. It edits a plain folder of `.md` files with nested folders, a lazy file tree, autosave, a filesystem watcher, a quick switcher, full-text search, wikilinks and backlinks. It ships on all three desktop OSes and carries many Windows fixes we would otherwise learn the hard way (custom URL schemes under WebView2, retrying renames on file locks, skipping junctions). It is also unusually well documented. `docs/markdown_editor_behavior_spec.md` is a 1,464-line acceptance contract with stable scenario IDs, and together with `packages/markdown_editor/DESIGN.md` and `docs/architecture.md` it reads like a ready-made requirements spec for an Obsidian-style editor.

**Why add Writer Computer.** It is the most-starred Tauri v2 + CodeMirror editor for folders of markdown, and it is built for performance ("opens very large workspaces instantly"). It also does several Tauri 2 things Otterly does not:
- a macOS overlay titlebar with vibrancy;
- async commands with `spawn_blocking` for all filesystem work;
- suppression of the app's own writes inside Rust;
- delete to the OS trash;
- native context menus;
- natural sort modes;
- a `.gitignore`-aware sidebar.

It takes the opposite policy on two decisions that matter for us: external changes (the disk wins) and autosave (a throttle instead of a debounce).

### Considered and rejected

| Repo | Stars | Stack | Reason not chosen |
| --- | --- | --- | --- |
| codexu/note-gen | 12,989 | Tauri 2 + Next.js + TipTap, GPL | AI capture app; WYSIWYG serializer, not a plain-vault editor |
| drl990114/MarkFlowy | 2,428 | Tauri, AGPL | Typora-style editor; weaker vault/tree model |
| erictli/scratch | 1,635 | Tauri 2 + React + TipTap | Minimal, but its WYSIWYG serializer rewrites the source; no license in the API |
| team-reflect/reflect-open | 1,615 | ProseMirror, MIT | Daily-notes "graph" model; Mac and iPhone only |
| zhitongblog/solomd | 1,515 | Tauri 2 + Vue 3 + CM6, MIT | Centred on AI and MCP; very large repo (97 MB) |
| lokus-ai/lokus | 832 | Tauri + React + ProseMirror | Block editor; license unclear |
| Razee4315/Paperling | 593 | Tauri + React | Single-file editor, no vault |
| jpzk/opensidian | 359 | Tauri 2, GPL | Clean-room Obsidian clone with plugins and canvas; far heavier than our scope |
| kuku-mom/kuku, thejacedev/Noteriv | 232, 108 | Tauri 2 | macOS-only or graph/plugin/AI heavy |
| paperhurts/doc-md | 4 | Tauri 2 + Svelte 5 | Same stack as ours, but too immature |

---

## 1. Otterly at a glance

- **Layers** (`docs/architecture.md`): ports and adapters for every IO boundary. `$state` store classes are synchronous and free of side effects. Services are async, one method per user intention. Reactors are persistent `$effect.root()` observers and the only place where store changes trigger side effects. A single **action registry** is the one entry point for buttons, hotkeys, the command palette and menus. A lint script (`scripts/lint_layering_rules.mjs`) enforces the layering.
- **The Rust side is a thin IPC layer.** No domain state lives there, apart from watcher, search-index, window-claim and cancel-token state. All state management is in the frontend.
- **Frontend dependencies:** svelte 5.47, @sveltejs/kit 2 with adapter-static, Tailwind 4, shadcn-svelte/bits-ui, CodeMirror 6, @tanstack/svelte-virtual, dompurify, turndown with the GFM plugin, mermaid, yaml.
- **Rust crates** (`src-tauri/Cargo.toml`): notify 7, walkdir, the ripgrep crates (ignore, globset, regex), rusqlite (bundled, FTS5), comrak (parser only; used for link and tag extraction), blake3 (vault id), mime_guess, unicode-normalization and git2 (local repos only).

## 2. Tauri 2 specifics (priority)

### 2.1 Commands and threading
- Otterly registers about 80 `#[tauri::command]`s in one place (`src-tauri/src/app/mod.rs`). Most notes and folder commands are **plain synchronous functions**. Per the Tauri v2 docs, a sync command runs **on the main thread** unless it is marked `async` or `#[tauri::command(async)]`. File listing, reading the first 8 KB of every note for its title, and writes therefore block the event loop on slow disks. Only 11 commands are `async` (settings, vault settings, sessions, opening a new window, opening the theme file or vimrc, and vault-wide replace); the other 73 are sync.
- Writer makes every filesystem command `async` and runs the IO in `tauri::async_runtime::spawn_blocking` (`apps/desktop/src-tauri/src/commands/fs.rs`, `blocking()` helper). Its comments name iCloud placeholder files that can block for seconds. It also never holds an `RwLock` across file IO.
- **Errors** are plain strings in Otterly, with typed prefixes such as `conflict:mtime_mismatch`, `conflict:file_missing`, `file_not_text` and `note already exists`. The frontend matches on these substrings, and the JS wrapper adds a `tauri invoke failed: <cmd>:` prefix (`src/lib/shared/adapters/tauri_invoke.ts`).
- **Streaming:** vault-wide find streams results through a `tauri::ipc::Channel` and flushes every 50 ms (`src-tauri/src/features/search/vault_find.rs`, frontend `new Channel(...)` in `search/adapters/vault_find_tauri_adapter.ts`).

### 2.2 Capabilities and security
- Otterly's `src-tauri/capabilities/default.json` covers windows `main`, `vault-*` and `document-*` with only these permissions: `core:default`, window `set-title`/`close`/`destroy`, `clipboard-manager:allow-read-text`, `dialog:default`, `log:default`, `opener:default`, `process:allow-restart`, `updater:default`, `window-state:default`. **There is no fs plugin, no store plugin and no shell plugin.**
- Every file operation is a custom command taking `(vault_id, relative_path)`. Rust looks the root up in `vaults.json` on each call (`shared/storage.rs::vault_path`); there is no in-memory cache. Path safety (`features/notes/service.rs`):
  - reject absolute paths and `..`, `.`, prefix and root components;
  - canonicalize the nearest existing ancestor and require it to stay under the canonical root;
  - for writes, also reject any symlink component.
- "Reveal in Finder" and "open in default app" run the opener plugin **from Rust** on a path that has been checked to sit inside the vault (`features/shell/service.rs`). The plugin's JS `open_path` would need a filesystem scope, and vaults can live anywhere.
- CSP (`tauri.conf.json`): `script-src 'self'`; `img-src 'self' data: blob: otterly-asset: http://otterly-asset.localhost`; `connect-src ipc: http://ipc.localhost`. `withGlobalTauri: false`.
- Writer contrast: it enables Tauri's built-in asset protocol with scope `**`, so the webview can read any file, and its `write_file` accepts absolute paths from the webview without checking they sit inside the workspace. That is simpler, but much weaker than Otterly's scoping.

### 2.3 Filesystem: custom Rust instead of plugin-fs
- **Atomic save** (`shared/fs.rs`). The app writes a temp file named `<ms>.<counter>.tmp` beside the target and copies the old file's permissions onto it. It then renames the temp over the target, retrying on Windows sharing violations and permission-denied errors (Defender and OneDrive hold files for a few milliseconds) with delays of 10, 20, 40, 80 and 160 ms, about 300 ms in total. On failure the temp file is removed. The tree, the watcher and find all ignore files matching the temp pattern (`shared/constants.rs::is_ignored_file`). Settings, `vaults.json`, sessions and pasted images use the same helper. There is no `fsync`.
- `create_note` opens the file with `create_new`, so creation is atomic and an existing file is never clobbered.
- **Renames** go through a temporary name (`.<name>.rename.<ms>.tmp`) and roll back if the second step fails. This is what makes case-only renames (`x.md` to `X.md`) work on case-insensitive volumes (`notes_service_safety.rs::rename_with_temp_path_supports_case_only_rename`).
- **Delete is permanent** (`remove_file` / `remove_dir_all`, guarded by a dialog saying "This action cannot be undone."). Writer moves files to the OS trash with the `trash` crate.

### 2.4 File watching
- Otterly uses `notify` 7 `RecommendedWatcher` directly from Rust, with no debouncer crate (`features/watcher/service.rs`):
  - one watcher thread **per window**, recursive on the canonical root, polling a stop channel every 200 ms;
  - events are classified as `note_added` (Create), `note_removed` (Remove) or `note_changed_externally` (other Modify);
  - a rename becomes a remove plus an add. Windows reports From then To, Linux can report Both `[from, to]`, and macOS reports Any per path, so on macOS a filesystem existence check decides which side a path is;
  - events go only to the owning window via `emit_to`. The frontend must listen on `getCurrentWebviewWindow().listen(...)`, because the global `listen()` also receives events targeted at other windows.
- The frontend's handling is described in §4.4.
- Writer's watcher (`apps/desktop/src-tauri/src/watcher.rs`) batches events for 300 ms. It drops `.git`, `node_modules`, dotfiles (except its own `.writer/` config and `.gitignore`) and gitignored paths. It suppresses its own writes **in Rust**: a map from path to timestamp is filled at write time and has a 2 s TTL. It also tags each event with a workspace "epoch" so that events arriving after a workspace switch are dropped.

### 2.5 Local images (asset protocol)
- Otterly registers a custom scheme (`register_uri_scheme_protocol("otterly-asset")`, handler in `shared/storage.rs`):
  - URLs look like `otterly-asset://vault/<vault_id>/<percent-encoded relative path>`;
  - on Windows they become `http://otterly-asset.localhost/...`, because WebView2 cannot load a bare custom scheme (`src/lib/shared/utils/custom_scheme_url.ts`);
  - the handler percent-decodes **into bytes first, then UTF-8**, so Hangul names survive;
  - it resolves the path through the same vault-scoping function and returns 400, 403 or 404, otherwise the whole file with a `mime_guess` content type. It does not support range requests, which is fine for images but not video.
- Image `src` values in notes stay note-relative. The editor resolves them against the note's folder before building the asset URL (`features/note/domain/asset_markdown_path.ts`).

### 2.6 Window chrome and windows
- Otterly keeps the default OS decorations. The single `main` window entry is declared with `create: false`, and Rust builds every vault window from that entry under its own label (`main`, `vault-<n>`) so that `tauri-plugin-window-state` stores size, position, maximized and fullscreen per label. `dragDropEnabled: false` so that the tree's HTML5 drag and drop works; on Windows, Tauri's native drop handler otherwise swallows HTML5 drag events.
- A vault can be open in only one window: Rust keeps a window→vault claim map and focuses the other window if needed (`features/vault/service.rs`). Files opened from the OS get a **document window** whose read and write commands take no path, so that window can only reach its own file (`features/document/service.rs`).
- Writer's chrome (`apps/desktop/src-tauri/tauri.conf.json`): `titleBarStyle: "Overlay"`, `hiddenTitle`, `trafficLightPosition {x:20, y:29}`, `transparent` with the `hudWindow` vibrancy effect (needs `macOSPrivateApi`), and `visible: false`. The frontend shows the window after its first render, which avoids a white flash. Closing the main window on macOS **hides** it, and a Dock click restores it with its state intact.

### 2.7 Close and quit: flushing pending saves
- Otterly intercepts the window `onCloseRequested` event when tabs are open and shows "Close window?". On confirm it **saves the tab session**, which includes the text of unsaved buffers, to `.otterly/sessions/latest.json`, then destroys the window (`reactors/app_close_request.reactor.svelte.ts`, `app/orchestration/app_actions.ts`). It does **not** write dirty notes to their `.md` files on close; unsaved text only comes back as dirty tabs next time.
- **Cmd+Q on macOS ends the process immediately.** tao implements only `applicationWillTerminate:`, so the predefined Quit item, Dock › Quit and logout never raise a preventable `ExitRequested` (Tauri issue #9198). Otterly accepts this and relies on autosave (2 s) and session persistence (1 s) having already run.
- The known workaround (not used by Otterly) is to replace the predefined Quit with a custom menu item bound to `CmdOrCtrl+Q` that flushes saves and then calls `app.exit(0)`. Dock Quit and logout still cannot be intercepted, so the save debounce must stay short.

### 2.8 Single instance, menus, file associations
- `tauri-plugin-single-instance` is registered **first**. A second launch forwards its arguments: a file opens a document window, and a plain launch opens a new vault window, which is how "New Window" works on Windows and Linux. On Windows, `AllowSetForegroundWindow` is called so the new window is not left behind Explorer.
- The macOS app menu is the default one with "New Window" (Shift+Cmd+N) added. There is no menu bar on Windows or Linux, because `Builder::menu` would add one to every window. Otterly also adds a Dock menu and a Windows jump list.
- File associations for `md` and `markdown`: macOS uses `RunEvent::Opened`, Windows and Linux use argv, and a custom `.desktop` file with `%F` handles Linux.
- Writer builds its context menus with the native Tauri menu API (`@tauri-apps/api/menu`, then `popup()`), so they look native and need no styling.

---

## 3. Vault and workspace
- **Opening:** a native folder dialog (`plugin-dialog`), then `open_vault` canonicalizes the path. The vault id is the blake3 hash of the path string, so moving the folder creates a new id.
- **Registry**, in `<app_config_dir>/otterly/vaults.json`: each vault's id, path, name, created_at, last_opened_at, cached note_count and is_available (unavailable vaults are greyed out), plus `last_vault_id`. Pinned vault ids are stored separately.
- **Startup:** a plain launch shows the **vault picker**. The last vault is recorded but **not** reopened automatically. A reload or New Window for a specific vault reopens it via `get_window_vault_id`.
- **Opening a vault** (`features/vault/application/vault_service.ts`):
  1. record the vault as last opened;
  2. fetch in parallel the first page (200 entries) of the root folder, the vault list and the pinned ids;
  3. load recent notes, starred notes and editor settings, then apply the snapshot so the tree shows at once;
  4. in the background, compute folder stats and run an incremental search-index sync with progress events.

  A revision counter makes the most recent open request win.
- **Per-vault state** lives in a hidden `<vault>/.otterly/`:
  - `settings.json` (vault settings such as recent and starred notes);
  - `sessions/latest.json` (tabs);
  - `search.db` with its WAL files;
  - cleanup backups.

  App-wide settings, themes, the vimrc and logs live in the app config dir. A Windows portable build keeps everything in `data\` next to the exe.
- Settings writes are read-modify-write under a Rust `Mutex`, because two async `set_setting` calls could otherwise drop each other's key (`features/settings/service.rs`, `features/vault_settings/service.rs`).
- Writer contrast:
  - per-workspace config lives in `.writer/config`, which is watched and hot-reloaded;
  - app preferences use `tauri-plugin-store` (`preferences.json`);
  - tab sessions for all workspaces go in one app-data `sessions.json`, keyed by workspace root, so the user's folder stays clean (`commands/workspace.rs`). A session is saved 500 ms after tab changes and on `beforeunload`;
  - a cold start **restores the last workspace** with a single `get_startup_state` IPC call (see §4.7).

## 4. Behaviors by rubric area

### 4.1 File tree
- **Listing is lazy and paginated per folder.** `list_folder_contents(folder, offset, limit)` returns up to 200 entries per page (`PAGE_SIZE`). Rust caches each folder's listing in memory for 30 s, with at most 64 folders and the least recently used one evicted first (`features/notes/service.rs`). The app's own mutations invalidate the affected parent folders. **External changes do not invalidate the cache**, so a tree refresh triggered by the watcher can return a stale listing for up to 30 s. That is a pitfall to avoid.
- **What is listed:** every file except the `.otterly` and `.git` folders, OS clutter (`.DS_Store`, `desktop.ini`, `Thumbs.db`) and atomic-save temp files. Symlinks and Windows junctions are skipped, because Documents folders contain junctions that point outside the vault. Dotfiles are hidden in the UI unless "Show hidden files" is on. Rows show the **raw filename including `.md`**. Writer instead shows only `.md` files and folders that contain markdown (or are empty), and can label a file by its title (frontmatter `title`, else the first H1) or by its file stem.
- **Sort:** folders first. Rust sorts by ASCII-lowercased name with an exact-name tiebreak; the JS tree re-sorts with `localeCompare`. Writer uses `Intl.Collator(undefined, {numeric: true, sensitivity: "base"})` for natural order ("file2" before "file10"). It offers six modes (name, modified time and created time, each ascending or descending) and a folders-first toggle (`components/sidebar/sidebar-sort.ts`).
- **Rendering:** the tree is flattened into rows (`features/folder/domain/flatten_filetree.ts`) and virtualized with `@tanstack/svelte-virtual`, using overscan 5 and a fixed row height (`--size-tree-row`, 30 px; indent 16 px). A "load more" row is added at the end of a partly loaded folder and fetches the next page automatically when it scrolls into view; the scroll position is kept across the append.
- **Context menus:**
  - folder: New Note, New Folder, Star, Scope to this folder, Reveal in Finder / Show in Explorer / Show in File Manager (chosen per OS), Rename, Delete;
  - file: Star, Copy File Path, Reveal, Open in Default App, Rename, Delete.

  Rename and delete use **modal dialogs**, not inline editing. Writer creates the file first and then shows an **inline rename** input (`create-sidebar-entry-and-rename.ts`); it also has Duplicate, Copy relative/absolute path and Open in Terminal.
- **Drag and drop:** HTML5 drag and drop with multi-select (Shift for a range, Cmd/Ctrl to add). The drop target can be a folder row or the empty area, which means the root. A drop is invalid when there is nothing to move, a folder would move into itself or a descendant, an item is already in the target, or the selection contains nested items (`features/folder/domain/filetree.ts`). The Rust `move_items` repeats these checks, deduplicates paths case-insensitively, returns a result per item, and only overwrites when explicitly asked (folder over file and file over folder are always refused).
- **Expand state** is in-memory only (a set in the UI store). It follows renames and moves, is pruned on delete, and is **not saved** across restarts.
- **Keyboard:** rows take Enter or Space to select. There is **no arrow-key navigation** in the tree.
- **Name validation** (`features/note/domain/sanitize_note_name.ts`):
  - trim, replace `/` with `-`, and turn a leading `.` into `_`;
  - **strip everything after the last dot**, which is a bug: "v1.2 plan" becomes "v1";
  - cap the length at 200 characters, add `_` to Windows reserved names (CON, PRN, AUX, NUL, COM1–9, LPT1–9), and append `.md`;
  - Windows-illegal characters (`<>:"\|?*`) are **not** handled.

  Collision checks are case-insensitive and exclude the note's own path, which allows case-only renames (`note_path_exists.ts`). The backend still refuses an existing target unless both paths canonicalize to the same file.

### 4.2 Editor (CodeMirror 6 live preview, `packages/markdown_editor`)
- **Flavor:** CommonMark plus the GFM extensions (tables, task lists, strikethrough, autolinks), YAML frontmatter, `> [!type]` callouts, `[[target]]` and `[[target|alias]]`, `#tags`, `<br>`, escapes and entities.
  - **Not supported:** footnotes, `==highlight==`, `![[embeds]]` (excluded from link extraction) and math.
  - Fenced code is highlighted through `@codemirror/language-data`; mermaid fences render as diagrams.
- **The source is the document.** Saving reads the raw text and never serializes the rendered view. The editor displays an LF-normalized document but keeps a shadow raw document with the original CRLF/CR line endings and BOM, and undo history runs on the raw text (`core/source_state.ts`). Spec rules SRC-001 to SRC-013 require that opening and saving with no edit is byte-identical, and that untouched line endings and escape spellings are kept.
- **Three kinds of construct** (DESIGN.md):

  | Kind | Examples | How it renders | When the source shows |
  | --- | --- | --- | --- |
  | Inline | bold, italic, strike, inline code, link, image | marks and hidden delimiters | an empty caret is in the node, ends included |
  | Line | heading, list item, quote, horizontal rule, frontmatter | line classes and a hidden or replaced prefix | an empty caret is inside the line's prefix |
  | Block | fenced code, table | one widget over whole lines | while it is being typed, until the caret leaves or Enter finishes it |

  - **A non-empty selection never reveals source**, so text does not shift while you select.
  - Reveal is **frozen while the mouse button is down and for 100 ms after release** (`core/reveal.ts`). Writer has the same idea ("unfurl freeze" during pointer drag).
  - Delimiters on marks that span lines stay visible, because hiding them would join or split lines visually.
  - Hidden ranges are atomic for arrow keys.
  - Images draw their widget after the source and stay visible while the source is revealed, so the layout does not jump.
- **Widgets:**
  - a task checkbox replaces the bullet once the caret leaves the brackets; clicking changes only the `x`/space character;
  - a horizontal rule is a styled empty element;
  - a code fence becomes a card containing a **nested CodeMirror** that edits a window of the outer source. Edits map back and the outer view owns all history (`core/surface.ts`);
  - a table is a static HTML grid. Only the active cell gets a nested editor, so 5,000-row tables stay bounded. Tab and Enter move between cells, and row and column actions are in a right-click menu;
  - an image can be resized; the size is stored as a ratio in the alt text.
- **Failure isolation:** each construct runs inside a guard. A construct that throws renders its node as plain source instead of disabling the whole decoration plugin.
- **Keys** (`plugins/commonmark/*`):
  - formatting: Mod-b, Mod-i, Mod-e (inline code), Mod-Shift-x or Mod-Alt-x (strike); Mod-Alt-1/2/3 for heading levels; Mod-Alt-7/8 for ordered and bullet lists; Mod-Alt-c for a code block;
  - Tab and Shift-Tab indent; Mod-Enter leaves a block; Alt-Enter edits a link;
  - undo and redo: Mod-z, and Mod-Shift-z or Mod-y.
- **Context-dependent keys.** Enter, Shift-Enter, Mod-Enter, Backspace, Tab and Shift-Tab dispatch from the innermost construct outward:
  - Enter continues a non-empty list item (a continued task starts unchecked), lifts an empty item one level, and leaves the list from the top level (LIST-001 to LIST-003);
  - Tab nests the whole subtree under the previous sibling, and does nothing on a first item (LIST-004, LIST-005);
  - Shift-Tab lifts the subtree (LIST-006);
  - Backspace at the start of an item's text removes one level of context (LIST-007);
  - Shift-Enter inserts a hard break plus the continuation indent (LIST-009);
  - two Enters leave a non-empty quote (QUOTE-003).
- **Lazy-line guard** (NAV-011): text typed on an empty line right under a quote, list item or table first gets a blank line inserted above it, in the same undo step, so it does not join that block as a lazy continuation. The guard skips text that starts with a block marker, and it skips IME composition.
- **Paste** (`plugins/clipboard.ts`, `features/editor/adapters/html_clipboard.ts`):
  - an image file in the clipboard is handed to the app, which opens a **"Save Image" dialog** (preview, size, location, filename) before writing to `.assets/`;
  - otherwise `text/markdown` is preferred, then plain text that already looks like markdown, then HTML sanitized with DOMPurify and converted with turndown (ATX headings, fenced code, `-` bullets, GFM tables);
  - code and frontmatter always get plain text;
  - CodeMirror's `pasteURLAsLink` is **explicitly disabled** (`core/syntax.ts`).
  - Dropping OS files into the editor is not handled.
- **Find and replace in the file:** a custom plugin with regex, case and whole-word options. Matches are drawn inside nested code and table editors, and the selected match is forced to show its source (`plugins/find.ts`).
- **IME:**
  - while `view.composing` is true, the decoration plugin only remaps its existing decoration sets through the changes and never rebuilds them;
  - after `compositionend` it schedules one refresh on the next animation frame (`core/inline_rendering.ts`);
  - app hotkeys ignore events with `isComposing`, and Enter in the omnibar and find bar ignores composition (`hooks/use_keyboard_shortcuts.svelte.ts`).

  The spec (ACCESS-007) admits that real IME testing was never done (jsdom only).
- Other features: source mode (Mod-/) keeps history and selection; zoom from 0.5 to 2 in 0.1 steps; an optional line-number gutter (source mode only); vim mode (patched `@replit/codemirror-vim`); a slash menu. All of these are outside mininote's scope except zoom.

### 4.3 Persistence and autosave
The typing-to-disk pipeline:
1. A CodeMirror update listener marks the buffer dirty **synchronously**.
2. It publishes the markdown to the store **200 ms** after the last edit (`features/editor/adapters/codemirror_adapter.ts`).
3. The autosave reactor is a Svelte `$effect` that re-runs on every store change and keeps one timer whose cleanup cancels the previous one. This gives a trailing debounce of **`autosave_delay_ms` (default 2000)** (`reactors/autosave.reactor.svelte.ts`). Guards drop the save if the vault, buffer or path changed meanwhile.
4. The save calls `editor_service.flush()` to read the live editor text, so a save never misses characters still waiting behind the 200 ms publish (SRC-005).

In effect a note reaches disk about 2.2 s after the last keystroke.

Details:
- **Write queue.** Saves are serialized per `[vault_id, note_id]` through chained promises (`shared/utils/write_queue.ts`). A queued save reuses the mtime returned by the previous write instead of reading the disk again, which avoids false conflicts (`note_service.ts::run_save_plan`).
- **Conflict guard.** `write_note` takes `expected_mtime_ms`. Rust refuses the write with `conflict:mtime_mismatch` when the file's mtime differs, or `conflict:file_missing` when it is gone, and on success returns the new mtime.
- **After a save** the editor is flushed again. The note is marked clean only if its text still equals the saved snapshot, so typing during a slow save stays dirty.
- **Draft notes.** "New note" creates an in-memory draft "Untitled-N" (path `draft:<ms>:<title>`). Drafts are **never autosaved**. The first Cmd+S opens a save dialog that suggests a filename from a first-line `# Heading` (lowercased, inline markup stripped, at most 80 characters, words joined by spaces or hyphens; `features/note/domain/heading_filename.ts`). Drafts survive restarts through the session file.
- **Conflicts.** A sticky toast "Note has been modified externally" offers **Reload from disk** or **Keep my changes**. "Keep" sets the stored mtime to 0 so the next save overwrites. In our reading the Rust guard compares 0 literally and would refuse again; prefer an explicit `force` flag.
- **Tabs** are capped at 5 by default. When full, the first tab that is not pinned, dirty or active is closed and its buffer released. If every tab is dirty, a toast blocks the open.
- **Other debounces:** session save 1000 ms; recent notes 1000 ms; starred notes 400 ms; backlink and tag panels 220 ms; vault find 200 ms; git autocommit 30 s (off by default); update check after 10 s, then every 6 h.
- **Writer's pipeline** (`apps/desktop/src/lib/save.ts`):
  - a **throttle**: the first change saves at once, then at most one save per **1000 ms** per file;
  - only one save in flight per file, with a follow-up save if the text changed during the write;
  - no conflict check at write time;
  - optional "trim trailing whitespace" and "insert final newline" settings, which change bytes on every save.

#### Watcher decisions in the Otterly frontend (`reactors/watcher.reactor.svelte.ts`)

Before every write the app calls `suppress_next(path)`, which marks the lowercased path for 2000 ms (`features/watcher/application/watcher_service.ts`); events for marked paths are dropped. The other events are handled as follows:

| Event | Open, clean | Open, dirty | Background tab, clean | Background tab, dirty | Other |
| --- | --- | --- | --- | --- | --- |
| changed externally | reload, forcing a new buffer | mark conflict | invalidate the tab cache | mark conflict | ignore |
| added | refresh the tree | | | | refresh the tree |
| removed | **close the tab, even if dirty** | same | remove the tab | remove the tab | refresh the tree |

- Tree refreshes are debounced by 300 ms.
- Index updates are collected over 300 ms; the last event for a path wins, and a removed folder's notes are dropped by prefix.

**Writer** cancels the pending save and reloads from disk whenever the disk text differs from the last known disk text. The **disk wins**, so unsaved edits typed within the throttle window can be lost.

### 4.4 Navigation and search
- **Omnibar (Cmd+O / Cmd+P):**
  - with no query it lists recent notes (last 10);
  - prefixes: `>` for commands, `#tag` for tag chips (results must carry every chip), `@file`, `path:` and `title:` to choose the field;
  - "All" shows 8 file matches and 8 content matches.
- **File matching** (`features/search/db.rs::suggest_files`) scans every indexed note and keeps the best score over three fields, weighted name ×1.3, title ×1.15 and path ×1.0:

  | Match | Score |
  | --- | --- |
  | exact | 1200 |
  | prefix | 1040 minus a length penalty |
  | word-boundary prefix (after `/ \ space _ - .`) | 820 minus penalties for position and length |
  | substring | 720 minus penalties |
  | subsequence | 420 plus per character: +12; +18 at the start; +16 after a boundary; +14 for consecutive characters; minus gap penalties |

  Ties are broken by path.
- **Note title:** the first non-empty line, if it is `# Heading`, within the first 8 KB; otherwise the file stem.
- **Full-text search:** a SQLite FTS5 index in `.otterly/search.db` with columns title, name, path and body.
  - The tokenizer is `unicode61 remove_diacritics 2`, ranking is `bm25` with weights 10, 12, 5, 1, and a 30-token snippet is returned.
  - Every query term is phrase-quoted, so all terms must match (AND). Wikilink suggestions use prefix queries.
  - **Pitfall for Korean:** unicode61 splits on spaces, so the Korean word for "note" will not match the same word with a grammatical particle attached unless the query is a prefix query. FTS5's `trigram` tokenizer, or plain substring scanning, suits Hangul better.
- **Index maintenance:**
  - one writer thread per vault receives commands on a channel, and a separate read connection works alongside it in WAL mode;
  - an incremental sync compares mtime and size against a stored manifest and processes changes in batches of 100;
  - progress events are sent as `index_progress`;
  - `PRAGMA user_version` forces a full re-parse when the tag-parser version changes.
- **Text search** (Cmd+Shift+F) runs on the files themselves with the ripgrep crates: substring, regex, case, whole word, include and exclude globs, and replace across files.
  - It stops at 10,000 matches, skips files over 20 MB, sniffs 8 KB for binary content and builds previews of 200 characters (60 before the match). Columns are counted in UTF-16 units so JS can use them directly.
  - Replace works by match ordinal plus content hash, skips files with unsaved edits, and takes a git checkpoint first.
- **Other navigation:** tabs with pin and reorder, reopening closed tabs (history of 10), Cmd+J/K for next and previous tab, and Cmd+\` for the last used tab. There is **no back/forward history and no outline view**. A side panel ("context rail") lists Tags, Backlinks, Outlinks, Planned (unresolved) links and External links.
- **Writer:**
  - keeps an in-memory index built by a parallel, cancellable `ignore::WalkBuilder` walk;
  - its quick open is a substring match that also tries the query with spaces and hyphens swapped. Scoring puts filename matches far above directory matches, then earlier matches, then shorter paths, with a limit of 50;
  - unlike Otterly, it keeps **per-tab back/forward history**, which is saved in the session (`stores/editor-store.ts::navigateBack`, `SessionTabData.back/forward`).

### 4.5 Links
- **Resolution** (`src-tauri/src/features/search/link_parser.rs::resolve_wiki_target`) is path-based, not Obsidian's shortest-path rule:
  - `[[a/b]]` means `a/b.md` from the **vault root**;
  - `./` and `../` are relative to the note;
  - `.md` is added when missing, `#fragment` is dropped, percent sequences are decoded, and http(s) targets are external;
  - when opening, an exact path match wins; then a case-insensitive match; then a match in the same folder; then the alphabetically first (`features/note/domain/note_lookup.ts`).

  Clicking an unresolved link **creates that note**.
- **Autocomplete** starts after `[[`, never inside code or after the `|` alias separator. It merges FTS prefix hits on title, name and path (weights 15, 20, 5) with "planned" targets: unresolved link targets ranked by reference count. Accepting inserts the full vault path without `.md` and reuses an existing `]]`. Stale queries are cancelled through an `AbortSignal` (MENU-005, MENU-006).
- **Backlinks and outlinks** are stored in an `outlinks(source, target)` table filled while indexing. comrak extracts the links (wikilinks plus `.md` markdown links) and skips `![[embeds]]`.
- **Rename and move repair** (`features/links/application/link_repair_service.ts` plus Rust `rewrite_links`):
  - collect backlinks from the index;
  - parse each source note with source positions and replace **only the byte range of each target** (existing wikilinks keep their style, and spaces get angle brackets in markdown links);
  - the moved note's own relative links are fixed too, and open buffers are updated in place;
  - progress shows as an operation message.

### 4.6 Rendering and typography
- **There is no reading view.** The editor is always live preview, with source mode as the alternative. Static rendering exists only for inactive table cells (`core/static_render.ts`). Raw HTML is never executed: HTML blocks stay literal and only `<br>` is rendered. Mermaid SVG is sanitized with DOMPurify.
- **Typography tokens:**
  - body 1rem (16 px) × zoom, line height 1.85, column width `min(85ch, 90%)`, weight 500 for headings and 600 for bold;
  - headings 1.75em, 1.1875em, 1.125em, 1.0625em, 1em and 0.875em; H5 and H6 are uppercase with letter spacing;
  - code 0.8125rem with line height 1.5 (`src/styles/editor.css`, `packages/markdown_editor/src/plugins/commonmark/theme.ts`);
  - UI text tokens are 11, 13, 14, 15 and 16 px, on a 4 px spacing scale (`docs/UI.md`).
- **How vertical spacing works.** This is directly relevant to our "spacing between blocks, not margins on blocks" rule. CodeMirror estimates the height of every undrawn line from one short plain-text line, so **a line box must never carry vertical space**; otherwise the view never settles and clicks land in the wrong place (SPACE-009). Otterly therefore:
  - gives text blocks (paragraphs, headings, list items) **no spacing of their own**; blocks written with no blank line between them touch;
  - makes **each blank source line** the gap between blocks, `max(1.25em, --editor-paragraph-spacing)` tall (default 1.5rem), and keeps it a caret stop with its whitespace hidden;
  - gives "boxed" blocks (code card, table, quote, callout, frontmatter, indented code) a margin `--editor-block-margin-y` (0.5rem) so they never touch a neighbour. The margin is drawn as **transparent top and bottom borders or padding on the wrapper**, never a CSS margin, which would escape CodeMirror's height map. Content inside a card is inset by `--editor-block-padding-y` (0.75rem);
  - checks every theme with a test (SPACE-009 in the spec) that fails if a line CodeMirror might sample has vertical styling.
- For mininote's markdown-it reading view, the takeaway is that the editor and the reading view need **different** spacing models. The editor follows the source's blank lines, while the reading view can use sibling-pair rules. The editor still has to keep vertical space off line elements.

### 4.7 Performance
- **Big notes** (`packages/markdown_editor/DESIGN.md`, `core/syntax.ts`):
  - Lezer parses a 19 KB note in about 2 ms; a 1.4 MB note takes about 155–175 ms for a full parse and about 1 ms after a one-character edit;
  - the editor parses the whole note synchronously up to 1,000,000 characters with no block over 200,000, within a 150 ms budget; beyond that it parses the visible part first and the rest in idle slices;
  - one giant paragraph is a known limit (1.4 MB takes 1.5 s).
- **Many notes:** the tree is lazy and paginated with a 30 s Rust listing cache and virtualized rows. Indexing is incremental and runs on a background thread. Opening a vault only reads the root folder's first page before the UI becomes usable.
- **One editor view.** A single `EditorView` is reused, and an `EditorState` is kept per open note in a map keyed by vault and path. Switching tabs swaps the state, which keeps undo history, selection and widget state (LIFE-001). Closing a tab drops its state, and the tab cap bounds memory.
- **Cost:** sync commands on the main thread (§2.1); a `vaults.json` read on every command; extracting titles means opening every `.md` file listed in a folder page.
- **Writer:**
  - async commands with `spawn_blocking`;
  - a parallel `ignore` walk that can be cancelled when the workspace changes;
  - a set of folders known to contain markdown, so each folder check is O(1);
  - one startup IPC call returns the workspace info, root entries, recent workspaces, session and the active file's content. It replaces a waterfall of four or five calls, and runs the reads in parallel (`commands/workspace.rs::RestoreWorkspaceResponse`);
  - a 40 ms grace period before showing a "Loading…" placeholder when opening a file;
  - a 150 ms debounce on heading extraction;
  - a size-optimized release build (`opt-level="s"`, full LTO, `codegen-units=1`, `panic=abort`, strip). Otterly builds with `opt-level=2`, thin LTO and 16 codegen units for faster compiles.

### 4.8 Platform details
- **Windows:**
  - convert custom-scheme URLs to `http://<scheme>.localhost`;
  - retry renames when files are locked;
  - skip junctions in listings;
  - strip the `\\?\` verbatim prefix before showing a path (`shared/paths.rs`);
  - pin the MSI `upgradeCode` so upgrades replace the old install;
  - keep the previous `.md` handler through NSIS hooks;
  - portable mode gets its own single-instance identifier derived from the folder hash.
- **Linux:** the product name stays lowercase so the `.desktop` and AppImage names are stable, and a custom `.desktop` file passes `%F`.
- **Paths:** the frontend always uses `/`-separated relative paths, built with `normalize_relative_path` in Rust. Path comparisons in JS are case-insensitive (`paths_equal_ignore_case`).
- **NFC/NFD: Otterly only NFC-normalizes tag keys**, not file paths. On macOS, a Hangul filename created by Finder or a sync tool can be NFD while a wikilink target typed with an IME is NFC, so string comparisons in link resolution, the index and tab matching can disagree. **mininote must normalize paths to NFC at the IPC boundary.**

### 4.9 Settings (Otterly defaults, `src/lib/shared/types/editor_settings.ts`)

| Setting | Default |
| --- | --- |
| autosave | on, 2000 ms |
| attachment folder | `.assets` (hidden) |
| store attachments next to the note | off |
| show hidden files | off |
| max open tabs | 5 |
| editor max width | 85ch |
| zoom | 1 |
| line numbers | off |
| filename delimiter | spaces |
| vim | off |
| git autocommit | off |
| vault dashboard on open | on |

Also configurable: themes (stored in a theme file that hot-reloads), hotkeys (recorder with validation) and the vimrc. Writer adds the sidebar sort mode, folders-first, title-or-filename labels and file processing options.

---

## 5. Pitfalls found (what to do differently)
1. **Sync commands block the main thread.** Make filesystem commands `async` and use `spawn_blocking`, as Writer does.
2. **Path caches go stale after external changes.** Invalidate any Rust listing cache from the watcher thread, or skip the cache.
3. **Close and quit do not flush to `.md` files** (Otterly saves the session instead), and Cmd+Q bypasses everything. Add a custom Quit menu item that flushes before `app.exit(0)`, flush on window blur and `visibilitychange`, and keep the save debounce short.
4. **The new-note draft is never autosaved**, and new names need a save dialog. This breaks "every edit is saved". Create a real file at once and rename it inline, as Writer and Obsidian do.
5. **The image paste dialog adds UI friction.** Write `attachments/<stamp>.png` silently. Note that Otterly's filename sanitizer drops non-ASCII characters (`sanitize_stem`), so Hangul names are lost.
6. **Disk-wins reload (Writer) can silently drop edits; "close the tab even if dirty" on removal (Otterly) can too.** On external change: reload a clean note silently; for a dirty note, keep the text and offer one minimal action.
7. **The FTS5 `unicode61` tokenizer is poor for Korean.** Use substring or trigram search.
8. **The filename sanitizer strips text after the last dot and misses Windows-illegal characters.**
9. **Self-write suppression keyed on lowercased paths in JS** can mask a real external edit within 2 s, and breaks if path forms differ (for example NFC vs NFD). Writer suppresses in Rust at write time and also tags events with an epoch.
10. **Permanent delete.** Use the OS trash.

## 6. What mininote should take
- Its **Tauri surface**:
  - only the dialog, opener, window-state and single-instance plugins;
  - custom vault-scoped commands taking `(vault_id, relative_path)`;
  - a custom asset scheme with the Windows `http://<scheme>.localhost` form;
  - a strict CSP;
  - `dragDropEnabled:false` if the tree uses HTML5 drag and drop;
  - a window created hidden and shown after the first paint.
- Its **save core**: atomic temp-then-rename with the Windows retry; a per-file write queue; an expected-mtime guard; a flush that reads the live editor text; marking clean only when the text is unchanged since the save.
- Its **editor rules**: the three kinds of construct; caret-local reveal; no reveal for non-empty selections; the pointer freeze; failure isolation; decorations that only remap during IME composition; one `EditorView` with an `EditorState` per note; source preservation via an LF display document over a raw document.
- Its **spacing discipline in the editor**: blank source lines are the gaps, and boxed blocks get transparent wrapper borders. Keep it apart from the reading view's sibling-pair CSS.
- Its **tree mechanics**: lazy, paginated per folder, virtualized and folders-first. Add Writer's natural collation (with a Korean-aware collator), immediate creation with inline rename, the OS trash and native context menus.
