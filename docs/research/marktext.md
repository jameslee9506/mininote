# MarkText: research notes for mininote

- **Repo:** https://github.com/marktext/marktext (shallow clone, commit `a520bef`, 2026-11-06, version `0.24.0-dev`)
- **License:** MIT, for both the desktop app and the bundled editor engine `@muyajs/core`. These notes describe behavior in our own words. No code was copied.
- **Stack:** Electron 45, Vue 3 + Pinia + Element Plus, and a custom WYSIWYG engine called *Muya*: a TypeScript rewrite that holds a block tree in `ot-json1` JSON state, renders inline tokens with `snabbdom`, and uses `marked` for import and export. CodeMirror 5 runs the "source code mode". The app also uses chokidar 5 (watcher), `@vscode/ripgrep` (search), `write-file-atomic` (saves), and `iconv-lite` + `ced` (encodings).
- **Path shorthand:** `desktop/` means `packages/desktop/src/` and `muya/` means `packages/muya/src/`.

MarkText is a *single-document WYSIWYG editor that also has a folder sidebar*. It is not a knowledge base. It has no wikilinks, backlinks, tags or index. Its value to us is the battle-tested desktop plumbing: saves, watchers, the file tree, IME handling, encodings, and session restore. Its editor model is the opposite of ours. Muya rebuilds Markdown from a block tree; we will edit raw text in CodeMirror 6.

---

## Key takeaways

**Adopt (proven, cheap to replicate)**
1. Durable atomic saves: temp file in the same directory, then fsync, then rename. On Windows, retry when a watcher briefly holds the file (EPERM/EACCES/EBUSY). See §4.3.
2. Classify external changes by content, not by timestamp:
   - identical text → ignore
   - clean buffer → silent reload, recorded as one undo step
   - dirty buffer → conflict banner, autosave paused
   - deleted → keep the buffer and mark it missing (§4.5)
3. Before each write, compare a SHA-256 *baseline* of the disk bytes with the current disk bytes (§4.3).
4. Keep the tree up to date incrementally from watcher events. Folders come first and use natural sort. Folds are stored as root-relative paths. Auto-reveal only scrolls when the row is not fully visible (§2).
5. Inline rename and create rules:
   - the file stem is preselected
   - Enter or a click elsewhere commits
   - Esc or a right-click cancels
   - the input closes before the async operation starts
6. CJK-friendly emphasis flanking, so bold Hangul words can be followed immediately by Korean particles (§3.2).
7. IME discipline: no Enter, Backspace, arrow or Tab logic while composing, and `compositionend` counts as input (§3.9).

**Avoid (pain MarkText documents for us)**
- Polling watchers on macOS. MarkText forces chokidar polling there.
- Reading the full content of every Markdown file during the initial folder scan.
- Showing `.git` and other dot-directories in the tree.
- Per-element margins that rely on margin collapsing for vertical rhythm. These need many patch rules (§7).
- A save path that can open a modal dialog during autosave.
- Path comparison without Unicode normalization. This is fatal for Hangul file names coming from NFD sources.
- AST round-tripping that rewrites the user's Markdown on save. For example, list indentation gets normalized to a preference.

---

## 0. Architecture in one screen

- **Main process** (`desktop/main/`) owns the parts that need native access:
  - every filesystem operation and the watchers (one chokidar watcher per sidebar root, one per open file)
  - saves and dialogs
  - the session and recovery state machine (`applicationState/sessionHost.ts`, `checkpointService.ts`, `documentRegistry.ts`, `closeCoordinator.ts`)
  - menus and keybindings
- **Renderer** (`desktop/renderer/src/`) runs sandboxed (`contextIsolation`, `sandbox`, no Node). Every native call goes through a typed preload bridge (`desktop/preload/index.ts`). Pinia stores hold the UI state: `editor.ts` for tabs, `project.ts` for tree roots, plus `layout.ts` and `preferences.ts`.
- **IPC rules.** Channels use the `mt::` prefix. Each renderer load receives a fresh **context token**, and every checkpoint carries a strictly increasing **sequence**. This lets main reject messages from a reloaded or stale renderer (`desktop/shared/types/applicationState.ts`).
- **Who owns the document.** Main keeps an authoritative copy of each open document: its identity, its live text (for recovery) and its verified disk baseline. The renderer sends the full Markdown of changed documents in debounced checkpoints. *For mininote this dual ownership is overkill.* Rust can own the disk while the webview owns the buffer, as long as saves happen quickly.

## 1. Vault / workspace

**Opening a folder**
- File → Open Folder (`Cmd+Shift+O`) *replaces* the window's roots, unless `openFolderInNewWindow` is set.
- "Add Folder" (the sidebar `+` button or the command palette) appends another root. MarkText supports multi-root windows, and each root gets its own collapsible tree (`desktop/main/windows/editor.ts` `openFolder`/`addFolder`).
- Folders can also arrive from CLI arguments, the macOS `open-file` event (coalesced for 100 ms), or a second instance's argv (`desktop/main/app/index.ts`).

**Root validation** (`desktop/main/windows/projectRoots.ts`)
- The path is resolved with `realpath` and must be a directory with read and execute permission that `readdir` can list.
- Adding a root that is already open does not duplicate it. The sidebar reveals the existing root and shows a "folder already added" toast.
- Nested or overlapping roots are rejected with an `overlap` error.

**Root lifecycle**
- A root starts as `loading` and becomes `ready` only after chokidar's `ready` event *and* after all initial file reads resolve.
- It becomes `unavailable` on a watcher error, a permission error, or when the root directory itself is deleted (an `unlinkDir` event on the root).
- While a root is not ready, the tree shows "Loading folder" or "Folder unavailable".
- The root's context menu offers **Retry** and **Remove Folder**. Retry refuses if the folder's real path has changed in the meantime.

**Identity** (`desktop/main/applicationState/identity.ts`)
- Each file location stores its display path, its canonical path (symlinks resolved, missing tail kept), and `key = sha256(canonicalPath)`.
- A workspace id is the SHA-256 of the *sorted* root keys, so root order does not change identity.
- Consequence: moving or renaming the vault folder forgets all of its remembered state.

**Startup** (`desktop/shared/applicationState/startupPlan.ts`)
- The `startUpAction` preference decides what opens:
  - `restoreAll` (default): every window of the last session, including unsaved recovery content
  - `restoreLastWindow`
  - `openLastFolder`
  - `folder`: a fixed `defaultDirectoryToOpen`, with a warning toast if it is missing
  - `blank`
- Explicit CLI or OS targets always override the stored choice.
- Three toggles narrow what gets restored: `restoreEditors`, `restoreViewState` and `restoreLayoutState`.

