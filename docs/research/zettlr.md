# Zettlr — functional research for mininote

- Repo: https://github.com/Zettlr/Zettlr (shallow clone, commit `87eac9e`, package version 4.9.0)
- License: **GPL-3.0**. This document only paraphrases behavior and approach; no code is copied. All paths are relative to the repo root.
- Stack: Electron 44 (Node "service providers" in the main process) + Vue 3/Pinia renderer + CodeMirror 6 with custom `@lezer/markdown` extensions + `@codemirror/collab`, chokidar 5 for watching, mocha unit tests.

---

## 0. TL;DR

Zettlr is a "publication workbench" (Pandoc export, citations, projects, LanguageTool, readability, Pomodoro…). Most of that is out of scope for mininote. The parts worth studying are the file layer (FSAL), the document layer (DocumentManager), and the CodeMirror 6 editor module with its live-preview "renderers".

**Worth adopting**

1. Live preview built from many small CM6 extensions. Each one hides or replaces syntax nodes only when no selection touches them. Headings and horizontal rules also reveal when the caret is merely *adjacent*.
2. One Lezer Markdown grammar for both the editor and the indexer. The indexer extracts tags, links, headings and word counts from the same tree, so what the editor highlights always matches what the index knows.
3. A cheap, three-step check before reacting to watcher events: (1) skip events caused by our own write, (2) require the disk mtime to be *newer*, (3) require the disk content to actually differ from what we last saved.
4. Keep every file's original line ending and BOM. Edit with LF only and restore the original form on save.
5. Give block widgets `estimatedHeight` (from a measured-height cache) and `coordsAt`, which stops CM6 scroll jumping. Use a measured hanging indent for wrapped list items.
6. Debounced persistence of UI state (1000 ms), flushed on shutdown.

**Avoid or improve on**

- Autosave is off by default. Writes are not atomic. A failed write still marks the document clean.
- No Unicode normalization (NFC/NFD) anywhere in the codebase. Wikilinks resolve by exact, case-sensitive basename.
- Prefix path checks are done without a trailing separator, so `/a/foo` "contains" `/a/foobar`.
- Every file is re-indexed during boot, before any window opens. The link and tag databases are rebuilt from scratch on every filesystem event.
- Per-folder settings are written as `.ztr-directory` dotfiles inside the user's notes folder. Folder expand/collapse state is not persisted.

---

## 1. Architecture snapshot (with Tauri mapping)

| Zettlr module | Responsibility | mininote analogue |
|---|---|---|
| `source/app/service-providers/fsal/*` | Descriptors for files and folders, metadata cache, chokidar watchers, recursive listing | Rust `vault` module (`walkdir`/`ignore` + `notify`) |
| `source/app/service-providers/documents/*` | Canonical in-memory text of open docs, autosave timers, external-change handling, tab/split tree persisted to YAML | For a single window: keep the document in the Svelte store; Rust writes atomically |
| `source/app/service-providers/commands/*` | One class per user action (`file-new`, `file-rename`, `request-move`, `dir-delete`, `force-open`…) | `#[tauri::command]` functions |
| `source/app/service-providers/{config,links,search,tags}` | Global config, link/ID database, full-text search, tag index | Config JSON, an in-memory index (Rust or a webview worker) |
| `source/win-main/*` | Main window UI: file manager, tabs, editor pane, global search, sidebar | Svelte components |
| `source/common/modules/markdown-editor/*` | CM6 editor: parser extensions, renderers, keymaps, autocomplete, tooltips, table editor | Our CM6 module |
| `source/pinia/*` | Renderer stores (workspace descriptors, window state, document tree) | Svelte 5 rune stores |

IPC style: the renderer calls `invoke(channel, { command, payload })`. Main broadcasts events (`fsal-event`, `documents-update`, `config-provider`, `links`, `search-provider`) to every window through a helper. This maps directly onto Tauri commands and `emit`.

---

## 2. Vault / workspace

- **No single vault.** The global config stores two lists:
  - `app.openWorkspaces` (folders)
  - `app.openFiles` (stand-alone files)

  Both can hold several roots at once. The tree shows them as two collapsible sections, "Files" and "Workspaces". (`source/app/service-providers/config/get-config-template.ts`, `source/win-main/file-manager/FileTree.vue`)
- **Opening a root.**
  - Use the dialogs: `Cmd+Shift+O` for a workspace, `Cmd+O` for files. Clicking the empty tree also opens the workspace dialog; Shift-click opens the file dialog.
  - Refused roots: non-directories, ignored paths, and the home directory. (`commands/root-open.ts`)
- **`addPath` rules.**
  - Deduplicates paths and accepts only md/code files or directories that are not on the ignore list.
  - `consolidateRootPaths` then drops root files that live inside an open workspace. It is also meant to drop nested workspaces, but it calls `slice` instead of `splice`, so that part does nothing (bug).
  - Roots are sorted naturally unless the user turned on manual workspace sorting (a drag & drop popover). (`config/index.ts`)
- Opening a file that lies outside every root silently adds it as a stand-alone root. (`documents/index.ts`, `openFile`)
- **Remembered state.**

  | State | Stored in |
  |---|---|
  | Selected folder | `openDirectory` in `userData/config.json` |
  | Open tabs/splits per window | `userData/documents.yaml` (absolute paths) |
  | Window bounds | `userData/window_state.yml` |
  | Recent documents (max 10) | `recent-docs` provider |
  | Previous searches (max 10) | `window.recentGlobalSearches` |

- **At boot.**
  - `checkPaths` removes roots that no longer exist.
  - Tabs whose file is no longer F_OK|R_OK|W_OK are closed, and empty panes are removed.
  - A workspace that exists but cannot be loaded (for example EACCES or EPERM) becomes "dead": it stays in the config, shows a "disconnect" icon, and its only context-menu item is "Check for directory…". (`config/index.ts`, `fsal/index.ts` `syncRoots`/`deadWorkspaces`, `documents/index.ts` `boot`)
- **No per-vault config.**
  - Per-folder settings (sort mode, icon, color, project) live in a `.ztr-directory` JSON dotfile *inside that folder*.
  - The file is written only when the settings differ from the defaults.
  - When reading, the app deletes the file again if it holds default values or is malformed, which means the app removes files in user folders. (`fsal/fsal-directory.ts`)
- **App data directory and CLI flags.**
  - App data lives under `userData`, and `--data-dir` (relative paths resolve against the executable) overrides it for portable installs.
  - `--clear-cache` wipes the metadata cache.
  - `--disable-hardware-acceleration` exists for VMs. (`source/main.ts`)

---

## 3. File tree

### 3.1 What is listed

