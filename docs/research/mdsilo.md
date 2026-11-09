# mdSilo: functional and technical analysis for mininote

- **Source:** https://github.com/mdSilo/mdSilo-app (shallow clone of commit `413b2aa`, 2026-11-06, app v0.8.0)
- **License:** AGPL-3.0-or-later. This covers the app and its WYSIWYG editor package `packages/mdsmirror`, which derives from Outline's rich-markdown-editor. Everything below describes behavior and approach in our own words. No code was copied.
- **Paths:** relative to the repo root. `src/` is the React frontend, `src-tauri/src/` is the Rust backend, and `packages/mdsmirror/src/` is the editor.

---

## 0. What mdSilo is, and which parts matter to us

mdSilo is a **Tauri 2 + React 19** desktop app. The same frontend also ships as a PWA, backed by an IndexedDB implementation of the Tauri commands. Beyond notes it bundles an e-book reader, RSS/podcast reader, issue tracker/kanban, graph view, git sync, static-site publishing, a plugin system and TTS. For mininote, only the "writing" half matters: folder-as-vault, file tree, markdown editor, autosave, watcher, link index, backlinks and search.

| Layer | mdSilo choice |
|---|---|
| Shell | Tauri 2.12, Rust edition 2024. All filesystem access goes through **custom commands**; there is no `tauri-plugin-fs`, and `tauri-plugin-dialog` is the only plugin. |
| UI state | zustand + immer. Settings persist through Rust into the OS data dir. |
| Styling | Tailwind 4 + daisyUI themes for chrome; styled-components for the editor |
| Editor | ProseMirror WYSIWYG (`mdsmirror`) with a markdown-it parser and a custom serializer. A second "raw" mode uses CodeMirror 6. |
| Index / search | Rust: SQLite (diesel, WAL) table of files plus parsed links; **tantivy** full-text with the **jieba** tokenizer |
| Watcher | `notify` 8 `RecommendedWatcher`, recursive, one at a time |

### Key takeaways for mininote

1. The parts most worth replicating are in Rust:
   - **atomic write + self-write suppression** (`src-tauri/src/atomic.rs`);
   - a **cross-platform watcher normalizer** that pairs renames, maps macOS FSEvents paths, and filters hidden and temp files (`src-tauri/src/files.rs`).
2. **Autosave is debounced at 500 ms with a 2000 ms max-wait.** Writes go through a per-path ordered queue and are flushed on note switch, blur, page hide and window close (`src/workspace/pendingSaves.ts`).
3. A **persistent index keyed by (size, mtime)** means startup re-parses only changed files. It also detects renames made while the app was closed and repairs links.
4. **Links are by title** (file stem), not by path. This creates pressure for globally unique titles: rename refuses duplicates, and renames rewrite links across the vault.
5. Weak spots mininote must do better on:
   - external edits to the **open** note are silently overwritten;
   - write failures are silent;
   - custom key handlers have **no IME composition guards**;
   - there is **no NFC/NFD normalization**;
   - **case-only renames are blocked**;
   - deleting a note **rewrites other notes** to unlink it;
   - a title edit is implemented as trash + re-create.
6. The ProseMirror WYSIWYG needed extensive serializer work to keep files byte-stable. It still rewrites table delimiter rows, and it serializes the whole doc on every keystroke. This supports our **CodeMirror 6 live-preview** decision, where the file text *is* the document.
7. Rendered spacing uses **per-element margins** plus first-child patches. That is the counter-example to our sibling-pair spacing rules.
8. Two Korean-specific findings:
   - tantivy+jieba tokenizes **Hangul as single syllables**;
   - mdSilo ships a **Linux AppImage IME fix** (fcitx/ibus) that is worth adopting.
9. On the Tauri side, the asset protocol is enabled with scope `**`, so any file is readable, and the commands accept any path. That is simple but unsandboxed. We should scope both to the vault.

---

## 1. Vault / workspace

**Opening a folder** (`src/workspace/useOpen.ts` `listInitDir`, `src/workspace/open.ts`):

- A native folder dialog opens via tauri-plugin-dialog. A source comment warns that on **macOS a directory dialog with `filters`, or with an empty-string `defaultPath`, crashes the app**. They pass `undefined` instead of `""` everywhere.
- The open sequence, in order:
  1. Resolve the layout.
  2. Push the folder onto the recent list.
  3. List the root (one level only) and start the watcher.
  4. In the workspace layout, also list and expand `reading/` and `writing/`.
  5. Set `currentDir` only **after** listing succeeds, so a failed open never shows an empty explorer.
  6. Start the background `loadDir`, which calls `index_open`.
- On failure, the store resets to "no folder" so the history list is clickable again.
- `reportOpening` writes a message into the explorer if opening fails, or if it takes longer than **8000 ms** (`OPEN_SLOW_MS`). The message lists the stuck commands and offers Copy/Reload buttons.
- "Open File" (pick individual `.md` files) makes their parent the current dir without creating a workspace.

**Layouts** (`src/workspace/layout.ts`, `src/workspace/migrate.ts`):

- **Workspace layout.** It is identified by the marker file `.mdsilo/workspace.json` (`{version, createdAt}`) and contains:
  - `reading/` for books;
  - `writing/` for notes, `assets/` and `daily/`;
  - `.mdsilo/` for JSON data;
  - `.mdsilo/local/` for device-only data: `index.db` and `search/`. `.mdsilo/.gitignore` contains `local/`.

  An **empty folder is auto-initialized**. The marker is written **last**, so a half-created layout still counts as legacy.