**Where state lives**
- Nothing is written inside the vault. Everything goes in the app-data directory: `%APPDATA%\marktext`, `~/.config/marktext`, or `~/Library/Application Support/marktext` (`packages/website/content/docs/end-user/APPLICATION_DATA_DIRECTORY.md`).

| File | Content |
|---|---|
| `preferences.json` | Validated preferences. Unknown keys are kept. An invalid file is treated as read-only and never overwritten (`desktop/main/preferences/preferenceFile.ts`). |
| `keybindings.json` | User overrides of the default keymap. |
| `state/application-state.json` | Windows, workspaces, layouts, open documents, view states and the recent-workspace cache. |
| `recovery/<windowId>/<documentId>.json` | Unsaved buffers (§4.2). |

- **Recent-workspace cache limits** (`desktop/shared/types/applicationState.ts` `STATE_LIMITS`): 50 workspaces, 100 files per workspace, 2000 collapsed paths per root, and 2000 collapsed outline keys per document.
- Collapsed paths are stored relative to their root. Absolute paths and `..` segments are filtered out when the state is captured and again when it is restored (`desktop/shared/applicationState/workspaceRecents.ts`, `desktop/renderer/src/store/project.ts` `safeCollapsedPaths`).

**Choosing a window for a file**
- Each window gets a score for the file: +5 if the file is inside one of its roots, +1 for each open file in the same directory, and -1 if the file is already open there.
- The highest score wins. Ties fall back to the last active window (`desktop/main/windows/editor.ts` `getCandidateScores`, `desktop/main/app/windowManager.ts` `findBestWindowToOpenIn`).

## 2. File tree

**What gets listed** (`desktop/main/filesystem/watcher.ts`, `desktop/common/filesystem/paths.ts`)
- The tree is built *entirely from watcher events*. The initial scan arrives as `add`/`addDir` events, followed by live `add`, `unlink`, `addDir`, `unlinkDir` and `change` events. There is no separate `readdir` listing.
- Files are listed only if their extension is in the Markdown set: `md markdown mdown mkdn mkd mdwn mdtxt mdtext mdx text txt`.
- **Every directory is listed**, including empty ones and dot-directories like `.git` and `.obsidian`. The only exclusions are `node_modules`, `*.asar`, and user globs in `treePathExcludePatterns` (minimatch with `matchBase`). The exclude list is empty by default.
- As a result, `.git` is watched recursively. That is a clutter problem and a CPU problem. **mininote should hide dot-entries by default.**

**Sorting** (`desktop/renderer/src/store/treeCtrl.ts`)
- Folders always come before files. They are always sorted by *natural* name, ascending: `localeCompare` with `numeric: true` and base sensitivity.
- Files sort by `created`, `modified` or `title`, ascending or descending. Ties break by natural name, then by full path.
- Effective default: `created` ascending. The bundled `static/preference.json` overrides the schema default, which is `modified`.
- In `modified` mode, a directory-watcher `change` event carries only the new mtime. The file is removed and reinserted at its new position, so the order stays live.
- New entries are inserted by searching for the first larger sibling and splicing. Nothing is fully re-sorted.