- **Ignore rules.** `ignorePath()` uses case-insensitive regexes that start and end at path-segment boundaries. (`common/util/ignore-path.ts`)
  - Always ignored: `.DS_Store`, `desktop.ini`, `.directory` (KDE), `.git`, `.hg`, `.svn`, `.obsidian`, `.quarto`, `.dropbox*`, LibreOffice locks `.~lock*`, Office temp files `~$*.doc(x)/xls(x)/ppt(x)`, Nextcloud temp files `*.~*`, and `*.asar` (Electron reports these as directories, which crashed the scanner).
  - The list also has entries `.app` and `.textbundle`, apparently meant for bundles. Because every pattern is anchored to a whole path segment, they only match segments named exactly `.app` or `.textbundle`; `Foo.app` and `Note.textbundle` are **not** matched (likely a bug). To match by suffix, the pattern needs a leading wildcard, as the `.asar` entry has.
  - `.ztr-directory` is hidden from the UI but still watched.
  - Dotfiles are hidden unless the "show dotfiles" setting is on.
- Only regular files and directories are listed. Symlinks are never followed (`lstat` everywhere, chokidar `followSymlinks:false`), and watcher events for symlinks are dropped.
- **File types.** (`common/util/file-extention-checks.ts`, `file-manager/util/filter-children.ts`)
  - Markdown: `.md .rmd .qmd .markdown .txt .mdx .mkd`.
  - Code: `.tex .latex .yaml .yml .json .dic`.
  - Images, PDF, MS Office, OpenOffice and data files each have three toggles: show in tree, show in sidebar, open with Zettlr or with the system. By default only md and code files appear in the tree. Attachments of the current folder appear in a sidebar "Other files" tab.
  - Unknown extensions are hidden unless listed in `attachmentExtensions`.
- **Labels.** Controlled by `fileNameDisplay`: `filename | title | heading | title+heading`. The default is title+heading: frontmatter `title` if present, else the first H1, else the filename. `.md` is hidden in labels by default (`display.markdownFileExtensions=false`). Two roots with the same name get the parent folder name appended. (`win-main/util/get-document-title.ts`)

### 3.2 Sorting (`common/util/directory-sorter.ts`)

- Each directory has its own sort mode: `name-up` (default), `name-down`, `time-up` or `time-down` (newest first), stored in `.ztr-directory`.
- Global settings:
  - `sorting` is `natural` (an `Intl.Collator` for `[appLang, 'en']` with `numeric:true`, comparing lower-cased names) or `ascii`.
  - `sortFoldersFirst` defaults to true.
  - `fileMetaTime` picks modification time or creation time for time sorts.
- Folders are always sorted by name. Files are sorted by their *display label* (title/H1 when that is what the tree shows), so visual order matches what the user reads.
- Performance smell: a new `Intl.Collator` is created inside every comparison. Create it once.

### 3.3 Operations

- **Create file** (`TreeItem.vue`, `commands/file-new.ts`, `common/util/generate-filename.ts`)
  - From the folder context menu: an inline input row appears under the folder. It is prefilled with a generated name (pattern `%id`, the ID being `YYYYMMDDhhmmss`), and everything before the last dot is selected. Enter commits; Esc or blur cancels.
  - Main sanitizes the name with `sanitize-filename` (illegal characters become `-`); an empty result is an error.
  - Extension handling: the inline flow requests a Markdown document, so `.md` is appended unless the name already has a Markdown extension (`foo.json` becomes `foo.json.md`). The menu flow without a type keeps any recognized extension, including configured attachment extensions.
  - If the target already exists, the user is asked whether to overwrite. On yes the app closes and **deletes** the existing file first.
  - The new note opens in a new tab.
  - From the menu (`Cmd+N`) without a name, a native Save dialog appears unless `newFileDontPrompt` is on. With no selected folder, it falls back to the OS Documents folder.
- **Create folder** (`commands/dir-new.ts`): an inline row prefilled with "Untitled", sanitized; the new folder becomes the selected directory.
- **Rename file** (`commands/file-rename.ts`)
  - Inline input in place of the label (`Cmd+R` or context menu). The extension is excluded from the initial selection. Enter commits; Esc or blur cancels.
  - Main applies these rules in order:
    1. Sanitize the name; an empty result is an error.
    2. If the extension changed: when the new extension is recognized, ask "Use .x / Keep .y" (Keep is the default); otherwise append the old extension.
    3. Refuse if the document has unsaved changes.
    4. Same name: do nothing.
    5. Case-only change where the filesystem reports the target as existing: assume a case-insensitive filesystem and rename without prompting.
    6. Any other existing target: ask to overwrite, which deletes the target.
  - Afterwards, open tabs and documents are re-pointed in place (`hasMovedFile`). The in-memory buffer survives, including unsaved state; the editor view is re-created for the new path from that same buffer.
  - Inbound wikilinks are rewritten after a confirmation dialog (see §7).
  - Bug: both existence checks probe the same path, so on a case-sensitive filesystem a case-only rename onto a *different* existing file overwrites it without asking. Compare inode/dev instead, or match the exact name from `readdir`.
- **Rename folder** (`commands/dir-rename.ts`): sanitize, then rename. Open documents under the folder are re-pointed by prefix replacement (`startsWith(oldPath)` without a separator, so it is buggy). If the folder is a root, its path is updated in the config. No link rewriting.
- **Delete** (`commands/file-delete.ts`, `dir-delete.ts`, `fsal/util/safe-delete.ts`)
  - The confirmation dialog defaults to OK. The file is closed everywhere, then moved to the OS trash with `shell.trashItem`.
  - If trashing fails and `system.deleteOnFail` is on (default false), the app does a recursive force delete; otherwise it reports an error.
- **Duplicate** (`commands/file-duplicate.ts`): named "Copy of X", then "Copy (n) of X"; the copy opens.
- **Move by drag & drop** (`TreeItem.vue`, `FileManager.vue`, `commands/request-move.ts`, `util/item-composable.ts`)
  - The drag payload uses a custom MIME type `text/x-zettlr-file` holding JSON `{type, path, id}`. Only folders accept drops.
  - Guards:
    - Dropping onto itself or into its current parent is a silent no-op.
    - Moving a folder into its own subtree is an error (prefix check without separator, so it is buggy).
    - If the name already exists in the target, the move fails with an error; there is no auto-rename.
    - Moving a file with unsaved changes is refused silently; the attempt is only logged.
  - Hovering a collapsed folder for **1000 ms** while dragging expands it.
  - Within 100 px of the tree's top or bottom edge the tree scrolls automatically, faster nearer the edge.
  - Dragging a file to the window border hands the drag over to a native OS drag (`webContents.startDrag`).