- **Legacy layout.** Any folder that already has content opens as-is, with notes at the root. A migration can move entries into `writing/` (and clips into `reading/`):
  - name collisions are skipped and reported;
  - old data files go to `.mdsilo/legacy/`;
  - the marker is written last.
- New notes created at the workspace root land in `writing/` (`newNoteDir`).

**Switching vaults** (`src/shell/sidebar/WorkspaceSwitcher.tsx`):

- A dropdown sits in the explorer bar. The pinned folder comes first, then recent folders, newest first. Each row has pin/unpin and "remove from recent".
- Other menu actions: Clear Recent, New Subfolder, Open Folder.
- Switching clears the store (tree first, then notes) and re-runs the open sequence.

**Remembered state:**

- **App-global settings** use zustand `persist` under the key `mdsilo-storage`, at version 5 with migrations. Rust `set_data` writes them into the OS data-local dir (`~/Library/Application Support/mdsilo`, `%LOCALAPPDATA%\mdsilo`, `~/.local/share/mdsilo`). The format is JSON wrapped in bincode, written atomically (`src-tauri/src/storage.rs`).
  - Remembered: `recentDir` (array; the last item is the newest), `pinnedDir`, `openOnStartup` (`previous | pinned | none`, default `previous`), `startupView`, and the last book per workspace.
- **Not remembered:** the last open note, expanded folders (the code explicitly says "not persisted"), cursor/scroll position, and the sidebar tab. Every launch lands on a welcome view.
- **Per-vault state:** the index lives in `.mdsilo/local/`. For legacy folders it lives in `<data dir>/mdsilo/index/<FNV-1a hash of the path>` (`src-tauri/src/index/mod.rs` `local_dir`).
- **Multi-window:** only the main window writes settings. Book windows receive a small shared subset via Tauri events (`src/state/windowSync.ts`).

---

## 2. File tree

**Listing** (`src-tauri/src/files.rs` `list_dir_entries`, `src/workspace/open.ts` `listDir`):

- **Rust lists one level** using `ignore::WalkBuilder` with these settings:
  - max depth 1;
  - hidden entries skipped (dot-prefix on Unix, the `FILE_ATTRIBUTE_HIDDEN` bit on Windows);
  - `.gitignore` **not** applied;
  - symlinks **not followed**.

  It returns metadata only. A sibling command, `read_directory`, also returns the content of text notes.
- **The frontend turns entries into tree items:**
  - folders and markdown files become "notes" in the store;
  - other files (images, PDFs) become tree-only items;
  - `.json` files are dropped.
- **Markdown detection differs between sides.** Rust accepts `md|markdown|text|txt`; TS also accepts `mkdn|mdwn|mdown`. We should keep a single list.
- **Store shape:**
  - `noteTree: Record<dirPath, Item[]>` is an adjacency map with one entry per listed folder;
  - `expandedDirs: Record<dirPath, true>` tracks expansion;
  - inserts deduplicate by id;
  - when a deep file appears through the watcher, its whole parent chain up to the vault root is upserted (`upsertTreeRecursively`).

**Rendering** (`src/shell/sidebar/SidebarNotes.tsx`, `SidebarNotesTree.tsx`, `SidebarNoteLink.tsx`):

- The tree is flattened into rows `(node, depth, isExpanded)` by walking from the current dir into expanded folders only.
- Rows render through **react-virtuoso with a fixed 32 px row height**, indented 16 px per level plus 8 px of base padding.
- Horizontal scrolling uses the widest row, measured with canvas `measureText` and cached per font.
- Sort order is **folders first**, then one of six orders: title A–Z/Z–A (the default is A–Z), modified old/new, or created old/new.
  - Title comparison uses one **shared `Intl.Collator(undefined, {sensitivity:'base', numeric:true})`**, which gives case-insensitive natural order where "2" sorts before "10".
  - Sorted arrays are cached in a WeakMap keyed by the immutable folder array.
- Clicking a row:
  - a folder toggles expansion, listing it lazily on first expand;
  - a note opens;
  - any other file opens in a plugin viewer or the OS default app (`open::that`).

**Operations:**

- **New note:** created through Mod+N find-or-create (see §5) or a wikilink. The file is written with **a single space (`" "`) as its content**. Probably a ProseMirror workaround; we should write an empty file.
- **New folder:** a modal with **no name validation**. Rust `create_dir_all` silently creates nested folders when the name contains `/`.
- **Rename** (`src/workspace/renamePath.ts`, `src/shell/sidebar/RenameModal.tsx`):
  - It is a modal, not inline. The name is preselected and, for notes, the extension is shown separately and preserved.
  - Validation rejects an empty name, the characters `\ / : * ? " < > |`, and a leading `.`.
  - It refuses an existing target, and for notes it refuses a **title already used by another note**.
  - Pending saves are flushed first. Then `fs::rename` runs (creating missing parent folders) and the rename is "followed" (links are rewritten, §6).
- **Title rename** (the title above the editor; `src/writer/Note.tsx` `onTitleChange`):
  - The title commits **on blur**. Enter is blocked and pasted text is flattened to one line.
  - It is implemented as flush → rewrite backlinks → **move the old file to the trash** → write a new file → swap store entries → navigate.
  - So every title edit leaves a trash entry, drops the file's creation time, and looks like remove+create to watchers.
  - Daily-note titles are read-only.
- **Move by drag & drop** (`src/shell/sidebar/treeMove.ts`):
  - Uses dnd-kit. A mouse drag activates after **5 px**; touch after a **250 ms hold**.
  - Drop targets: a folder row, a file row (meaning its folder), or blank tree space (meaning the current folder).
  - Moving into itself, into a descendant, or into its current parent is refused.
  - A collision shows a native message dialog.
  - All saves are flushed, then the item is renamed on disk. The watcher updates the store, and an open note stays open at its new path.
  - A "Move to" modal with fuzzy folder search does the same thing.