**Creating a note or folder** (`store/project.ts` `CREATE_FILE_DIRECTORY`, `components/sideBar/treeFolder.vue`)
- The target folder expands and an inline input appears *between its subfolders and its files*.
- Notes get `.md` appended when the name has none of the Markdown extensions.
- If the path already exists, creation is refused with an error toast. An older version silently truncated the existing file (#1946).
- Parent directories are created as needed.
- The new note opens **when the watcher reports its `add` event**, matched against `newFileNameCache`. Opening is therefore exactly as slow as the watcher.
- An empty root shows a "Create file" button.

**Rename** (`store/project.ts` `RENAME_IN_SIDEBAR`, `components/sideBar/renameKey.ts`, `tree.vue`)
- **Trigger:** `F2` or `Enter` on the selected row. It is ignored for the root, while an input is already open, and while focus is in an editable element.
- **Input:** the label is replaced by an input with only the *stem* selected. The selection ends at the last dot, unless the dot is the first or last character.
- **Commit:**
  - `Enter` commits.
  - A click anywhere else commits. A *capture-phase* document click listener makes this work even when other elements call `stopPropagation` (#3207, #3385).
- **Cancel:**
  - A right-click cancels, because the native context menu reads the selection afterwards.
  - `Esc` cancels and clears the selection.
  - An empty name cancels, and a name that resolves to the same path does nothing.
- **Double-submit guard:** the input state is cleared *before* the async move runs, so a second click cannot submit it twice.
- **Validation gaps:**
  - No name validation. A `/` in the name moves the file into a new subfolder, because `fs.move` creates parent directories.
  - Windows-illegal characters and reserved names are not checked.
  - A name collision fails `fs.move(..., {overwrite:false})` and shows an error toast.
- **Case-only renames** (`a.md` → `A.md`) pass the same-path check, which is an exact string comparison. They rely on fs-extra's support for changing case on case-insensitive filesystems.
- **Open documents** inside a renamed or moved path are relocated by main. Matching is by prefix on both the requested path and the canonical path (`desktop/common/filesystem/resourceMove.ts`, `sessionHost.ts` `_moveResourceNow`). While the move runs, main suppresses the watcher's `unlink` for the old path, so the tab is not flagged as deleted.

**Delete** (`desktop/main/filesystem/trash.ts`, `components/sideBar/trashKey.ts`)
- **Triggers:** the "Move to Trash" context-menu item, or a key:
  - `Delete` works on every OS.
  - On macOS, `Cmd+Backspace` also works. A bare Backspace never deletes.
  - Key-repeat is ignored.
  - The root can never be trashed from the keyboard.
- **Confirmation:** a dialog asks first. *Cancel is both the default button and the cancel button*, so pressing Esc or Enter does not destroy anything.
- **Deletion:** `shell.trashItem` moves the item to the OS trash. On success the selection is cleared.
- **Open documents:** a note whose file disappears stays open. It is marked missing and unsaved, with the bar "X has been removed on disk". Saving recreates the file.

**Copy / cut / paste**
- The tree has its own path clipboard.
- Cutting an item and pasting it back in the same location is refused.
- Copying into the same folder produces `name (copy).md`, then `name (copy 2).md`, and so on up to 99. After that it refuses.

**Drag and drop move** (`components/sideBar/useTreeDragDrop.ts`, `desktop/main/filesystem/sidebarMove.ts`)
- **Renderer rules:**
  - Moves stay within the same root, and the root must be ready.
  - The target must be a directory. Dropping on a file targets that file's parent.
  - An item cannot be dropped into itself, a descendant, or its current parent.
  - Dragging is disabled while a name input is open.
- **Feedback:**
  - Hovering a collapsed folder for **700 ms** expands it.
  - Holding within **32 px** of the top or bottom edge scrolls **8 px per frame**.
  - During the move the tree is `aria-busy`, and clicks, F2 and Delete are blocked.
- **Main-process checks** run first with `realpath`/`lstat`. A move is rejected for any of these:
  - a symlink below the root
  - a source or target outside the root
  - a different device (cross-device move)
  - an existing destination
  - a document from the source subtree open in *another* window
  - an open document already at the destination
- **Commit sequence:**
  1. Main shows a confirmation that mentions the directory's contents.
  2. Right before calling `fs.move`, it re-checks the inode and device, closing the TOCTOU window.
  3. On success the tree reveals and selects the destination. On failure the root is rescanned.

**Context menus** (`desktop/renderer/src/contextMenu/sideBar/`)
- File or folder: New File, New Folder | Copy, Cut, Paste (disabled when the clipboard is empty) | Rename, Move to Trash | Copy Path, Show in Folder.
- Root: New File, New Folder, Paste | Copy Path, Show in Folder | Remove Folder (removes it from the sidebar only).
- An unavailable root shows Retry instead of the creation items.

**Keyboard and selection**
- Keys: `F2`/`Enter` rename, `Delete` trash, `Esc` cancels and clears the selection. Root rows also accept `Enter`/`Space` to toggle and `ContextMenu` or `Shift+F10` to open their menu.
- **There is no arrow-key row navigation.** This is a gap mininote should fill.
- The *selected* row (`activeItem`, background tint) is tracked separately from the *current* note (2 px accent bar plus colored text).
- A single click selects and opens. A double click pins the preview tab and focuses the editor.

**Expand and collapse**
- New folders start collapsed. The root starts expanded.
- Folds are persisted per root as relative paths and restored.
- The collapsed flag lives on the tree *node*, not in the component, because switching sidebar panels remounts the tree (#5631).
- Right after a session restore, auto-reveal does not expand anything, so the user's deliberate folds survive. Normal reveal behavior resumes after the user switches documents (`restoringSession`).

**Auto-reveal of the active note** (`tree.vue` `revealPath`, `desktop/renderer/src/util/revealTreeRow.ts`)
- **Trigger:** a change of the active document, or any tree update while the folder is still loading incrementally.
- **Action:** expand the note's ancestors. Scroll only if the row is *not fully visible*, and then center it, following VS Code's `relativeTop = 0.5`.
- An explicit "Reveal in sidebar" request keeps retrying through tree updates until the user navigates elsewhere.

**Visual metrics:** rows are 30 px high with 14 px text, indent is `depth*6+15` px, and the current note gets a 2 px bar. An "Opened files" list (resizable, with Save All and Close All) sits above the tree. That list is clutter for us.

## 3. Editor

### 3.1 Engine model
- Muya keeps a **block tree** (paragraph, heading, list, list-item, table, code, math, diagram, html, front matter) as JSON state. Each leaf block is a contenteditable region whose inline tokens are re-rendered with snabbdom (`muya/editor/index.ts`, `muya/block/`).
- **Transactions:** mutations from one frame are batched and committed together. `muya.flush()` must run before persisting or switching documents. The desktop exposes this as the `flush-active-editor` bus event (`desktop/renderer/src/store/editor.ts` `flushActiveEditor`). Without it, an edit made in the same frame as a save was lost (#3803, #2938).
- **Output:** after every committed change the desktop rebuilds the **entire Markdown string** from state, plus the outline and word count (`components/editorWithTabs/editor.vue`, the `json-change` handler).
- **Normalization on save:** because the file is regenerated, the saved text can differ from what the user typed. Nested list indentation follows the `listIndentation` preference, for example. This is the main reason we chose CodeMirror 6 over a structural editor.
- **Undo:** entries within 1000 ms are grouped, with a 100-entry stack. Word boundaries and switches between insert and delete start new groups (`muya/history/index.ts`). Undo history is kept per tab.

### 3.2 Markdown flavor
- **Spec conformance:** CommonMark 0.31 plus GFM 0.29, tracked by fixture suites with a locked expected-failure list (`packages/muya/test/spec/`).
- **On by default:** tables, task lists, `~~strike~~`, extended autolinks, `$…$`/`$$` math (KaTeX), emoji `:shortcodes:`, rendered (sanitized) HTML, and front matter (`---` YAML, `+++` TOML, or JSON).
- **Opt-in:** footnotes, `==highlight==`, `^sup^`/`~sub~`, GitHub alerts (`> [!NOTE]`), the `>>>` multiline blockquote, inline diff, and pandoc "fancy lists".
- **Diagrams:** fenced `mermaid`, `plantuml` (rendered by a remote server), `vega-lite`, `flowchart` and `sequence` blocks.
- **Not supported:** wikilinks, embeds, Obsidian callouts (beyond GitHub alerts), tags, block references.
- **CJK emphasis** (`cjkEmphasis`, default **on**; `muya/utils/delimiters.ts`, `muya/utils/inlineCharacters.ts`)
  - When deciding left- and right-flanking delimiter runs, a CJK character counts as a boundary, the same way punctuation and whitespace do.
  - This lets a bold, quoted Hangul word be followed immediately by a Korean particle. Strict CommonMark rejects this because the closing delimiter run sits between punctuation and a letter.
  - The CJK character class covers Hangul syllables (U+AC00–D7AF) but *not* conjoining Jamo. NFD text would therefore lose the benefit.
- **Heading slugs** are Unicode-aware: lowercase, keep letters, marks, digits and connector punctuation, turn whitespace into `-`, and collapse repeated dashes. Korean headings keep their anchors (#5292; `muya/utils/slug.ts`).

### 3.3 Live preview: what is hidden and when it appears (`muya/inline/renderer/index.ts` `getClassName`)
- **Reveal rule:** an inline token's markers are shown dimmed (`mu-gray`) when the caret's anchor *or* focus lies within the token's range, *boundaries included*, and only inside the block that holds the caret. Otherwise the markers are hidden (`mu-hide`).
- **Read-only mode:** all markers are hidden.
- **Hiding technique** (`muya/assets/styles/inlineSyntax.css`)
  - Markers are hidden as zero-size *inline* text (`font-size:0; white-space:nowrap`), not as `inline-block` boxes.
  - Atomic inline-blocks create a line-break opportunity, which pushed punctuation after a link onto its own line (#2258, #3025).
  - HTML entities show their glyph through `::before` and take the literal text out of flow.
- **Blocks:**
  - A thematic break draws a dashed line unless it is active.
  - Code fences show a language input.
  - Math, diagram and HTML blocks show a rendered preview and switch to source while active.
  - Tables are edited as real tables with toolbars.
  - Task checkboxes are widgets.
  - Images render inline and show their syntax when the caret is on them.

### 3.4 Block transforms
- Typing a block prefix converts the paragraph immediately (`#`, `-`, `1.`, `>`, `[ ]`).
- **Enter** on a paragraph that matches a full-line pattern converts it (`muya/block/content/paragraphContent/index.ts` `matchBlockConversion`):
  - ```` ``` ````/`~~~` + info → code block
  - `$$` → math block
  - `| a | b |` → table
  - `<div>` → HTML block
  - `> [!TYPE]` → alert
- With CodeMirror 6 these conversions are unnecessary. The text simply stays as typed.

### 3.5 Lists, Enter and Tab (`paragraphContent/index.ts` `_enterInListItem`, `tabHandler`; `muya/block/listOperations.ts`)
- **Enter in a non-empty item:** split at the caret into a new sibling item. A new *task* item is always unchecked.
- **Enter in an empty item exits the list:**
  - The only item → the list becomes a paragraph.
  - The first item → a paragraph is inserted before the list.
  - The last item → a paragraph is inserted after the list.
  - A middle item → **the list is split into two**, with a paragraph between them.
- **Empty paragraph inside a multi-paragraph item:** a new item is created below it. Splitting at index 0 is avoided because it left a childless item that broke arrow navigation (#4644).
- **Blockquote:** Enter on an empty paragraph moves it out of the quote, splitting the quote if needed.
- **Shift+Enter** inserts a soft line break.
- **Tab** at offset 0 of an item indents it, but only when a previous sibling exists. **Shift+Tab** outdents.
  - When the caret sits right before closing inline markers (`**`, `` ` ``, `]`…), Tab *jumps past them*.
  - In all other positions Tab inserts `tabSize` spaces (default 4).
- **Task checkbox** clicks toggle `[x]`. With the `autoCheck` option, the change cascades to child items and parents are re-derived (`muya/block/gfm/taskListCheckbox/index.ts`).

### 3.6 Auto-pairing (`muya/block/base/content.ts`)
- Separate switches control brackets, quotes and Markdown markers. All three default to on.
- **When a pair is inserted:**
  - only when the caret is at the end of the line or before whitespace (typing `"` in front of `foo` gives `"foo`, not `""foo`)
  - never after a backslash
  - never inside inline code or math
- Typing a closing character over an auto-inserted one overtypes it. Backspace removes both characters of an empty pair.
- Typing `* ` inside `**` drops the second `*` so the line becomes a bullet.
- With a selection, typing a pair character wraps the selection. Modifier keys and IME composition bypass this.

### 3.7 Paste and drop (`muya/clipboard/`, `desktop/renderer/src/components/editorWithTabs/editor.vue` `imageAction`)
- **URL over a selection** (`pasteUrl.ts`): pasting one http(s) URL while a *non-empty, single-line* selection exists produces `[selection](url)`. Conditions:
  - The selection must not cut through tokens other than whole or inner-content emphasis, strong, strikethrough or mark.
  - Brackets and backslashes in the label get escaped. Parentheses and `|` in the URL get escaped.
  - Without a selection, the URL is pasted as plain text and renders as an extended autolink.
- **HTML paste** is converted with turndown (plus the GFM plugin) into Markdown, then into blocks. `Cmd+Shift+V` pastes plain text.
- **Image paste or drop** (`pasteImage.ts`, `desktop/renderer/src/util/fileSystem.ts`)
  - A `![](loading-…)` placeholder is inserted first, then replaced once the host's `imageAction` resolves.
  - What happens is set by `imageInsertAction`:
    - `path` (default): keep the original path.
    - `folder`: copy into a global images folder, or into a *relative* directory (`assets` by default, `${filename}` placeholder supported) next to the note or at the root.
    - `upload`: send to a configured uploader.
  - Copied images are named by the SHA-1 of their bytes, so pasting the same picture twice reuses one file.
  - Clipboard bitmaps arrive as `data:` URLs and are converted to files first.
  - An untitled note has no directory for relative assets, so the user is asked to save it first (`desktop/renderer/src/services/imageDrop.ts`).
- **Files dropped on the window:** Markdown files open in the app; other formats go through the pandoc import dialog (`pages/app.vue`).

### 3.8 Find and replace (`muya/search/index.ts`)
- Find in the current document (`Cmd+F`) supports case, whole word and regex. Replace works one at a time or all at once, and regex replacements support capture groups.
- Searching unfolds folded heading sections. Results refresh when the document changes.

### 3.9 IME and composition (`muya/editor/index.ts`, `muya/block/base/content.ts`)
- The selection at `compositionstart` is saved and reused for the transaction that `compositionend` commits.
- Enter, Backspace, Delete, arrows and Tab do nothing while `isComposed` is set.
- `compositionend` invokes the input handler directly, because the final composed text may not produce its own `input` event.
- **Chromium workaround** (#3468): composing at the end of a block that ends with `\n` overwrote the newline and lost the first keystroke. Muya seeds a zero-width-space text node as a temporary anchor and removes it again on `compositionend`.
- Sidebar search ignores Escape when `isComposing` is true or `keyCode === 229`. Name inputs commit on `keypress.enter`, which does not fire for the IME's own Enter keydown.

### 3.10 Keyboard shortcuts (`desktop/main/keyboard/keybindings{Darwin,Windows,Linux}.ts`)
- **Highlights on macOS:**

| Group | Shortcuts |
|---|---|
| Files and windows | `Cmd+S` save, `Cmd+Shift+S` save as, `Cmd+N` new window, `Cmd+T` new tab, `Cmd+W` close tab |
| Navigation and panels | `Cmd+P` quick open, `Cmd+Shift+P` command palette, `Cmd+J` sidebar, `Cmd+K` outline |
| Search | `Cmd+F` find, `Cmd+Option+F` replace, `Cmd+Shift+F` find in folder |
| Blocks | `Cmd+1..6` heading level, `Cmd+0` paragraph, `Cmd+=`/`Cmd+-` heading up/down |
| Inline formats | `Cmd+B/I/U`, `Cmd+D` strikethrough, `Cmd+L` link, `Ctrl+Cmd+C` inline code (`` Cmd+` `` is left free for window cycling), `Shift+Cmd+H` highlight |
| Tabs | `Ctrl+Tab`/`Ctrl+Shift+Tab` cycle, `Ctrl+1..0` jump to a tab |
| Modes | `Ctrl+Cmd+R` reading mode, `Cmd+Option+S` source mode, `Cmd+Shift+J` focus mode |

- **Per-platform rules:**
  - Pure `Option` chords are avoided on macOS because they type characters.
  - `Ctrl+Alt` is avoided on Windows because it equals AltGr. For that reason heading shortcuts are unbound on Windows.
  - Redo is `Ctrl+Y` on Windows and `Cmd+Shift+Z` on macOS.
- **Implementation** (`shortcutHandler.ts`)
  - Shortcuts are registered per `BrowserWindow` through electron-localshortcut, with a keyboard-layout-aware key mapper (native-keymap) so non-US layouts work.
  - The app menu's own accelerators are disabled with `setIgnoreMenuShortcuts`.
- **User overrides** live in `keybindings.json`. An empty string unbinds a command. Invalid accelerators are skipped. A duplicate inside the user file rejects the whole file. A user binding that collides with a default unbinds the default.

### 3.11 Modes
- **Reading mode:** per tab and read-only. All markers are hidden, unsaved text stays in memory and autosave pauses. `defaultOpenMode=read` opens files this way, and so does `--read-only`.
- **Focus mode:** top-level blocks fade to opacity 0.25, except the active one.
- **Typewriter mode:** keeps the caret centered.
- **Source mode:** CodeMirror 5 with `viewportMargin: Infinity`, which means no virtualization, and no list continuation.
- **Heading folding:** affects the view only, and the fold state is saved per document.

## 4. Persistence

### 4.1 Autosave (`desktop/renderer/src/store/editor.ts` `HANDLE_AUTO_SAVE`)
- **Off by default.** `autoSaveDelay` defaults to **5000 ms**, with a minimum of 1000 ms.
- **Timing:** a *trailing* debounce per tab that restarts on every change, with **no max-wait**. Continuous typing therefore never saves.
- **Skipped** for untitled notes, read-only tabs, tabs switching mode, and tabs in **disk conflict**. Autosave never silently overwrites an external edit.
- **Cancelled** when the tab closes, when reading mode turns on, and on a clean external reload.
- **Not triggered** by blur or by switching tabs. Each tab keeps its own timer.

### 4.2 Crash-recovery checkpoints (`desktop/renderer/src/services/windowSession.ts`, `desktop/main/applicationState/{checkpointService,storage,atomicJsonFile}.ts`)
- **What is sent:** every change schedules a checkpoint, debounced by **250 ms**. It contains:
  - the full Markdown of each changed document, with a monotonically increasing revision per document
  - the window layout, tree folds and per-document view state
- **Storage:** main writes `recovery/<win>/<doc>.json` plus `application-state.json` with `write-file-atomic` (mode `0600`). Writes go through a promise queue so they never overlap.
- **Storage failure:** a file that cannot be parsed becomes *read-only*, which protects the original from being replaced. The user sees "Keep this window open and save your documents".
- **Tombstones:** "Don't save" writes a `discarded` record and a completed save writes a `saved` record. Neither can be resurrected after a crash. Records are deleted only after the metadata commit succeeds.

### 4.3 The save path (`desktop/main/applicationState/sessionHost.ts` `saveDocument`, `desktop/main/filesystem/{markdown,index,documentWrites}.ts`)
1. **Flush and checkpoint.** The renderer flushes pending engine edits and checkpoints. Main queues saves *per document* and captures an immutable snapshot: text, format and disk baseline.
2. **Baseline check.**
   - If the path exists, main hashes the current disk bytes with SHA-256 and compares them with the baseline from the last load or save.
   - On a mismatch it shows a modal: "file exists, Replace? (default Cancel)".
   - Autosave uses the same path. If the watcher has not reported the external change yet (it waits about 1 s, §4.5), **autosave can open this modal**. That is a race to avoid.
3. **Encoding.** The text is encoded with iconv (with an optional BOM) and decoded again to verify the round trip. If characters cannot be represented, the save is refused with an error listing up to 8 of them. Line endings are converted from LF to CRLF when needed.
4. **Durable atomic write.**
   - `write-file-atomic` writes a uniquely named temp file next to the target, calls fsync, renames it over the target, keeps the mode and owner, and writes through symlinks.
   - The fsync matters: without it, a power loss left zero-filled files (#3786, #3828).
   - A missing parent directory is recreated (#3509), but `mkdir` is skipped when the parent exists, because Windows returns EPERM for existing drive roots like `E:\` (#5150).
5. **Windows rename race.**
   - Windows refuses `MoveFileEx(REPLACE_EXISTING)` while *any* handle is open on the target, and MarkText's own watcher stats the file.
   - Saves are retried on `EPERM`/`EACCES`/`EBUSY` with delays of **50, 75 and 50 ms**, which add up to 50/125/175 ms offsets.
   - The offsets are chosen to land on different phases of the watcher's 100 ms and 150 ms periods. Longer backoff measured *worse* (#5322).
6. **After the write.**
   - Main computes a new baseline (sha256, size, mtime), registers the self-write with the watcher, and updates the recent-documents list.
   - The renderer receives `savedMarkdown` and sets `isSaved = (currentText === savedMarkdown)`, so typing during the save stays dirty.
- **Write epochs** (`DocumentWriteCoordinator`): each document has an epoch. Toggling read-only, or a move barrier, bumps it, and queued writes from an older epoch are dropped. Moves wait for in-flight writes to finish.

### 4.4 Encoding and line endings (`desktop/main/filesystem/encoding.ts`, `markdown.ts`; `desktop/renderer/src/util/markdown.ts`)
- **Detection order:**
  1. a BOM (UTF-8, UTF-16BE/LE)
  2. *strict* UTF-8 validation (fatal `TextDecoder`, and no NUL bytes)
  3. the `ced` detector, whose `KSC`/`ISO-2022-KR` results map to `euckr`
- Validating UTF-8 first exists because `ced` sometimes guessed GBK for valid UTF-8 (#3151).
- **Line endings:** text is always LF internally. The detected ending (LF or CRLF) is restored on save. Mixed endings are normalized, with an info notice.
- **Trailing newline policy** (`trimTrailingNewline`): 0 trims all, 1 keeps exactly one, 2 (default) auto-detects. On load, mode 2 records whether the file ended with 0, 1 or 2 newlines, and that shape is preserved.

### 4.5 External modifications (`desktop/main/filesystem/watcher.ts`, `desktop/renderer/src/store/editor.ts` `LISTEN_FOR_FILE_CHANGE`/`loadChange`)
- **Watching:** each open file gets a chokidar watcher with `awaitWriteFinish` (stability **1000 ms**, poll **150 ms**), so a half-written file is never read (GH#1043). Directory watchers do *not* wait; that delay made new files appear about 1 s late (GH#3955).
- **Reading:** main reads and decodes the changed file. A per-path read sequence drops results that arrive out of order.
- **What the renderer does:**

| Situation | Behavior |
|---|---|
| Text identical to the buffer (e.g. a git checkout) | Nothing (#1861). A "missing" mark is cleared. |
| Buffer clean | Reload silently. Scroll is kept, the pending autosave is cancelled, and the reload is recorded as **one undoable step**: the first undo restores the pre-reload text. |
| Buffer dirty | Set `diskConflict` and show the bar "X has been changed on disk. Reload?" with OK (reload) and ✕ (keep mine). The next save then shows the Replace modal. |
| File deleted (`unlink`) | Set `diskMissing`, mark unsaved, show a warning bar. |

- **Linux atomic saves:** editors like vim save by renaming, which detaches the inotify watch from the old inode. After a raw `rename` event, MarkText re-adds the watch after **150 ms** if the file still exists (chokidar#591).
- **inotify limit:** `ENOSPC` triggers a one-time warning, and the root is marked unavailable.

### 4.6 Ignoring self-generated events (`watcher.ts` `ignoreChangedEvent`/`_shouldIgnoreEvent`, `windowManager.ts`)
- **Time window:** after a save, the next `add`/`change` event for that path in that window is ignored if it arrives within **1300 ms** (stability plus two poll intervals).
- **mtime fallback:** if the event is later and the watcher is not polling, main stats the file and still ignores the event when the file's mtime falls within that window of the save. Cloud drives that deliver events late or re-sync produced exactly this case (GH#3044).
- **One-shot:** an ignore entry is consumed by its first matching event.
- The content-equality check in the renderer (§4.5) is the final, and most robust, guard.

### 4.7 Close and quit (`desktop/main/applicationState/closeCoordinator.ts`)
1. **Checkpoint.** Every affected window checkpoints. Main waits up to **10 s** for the renderer.
2. **Ask.** If anything is dirty, one dialog per window offers **Save / Don't Save / Cancel**. Read-only documents label the button differently.
3. **Re-verify.** After the dialogs, everything is checkpointed again. If any dirty revision changed while a dialog was open, the close is aborted.
4. **Commit and destroy.** Windows close only after a successful commit.
- Closing a tab follows the same steps for the selected documents.
- On non-mac platforms the app quits when the last window closes. On macOS it stays alive.

## 5. Navigation and search

**Quick open, `Cmd+P`** (`desktop/renderer/src/commands/quickOpen.ts`)
- **Empty query:** recent files (removable) followed by open tabs.
- **Typed query:**
  - After a **300 ms** debounce, the query becomes a case-insensitive regex. `*` acts as a wildcard and every other special character is escaped.
  - Recents are matched on the basename first, then on the full path. A query containing a path separator matches full paths only.
  - Vault files come from `rg --files` with `--iglob '*<query>*.<ext>'` for each Markdown extension. That is a **contiguous substring match, not fuzzy**, and results are unranked, in arrival order.
  - The search stops after **30** paths with an info toast.
- Results are grouped as "Recently opened" and "Files", and labeled `root / relative/path`.

**Command palette** (`Cmd+Shift+P`): plain substring filter on command descriptions.

**Find in folder, `Cmd+Shift+F`** (`desktop/main/ipc/ripgrep.ts`, `components/sideBar/search.vue`, `searchResultItem.vue`)
- **Execution:** main spawns ripgrep once per root with `--json`. Defaults are `--fixed-strings` and `--ignore-case`.
- **Options:**
  - case, whole word and regex toggles (`--multiline` is added when the regex contains `\n`)
  - exclusion globs, maximum file size, hidden files, `--no-ignore`, and follow symlinks (default on)
  - `.gitignore` is respected by default, which can hide notes from search
- Only Markdown globs are included.
- **Streaming:** results arrive per file, using rg's `begin`/`match`/`end` events.
- **Offsets:** ripgrep reports *UTF-8 byte* offsets. They are converted to JS string offsets whenever a line contains multi-byte characters. Without this, Korean highlights land in the wrong place.
- **Limits:** the search is capped at **100 files** with a "search limited" message. A cancel control appears after **500 ms**.
- **Triggering:** the search reruns on *every keyup*, cancelling the previous run, with no debounce. It also reruns when roots change.
- **Results:**
  - Grouped per file. A file is expanded when it has 20 or fewer matches.
  - 10 matches show at first, and "more" adds 15 at a time (`Cmd`/`Ctrl`+click shows all).
  - Each line preview is trimmed to about 6 characters before the match.
  - Clicking a match opens the note, or switches to it, and selects the match range.

**Tabs** (`components/editorWithTabs/tabs.vue`, `contextMenu/tabs/`)
- **Preview tabs** (`openFilesInPreviewMode`, default on): a single click in the sidebar opens a reusable tab with an *italic* title. The next sidebar click replaces it, but only if it is still clean. Editing or double-clicking pins it.
- **Mouse:** tabs reorder by drag, and a middle click closes. An unsaved tab shows a 6 px dot that turns into the close button on hover.
- **Context menu:** Close, Close Others, Close Saved, Close All, Rename, Copy Path, Show in Folder, Show in Sidebar.
- **Size and layout:** tabs are 28 px high with 12 px text and a maximum width of 280 px. The active tab scrolls into view. **The tab bar is hidden by default.**
- **Untitled tabs** are numbered `Untitled-N`.

**History:** there is no back/forward navigation.

**Outline** (`components/editorWithTabs/outline.vue`, `desktop/renderer/src/util/findActiveHeading.ts`)
- A separate column on the left or right, resizable from 180 to 600 px (default 220).
- When collapsed, hovering its icon shows a floating preview.
- The active heading is the last heading whose top is at or above the caret, or 80 px below the scroll top.

## 6. Links
- **Not present:** wikilinks, backlinks, unresolved-link detection, and link rewriting on rename. A rename relocates only open tabs.
- **Following links** (`desktop/renderer/src/store/editor.ts` `FORMAT_LINK_CLICK`, `desktop/main/menu/actions/file.ts`, `desktop/main/filesystem/index.ts` `resolveLocalLinkTarget`)
  - **How:** `Cmd`/`Ctrl`+click in edit mode, a plain click in reading mode.
  - **`#anchor`:** scrolls to the heading whose GitHub slug equals the percent-decoded anchor. If none matches, it falls back to any element with that `id`.
  - **Web URLs:** `http(s)` opens in the system browser. Other `scheme://` URLs are ignored.
  - **Local targets:**
    - Only the link target is percent-decoded, never the note's directory (which may legally contain `%`). Malformed `%` sequences are used as written (#4749).
    - `#frag` is split off unless the whole string names an existing file (`C#.md`).
    - Markdown files open in the app at the anchor.
    - Other files open through the OS. **Executable extensions ask for confirmation first** (#3575); the list covers Windows, macOS and Linux launchers, and trailing dots and spaces are stripped before the check.
  - **Spaces:** a link containing raw spaces shows an error explaining `%20` and `<./My Link.md>`.
- **Image paths** autocomplete in the image popup, using fuzzaldrin over a directory listing.

## 7. Rendering and typography

**Pipelines**
- **Editing and reading:** the same Muya DOM. Reading mode is that DOM with every marker hidden.
- **Export** (`muya/state/markdownToHtml.ts`, `muya/utils/sanitizeExportHtml.ts`, `muya/config/index.ts`): marked, then DOMPurify, then github-markdown-css with KaTeX and Prism.
- **DOMPurify settings:** HTML, SVG and SVG-filter profiles on; MathML off; `contenteditable` forbidden; data attributes off except `data-align`. The export profile also allows `file:` URIs so Windows images survive (#1997).

**Typography defaults** (`muya/assets/styles/{index,blockSyntax,inlineSyntax}.css`)

| Element | Value |
|---|---|
| Base text | 16px, line-height 1.6, Open Sans stack, then Noto Music / Noto Sans Math (offline glyph fallbacks) |
| h1…h6 | 1.875 / 1.5 / 1.375 / 1.25 / 1.125 / 1em; bold; line-height 1.4 |
| Inline code | 0.8em, padding .2em .4em, radius 3px, 3% black background |
| Code block | 90% size (`codeFontSize` 14px on desktop), padding 1em, 1px border, radius 3px, line-height 1.6; optional line numbers and wrapping; hover copy button |
| Blockquote | `padding: 0 30px`, 2px bar drawn at 15px from the left, muted color |
| Lists | `padding-inline-start: 30px`; bullets cycle disc → circle → square |
| Thematic break | 2px dashed border |
| Table cells | 6px 13px |
| Editor column | `max-width` 750px on desktop (800 in Muya), configurable as ch, px or %; padding `0 50px 100px 74px` (the left gutter holds the block handle and fold/copy-link controls); 20px top |

- **Task checkbox centering:** the checkbox is positioned with `calc(line-height × 0.5 × font-size − 7px)` using the *CSS variables* rather than `em`, because Chromium freezes `em` inside `<input>`.

**Vertical rhythm: per-element margins plus margin collapsing.** This is the approach mininote rejects. MarkText sets:

| Element | Margin |
|---|---|
| `p, blockquote, ul, ol, table` | `0.5em 0` |
| Headings | `1rem 0`. **`rem` is the root's 16px**, so heading spacing does not scale with the editor font-size preference while paragraph spacing does. |
| Code blocks | only `margin-top: 1.5em`. The bottom falls back to the browser's UA `pre` margin (1em), so spacing is asymmetric. |

The approach then needs patch rules to repair the edges:
- tight lists remove `p` margins
- nested lists get no margin
- a list that is the first or last child loses its top or bottom margin
- figures inside blocks get zeroed margins

Export uses github-markdown-css, which is again a per-block `margin-bottom` with first/last-child resets. For reference, the gaps MarkText actually produces at 16px:

| Pair | Gap |
|---|---|
| p → p | 8px |
| p → h* and h* → p | 16px (collapsed) |
| p → code | ≈21.6px |
| code → p | ≈14.4px |
| tight list items | 0 |

That set is a useful baseline when tuning mininote's pair table: `* + *`, `h2 + p` and so on (see `docs/DESIGN.md` §3).

## 8. Performance
- **Initial scan:** every Markdown file's *full content* is read and decoded during the directory scan. The code marks this as a known hack, and it ships the content over IPC one message per file even though the tree only uses metadata. Opening a large vault therefore costs O(total bytes).
- **macOS polling:** chokidar is forced into **polling** on macOS (a legacy fix, #1418/#1430) and on UNC paths. The default polling interval is 100 ms, so CPU use grows with vault size.
- **Tree:** in-place mutations of a reactive tree, plus a `treeVersion` counter so watchers notice. There is no virtualization, but collapsed folders render no children, which keeps the DOM close to the visible rows.
- **Editor:** every block is rendered, with no virtualization. Each change batch regenerates the full Markdown, the outline and the word count. A 250 ms checkpoint then sends the full text to main, which writes it to disk with fsync.
- **Search:** there is no index. Every query spawns a ripgrep process, and quick open spawns `rg --files`.
- **Startup:**
  - The window is created hidden, with `backgroundColor` set to the theme's background (from a table of theme colors), so there is no white flash.
  - Only the essentials (theme, code font, title-bar style, user-data path) are passed in the URL query. The full preferences load later.
  - The window is shown once the renderer reports it is initialized.
  - On Linux, the first window waits for `nativeTheme.updated` or 150 ms.

## 9. Platform and desktop
- **Window chrome** (`desktop/main/config.ts`, `desktop/main/windows/editor.ts`, `components/titleBar/index.vue`)

| Item | macOS | Windows / Linux |
|---|---|---|
| Window frame | `titleBarStyle: 'hiddenInset'`, frameless | `titleBarStyle=custom` (default): frameless, with HTML min/max/close controls; `native`: OS frame |
| Title-bar height | 21 px | 32 px |
| Double-click title area | Toggles zoom, reimplemented by hand because the window is frameless | n/a |
| Window title | `file - folder` | `file - folder - MarkText`, so taskbars can identify the app |

  - Drag regions use `-webkit-app-region`.
  - The minimum window size is 550×350 and the default is 1200×800.
  - Zoom ranges from 0.5 to 2.0 in steps of 0.125.
- **Geometry restore** (`desktop/main/applicationState/windowGeometry.ts`)
  - **Saved:** `normalBounds`, the maximized flag and the display id.
  - **Restored:** fitted to the display with the most overlap. The size is clamped to the work area (minimum 550×350) and the position is clamped inside it.
  - **macOS:** while a window is zoomed, macOS can report stale normal bounds, so the previous bounds are reused.
  - **Writes:** debounced by 200 ms, plus an immediate write on `resized`.
- **Single instance**
  - `requestSingleInstanceLock` passes argv as `additionalData`, because Electron reorders argv and that split `--user-data-dir <dir>` (#3020).
  - A second instance's paths open in the best-scoring window, or in a new window with `--new-window`.
- **Menus:** the full app menu has File, Edit, Paragraph, Format, Window, View and Help. On Windows/Linux the custom title bar has a hamburger button that pops up the same menu.
- **Paths**
  - **Separators:** the renderer uses a real win32 path implementation on Windows instead of a POSIX shim, so the whole app shares one path representation (#5683).
  - **Same-file test:** `isSamePathSync` normalizes first and returns false immediately when the lengths differ. Strings equal except for case are confirmed with an inode check over a synchronous IPC call.
  - **No Unicode normalization anywhere:** an NFD Hangul path (from HFS+, zip files, or some sync tools) never equals its NFC twin. Tab lookups fail ("Cannot find tab for path") and external changes are missed.
- **Security:** navigation, `window.open` and `<webview>` are all blocked. The renderer is sandboxed with context isolation, HTML is rendered through DOMPurify, and HTML rendering can be turned off.
- **Theme following:** `nativeTheme.updated` switches between the configured light and dark themes (`followSystemTheme`).

## 10. Settings and defaults
Source: `desktop/shared/preferences/schema.json`, overridden by the bundled `packages/desktop/static/preference.json`. *Effective* defaults are shown.

| Key | Default | Notes |
|---|---|---|
| `autoSave` / `autoSaveDelay` | false / 5000 ms | minimum 1000 |
| `fontSize` / `lineHeight` | 16 / 1.6 | ranges 12–32 / 1.2–2 |
| `editorFontFamily` / `codeFontFamily` / `codeFontSize` | Open Sans / DejaVu Sans Mono / 14 | |
| `editorLineWidth` | "" (750px) | accepts `ch`, `px` or `%` |
| `tabSize` / `listIndentation` | 4 / 1 | indentation options: `dfm`, `tab`, 1–4 |
| `bulletListMarker` / `orderListDelimiter` / `preferLooseListItem` / `preferHeadingStyle` | `-` / `.` / true / atx | |
| `autoPairBracket` / `autoPairMarkdownSyntax` / `autoPairQuote` | true / true / true | |
| `endOfLine` / `defaultEncoding` / `autoGuessEncoding` / `trimTrailingNewline` | default / utf8 / true / 2 | |
| `cjkEmphasis` / `texMathDollars` / `isHtmlEnabled` | true / true / true | other syntax extensions are off |
| `fileSortBy` / `fileSortOrder` | created / asc | the schema says modified |
| `treePathExcludePatterns` / `searchExclusions` | [] / [] | |
| `startUpAction` | restoreAll | plus the three restore toggles, all true |
| `openFilesInPreviewMode` / `autoRevealInSidebar` / `openedFilesInSidebar` | true / true / true | |
| `theme` / `followSystemTheme` | light / true | about 30 bundled themes |
| `titleBarStyle` | custom | |
| `imageInsertAction` / `imageRelativeDirectoryName` | path / `assets` | |
| `watcherUsePolling` | false | forced to true on macOS and UNC paths |
| Layout defaults | | sidebar *hidden*, 280px (min 220, max viewport−320); outline visible, 220px; tab bar *hidden*; minimum editor width 320px |

## 11. Implications for mininote (Tauri 2 + Svelte 5 + CodeMirror 6)
- **Watcher in Rust:**
  - Use `notify` with a debouncer and native FSEvents on macOS, never polling.
  - Build the initial tree with a parallel directory walk that reads *metadata only*, and send it as one batched message.
  - Exclude dot-entries and `node_modules` by default.
  - Normalize every path to NFC before it enters the tree or any map.
- **Saves:**
  - Write a `tempfile` in the same directory, then `sync_all`, then `persist`.
  - Retry `PermissionDenied` on Windows with staggered short delays.
  - Keep `lastWrittenSha256` for each path, and drop any watcher event whose fresh hash equals it. This is more reliable than a time window.
- **Autosave:** always on. Use an idle debounce of a few hundred ms with a max-wait, and flush synchronously on note switch, window blur and quit. Never open a modal from autosave: a baseline mismatch becomes a conflict state with a non-modal bar.
- **External changes:** same matrix as §4.5. In CodeMirror 6, apply a clean reload as a single transaction tagged with an `addToHistory` annotation, so one undo step reverts it.
- **Editor:**
  - Replicate the reveal rule: markers stay visible while the caret touches the token, boundaries included, in the caret's block only.
  - Implement CJK-friendly emphasis. `@lezer/markdown` follows strict CommonMark flanking, so it needs a custom emphasis resolver or post-pass. The reading view should use a markdown-it CJK-friendly plugin so both views agree.
  - Never act on Enter or Tab while `view.composing` is true.
- **Tree UX:**
  - Copy the rename and create state machine (§2) and the auto-reveal centering rule.
  - Add arrow-key navigation, which MarkText lacks.
  - Validate names: no `/`, `\`, `:` or the Windows-reserved characters, and no trailing dots or spaces.
  - Allow case-only renames.
- **Quick switcher:** an in-memory fuzzy match over the indexed file list, with recents first. No subprocess.
- **Full-text search:** run it in Rust (the `grep-*` crates or a simple scan) and return UTF-16 offsets for the webview.
- **Vertical rhythm:** keep the sibling-pair gap table. MarkText's margin approach shows the edge cases it avoids: collapsing, UA `pre` leaks, and mixed `rem`/`em` units.

### Appendix: constants worth reusing

| Constant | Value | Where |
|---|---|---|
| Watcher write stability / poll | 1000 / 150 ms | `desktop/main/filesystem/watcher.ts` |
| Self-write ignore window | 1300 ms | same |
| Linux rename re-watch | 150 ms | same |
| Atomic-rename retry delays (Windows) | 50, 75, 50 ms | `desktop/main/filesystem/index.ts` |
| Recovery checkpoint debounce | 250 ms | `desktop/renderer/src/services/windowSession.ts` |
| Close-checkpoint timeout | 10 s | `desktop/main/applicationState/sessionHost.ts` |
| Geometry write debounce | 200 ms | same |
| Undo grouping / stack | 1000 ms / 100 | `muya/history/index.ts` |
| Quick-open debounce / cap | 300 ms / 30 | `desktop/renderer/src/commands/quickOpen.ts` |
| Find-in-folder cap / cancel delay | 100 files / 500 ms | `components/sideBar/search.vue` |
| Drag hover expand / edge zone / scroll step | 700 ms / 32 px / 8 px per frame | `components/sideBar/useTreeDragDrop.ts` |
| Copy-name suffix limit | 99 | `desktop/renderer/src/store/project.ts` |
| macOS open-file coalescing | 100 ms | `desktop/main/app/index.ts` |
| State cache limits | 50 workspaces, 100 files, 2000 folds | `desktop/shared/types/applicationState.ts` |