- **Context menus** (`util/file-item-context.ts`, `util/dir-item-context.ts`, `FileTree.vue`)
  - File: Open in new tab · Properties · Rename (Cmd+R) · Duplicate · Delete (Cmd+Backspace) · Copy path · Copy filename · Copy ID · "Reveal in Finder / Explorer / File Browser" (label depends on the OS) · Close file (roots only).
  - Folder: Properties · New file… · New directory… · Rename · Delete · Copy path · Reveal · (Export project) · Close workspace (roots only).
  - Section headers: Close all files · Collapse workspaces (optional two-step: subfolders first, then roots) · Sort workspaces… · Close all workspaces.

### 3.4 Interaction details

- **Clicks**
  - Click a file to open it in the last focused pane. Middle-click, or Alt-click on a Markdown file, forces a new tab.
  - Click a folder to select it (`openDirectory`) and expand it. Clicking the chevron only toggles it.
  - Opening a file expands its parent folder and scrolls the row into view. The scroll is smooth and keeps a 100 px safety margin for the filter box and sticky headers. (`item-composable.ts`, `TreeItem.vue scrollIntoView`)
- Expanded folders use `position: sticky; top: 0`, so the header of the folder you are inside stays visible while scrolling a long folder.
- **Keyboard** (`FileTree.vue navigate`)
  - `Mod-Shift-T` focuses the filter.
  - ArrowUp/Down move a virtual cursor over a *flattened list of visible rows*. That list is built with the same filter and sort as the rendered tree.
  - ArrowLeft collapses a folder, or jumps to the parent of a file and collapses it. ArrowRight expands.
  - Enter opens the file; Esc clears the cursor.
  - Bug: Enter on a *folder* reads the path slot instead of the type slot of the cursor tuple, so the folder is sent to "open file", which hands it to the OS file manager.
- Expand state is an in-memory array per window (`pinia/window-state-store.ts`) and is **lost on restart**.
- Geometry: 13 px font, 8 px vertical margin per row, indentation of `depth × 15 + 10` px.
- In the non-default "thin" and "expanded" modes, a flat list of the selected folder is shown with a virtual scroller (`RecycleScroller`, page mode, fixed row height). In thin mode a horizontal wheel swipe switches between tree and list. (`FileList.vue`, `FileManager.vue`)

---

## 4. Editor

### 4.1 Markdown flavor (`markdown-editor/parser/markdown-parser.ts`)

The base is `@codemirror/lang-markdown` with the GFM `markdownLanguage`: tables, task lists, strikethrough and autolinks. Custom Lezer parsers add the following.

- **YAML frontmatter** (`parser/frontmatter-parser.ts`)
  - A block parser ordered *before* `HorizontalRule`, so `---` is not taken for a rule.
  - Recognized only at document offset 0 with a line that is exactly `---`. It ends at a line of `---` or `...`; the first content line must not be blank; an unterminated block is not frontmatter.
  - The YAML content gets nested highlighting through `parseMixed`, and the block is foldable.
- **Wikilinks** `[[target]]` and `[[target|title]]` (or `title|target` via the `zkn.linkFormat` setting; changing it requires an editor reload) (`parser/zkn-link-parser.ts`)
  - An inline parser registered *before* `Link`, otherwise the inner brackets become a normal link.
  - A pipe at the very start or end of the content counts as "no pipe".
- **Tags** `#tag` and `##tag` (`parser/zkn-tag-parser.ts`): must follow line start, whitespace, `(`, `{` or `[`. The body is Unicode letters, numbers, emoji, `_` or `-`, so Hangul tags work.
- **Highlight** `==text==` (also `::text::`): delimiter-based, with "flanking" rules built on the Unicode space, punctuation and symbol classes. (`parser/highlight-parser.ts`)
- **Further extensions:**
  - Footnotes `[^1]`, inline `^[…]`, and definitions as composite blocks.
  - Callouts `> [!NOTE] title` with keywords note/tip/important/warning/caution, nestable. (`parser/admonition-parser.ts`)
  - Math `$…$` / `$$…$$`, citations `[@key]`, Pandoc attributes `{#id .class}`, divs `:::` and spans, grid and pipe tables.
- **Fenced code:** the info string (optionally wrapped as `{.lang}`) is matched against about 60 language selectors. `mermaid` gets an empty stream language just so that a `FencedCode` node exists for its renderer.
- No embeds (`![[…]]`) and no block references.

### 4.2 Live preview — the "renderers" (`markdown-editor/renderers/*`)

- **Modes.** Rendering mode is `preview` (default) or `raw`, and each renderer can be switched off in the settings. Changes apply without recreating the editor: a `transactionExtender` reacts to a config effect and reconfigures a `Compartment`. (`renderers/index.ts`)
- **Reveal rule.** A node is rendered (syntax hidden or a widget shown) only when no selection range overlaps it. (`util/range-in-selection.ts`)
  - The helper has an "include adjacent" mode in which a caret right before or after the node also counts as touching. It is driven by `previewModeShowSyntaxWhenCursorIsAdjacent`, default true.
  - Headings and HRs *always* use adjacent mode, because otherwise you could never place the caret into the hidden `#`.
- **Two helpers** (`renderers/base-renderer.ts`):
  - *Inline*: a ViewPlugin that walks the syntax tree over `view.visibleRanges` only, and is recomputed on doc, viewport or selection change.
  - *Block*: a StateField that re-walks the whole document on every transaction, because block decorations must come from state. It is slower and only used for multi-line replacements such as HRs.

Per element:

- **Emphasis / strong / strikethrough / highlight** (`render-emphasis.ts`)
  - Hide only the mark child nodes.
  - Inline code: hide the backticks.
  - Fenced code: hide both the ``` fences *and* the info string.
  - Escapes: hide just the backslash. Footnote references: hide the brackets.
  - Blockquotes: hide `>` plus up to three following spaces, but only while the *outermost* blockquote is untouched, which avoids half-rendered nested quotes.
  - Bullet markers `- * +` are replaced by a `•` widget. Ordered numbers stay visible.
- **Headings** (`render-headings.ts`, `theme/editor.ts`)
  - Hide `#…` together with the following spaces.
  - The heading size is applied to the whole line with `.cm-line:has(.cm-header-N)`: h1 2em, h2 1.8em, h3 1.5em, h4 1.3em, h5 and h6 1em, all bold. This needs CSS `:has()` support.
  - An optional gutter shows `h1`…`h6`.
- **Links** (`render-links.ts`, `plugins/click-listeners.ts`, `util/open-markdown-link.ts`)
  - For `[text](url)`, hide `[` and `](url)`. The renderer only acts when the node has at least three link marks or a label, and skips an empty link text so the whole link never vanishes.
  - For a wikilink with a title, hide the target and the pipe. `[[`/`]]` stay visible but dimmed.
  - **Mod-click** (Cmd on macOS, Ctrl elsewhere) opens: URLs in the OS browser; `#heading` jumps to the heading through the outline ids; an absolute local path opens in the app; a wikilink goes through the link resolver.