- **Delete:**
  - It lives in the note header menu, labelled "Delete Permanently". The backend actually calls `trash::delete_all`, so the file goes to the **OS trash**.
  - Order: cancel the pending save → remove from the store → unlink every link to the note in other notes (§6) → trash the file.
  - This snapshot has no folder delete in the tree.
- **Row menus** open from a hover "…" button; there is no right-click menu.
  - Note rows: Move to, Rename, and metadata (word and character counts, created, modified).
  - Folder rows: New Subfolder, Open Folder Here (re-roots the tree), Rename.
- **Missing:** keyboard navigation, inline rename, reveal in Finder/Explorer, duplicate, copy path, multi-select, persisted expansion state.
- **Validation gaps:**
  - no handling of Windows reserved names (`CON`, `NUL`, `COM1`…), trailing dots or spaces, or length limits;
  - **case-only renames fail** on case-insensitive filesystems (macOS, Windows), because the existence check finds the old file and reports "already exists".

---

## 3. Editor

The editing mode is a global choice (`rawMode`, default `wysiwyg`) among WYSIWYG, raw markdown (CodeMirror), mind-map and plugin modes.

### 3.1 WYSIWYG (ProseMirror, `packages/mdsmirror`)

**Parser:** markdown-it "default" preset with `html:false`, `breaks:false`, and linkify enabled with fuzzy links (`core/rules/markdown.ts`). Custom inline and block rules add:

- task checkboxes;
- `==highlight==`, `~~strike~~`, `__underline__`, `^sup^`, `&sub&`, `!!placeholder!!`;
- `#hashtag#`, written with a hash on **both** sides (not Obsidian's `#tag`);
- tables;
- `:::info|warning|tip` notices (callout-like);
- `$`/`$$` math (KaTeX + mhchem);
- `[[target|alias]]` wikilinks, parsed **before** emphasis so titles like `_draft_` survive;
- `{{book}}` links, embeds, attachments, and `<!-- comments -->` shown muted.

Footnotes are not rendered; they survive only as escaped text. Frontmatter is not handled by the editor; Rust reads front matter only for publishing.

**Markdown shortcuts** are input rules:

- blocks: `#`–`######`, `- + *`, `1.`, `[]`, `>`, ```` ``` ````, `---`/`***`/`___`, and `|--` for a table;
- marks: `**x**`, `==x==`, `~~x~~` and `` `x` ``.

**SmartText** silently rewrites straight quotes to curly quotes, `...` to an ellipsis, and `->` to an arrow. This **changes file content** and should be avoided in a plain-markdown app.

**Keymap:**

- Marks: Mod-B/I/U, Mod-` (code), Mod-H (highlight), Mod-K (link).
- History: Mod-Z, Mod-Y, Shift-Mod-Z.
- Headings: Ctrl-1..3 (Ctrl, not Mod).
- Lists: Ctrl-7/8/9 toggle task/bullet/ordered lists.
  - Enter splits an item; Tab/Shift-Tab and Mod-]/Mod-[ indent/outdent; Shift-Enter inserts a soft break; Alt-Up/Down moves the item.
- Elsewhere, Tab and Shift-Tab are swallowed so focus never leaves the editor.
- Backspace right after an input rule undoes the rule.

**Menus:**

- A slash menu (`/` on an empty line) offers image, file, date/time, H1–H3, lists, link, table, quote, code, comment, math, divider, page break and notices. Typing `/date ` or `/time ` inserts directly.
- A selection toolbar offers link, bold, highlight, italic, underline, strike, code, copy and "new issue".
- `[[` opens a link search menu showing the top 10 notes plus issues.
- Typing a **complete** `[[Title]]` converts it into a link and **creates the note if it is missing**. This is aggressive; Obsidian creates nothing until you click.

**Paste rules** (`plugins/PasteHandler.ts`):

1. A URL pasted over a selection becomes a link on that selection.
2. A bare URL becomes an embed if a matcher accepts it (YouTube, Figma…); otherwise it is inserted as linked text.
3. Inside code, paste is plain text.
4. If the clipboard carries **VS Code metadata** (`vscode-editor-data`) with a non-markdown language, the paste becomes a fenced block in that language.
5. HTML that came from ProseMirror goes through the HTML parser.
6. Text that "looks like markdown", or arrives with no HTML at all, is parsed as markdown. Bare `[ ]` lines are first wrapped into list items, and 2+ blank lines become a hard break.
7. Anything else goes through the default HTML→document conversion, with a Dropbox Paper quirk fix.

**Attachments** (`src/writer/Note.tsx` `onAttachFile`, Rust `copy_file_to_assets`):

- `/image` and `/file` open a native picker.
- When "Use Assets Folder" is on (the default), the file is copied into `<notes root>/assets/` and inserted as `./assets/<name>`. That path is relative to the **vault (writing) root**, not to the note. When the setting is off, the absolute path is inserted.
- Naming avoids collisions with `name-1.ext`, `name-2.ext`, and so on.
- A file with **identical content** to an existing asset is reused rather than copied again. The check canonicalizes paths, compares sizes, then streams an 8 KiB-chunk comparison.
- Copying a file onto itself is detected, because it would truncate the file.
- Images are preloaded before insertion so they appear immediately.
- **Clipboard-image paste and OS file drop exist in the editor but are inert in the desktop app.** `uploadFile` is never supplied, and the upload plugin checks an option that is never set. The manual claims otherwise.

**Local image display** (`lib/resolveImageSrc.ts`):

- URLs and `data:`, `blob:` and `#` sources are left untouched.
- `./x` resolves against the vault writing root.
- Any other relative path resolves against the note's folder.
- Absolute paths (POSIX or `C:\`) are kept as-is.
- The result then goes through Tauri `convertFileSrc` (§9).

**Other behaviors:**

- **Checkboxes stay clickable in read mode** and persist.
- Headings fold; the fold state is a node attribute and is never written to the file.
- A collapsed table of contents appears above the editor when the note has headings.
- RTL is supported, using the first strong character for auto-direction.

### 3.2 Raw mode (CodeMirror 6, `src/writer/md/`)

- Setup: `basicSetup`, `@codemirror/lang-markdown` with nested code languages from `@codemirror/language-data`, indent-with-Tab, line wrapping, one-dark/one-light themes, and a configurable font.
- **Controlled value without echo loops:** when the `value` prop changes from outside, the update is dispatched with a custom **transaction annotation**. The update listener ignores annotated transactions, so programmatic syncs never come back as user edits or trigger saves. The new value is compared with the current doc before dispatching.
- **Find/replace** is only CodeMirror's default search panel in raw mode. WYSIWYG has none.

### 3.3 IME / composition

- There is **no composition handling anywhere** in the app or the editor package. A grep for `isComposing` and `composition` finds nothing.
- ProseMirror and CodeMirror handle IME internally, but every **custom** keydown handler acts on Enter and arrow keys without checking composition:
  - the slash and link menus, which listen on `window`;
  - the find-or-create input;
  - the link editor;
  - the search box.
- For Korean, pressing Enter to commit a syllable can therefore select a menu item or create a note named after an incomplete word.

---

## 4. Persistence

**Write path** (`src/writer/Note.tsx`):

- Each editor change calls `scheduleSave(path, text)`. In WYSIWYG, a trailing newline is appended if missing.
- A **separate 800 ms debounce** (`CONTENT_SYNC_MS`) pushes the content into the in-memory store, so backlinks, search and the TOC see it without re-rendering on every key.

**Scheduler** (`src/workspace/pendingSaves.ts`):

- **Trailing debounce 500 ms** (`SAVE_DELAY_MS`) with a **max wait of 2000 ms** (`MAX_WAIT_MS`) measured from the first unsaved change. The next delay is `min(500, firstChange + 2000 − now)`, so continuous typing still saves about every 2 s.
- Only the latest content is kept per path.
- Writes are **chained per path**, so they land in order even if one is slow.
- Errors are only logged.
- API:
  - `flushSave(path?)` writes now, or awaits an in-flight write;
  - `cancelSave(path)` is used before delete, so a pending save can't resurrect the file;
  - `hasPendingSave(path)` reports whether a save is waiting.
- **Flush triggers:**
  - window `blur`, `pagehide`, `beforeunload`, and `visibilitychange` to hidden;
  - unmounting the note component (switching notes);
  - Tauri **`onCloseRequested`**, which awaits `flushAll()` (notes plus other stores) before the window closes;
  - before rename, move and migration (a folder rename or move flushes everything).
- **Tray quit:** the first Quit closes the main window, so the close guard runs. A second Quit exits immediately (`src-tauri/src/tray.rs`).

**Atomic write** (`src-tauri/src/atomic.rs` `write_atomic`):

1. Create the parent folders.
2. If the target is a **symlink**, write through it directly. This keeps the link but is not atomic.
3. Otherwise write a hidden temp file `.<name>.mdsilo-tmp` in the **same folder**, `fsync` it, copy the replaced file's permissions, and rename it over the target. On error, remove the temp file.
4. The command returns a `bool`, and **the frontend never checks it**. A failed save (permissions, full disk, file locked on Windows) is silently lost with no UI signal.

**Self-write suppression:**

- Before writing, the backend records `path → (expected len, mtime=unknown, timestamp)`. After writing, it records the real `(len, mtime)`.
- The watcher drops an event if the file's *current* metadata still equals the recorded pair within a **60 s TTL**. While the write is in flight (mtime still unknown), only the length is compared.
- An external edit changes the mtime and/or size, so its event passes.
- Stale entries are pruned on each insert.
- The search/link index runs **before** this filter, so it also follows the app's own writes.

**Watcher** (`src-tauri/src/files.rs` `listen_dir`):

- One global watcher, recursive. Listening again drops the previous watcher. The frontend emits `unlisten_dir` to stop it.
- The handler runs on notify's thread. A comment warns that blocking async-runtime threads would starve later commands.
- **macOS:** FSEvents reports resolved paths such as `/private/var/…`. These are mapped back to the folder prefix the user opened.
- **Filtered out:** any path with a dot-segment under the root (`.git/`, `.mdsilo/`) and temp files.
- **Event mapping:** Create → `create`; a name change → rename handling; any other Modify → `write`; Remove → `remove`; Access is ignored.
- **Rename pairing:**
  - On Windows and macOS the two sides arrive separately. A single "from" followed by a single "to" within **500 ms**, with nothing in between, also emits `renamed [from, to]`.
  - Linux reports both sides together.
  - When FSEvents can't tell which side is which, the paths are split by whether they still exist.

**Frontend event handling** (`src/workspace/directory.ts`):

- Events are **serialized through a promise chain**, so a rename is followed only after the store has the new path.
- The listener is replaced using a **sequence counter**, so reopening a folder never handles an event twice.
- Per event:
  - `write`: re-read and upsert every changed file **except the open note, which is ignored**;
  - `remove` / `renameFrom`: if the file **exists again**, re-read it. This handles vim-style saves (rename away, then write a new file). Otherwise delete the entry and its descendants from the store, and clear the open note if it was inside;
  - `create` / `renameTo`: re-read and upsert, including the parent chain;
  - `renamed`: follow the rename (rewrite links).
- **Conflict policy: none.** External edits to the **open** note are ignored and overwritten by the next autosave (last writer wins).
  - The open note is remounted only after a git-sync pull (`reloadOpenNote` bumps a React key).

---

## 5. Navigation & search

**Quick switcher = "find or create"** (Mod+N toggles it; `src/writer/NoteNewInput.tsx`):

- fuse.js matches on titles (threshold 0.1, `ignoreLocation`, top 10).
- The first option is "New: <text>" unless the top hit matches the input case-insensitively.
- ↑/↓ wrap around; Enter opens or creates. New notes go in the current folder, or in `writing/` at the root.
- No paths are shown and there is no recency ranking.

**Full-text search** (sidebar tab, Mod+Shift+F; `src/shell/sidebar/SidebarSearch.tsx`, `src/lib/hooks/useNoteSearch.ts`):

- Input is debounced **500 ms**; Enter searches immediately.
- Pipeline:
  1. Rust `index_search` queries title+body with AND semantics and lenient parsing (quotes make a phrase). Limit 300.
  2. Add loaded notes whose current content contains the query, since the index may lag.
  3. Read the candidates' contents through the LRU cache.
  4. Run a fuse extended search per **block** (threshold 0, matches included).
  5. Render a tree: note title → matching blocks with highlighted words.
- Book hits show 160-character snippets with `<b>`-marked words, sanitized with DOMPurify.
- Clicking a result opens the note but does not scroll to the block (marked TODO).

**Tantivy details** (`src-tauri/src/index/search.rs`):

- Schema fields:
  - `id` (raw string, stored);
  - `kind`;
  - `title` and `body` (jieba tokenizer with lowercasing and a filter that drops tokens over 40 characters; frequencies and positions; stored);
  - `label`.
- Title boost **2.0**. Writer heap **30 MB**. The reader reloads manually after each commit.
- A VERSION file triggers a rebuild on schema change or corruption.
- If the writer lock is held (the vault is open in another window), search is unavailable and the app falls back to fuse over all notes.

**Korean tokenization caveat** (verified in the jieba-rs source, `jieba/src/lib.rs`):

- Jieba segments only CJK ideographs and ASCII. **Hangul falls outside that class, so each syllable becomes its own token.**
- The Korean word for "search" (U+AC80 U+C0C9) is indexed as two separate syllable tokens. The default AND query then matches any document containing both syllables anywhere, which produces false positives.
- A quoted phrase uses positions and stays precise.

**Not present:** back/forward history (the app has a single view state), tabs, a recent-files list, or an outline beyond the TOC dropdown.

**Daily notes:** "Today" in the Chronicle view opens or creates `writing/daily/YYYY-M-D.md`. The name is **not zero-padded**, so it sorts poorly outside a numeric collator.

---

## 6. Links

**Model.** A note is identified by its **title**, the file name without extension.

- Supported link forms: `[[Title]]`, `[[Title|alias]]`, and `[label](Title%20encoded)`, where the href *is* the title.
- `issue:` and `book:` hrefs and http(s) URLs are excluded from note links.
- **Not supported:**
  - paths in links;
  - a `.md` extension in links;
  - `#heading` targets (a `#` simply becomes part of the title, so a missing-note click would create `Note#Heading.md`);
  - `![[embed]]`.

**Resolution** (`src/writer/hooks/useLinkHandlers.ts`):

- The target resolves to the **first** note whose title `===` the target: exact, case-sensitive, with no Unicode normalization.
- There is a fallback for a legacy form that wrote spaces as `_`.
- Clicking a missing target **creates `<target>.md` in the current note's folder**.
- With duplicate titles, an arbitrary first match wins, which a source comment admits. That is why renames refuse titles already in use.

**Extraction** has two deliberately equivalent implementations, Rust `src-tauri/src/index/parse.rs` and TS `src/lib/mdlink.ts`:

1. **Mask code first.** Fenced blocks and inline code spans are replaced by spaces of equal byte length, keeping newlines, so offsets stay valid.
2. Match wikilinks and markdown links, skipping escaped `\[`, images, and the `[[x]](y)` overlap.
3. Remove backslash escapes and percent-decode safely, falling back to the raw text when decoding fails.

The same pass also collects `#tags#`, issue refs, book refs, and a cheap "may have tasks" flag.

**In-memory LinkIndex** (`src/lib/linkIndex.ts`):

- Each note's entry is invalidated by **identity**: a new content string, or a new parsed object.
- The inverted map `title → Set<noteId>` is built lazily on the first query and then maintained incrementally.
- A per-title count answers "does a note with this title exist?".
- Context comes from walking markdown-it inline tokens into text runs tagged with their link target. The result is cached per content.
- "Mentioned in" first pre-filters raw content with a substring check, so most notes are never parsed.

**Backlinks panel** (a collapsed toggle under the editor; `src/writer/backlinks/`):

- It shows **linked** backlinks (runs whose link target matches the title) and **unlinked mentions** (the title appears in plain text).
- Results are grouped by note, then by block. Each context is trimmed to **128 characters** centred on the first match, with matches highlighted.
- The notes snapshot feeding the panel is debounced **1000 ms**.
- The panel starts collapsed when there are more than **42** matches.
- For notes whose content isn't loaded yet, candidates come from a tantivy **phrase** search (limit 500).

**Rename → rewrite links** (`src/workspace/renames.ts`, `src/writer/backlinks/updateBacklinks.ts`):

- A sequential, idempotent queue handles renames from three sources: in-app renames, watcher `renamed` events, and renames detected at startup.
  - **Startup detection:** a file that vanished and a new file with the same size, mtime and extension, where each is the other's only candidate. Ambiguous "twins" are ignored.
- If no other note still uses the old title, every link to it is rewritten. Alias, label and link-title text are kept.
- If the new title contains `[`, `]`, `|` or a newline, wikilinks are converted to `[label](encoded)` form.
- Notes that aren't loaded are read only when the index says they link to the old title. Loading waits at most **5000 ms**.
- Rewritten files are written directly, bypassing the debounce.

**Delete → unlink:** every link to the deleted title is replaced by its plain label text (unless another note shares the title). This is destructive and surprising; do not copy it.

---

## 7. Rendering & typography

- **No separate reading renderer:** read mode just makes the ProseMirror editor read-only. markdown-it `renderToHtml` exists only for publishing and plugins.
- **Safety:**
  - markdown-it runs with `html:false`, so raw HTML is never rendered;
  - external HTML (feeds, plugin SVG) goes through DOMPurify, which forbids `style`, `class`, `id` and form elements, and forces links to `target=_blank rel=noopener` (`src/lib/sanitize.ts`).
- **Editor typography** (`packages/mdsmirror/src/styles/editor.ts`, `theme.ts`):
  - base size 1.1em × the user scale (about 17.6 px at a 16 px root);
  - line-height 1.6em; weight 400, with bold at 600 and headings at 500;
  - a system UI font stack, and a mono stack of SFMono, Consolas, Liberation Mono and Menlo;
  - heading sizes: h1 `xx-large`, h2 `x-large`, h3 `large`, h4 `medium`;
  - a hover gutter label ("H1"…) placed at −24 px.
- **Block spacing uses per-element margins:**
  - `p` 1em top and bottom; headings 1em top and 0.5em bottom; blockquote 5px; notices 8px; comment blocks 0.5em;
  - patch rules are then needed, for example zero margin on `li p:first-child` and zero top margin on a leading heading;
  - the layout depends on margin collapsing.

  This is exactly the edge-case-prone approach mininote will replace with sibling-pair spacing.
- **Code blocks:** Prism (refractor) highlighting, a language picker, optional line numbers, and diagrams (mermaid, echarts, abcjs, smiles) rendered under the source. Shift-Enter inserts a newline; Tab inserts indentation.
- **Tables:** prosemirror-tables with row/column handles, sorting and alignment. The serializer **normalizes the delimiter row** (`:--` becomes `:---`) and appends a newline, so files change even when untouched.
- **Colors:** not monotone. A cyan primary, colored notices, and daisyUI themes (default follows the system).
- **Fonts:**
  - the picker lists installed families via Rust `fontdb` (`src-tauri/src/system_fonts.rs`);
  - a separate **CJK font** setting is inserted **after the Latin family and before the generic family**, so Latin glyphs keep the Latin face and Hangul falls through to the CJK face (`src/custom/fonts.ts` `fontFamilyWithCjk`).

---

## 8. Performance

- **Startup path:**
  1. The main window is created hidden and a splash window is shown.
  2. Settings hydrate over IPC.
  3. The tree lists the top level (plus `reading/` and `writing/`); deeper folders load lazily.
  4. `index_open` runs on a blocking thread:
     - walk the vault with `ignore`;
     - compare `(is_dir, size, mtime)` with the SQLite rows;
     - re-read, parse and tantivy-index **only** new or changed text files;
     - **commit once**;
     - return all notes *without content*, carrying their parsed links, tags and task flag.
- **Lazy content:**
  - notes loaded from the index have empty content plus `parsed`;
  - content is read on demand through an **LRU cache of 300**, keyed by `(updated_at, path)` so changed notes are re-read;
  - reads happen in batches of 16.
- **SQLite index** (`src-tauri/src/index/db.rs`): a `files(path PK, is_dir, size, modified, created, parsed JSON)` table plus `PRAGMA user_version`, which triggers a rebuild on schema change. WAL with `synchronous=NORMAL`; batch upserts in one transaction.
- **Store:** `NoteMap` is a persistent map with **128 hash buckets**, so updating one note copies only one bucket. Bucket indices are cached for up to 100k ids, and `values()` is memoized (`src/lib/noteMap.ts`).
- **Persisted settings:**
  - serialization is memoized by field identity, so unchanged state is never rewritten on each store update;
  - writes are skipped while hydration is still reading, so defaults never overwrite real settings (`src/state/store.ts`).
- **Measured costs to avoid:**
  - WYSIWYG serializes the **whole document to markdown and JSON on every transaction** and forces a React re-render;
  - the watcher runs an index update **and a tantivy commit synchronously for every event**, with no batching. With 500 ms autosave, every save triggers a commit.
- **Release profile:** LTO, strip, `opt-level = "s"`.

---

## 9. Platform / desktop / Tauri specifics

**Windows and chrome** (`src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`):

- The main window is 1024×768 (minimum 800×600) and starts **hidden**. An 800×600 undecorated splash window shows meanwhile.
- The frontend calls `close_splashscreen` after React mounts, which closes the splash and shows the main window. This avoids a white flash.
- Default decorations; there is no macOS overlay titlebar.
- The window title is `<note title> - mdSilo`, with a "Loading" suffix while indexing.
- Destroying the main window exits the app.
- The tray icon offers Show/Hide/Quit, and a left click focuses the window.
- No app menu is configured, there is no single-instance plugin, and the updater is disabled.

**Permissions:**

- The single capability (`default.json`) grants `core:default`, window set-title, destroy, set-focus and unminimize, webview creation (for book windows), and `dialog:default`. It applies to `main`, `splashscreen` and `book-*`.
- All file I/O goes through custom `#[tauri::command]`s that accept **any absolute path**. Nothing restricts them to the vault, so XSS in the webview would mean arbitrary file access. Raw HTML is disabled, which shrinks that surface.

**Asset protocol:**

- Enabled through the `protocol-asset` feature, with `assetProtocol.scope: ["**", "**/*"]`. Every file on disk is loadable.
- The CSP `default-src` allows `asset:`, `http(s)://asset.localhost`, `ipc:` and the plugin scheme. `script-src` allows only self and `wasm-unsafe-eval`.
- Image URLs come from `convertFileSrc`. A helper also hard-codes `https://asset.localhost/` on Windows and `asset://` elsewhere (`src/workspace/util.ts`).
- The scope is never narrowed at runtime.

**Custom scheme:** `mdsplugin://` serves plugin files with a strict per-response CSP. Network access is allowed only when the user grants it (`src-tauri/src/plugin_scheme.rs`).

**Paths:**

- Everything is normalized to `/`:
  - Rust `normalize_slash` converts separators, strips a Windows `\\?\` verbatim prefix when that is safe, and trims trailing slashes (`src-tauri/src/paths.rs`);
  - TS mirrors this with `normalizeSlash`, `joinPath`, `movedPath`, and `isAbsolutePath` (which recognizes `C:/` and `//host`).
- Data files store vault-relative `/` paths.

**Linux AppImage IME fix** (`src-tauri/src/input_method.rs`, issue #782):

- The AppImage bundles GTK together with its own IM-module cache, and that cache lacks fcitx/ibus. Korean/CJK input was impossible.
- Fix: before GTK initializes, when `APPIMAGE` is set and the module named by `GTK_IM_MODULE` is missing from the bundled cache, point `GTK_IM_MODULE_FILE` at the system cache. Candidates are the Debian multiarch dirs, `/usr/lib64` and `/usr/lib`.

**Other notes:**

- **Unicode normalization:** none anywhere. Titles and paths compare byte-wise, so an NFD file name (from older macOS, zips, some sync tools) never matches a wikilink whose target was typed in NFC.
- **Trash:** `trash` crate. A comment notes that non-empty folders might not be deleted on Linux.
- **Logging:** errors go to a capped log in the data dir (500 entries, 2000 bytes each).
- **Web host:** Vite aliases swap `@tauri-apps/api/core|event|window|app` and `plugin-dialog` for browser implementations with the same command names, backed by IndexedDB (`vite.web.config.mts`, `src/host/web/core.ts`). The whole UI runs in a plain browser.

---

## 10. Settings (user-configurable, with defaults)

| Setting | Default | Notes |
|---|---|---|
| Theme | `system` | daisyUI themes plus a custom theme editor; dark mode follows the theme |
| Font / Code font / CJK font | system stack / default mono / none | installed fonts listed via Rust |
| Font size | `1.1` (em) | multiplies the editor's 1.1em base |
| Line height | `1.6` (em) | |
| Font weight | `400` | |
| Right-to-left | off | |
| Spell check | **on** | `spellcheck` attribute on title and editor |
| Use assets folder | **on** | `./assets/` relative to the vault writing root |
| Editor mode | `wysiwyg` | or `raw`, `mindmap`, plugin modes |
| Read mode | off | read-only editor; checkboxes still toggle |
| Open on startup | `previous` | or `pinned` / `none` |
| View on startup | `notes` (explorer) | or library, last book, feeds, issues… |
| Note sort | Title A–Z | 6 options; folders always first |
| Sidebar width | 256 px (160–640) | resizable panes persisted |
| Side menu orientation | `auto` | vertical, horizontal |
| Sync | interval 0 (off), sync on exit off | git sync |

---

## 11. Bugs and pitfalls observed (lessons, with evidence)

1. **Prefix delete breaks for multi-byte folder names.** `src-tauri/src/index/db.rs` `delete` compares `substr(path, 1, len+1)` with `"<dir>/"`, where `len` is the Rust **byte** length. SQLite's `substr` counts **characters**, so for a folder with a Hangul name the comparison never matches and child rows survive the deletion. The tests use ASCII only.
   - Fix: use a range predicate (`path >= 'dir/' AND path < 'dir0'`) or `LIKE 'dir/%' ESCAPE`.
2. **Case-only rename is refused** on macOS and Windows, because the existence check hits the old file (`renamePath.ts`).
3. **No IME guard** in custom keydown handlers (§3.3).
4. **No NFC/NFD normalization** for titles or paths (§9).
5. **A silent write failure loses data.** `write_file` returns `false` and nobody checks it (§4).
6. **External edits to the open note get overwritten** (§4).
7. **Delete rewrites other notes** to remove links (§6).
8. **Title rename goes through the trash and re-creates the file**, losing its creation time (§2).
9. **New notes contain a single space**; WYSIWYG adds a trailing newline; tables and smart quotes are rewritten. In each case the app changes a file the user didn't edit.
10. **Daily-note names `YYYY-M-D`** are not zero-padded.
11. **A complete `[[X]]` creates a file** as soon as it is typed (§3.1).
12. **`#` in link targets** is not treated as a heading anchor (§6).
13. **The documentation drifts from the code:** the manual promises image paste/drag and delete from the tree menu; neither is wired in this snapshot.
14. **A tantivy commit runs per watcher event** with no batching (§8).

---

## 12. Recommendations for mininote

**Adopt (re-implement in our own words):**

- Rust `write_atomic`: temp file in the same folder, then `fsync`, preserve permissions, and rename. Handle symlinks explicitly.
- A self-write registry keyed by path with `(len, mtime)` and a TTL. Index updates may still consume the app's own writes.
- One recursive watcher per vault with:
  - hidden-segment and temp-file filtering;
  - FSEvents canonical-path mapping on macOS;
  - pairing of rename sides within 500 ms;
  - a "file exists again" check on remove events (vim-style saves);
  - a frontend promise chain that serializes events.
- Autosave at 500 ms debounce with a 2000 ms max-wait, writes chained per path, and flushes on note switch, `blur`, `visibilitychange`, `pagehide` and `onCloseRequested`. Flush before rename or move; cancel before delete.
- Folders first, then a shared `Intl.Collator` (numeric, base sensitivity) for natural case-insensitive sort.
- A flattened, virtualized tree with fixed row height, and lazy listing per folder.
- Attachment copying with `name-N.ext` collision handling, same-content dedupe, and a guard against copying a file onto itself.
- Code masking that preserves offsets before extracting links, plus span-based rewriting of links on rename.
- `html:false` in markdown-it for the reading view, and DOMPurify for any foreign HTML.
- The Linux AppImage IME environment fix.
- A CJK font stack ordered Latin → CJK → generic.
- A hidden main window until the first paint.
- A browser shim for `@tauri-apps/api` through Vite aliases, for fast UI iteration without native builds.

**Do differently:**

- **Conflict policy for the open note.** If there are no pending local edits, reload silently and keep the cursor. If edits are pending, keep the local text, write it, and show a minimal monochrome indicator, or compare against the last-known disk text to merge.
- **Surface write failures**: keep the dirty state, retry, and show a single unobtrusive mark.
- **Guard every custom Enter/Arrow handler** with `event.isComposing || event.keyCode === 229`.
- **Normalize to NFC** for every title comparison, link resolution and index key. Keep the on-disk name as-is for filesystem calls.
- **Case-only rename:** when the old and new paths differ only in case, skip the existence check (or check by canonical name), and rename through a temporary name if needed.
- **Inline rename in the tree, plus keyboard navigation.** Validate Windows reserved names and trailing dots/spaces.
- **Persist per-vault UI state**: expanded folders, last open note, scroll and cursor position.
- **Delete leaves links unresolved** (Obsidian-style) instead of rewriting other notes.
- **A wikilink creates nothing until clicked.**
- **Support `[[note#heading]]` and `[[note|alias]]`.** Resolve by NFC + case-insensitive title, with a path suffix for disambiguation.
- **Don't auto-alter text**: no smart quotes, no forced trailing newline, empty new files. CodeMirror 6 keeps the file text authoritative.
- **Search for Korean:** for an MVP, in-memory substring search over NFC-normalized, lowercased content is enough. If an index is added later, use a **bigram/n-gram tokenizer for Hangul** instead of jieba. Batch index commits (for example 1–2 s idle) instead of committing per event.
- **Scope file commands and the asset protocol to the open vault** (runtime `allow_directory`), instead of `**`.
- **Spacing:** use sibling-pair rules (`* + *`, `h2 + p`, `li + li`) on a flow container, never per-element margins with first-child patches.

---

## 13. Evidence index (most relevant files)

- **Rust:**
  - `src-tauri/src/files.rs`: listing, metadata, CRUD, assets, watcher, rename pairing
  - `src-tauri/src/atomic.rs`: atomic write, self-write registry
  - `src-tauri/src/wsfs.rs`: filesystem trait
  - `src-tauri/src/paths.rs`: slash normalization
  - `src-tauri/src/storage.rs`: settings and log storage
  - `src-tauri/src/index/{mod,parse,search,db}.rs`: index and search
  - `src-tauri/src/input_method.rs`: Linux AppImage IME fix
  - `src-tauri/src/tray.rs`, `src-tauri/src/lib.rs`
  - `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
- **Workspace:** `src/workspace/{open,useOpen,directory,files,write,pendingSaves,renamePath,renames,layout,migrate,util,process}.ts`
- **State:** `src/state/{store,userSettings,storage,windowSync,viewReducer,useStartupView,useFollowRenames}.ts`
- **Links and search:** `src/lib/{mdlink,linkIndex,parseNote,contentCache,noteMap,sanitize,helper}.ts`, `src/lib/hooks/{useNoteSearch,useDebounce}.ts`
- **Writer:** `src/writer/{Note,Title,Toc,MdView,NoteNewInput}.tsx`, `src/writer/hooks/useLinkHandlers.ts`, `src/writer/backlinks/{useBacklinks,updateBacklinks,Backlinks,BacklinkMatchLeaf}.ts(x)`, `src/writer/md/{Markdown,useCodeMirror}.ts(x)`
- **Sidebar:** `src/shell/sidebar/{SidebarNotes,SidebarNotesTree,SidebarNoteLink,SidebarDropdown,RenameModal,WorkspaceSwitcher,SidebarSearch,treeMove}.ts(x)`, `src/App.tsx`
- **Editor:** `packages/mdsmirror/src/{index.tsx,core/rules/{markdown,wikilink,mark}.ts,plugins/{PasteHandler,Keys,SmartText,upload}.ts,lib/resolveImageSrc.ts,core/commands/attachFiles.ts,marks/WikiLink.ts,styles/{editor,theme}.ts,roundTrip.test.ts}`
- **Docs:** `docs/manual/{2 Workspace,3 Editor,4 Linking}.md`
- **External verification:** jieba-rs `jieba/src/lib.rs` (Hangul handling)