- **Tasks** (`render-tasks.ts`): the `TaskMarker` (`[ ]` / `[x]`) is replaced by a real checkbox. Clicking it rewrites the marker in the source and refocuses the editor. The widget ignores `mousedown` so CM6 does not move the caret into it, which would un-render it.
- **Horizontal rules** (`render-hr.ts`): a block `<hr>` widget, revealed when the caret is adjacent.
- **Images** (`render-images.ts`), rendered as an inline widget (`figure` > `img` + caption + size badge + "open externally" button):
  - Relative URLs resolve against the note's folder; local files load through a custom `safe-file://` protocol.
  - A broken image shows an embedded 404 placeholder and an "Image not found: …" caption.
  - The caption is editable in place (contenteditable). Enter or blur rewrites the source as `![caption](url "caption")`.
  - Maximum size comes from the settings (100% width, 50vh height) or from Pandoc attributes such as `{width=50%}`.
  - Clicking the image selects its source text.
  - Images whose source spans a newline are skipped, because inline decorations cannot cross lines.
  - Reference-style images resolve through a case-insensitive label lookup.
  - `estimatedHeight` comes from a cache of measured heights keyed by URL, and `updateDOM` reuses the existing DOM to avoid flicker.
- **Blockquotes and callouts** (`render-blockquotes.ts`, `render-admonitions.ts`): a `BlockWrapper` (a recent CM6 API) wraps the quoted lines in an element with a left border and 0.7 opacity. Callouts get a class per keyword and a title widget showing the custom title or the translated keyword.
- **Code** (`render-code.ts`, `plugins/code-background.ts`): a mark decoration styles the code text. The background is drawn by a CM6 `layer` of `RectangleMarker`s (rounded top and bottom), so a code block gets one continuous background that does not conflict with line decorations.
- **Tables** (`table-editor/*`): a block widget replaces GFM pipe tables, but only rectangular ones.
  - A clicked cell hosts a *nested EditorView* that holds the full document with everything outside the cell hidden. A transaction filter clamps selections to the cell and turns newlines into spaces.
  - Rows and columns can be added, removed, moved and aligned; Tab and Enter navigate between cells.
  - Scroll jumping is prevented with `estimatedHeight` (an LRU cache of 100 entries keyed by table start; otherwise rows × 100 px) plus a `coordsAt` override.
- Further renderers: math (KaTeX), mermaid, iframes (whitelist `www.youtube.com`, `player.vimeo.com`), citations, Pandoc divs.
- **Hanging indent for wrapped lines** (`plugins/visual-indent.ts`): for list and quote lines, the plugin measures the pixel width of the marker prefix with `requestMeasure`, cached per prefix string so `* One` and `* Two` share one measurement. It then sets `padding-left` plus a negative `text-indent` on the line, so wrapped lines align with the text rather than the marker. Tabs are replaced by fixed-width space widgets to stop jitter while typing.

### 4.3 Keyboard (`keymaps/default.ts`, `app/service-providers/menu/menu.darwin.ts`)

- **Formatting:** Mod-B bold (`**`), Mod-I italic (`_`), Mod-T task list, Mod-Shift-C comment.
  - Configurable defaults: Mod-K link, Mod-Shift-I image (macOS), Ctrl-Shift-H highlight.
  - Insert link reads the clipboard and prefills the URL when it looks like one.
- **Search and completion:** Mod-G / Mod-Shift-G find next/previous, Mod-D select next occurrence, Mod-Shift-L select all matches, Ctrl-Space open autocomplete. (`keymaps/shortcuts.ts`)
- **Inline toggle algorithm** (`commands/markdown.ts`), four cases:
  1. The markers sit just outside the selection: unwrap.
  2. The selection includes the markers: unwrap.
  3. An empty caret sits right before the closing marker: jump over it.
  4. Otherwise: wrap the selection and keep it selected inside the markers.
- **Enter chain:** autocorrect, then "next table row", then `insertNewlineContinueMarkup` (continues lists and quotes; an empty item ends the list), then plain newline-and-indent. Mod-Enter inserts a blank line.
- **Backspace chain:** `deleteMarkupBackward` removes list or quote markup before the normal delete.
- **Tab chain:** accept completion, next snippet field, next table cell, list indent (plus renumbering), then insert the indent unit (4 spaces by default) or indent the selection. Shift-Tab mirrors it.
- **Line operations:** Alt-Up/Down move lines (lists renumbered afterwards); Alt-Shift-Up/Down copy lines; Shift-Mod-K deletes a line; Mod-] / Mod-[ indent and outdent.
- **List fix-up** (`commands/lists.ts`): after indent, outdent or a line move, every touched ordered list is renumbered starting at 1. Mixed bullet symbols on one level are unified to the first item's symbol.
- **Global shortcuts:**

  | Shortcut | Action |
  |---|---|
  | Mod-F | Find panel (top) |
  | Mod-Shift-F | Global search |
  | Mod-Shift-T | Filter files |
  | Cmd+[ / Cmd+] | Previous / next file in history |
  | Ctrl-Tab / Ctrl-Shift-Tab | Next / previous tab |
  | Cmd+W | Close tab |
  | Cmd+S | Save |
  | Cmd+N | New file |
  | Cmd+R | Rename |
  | Cmd+Backspace | Delete file |

- Optional vim and emacs input modes; macOS gets emacs-style Ctrl movement keys by default.

### 4.4 Paste and drop (`plugins/md-paste-drop-handlers.ts`, `commands/save-image-from-clipboard.ts`)

- **Intent heuristic.** If the clipboard contains `text/plain`, the user wants text, even if an image is also present (Office puts both). With `text/html` also present, the HTML is converted to Markdown (respecting the `**`/`_` preferences), falling back to the plain text on error. Plain text alone goes through CM6's default paste.
- **No text, only files:**
  - An image that exists on disk is inserted as `![name](relative/path)`.
  - A clipboard-only image (a screenshot) opens a modal: target folder (default `editor.defaultSaveImagePath` resolved relative to the note), name, and optional resize.
  - The name comes from the clipboard text's basename when one is present, else from the MD5 of the data URL, which deduplicates identical images. The generic `image.png` that screenshots get is discarded.
  - The image is saved as PNG or JPEG (quality 100) and inserted as `![name](./relative/path)` with forward slashes and a `./` prefix.
- No URL-to-link conversion on paste.
- **Drop onto the editor:**
  - OS image files: a relative link is inserted at the drop position.
  - md/code files: opened in a new tab.
  - Tree items: Markdown becomes `[[name]]`, code becomes `[name](./rel)`, images become `![name](./rel)`.
- Mod-Shift-V pastes as plain text; Mod-Alt-C copies as HTML.

### 4.5 Find and replace

The stock `@codemirror/search` panel at the top (Mod-F): next/previous, select all matches, go to line, select next occurrence. Global search hits are additionally painted into the editor as highlight ranges.

### 4.6 IME / composition

- The editor relies entirely on CM6's built-in composition handling. No command, renderer or keymap checks `view.composing`.
- Enter-during-composition is guarded only in form inputs (`event.isComposing`): the global search field (`GlobalSearch.vue onEnter`) and the autocomplete text control (`common/vue/form/elements/AutocompleteText.vue`).
- Risk for Korean: renderers recompute decorations on every selection change. Hiding or showing marks right next to an active composition can disturb Hangul input. mininote should freeze decoration changes near the composition range while `view.composing` is true.

### 4.7 Other editor features (mostly out of scope)

Autocomplete for `[[` files, `#` tags, `@` citations, ``` languages, `:` snippets/emoji and headings; a floating formatting toolbar on selection; hunspell spellcheck; remark-lint; LanguageTool; typewriter and distraction-free modes; readability mode; statistics; folding; hover tooltips for footnotes, URLs and linked files.

---

## 5. Persistence

### 5.1 Document model (`documents/index.ts`, `markdown-editor/plugins/remote-doc.ts`, `markdown-editor/util/ipc-api.ts`)

- **Main owns the text.** The main process holds the canonical text of every open document as a CM `Text`, together with `currentVersion`, `lastSavedVersion`, `lastSavedContent` and up to **100** recent updates (`MAX_VERSION_HISTORY`).
- **Sync between editors.**
  - After every change, an editor sends `@codemirror/collab` updates to main ("push").
  - Main applies them and broadcasts a `CHANGE_FILE_STATUS` event.
  - Other editors showing the same file then pull the missing updates. The pull waits for that event, so it is event-driven, not polling.
  - If an editor's version is outside the retained window, it reloads the whole document.
- Benefits: split panes and multiple windows stay in sync, and main can still save after a renderer crash.
- **Tab switch.** Editor views are destroyed and recreated on every tab switch. A per-path in-memory map keeps the CM `scrollSnapshot()` effect, the selection and the folded ranges, and restores them after `setState`. Selection ranges beyond the new document length are dropped. (`markdown-editor/index.ts persistentState`, `win-main/MainEditor.vue`)

### 5.2 Autosave and saving

- **Setting `editor.autoSave`:** `off` (**default**), `immediately` (**500 ms**), or `delayed` (**5000 ms**). The comment explains that even "immediate" waits a little to avoid races on slow machines.
  - Every push clears and re-arms the document's timer, so this is a pure trailing debounce with no max-wait. Typing continuously never saves in "delayed" mode.
- **Flush triggers.**
  - Explicit `Cmd+S` and the timer.
  - On `before-quit` and on window close: if any document is dirty, a dialog offers Save / Discard / Cancel.
  - Closing the last tab of a dirty document opens a Save / Don't save / Cancel dialog.
  - Switching tabs or losing focus does **not** save; the document stays dirty in main.
- **Save steps:**
  1. Clear the timer and join the lines with LF.
  2. Set `lastSavedVersion` and `lastSavedContent` *before* writing. This prevents the race where edits typed during a slow write would be marked as saved.
  3. Update the word-count statistics.
  4. Add the path to the ignore-once list.
  5. Write the BOM plus the content using the file's original linefeed, with plain `fs.writeFile` (not atomic).
  6. Refresh the descriptor and broadcast `FILE_SAVED`.
- **On a write error** a native error box appears and the error is rethrown. `lastSavedVersion` stays updated, though, so the document *looks clean although it is not saved* (data-loss risk).
- **Line endings and BOM** (`fsal/util/extract-linefeed.ts`, `extract-bom.ts`, `fsal/fsal-file.ts load`)
  - The linefeed is detected per file (LF, CR, CRLF or LFCR; when mixed, the first occurrence wins) and content is normalized to LF in memory.
  - The BOM is detected (UTF-8/16/32 and more) and stripped on load; both are restored on save.
- Rename and move are refused while a document is dirty.
- **App-state persistence** (`common/modules/persistent-data-container`): `set()` deep-clones the data, debounces the disk write by **1000 ms**, and flushes on shutdown. Used for config, document tree, window state, tags and targets.

### 5.3 Watching and external modifications

- **FSAL watchers** (`fsal/fsal-watchdog.ts`, `fsal/index.ts`)
  - One chokidar watcher per root, with `ignoreInitial`, `followSymlinks:false`, `ignorePermissionErrors`, and the ignore regex list.
  - Polling is opt-in (`watchdog.activatePolling`). Only then is `awaitWriteFinish` enabled, with `stabilityThreshold` **1000 ms** (configurable; validated 1–100000) and `pollInterval` **100 ms**.
  - Every event first invalidates the cache entry. Then `{event, descriptor}` (add, addDir, change; freshly stat'ed) or `{event, path}` (unlink, unlinkDir) goes to main listeners and all windows.
  - A change to `.ztr-directory` is re-emitted as a change of its folder.
  - Watchers must be closed explicitly on quit; otherwise fsevents makes macOS show a crash report.
- **DocumentManager** runs its own watcher over *open files only*, kept in sync with the tabs (`syncWatchedFilePaths`).
  1. **Self-write suppression:** the path is pushed to `_ignoreChanges` right before the write, and the next `change` event for it is swallowed once.
  2. `unlink`: the file is closed everywhere, even if pinned, without asking.
  3. `change` runs `handleRemoteChange`:
     - Ignore the event unless the disk mtime is **newer** than the descriptor's. Equal mtimes are ignored on purpose, against OneDrive/Box "jumping text".
     - Load the disk content and ignore the event if it equals `lastSavedContent` (attribute-only changes, duplicate events).
     - If the document is clean and `alwaysReloadFiles` is on (default **true**), reload silently. Editors keep selection and scroll position.
     - Otherwise ask: "Keep editor contents" / "Load changes from disk", with a checkbox "Always load changes from disk if there are no unsaved changes". At most one dialog per file at a time.
     - Choosing "keep" marks the document dirty by decrementing `lastSavedVersion`, so the next save wins.
- **Pitfalls**
  - The ignore-once entry leaks when a write produces no event; it then swallows the next genuine external change. Multi-event writes slip past it; the content check catches those.
  - An external rename arrives as unlink + add, so the tab is simply closed.

---

## 6. Navigation and search

- **No fuzzy quick switcher.**
- **Filter files** (`Mod-Shift-T`) focuses the tree filter (`file-manager/util/match-query.ts`, `FileTree.vue`, `FileManager.vue`):
  - The query is split on spaces and *every* term must match (AND) as a case-insensitive substring.
  - A term can match the name, the frontmatter title (if titles are displayed) or the first H1 (if headings are displayed).
  - `#` alone matches any tagged file; `#foo` matches tags containing "foo".
  - Ancestors of matches stay visible and folders are shown expanded while filtering. The filter resets when another folder is selected.
- **Full-text search** (`Mod-Shift-F`; `search/index.ts`, `search/util/boolean-search.ts`, `win-main/GlobalSearch.vue`)
  - **Engine:** runs in main, searching files *one at a time* (an async chain, no parallelism). Each file's result is streamed to the renderer with a progress fraction. Cancel simply empties the queue.
  - **Query language:**
    - Whitespace means AND; `|` means OR (consecutive ORs are grouped).
    - `"exact phrase"` keeps inner spaces.
    - `!word` means NOT: any match excludes the file, and a NOT-only query returns every file without the word.
  - **Options:** case-insensitive (default on) and an optional "restrict to folder" with autocomplete of workspace-relative folder paths.
  - **Scoring:**
    - A filename or tag match is a metadata hit with weight 2; each matching line adds weight 1 (several hits on one line are merged).
    - A file's weight is the sum. Results are sorted by weight as they arrive.
    - A relevance dot is gray below 30% of the best weight, blue below 70%, green above.
  - **Excerpts:** ±40 characters around the matches on a line; excerpts may cross newlines.
  - **Result list:** virtualized (`DynamicScroller`), filterable, and collapsible per file. Clicking a hit opens the file, jumps to the line and paints all matches in the editor.
  - There is no index and no result limit.
  - Clicking a tag starts a search for it, and so does following a wikilink when `zkn.autoSearch` is on (default true).
  - Case folding works by lower-casing the whole text and reusing the offsets. That breaks for characters whose length changes when lower-cased (for example `İ`), but is harmless for Hangul.
- **History** (`documents/document-tree/tab-manager.ts`, `windows/create-main-window.ts`)
  - Each pane keeps a session list. Opening a file removes its earlier entry and appends it, so this is *not* a strict browser back stack.
  - Back and forward via `Cmd+[` / `Cmd+]`, mouse back/forward buttons (`app-command` on Windows/Linux) and trackpad swipe on macOS.
- **Tabs** (`win-main/DocumentTabs.vue`, `tab-manager.ts`)
  - A new tab is inserted right of the active one. Pinned tabs stay grouped on the left and cannot be closed.
  - Closing the active tab activates its left neighbour.
  - With `avoidNewTabs`, a clean active tab is replaced instead of a new one opening.
  - Middle-click closes. Tabs can be dragged to reorder, to another pane, or to a pane edge to split horizontally or vertically.
  - Dirty tabs carry a `modified` class. On macOS the window also shows the "edited" dot (`setDocumentEdited`). Tabs with the same title show their folder name.
- **Outline** (`markdown-editor/plugins/toc-field.ts`, `win-main/sidebar/ToCTab.vue`)
  - Built by a StateField with `ensureSyntaxTree(state, len, 1000 ms)`, numbered hierarchically (1, 1.1, …).
  - IDs follow Pandoc: an explicit `{#id}` or `<a name>` wins; otherwise the heading is slugified *ASCII-only*, so a Korean heading collapses to `section`.
  - Click to jump, drag a heading to move its whole section, and the section containing the cursor is highlighted.

---

## 7. Links

- **Resolution rules** (`fsal/index.ts findExact`, duplicated in `links/index.ts`):
  1. Drop a `#anchor` suffix. The file still opens, but there is no jump to the heading.
  2. If the query matches the ID regex (default `(\d{14})`), find the file with that ID: taken from the filename if present, else the first ID in the content that is not inside `[[ ]]`.
  3. Else, if the query ends with a Markdown extension: exact basename match.
  4. Else: basename equals query plus the file's extension.
  - Matching is exact and case-sensitive, with no NFC/NFD normalization. The first hit in traversal order wins (open files, then workspaces in config order).
  - There is no shortest-path or relative-path logic, so `[[folder/note]]` never resolves.
- Every resolution re-walks all workspaces with a fresh recursive `readdir` (descriptors come from the cache). That happens on Mod-click and on the hover preview, which fires after **100 ms** of hovering.
- **Unresolved links:** the hover preview shows "File X does not exist." Clicking creates the note only if `zkn.customDirectory` is set and exists; otherwise nothing happens beyond the optional auto-search.
- **Autocomplete after `[[`** (`autocomplete/files.ts`, `autocomplete/index.ts`, `MainEditor.vue updateFileDatabase`)
  - Candidates: every Markdown file (filename without extension; display label per `fileNameDisplay`; ID shown as detail) plus every *unresolved* link target from the link database. That keeps links to notes that do not exist yet consistent.
  - Matching is a lower-cased substring test on the label; no fuzzy ranking; `maxRenderedOptions: 20`.
  - Applying a candidate inserts `target|title` when `zkn.linkAddFileTitle` is on (default true), adds `]]` unless it already follows, and pre-selects the title for overwriting. `linkWithIDIfPossible` uses the ID instead of the filename.
  - Suppressed inside frontmatter and math.
- **Backlinks** (`links/index.ts`, `win-main/sidebar/RelatedFilesTab.vue`, `tags/index.ts`)
  - The link database maps each file to the raw link targets extracted from its syntax tree; a second map holds IDs.
  - A file's inbound links are all files whose targets contain its ID or its basename (with or without extension).
  - The "Related files" sidebar lists inbound, outbound and bidirectional links, then files sharing tags ranked by summed IDF (`log(N/df)`).
  - Both databases are rebuilt *from scratch on every FSAL event*.
- **Rename updates links** (`commands/file-rename.ts`, `common/util/replace-links.ts`)
  - Only when a file is renamed. Moving never breaks basename links.
  - The user confirms "Update N internal links to file X?".
  - Only wikilink targets are rewritten, at the exact ranges from the AST, keeping the with/without-extension form the author used.
  - Linking files are read and written directly on disk, not through open editor buffers. An open linking file therefore goes through the external-change flow.
  - No link updates on folder rename.

---

## 8. Rendering and typography

- **No reading view.** Preview happens inside the editor.
- A custom AST-to-HTML converter, built on the same Lezer tree, is used for print, copy-as-HTML, hover previews, footnote tooltips and table cells. Unknown nodes become `span`/`div` with a kebab-case class. The result is sanitized with DOMPurify; the only extra allowed tag is `cds-icon`. (`markdown-utils/markdown-to-html.ts`, `common/util/sanitize-html.ts`)
- **Editor typography** (`theme/editor.ts`, `editor.css`, `MainEditor.vue`)
  - System UI font stack; font size from `editor.fontSize` (default **18 px**); line-height **1.4**; code font Inconsolata/monospace.
  - Headings: 2 / 1.8 / 1.5 / 1.3 / 1 / 1 em, bold.
  - Editor padding: `.cm-scroller` 50 px.
  - Distraction-free side margins: 50 px below 800 px width, 5vw up to 1000 px, 10vw up to 1100 px, 20vw up to 1300 px, 30vw above.
  - Five themes, each light/dark, set through `--zettlr-editor-*` CSS variables.
  - In the editor, spacing between blocks is simply source lines: blank lines plus line-height, no margins.
- **Print CSS** (`win-print/App.vue`) copies Pandoc's default HTML template, i.e. *per-element margins*:
  - `p` gets `1em 0`; headings get `margin-top: 1.4em` only when not the first child.
  - Lists get `margin-top: 1em`, reset to 0 when nested in an `li`; blockquotes get `1em 0 1em 1.7em`.
  - It already needs exceptions (`:not(:first-child)`, `li > ul`). This is exactly the pattern mininote wants to replace with spacing between adjacent blocks.
- **Colors:** an 8-step gray ramp `--grey-0…7` (rgb 240 → 40) exists, but an accent green `#1cb27e` is used for marks, links and the cursor. Selection colors are greenish.
- **Word count:** `Intl.Segmenter(locale, {granularity:'word'})` counting `isWordLike` segments, which is correct for Korean, Japanese and Chinese. Character count is text length. (`common/util/counter.ts`)

---

## 9. Performance

- **Metadata cache** (`fsal/fsal-cache.ts`, `fsal/fsal-file.ts`)
  - Per-file descriptors (tags, links, ID, first H1, frontmatter, word/char count, BOM, linefeed) are kept in maps sharded into at most about 99 JSON files under `userData/fsal/cache`. The shard is chosen from the first two characters of the path hash.
  - An entry is valid only if its `mtimeMs` equals the current one.
  - Keys not accessed during the session are dropped when the cache is persisted, which happens only at shutdown.
  - The cache is cleared on a version change or `--clear-cache`.
  - Per the source comment, roughly 6,000 files map to about 100 shard files and boot gets 25–90% faster.
- Files **over 10 MB** are not parsed (metadata only).
- **Boot order** (`app/app-service-container.ts`):
  1. Config.
  2. FSAL (starts the watchers).
  3. **Re-index every file**: a stat each, plus a parse on cache misses. A splash screen with per-file progress appears if boot takes over **1 s**.
  4. Links, search, commands, windows, tags…
  - Result: on a first start or after an upgrade the whole vault is parsed before any UI appears.
- **Renderer startup** (`pinia/workspace-store.ts`, `file-manager/TreeItem.vue`)
  - One IPC call per root returns the flat recursive path list, then *one bulk IPC call* fetches all descriptors. Afterwards the store is patched from `fsal-event`.
  - Tree children are fetched lazily per mounted (expanded) folder via `read-directory`, and refetched only when an event concerns a *direct* child. That is detected by the relative path containing no further separator, using the platform separator.
  - Long lists are virtualized: file list, search results, related files.
- **Editor:**
  - Inline renderers only walk the visible ranges.
  - Tables use `ensureSyntaxTree` with a 500 ms budget and the outline uses 1000 ms.
  - Table and image heights are cached to stabilize scrolling.
- **Anti-patterns to avoid:**
  - Link and tag databases are fully rebuilt on every FS event, without debounce (a `git checkout` causes an event storm).
  - `findExact` walks the vault on every call.
  - `Intl.Collator` is created per comparison.
  - Search runs sequentially.
  - Settings files are written and deleted inside user folders.

---

## 10. Platform and desktop

- **Window chrome** (`windows/set-window-chrome.ts`, `appearance/*`, `source/main.ts`)
  - macOS: `titleBarStyle: 'hiddenInset'` (inset traffic lights, no title bar) and optional vibrancy `under-window`.
  - Windows, and Linux with non-native appearance: frameless window with `titleBarOverlay` (transparent background, theme-dependent symbol color, fixed height) and an HTML menubar. Linux additionally needs an explicit PNG window icon.
- **Single instance** (`source/main.ts`, `util/extract-files-from-argv.ts`)
  - `requestSingleInstanceLock`. A second launch forwards its arguments — only md/code paths, never `--flags` — through `second-instance`, and a window is shown.
  - macOS `open-file` events that arrive before the app is ready are queued.
  - The app keeps running on macOS after the last window closes.
- **Window bounds** (`windows/index.ts`): stored per window id together with the display id. On restore they are clamped to that display's work area, falling back to the primary display: shrink to fit, then push inside. "Maximized" is inferred when the size equals the work area.
- **Navigation lockdown** (`util/attach-app-navigation-handlers.ts`, `util/custom-protocols.ts`, `common/util/make-valid-uri.ts`)
  - Renderer `sandbox:true` with a preload script. `will-navigate` is intercepted: http(s) links open in the OS browser and `safe-file://` URLs go to `shell.openPath`. `window.open` is denied.
  - Local assets are served by the custom `safe-file://` protocol:
    - A leading `/` before a Windows drive letter (`/C:/…`) is stripped.
    - `//host/share` maps to a UNC path on Windows and `/Volumes/host/…` on macOS; on Linux it returns 404.
    - Responses carry `Cache-control: no-store` and explicit content types (svg and pdf break without them).
- **Paths**
  - Backslashes are converted to `/` for URIs and inserted links.
  - Several prefix checks lack a separator: dir-rename re-pointing, move-into-own-subtree, "is the file inside a workspace", root consolidation.
  - **No** `normalize('NFC')` call exists anywhere (grep), so macOS NFD Hangul names compare unequal to typed NFC link targets, filters and duplicate checks.
- **Permissions:** EACCES/EPERM on a folder yields a dummy "not found" descriptor instead of a crash, and chokidar ignores permission errors.

---

## 11. Settings and defaults (relevant subset)

| Key | Default | Notes |
|---|---|---|
| `editor.autoSave` | `off` | `immediately` = 500 ms, `delayed` = 5 s trailing debounce |
| `editor.fontSize` | 18 | px |
| `editor.indentUnit` / `indentWithTabs` | 4 / false | |
| `editor.autoCloseBrackets` | true | |
| `editor.autocompleteWithTab` / `WithEnter` | true / false | |
| `editor.boldFormatting` / `italicFormatting` / `highlightFormatting` | `**` / `_` / `==` | |
| `display.renderingMode` | `preview` | or `raw` |
| `display.previewModeShowSyntaxWhenCursorIsAdjacent` | true | |
| `display.render{Images,Links,Tasks,HTags,Emphasis,HorizontalRules,…}` | all true | per-renderer toggles |
| `display.imageWidth` / `imageHeight` | 100 / 50 | % of width / vh |
| `display.markdownFileExtensions` | false | hide `.md` in labels |
| `fileNameDisplay` | `title+heading` | |
| `sorting` / `sortFoldersFirst` / `fileMetaTime` | `natural` / true / `modtime` | |
| `fileManagerMode` | `combined` | tree with files inside |
| `files.dotFiles` | hidden | images/pdf: hidden in tree, shown in sidebar, opened by the system |
| `alwaysReloadFiles` | true | silent reload when clean |
| `newFileNamePattern` / `newFileDontPrompt` | `%id` / false | ID = `%Y%M%D%h%m%s` |
| `zkn.idRE` | `(\d{14})` | changing it requires a restart and clears the cache |
| `zkn.linkFormat` / `linkAddFileTitle` / `linkWithIDIfPossible` | `link|title` / true / false | |
| `zkn.autoSearch` / `zkn.customDirectory` | true / `''` | auto-create location for unresolved links |
| `watchdog.activatePolling` / `stabilityThreshold` | false / 1000 | |
| `system.deleteOnFail` / `avoidNewTabs` / `leaveAppRunning` | false / false / false | |
| `darkMode` / `autoDarkMode` | follows OS / `system` | schedule 21:00–06:00 optional |
| `window.nativeAppearance` / `vibrancy` | macOS only / false | |
| `ui.fileManagerSplitSize` / `editorSidebarSplitSize` | [20,80] / [80,20] | percent |
| `editor.autoCorrect.active` | true | arrows, fractions, `--`→–, `...`→…, magic quotes |

The config is merged with the template through `safeAssign`, so unknown keys are dropped and missing keys get defaults. Migrations run before the merge. Validation rules are strings like `required|number|min:1|max:24`. Some keys need a relaunch, sometimes with a cache clear, which a dialog offers; others only need an editor reload. (`config/index.ts`, `config/config-validation.ts`)

---

## 12. Lessons for mininote

### Adopt

- **Live-preview architecture**
  - One small CM6 extension per element.
  - Inline hiding through ViewPlugins over `visibleRanges`; block widgets through a StateField.
  - A shared range-in-selection helper with an "adjacent" option, always on for headings and HRs.
  - Task checkboxes that ignore `mousedown`; `estimatedHeight` caches for images and tables.
- **Hanging indent** for wrapped list and quote lines by measuring the marker prefix (cache keyed by prefix text) and fixed-width tab widgets.
- **Code block background** drawn as a CM6 `layer` with rounded first and last rectangles, instead of per-line backgrounds.
- **Frontmatter parser** ordered before HorizontalRule and only at offset 0; wikilink parser before Link; Unicode-aware tag regex.
- **External-change pipeline:** self-write suppression, then "mtime newer?", then "content differs from last saved?", then reload when clean. One prompt per file at most. Preserve selection and scroll on reload, clamped to the new length.
- **Save race guard:** take the snapshot (text and version) before the asynchronous write starts. The difference from Zettlr: mark the document clean only after the write succeeds, and only if the version is unchanged.
- **Line endings and BOM:** detect on load, edit as LF, restore on save.
- **Rename safety:** sanitize, keep the extension, no-op on same name, case-only rename, collision prompt, re-point the open editor without reloading.
- **Tree UX:** inline create/rename with the name pre-selected up to the extension; Enter commits; Esc or blur cancels; sticky open-folder headers; auto-expand on drag hover; keyboard navigation over the flattened visible list; scroll-into-view with a margin.
- **Startup:** bulk startup IPC (paths, then descriptors in one call), followed by incremental FS events and lazy children per expanded folder.
- **Natural sort:** `Intl.Collator([lang, 'en'], {numeric:true})` created once.
- **Word count:** `Intl.Segmenter` (CJK-safe), if we ever show counts.
- **Navigation lockdown:** external URLs open in the OS browser; a custom protocol (or Tauri's asset protocol with a scope) serves local images.

### Avoid / do better

- **Autosave:** always on. Use a debounce of about 400–800 ms *with a max-wait* of about 2–3 s, and flush on note switch, window blur and close-requested. Write atomically (temp file in the same directory + fsync + rename) from Rust. Keep the document dirty and retry on failure.
- **Self-write detection:** compare against the recorded size, mtime and content hash of our last write, instead of an "ignore next event" list.
- **NFC normalization:** normalize every path and name to NFC for comparison, sorting, search and link matching, but keep the on-disk byte form for filesystem calls.
- **Link resolution:** case-insensitive, NFC-normalized, shortest path, with `folder/note` and `#heading` support.
- **Prefix checks:** compare paths with a trailing separator, or by path components.
- **Startup:** never block it on indexing. Show the tree from `readdir` immediately and index incrementally with a debounced batch updater.
- **Index updates:** incremental per changed file, not a full rebuild per event. Keep a basename (NFC, lower-case) → paths map for O(1) link resolution.
- **Per-vault state:** expanded folders, last note, scroll positions — store it in the app data directory keyed by vault, with *relative* paths. Never write dotfiles into user folders.
- **Persist expand/collapse state**, which Zettlr loses.
- **Outline slugs:** use Unicode-aware slugs; Zettlr's ASCII-only ones turn Korean headings into `section`.
- **Heading size:** set it with `Decoration.line({class})` computed from the syntax tree rather than `.cm-line:has(...)`. This is more robust across WebKitGTK, WebKit and WebView2 versions.
- **Block spacing in the reading view:** sibling-pair rules such as `* + *`, `h2 + p`, `li + li`, never per-element margins (contrast with `win-print/App.vue`). In the live editor, spacing can follow the same idea with line classes like `block-start` and `after-heading` derived from the previous sibling block.
- **IME:** guard Enter in inputs with `isComposing`, and do not change decorations around an active composition.

### Constants worth reusing

| Constant | Zettlr value | Suggested for mininote |
|---|---|---|
| Autosave debounce | 500 ms (immediate) / 5000 ms (delayed), no max-wait | ~500 ms debounce, ~2–3 s max-wait |
| UI state persistence delay | 1000 ms | 500–1000 ms |
| Drag-hover expand | 1000 ms | 600–800 ms |
| Tree edge auto-scroll zone | 100 px | 40–60 px (smaller UI) |
| Hover preview delay | 100 ms | 300–500 ms |
| Large file parse limit | 10 MB | 5–10 MB |
| Autocomplete max options | 20 | 20 |
| Recent docs / searches | 10 / 10 | 10 |
| Search excerpt window | ±40 chars | ±40 chars (by grapheme) |
| Collab history kept | 100 updates | n/a (single editor) |
| `awaitWriteFinish` | 1000 ms / poll 100 ms (only when polling) | notify debouncer ~100–200 ms |
| Table/ToC parse budget | 500 ms / 1000 ms | same idea via `ensureSyntaxTree` |
