# Obsidian baseline: functional requirements and proven techniques for mininote

Research only. Obsidian is closed source, so this baseline is reconstructed from two public repositories:

- `obsidian-help` (official help vault: `en/**` pages plus 341 files under `Release notes/`). No license file; content belongs to Dynalist Inc. Everything below is paraphrased.
- `obsidian-api` (public TypeScript typings `obsidian.d.ts`, v1.14.4, MIT, Copyright 2022 Dynalist Inc.). Used only as architecture inspiration; no code is copied.

Evidence notation used throughout:

- `H:<page>` = `obsidian-help/en/<page>.md` (e.g. `H:Files and folders/Manage notes`)
- `RN:vX.Y.Z` = `obsidian-help/Release notes/vX.Y.Z.md`
- `API:<line>` = `obsidian-api/obsidian.d.ts` line number

Release notes are the most valuable source: they record edge cases Obsidian actually hit and fixed. When a behavior appears only as a bug fix, the fix tells us the intended behavior.

---

## 0. Top takeaways for mininote

1. **Autosave contract.** Obsidian's text view debounces saves by 2 s (`API:9858`). It flushes pending changes when a file is unloaded (`API:9871-9876`). On quit it waits for in-flight saves and filesystem operations (`RN:v1.3.2`, `RN:v1.7.2`, `RN:v1.13.5`). mininote wants "saved as you type", so use a shorter trailing debounce (400-800 ms) with a max-wait cap, and keep the same flush points.
2. **External edits are merged, not discarded.** If a file changes on disk while unsaved edits exist (inside the 2 s window), Obsidian merges both versions (`RN:v0.11.6`). Undo history survives file switches for the last 20 files, but is dropped if the file changed externally (`RN:v0.13.16`).
3. **Autosave race history.**
   - Two overlapping autosaves once blanked a note (`RN:v0.6.2`).
   - The last typed characters were lost on large files (`RN:v0.9.12`).
   - After a failed open, the previous note's buffer could be saved into the new file (`RN:v0.11.6`).
   - Switching files mid-rename renamed the wrong file (`RN:v1.0.1`).
   - Fix: serialize writes per file, and bind every save to the file identity captured at edit time.
4. **Save failures must surface.** A notice appears (`RN:v0.7.5`, USB drive ejected case), and a copy goes to File Recovery (`RN:v0.14.0`). Even a minimal UI needs an error indicator.
5. **Unicode paths.**
   - `normalizePath` converts slashes, trims slashes, maps NBSP/NNBSP to a space and applies **NFC** (`API:6705-6721`).
   - All Vault APIs normalize their inputs (`RN:v0.9.11`).
   - Accented and CJK filenames caused macOS trouble (`RN:v0.7.0`).
   - Hangul NFD names from macOS are a must-handle case.
6. **Sorting** is case-insensitive, accent-insensitive and natural-numeric ("1, 2, 10") (`RN:v0.8.15`). This is an `Intl.Collator` with `numeric: true, sensitivity: 'base'`.
7. **Name validation.**
   - Trim leading/trailing spaces (`RN:v1.1.13`).
   - Forbid a leading `.`, which would hide the file (`RN:v0.14.0`).
   - Link-breaking characters `# | ^ : %% [[ ]]` only warn (`RN:v1.11.0`, `H:Linking notes and files/Internal links`).
   - An invalid name shows an error and keeps the editor open (`RN:v1.4.15`).
   - The collision check is case-insensitive (`RN:v0.10.0`).
   - Case-only renames are a known trap (`RN:v0.4.1`, `RN:v1.7.2`).
8. **Delete** goes to the OS trash by default, with vault `.trash` and permanent delete as alternatives. Confirmation is on by default (`H:Files and folders/Manage notes`, `RN:v0.1.0`, `RN:v0.6.6`). If system trash fails, fall back to local trash (`API:3318-3331`).
9. **Live Preview reveal rules.**
   - Syntax is hidden except where the selection touches the construct.
   - Heading `#` shows on the cursor line; empty headings keep `#`.
   - Escapes are hidden off-line.
   - Hiding applies only while the editor has focus (`RN:v0.13.1`, `RN:v0.13.9`, `RN:v0.14.11`, `RN:v0.13.20`).
   - Decorations should not flip during a mouse drag-select (`API:5705`, `RN:v0.13.4`).
10. **IME bugs are common.** Obsidian shipped more than 15 IME fixes: cursor jumps, duplicated characters, characters placed behind the cursor, stray newlines before tables, and Enter-to-confirm during composition. All of them target Chromium (Electron). mininote runs on WKWebView (macOS) and WebKitGTK (Linux) as well, so these must be re-verified there.
11. **Links.**
    - Default is the "shortest unique path" format (`RN:v0.8.0`): file name if unique, else the full path (`API:6484-6493`).
    - Resolution is "best match" relative to the source (`API:6448-6460`).
    - Rename rewrites links using cached source positions; Obsidian switched parsers for this (`RN:v0.8.5`).
    - Ambiguous names upgrade to absolute links (`RN:v0.8.3`).
12. **Quick switcher.**
    - Empty query lists recent files.
    - Enter creates a note when nothing matches; Shift+Enter forces creation; Mod+Enter opens in a new tab.
    - Tab completes a path segment (`RN:v1.6.0`).
    - Word-start matches rank higher (`RN:v1.14.3`).
13. **Search.**
    - Terms are ANDed; `OR`, `-neg`, `"phrase"`, `/regex/` and operators are supported.
    - Korean uses character (substring) matching rather than word matching (`RN:v0.11.1`).
    - Results are virtualized (`RN:v0.8.0`).
    - Markdown files larger than 2 MB are not indexed (`RN:v1.6.0`).
14. **Spacing evidence.** Release notes repeatedly fix per-element margin bugs:
    - Tables stuck together (`RN:v0.8.10`).
    - Extra list/sub-list gap (`RN:v1.3.7`).
    - Missing space after blockquotes (`RN:v1.12.0`).
    - Missing margins inside embeds (`RN:v1.8.0`).
    - Theme margins breaking editor selection (`RN:v0.13.9`).
    - This supports mininote's sibling-pair spacing model, and a rule of no margins on CodeMirror lines.
15. **Desktop chrome.**
    - Frameless/hidden title is the default, and macOS traffic lights are offsettable (`RN:v0.16.0`, `RN:v1.12.0`).
    - Single instance: a second launch re-opens the starter (`RN:v1.12.1`).
    - Off-screen windows are restored to the main display (`RN:v0.11.10`).
    - Local images load through an `app://<random-id>/` scheme (`API:7104-7111`), the analogue of Tauri's asset protocol.

---

## 1. Architecture inspiration: Obsidian's data model (obsidian-api)

### 1.1 Module map

`App` owns `vault`, `workspace`, `metadataCache`, `fileManager`, `keymap` and a root `scope` (`API:1326-1410`). It also exposes:

- `lastEvent`, the last user event, so commands can read modifier keys.
- `loadLocalStorage` / `saveLocalStorage`, a localStorage namespaced per vault (`API:1398`).

The README summarizes the split: Vault = files, Workspace = panes, MetadataCache = parsed per-file metadata (`obsidian-api/README.md`). The desktop app is Electron; mobile is Capacitor (`Platform`, `API:7041-7111`).

### 1.2 Files: Vault vs DataAdapter

**Two-layer design.**

- `Vault` (`API:10182`) is a high-level, in-memory model.
- `DataAdapter` (`API:3181`) is low-level and path-based.
- `FileSystemAdapter` (desktop) and `CapacitorAdapter` (mobile) implement the adapter.

**Model objects.**

- `TAbstractFile` has `{vault, path, name, parent}` (`API:9694`).
- `TFile` adds `stat: {ctime, mtime, size}` in ms, plus `basename` and `extension` (`API:9926`, `API:4470`).
- `TFolder` has `children` and `isRoot()` (`API:9953`).
- The whole tree is in memory (`getAllLoadedFiles`, `getAllFolders`, `recurseChildren`).

**Vault operations.**

- Lookup is vault-relative and **case-sensitive** (`getAbstractFileByPath`, `API:10222-10236`).
- `create` throws if the file exists.
- `read` hits disk, while `cachedRead` serves display.
- Write operations: `modify`, `append`, `process` (atomic read-modify-write with a synchronous callback, `API:10382`), `copy`, `rename` (no link update), `delete(force)` and `trash(file, system)`.
- Events are `create | modify | delete | rename(oldPath)`.
- `create` also fires for every existing file during vault load. Listeners that only want new files must register after layout-ready (`API:10427-10433`).

**Adapter operations.**

- `exists(path, sensitive?)` has an explicit case-sensitivity flag because the filesystem may be case-insensitive (`API:3203`).
- `stat` returns `{type, ctime, mtime, size}`, and `list` is non-recursive.
- `write` overwrites or creates.
- `trashSystem` returns `false` when the OS trash is unavailable; `trashLocal` moves into `.trash` at the vault root (`API:3313-3331`).
- `rmdir(path, recursive)`, and `copy` fails if the target exists.
- `DataWriteOptions` lets the caller set `ctime`/`mtime` (`API:3368-3386`). Obsidian preserves timestamps explicitly; this matters when atomic writes reset birth time.
- Desktop adds `getBasePath`, `getFullPath`, `getFilePath` (a `file://` URL) and a recursive static `mkdir` (`API:4492-4640`).

### 1.3 FileManager: the policy layer (`API:4363-4463`)

FileManager applies user preferences on top of raw Vault operations:

- `getNewFileParent(sourcePath)`: where new notes go.
- `renameFile`: move/rename, then update links per preference.
- `promptForDeletion` and `trashFile`: trash per preference.
- `generateMarkdownLink(file, sourcePath, subpath, alias)`: wikilink vs Markdown and shortest/relative/absolute.
- `processFrontMatter`: an atomic YAML edit that throws on parse errors.
- `getAvailablePathForAttachment(filename, sourcePath)`: creates the parent folder and de-duplicates the name.

**Lesson:** keep raw fs operations (Rust) separate from policy (TS service).

### 1.4 MetadataCache: the derived index (`API:6446-6531`, `API:2391-2548`)

`CachedMetadata` per file contains:

- `links`, `embeds`, `tags` and `headings` (level 1-6).
- `footnotes`, `footnoteRefs` and `referenceLinks`.
- `sections`: root-level blocks typed `blockquote | callout | code | element | footnoteDefinition | heading | html | list | paragraph | table | text | thematicBreak | yaml` (`API:8181-8192`).
- `listItems`: the task character (space means not done, any other character means done), plus `parent` = the parent item's line. For root items, `parent` is the negative line of the list's first item (`API:5604-5628`).
- `frontmatter`, `frontmatterPosition`, `frontmatterLinks`, and `blocks` keyed by `^id`.

Every item carries `position {start, end}` with `{line, col, offset}`, all 0-based (`API:5743-5760`, `API:7555`).

Graph maps:

- `resolvedLinks[source][dest] = count`
- `unresolvedLinks[source][linktext] = count`

Events are `changed(file, data, cache)`, `deleted(file, prevCache)`, `resolve(file)` and `resolved()`. `changed` is **not** emitted on rename, for performance; consumers must also listen to the vault `rename` event (`API:6508-6516`).

### 1.5 Workspace, leaves, views and history

**Workspace** (`API:10659`) is a tree of splits, tab groups and leaves:

- `getLeaf(false | 'tab' | 'split' | 'window')` and `openLinkText(linktext, sourcePath, newLeaf, state)`.
- `getLastOpenFiles()` returns the **10** most recent files (`API:10994`).
- `requestSaveLayout` is a debouncer (`API:10724`).
- Events:
  - `file-open`
  - `active-leaf-change`
  - `editor-change`
  - `editor-paste` / `editor-drop` (check `defaultPrevented`, call `preventDefault` when handled)
  - `quick-preview` (the active file changed but is not saved yet, `API:11021`)
  - `quit(tasks)`: best effort; async cleanups are queued on `Tasks` (`API:11124`, `API:9765`, `RN:v0.10.2`).

**Leaf** (`API:11200`):

- `getViewState` / `setViewState` hold persistent state, separate from **ephemeral** state such as scroll and cursor.
- Leaves can be pinned and linked into groups.
- Background tabs are **deferred**: not instantiated until shown (`API:11255-11265`, `RN:v1.7.2`).

**View** (`API:10460`):

- A `navigation` flag says whether the view can be navigated.
- `setState(state, result)` with `result.history = true` pushes onto that tab's history (`API:10538-10556`, `API:10645-10650`).

### 1.6 Editor-side API

`TextFileView` (`API:9843-9921`):

- Holds the in-memory `data`.
- `requestSave` is **debounced by 2 seconds**.
- `onUnloadFile` saves unsaved changes before switching.
- `setViewData(data, clear)`: when `clear` is set, a different file is loading, so undo history and caches must be reset.
- The default saves only on close. Autosave works by calling `requestSave()` on every change.

`Editor` (`API:3652-3910`) is a CodeMirror-agnostic facade:

- Positions are `{line, ch}`.
- `transaction`, `processLines(read, write)` and `wordAt`.
- `exec('swapLineUp' | 'indentMore' | 'toggleFold' | 'foldAll' | …)`.

CodeMirror 6 hooks:

- `editorInfoField` and `editorLivePreviewField` (`API:3931-3943`).
- `livePreviewState.mousedown`, true while the left button is held for drag-select (`API:5693-5705`).

`EditorSuggest` (`API:4078-4205`):

- `onTrigger` runs on every keypress, so it must return `null` fast.
- It returns `{start, end, query}` and has a `limit`.

`Keymap` / `Scope` (`API:5443-5550`, `API:8010-8040`):

- Scopes form a stack.
- `Mod` maps to Meta on macOS and Ctrl elsewhere.
- `isModEvent` maps Mod-click or middle-click to a new tab, Mod+Alt to a split, and Mod+Alt+Shift to a window.

### 1.7 Rendering API (`API:5862-6110`)

Reading view renders **per section**:

- Post-processors receive one section element at a time, ordered by `sortOrder`.
- The context exposes `sourcePath`, `frontmatter` and `getSectionInfo(el)`, which returns `{text, lineStart, lineEnd}`.
- `MarkdownRenderChild` components unload automatically when their element is replaced after an edit.
- `MarkdownPreviewView.rerender(full?)` re-renders only the changed parts (`API:5999`).

Utilities:

- `sanitizeHTMLToDom` (`API:8003`)
- `htmlToMarkdown` for paste (`API:5295`)
- `getFrontMatterInfo` returns `{exists, frontmatter, from, to, contentStart}` (`API:4849-4875`, `API:5060`)

### 1.8 Utilities worth mirroring

- `debounce(cb, ms, resetTimer)` returns a debouncer with `cancel()` and `run()`, where `run()` flushes now (`API:3436-3480`). Flush-now is exactly what save-on-switch needs.
- `prepareFuzzySearch` (warning: slow if run "more than a few thousand times") vs `prepareSimpleSearch` (space-separated words) (`API:7565-7584`).
- Results are `{score, matches: [from, to][]}`, highlighted with `renderMatches` / `renderResults` (`API:8085-8100`, `API:7780-7811`).
- `stripHeading` normalizes a heading for anchor matching: punctuation removed, whitespace collapsed (`API:9527-9536`). `stripHeadingForLink` removes characters that break links (`# | ^ : %% [[ ]]`, CR/LF) when *generating* a heading link (`API:9539-9547`).
- `parseLinktext('a#b')` returns `{path: 'a', subpath: '#b'}`, and `getLinkpath` drops the subpath (`API:5083-5093`, `API:7000-7020`).

### 1.9 Proposed mininote mapping

| Obsidian | mininote (Tauri 2 + Svelte 5) |
|---|---|
| `DataAdapter`/`FileSystemAdapter` | Rust `vault` module: scan, read, atomic write, rename, trash, watcher, normalization |
| `Vault` + `TFile`/`TFolder` tree | Svelte `$state` store built from the Rust scan. Key = NFC vault-relative path; keep the on-disk name separately |
| `FileManager` | TS service: new-note location, rename plus link rewrite, trash policy, link generation |
| `MetadataCache` | TS index (worker if needed): headings, links, tags, resolved/unresolved maps |
| `TextFileView.requestSave` | Per-document save controller with debounce, `run()`-style flush, and a serialized queue |
| Leaf state / ephemeral state | Per-tab `{path, history[], index}`; per-file `{cursor, scroll}` cache |
| `Keymap`/`Scope` | Small keybinding layer with Mod mapping; modal scopes for switcher and rename |

---

## 2. Vault and workspace

- **What a vault is.** Any folder, including subfolders. The user either picks an existing folder or creates a new one (name plus parent location) (`H:Getting started/Create a vault`).
- **Vault switcher.** A list of known vaults with these actions:
  - Rename (renames the folder) and Move.
  - Remove from list (does not delete files) (`H:Files and folders/Manage vaults`).
  - Keyboard commands "Change vault…" and "Open vault…" (keeps the current vault open) (`RN:v1.12.0`).
- **Per-vault config.** Lives in `.obsidian/` at the vault root, hidden by the OS. It can be renamed (must start with `.`) (`H:Files and folders/Configuration folder`). It holds hotkeys, appearance, plugins and `workspace.json`. The latter is rewritten every time a file opens, and the docs suggest git-ignoring it (`H:Files and folders/How Obsidian stores data`).
- **Global data.** Stored in the OS app-data folder:
  - macOS: `~/Library/Application Support/obsidian`
  - Windows: `%APPDATA%\Obsidian\`
  - Linux: `$XDG_CONFIG_HOME/obsidian`
  - It holds the vault list and File Recovery snapshots. Snapshots are keyed by absolute path, so they break if the vault moves (`H:Plugins/File recovery`).
  - The metadata cache persists in IndexedDB, with a manual "Rebuild vault cache" (`H:…/How Obsidian stores data`, `RN:v1.6.5`).
  - Each folder gets a random 16-character vault ID (`H:Extending Obsidian/Obsidian URI`).
- **Restore.**
  - Previously open vaults re-open on restart (`RN:v0.10.0`).
  - The active pane, window size and pop-out positions are restored (`RN:v0.11.11`, `RN:v0.10.2`, `RN:v0.15.3`).
  - The tab layout persists (`H:User interface/Tabs`).
  - "Default file to open" can be: last opened files / new note / specific note / daily note (`RN:v1.11.0`).
- **Device vs vault scope.** Font size is per device and not synced (`H:User interface/Settings`). Zoom is per vault (`RN:v0.14.7`).
- **Guardrails.**
  - No vaults inside vaults, because links become ambiguous.
  - Never put a vault inside the app-data folder (`H:…/How Obsidian stores data`).
  - Symlinks: loops are rejected; targets must be disjoint from the vault and from each other; cross-device moves are not handled; file symlinks are not watched (`H:Files and folders/Symbolic links and junctions`).
- **Live reload.** Config files changed on disk are reloaded live (`RN:v0.13.3`, `RN:v1.6.0`).
- **Single files outside a vault** were added late (v1.14, `TExternalFile`, `API:9830`). Out of scope for us.

**mininote decision:** keep per-vault UI state (open tabs, expanded folders, per-file cursor/scroll) in the app data dir, keyed by a hash of the canonical vault path. Writing a dot-folder into the user's notes adds clutter and git churn. Keep a recent-vaults list. Debounce layout saves the way `requestSaveLayout` does.

---

## 3. File tree (File explorer)

**What is listed.**

- Markdown plus accepted formats (`H:Files and folders/Accepted file formats`):
  - Images: avif, bmp, gif, jpeg/jpg, png, svg, webp
  - Audio: flac, m4a, mp3, ogg, wav, webm, 3gp
  - Video: mkv, mov, mp4, ogv, webm
  - Documents: pdf, plus canvas and base
- Unknown extensions are hidden unless "Show all file types" is on (`H:User interface/Settings`, `RN:v0.10.10`).
- Dot-files and dot-folders (config folder, `.trash`) are hidden, and keyboard navigation skips hidden items (`RN:v0.16.0`). Hidden unsupported files once glitched the tree (`RN:v0.11.8`), and shift-select once grabbed hidden files (`RN:v0.12.0`). Operate only on visible rows.
- Each row carries `data-path` for CSS (`RN:v0.10.5`). Hover shows ctime/mtime (`RN:v0.10.3`). Long names do not wrap; a tooltip shows the full name (`RN:v0.4.1`).

**Sort.**

- Options: name A→Z / Z→A, modified new→old / old→new, created new→old / old→new (`H:Plugins/File explorer`).
- The comparator is case-insensitive, accent-folded and natural-numeric (`RN:v0.8.15`).
- Under modified-time sort, the list re-sorts when files change (`RN:v0.10.12`). The sort choice is saved in the layout (`RN:v1.10.0`).
- *Folders-first ordering is the observed convention but is not stated in the docs.*

**Create.**

- Toolbar "New note" goes to the default location; "New folder" goes to the root. The folder context menu offers "New note" / "New folder" inside it. The name is typed inline and committed with Enter (`H:Plugins/File explorer`).
- The default name is "Untitled" (`H:Extending Obsidian/Obsidian CLI`). The collision check must be case-insensitive (`RN:v0.10.0`).
- New notes always open in edit mode (`RN:v0.10.1`).
- Typing `Folder/Page` in the quick switcher creates the folders too (`RN:v0.4.1`, `RN:v0.11.2`).

**Rename (inline).**

- Start: context menu "Rename…", F2 on the focused row, or Enter on macOS (OS convention) (`RN:v1.3.2`). For the active note: F2 or click the title (`H:Files and folders/Manage notes`).
- The whole name is pre-selected (`RN:v0.7.4`).
- Clicking inside the field must not cancel (`RN:v1.7.0`, `RN:v0.8.10`).
- Esc cancels and keeps tree focus (`RN:v1.13.0`). Auto-reveal is suppressed while renaming (`RN:v1.13.0`).
- No ellipsis while editing (`RN:v1.7.0`), and spellcheck is on (`RN:v1.3.1`).
- Validation:
  - Trim spaces (`RN:v1.1.13`).
  - Block a leading `.` (`RN:v0.14.0`).
  - Control characters must not crash (`RN:v0.8.5`).
  - Link-unsafe characters warn only (`RN:v1.11.0`).
  - Invalid names show an error and keep editing (`RN:v1.4.15`).
  - Duplicates warn (`RN:v0.0.2`).
  - A failed rename must not report success (`RN:v1.2.7`).
- IME: Enter during composition must not commit (`RN:v0.9.20`). Non-English keyboard characters were once misread as illegal (`RN:v0.12.7`).
- Case-only renames duplicated entries on Windows (`RN:v0.4.1`). Moving into a folder holding a same-name, different-case file failed (`RN:v1.7.2`).
- Renaming keeps the scroll position (`RN:v1.1.6`) and updates links automatically, or prompts (`H:Linking notes and files/Internal links`).

**Delete.**

- Confirmation is optional and on by default (`RN:v0.1.0`).
- Destination: system trash (default) / vault `.trash` / permanent (`H:Files and folders/Manage notes`, `RN:v0.6.6`). There is a "Show trash" command (`RN:v1.5.0`), and folder names must not gain a trailing `.` in `.trash` (`RN:v1.1.0`).
- Optional deletion of attachments: Always / Ask / Never (`RN:v1.12.0`).
- If an open tab showed the deleted file and has history, it falls back to the previous file instead of closing (`RN:v1.3.4`). Multi-select delete/move is available from the context menu (`RN:v0.14.11`).

**Move.**

- Drag onto a folder. Alt/Opt-click toggles selection; Shift-click selects a range (`H:Plugins/File explorer`, `RN:v0.10.0`). Alt-click adds the previously active item (`RN:v1.12.0`).
- "Move file to…" opens a fuzzy folder picker (`RN:v0.9.21`).
- While dragging, collapsed folders auto-expand (`RN:v1.8.0`), and the list auto-scrolls near the edges (`RN:v0.9.21`, `RN:v1.14.2`).
- Files moved into a collapsed folder are deselected (`RN:v1.8.1`).
- External files dropped anywhere import a copy into the folder under the cursor (`RN:v1.5.0`). Invalid characters are stripped from imported names (`RN:v1.11.0`). Conflicting folder names are suffixed (`RN:v1.6.4`).
- Copy/paste with Mod+C/V (`RN:v1.12.0`). "Duplicate" exists; folder names containing `.` were an edge case (`RN:v1.12.3`).

**Context menu (desktop).**

- File items: open in new tab / to the right / new window; Duplicate; Move file to…; Bookmark; Merge; Copy path (Obsidian URL, vault-relative, absolute); Open in default app; Reveal in Finder / Show in system explorer; Rename…; Delete.
- Folder items: New note, New folder; Duplicate; Move folder to…; Search in folder; Copy path; Reveal; Rename…; Delete (`H:Plugins/File explorer`).
- Right-clicking empty tree space opens a menu (`RN:v1.8.0`).

**Keyboard.**

- Arrow keys move; F2 renames; Space opens. On macOS, Enter renames and Cmd+↓ opens (`RN:v1.3.2`).
- Esc clears the selection (`RN:v1.13.0`). The root cannot be collapsed by keyboard (`RN:v1.0.1`).
- Arrow keys with modifiers must not be captured, so editor shortcuts keep working (`RN:v1.1.0`).

**Expand/collapse state.**

- Persisted per vault (`RN:v0.11.0`). Restore bugs recurred (`RN:v1.2.4`, `RN:v1.5.1`, `RN:v1.6.2`); write it eagerly.
- Expand all / Collapse all; an "Auto-reveal active file" toggle (`RN:v1.8.2`); a "Reveal file in navigation" command (`RN:v0.8.5`).

**Performance history.**

- Big-vault lag (`RN:v0.9.18`, `RN:v0.13.32`).
- High CPU with many expanded items (`RN:v0.15.2`), later improved (`RN:v1.8.8`).
- Drag lag (`RN:v1.6.4`).
- Virtualize the flattened visible rows from day one.

---

## 4. Editor

### 4.1 Markdown flavor (`H:Editing and formatting/Obsidian Flavored Markdown`, `H:…/Basic formatting syntax`, `H:…/Advanced formatting syntax`)

The base is CommonMark plus GFM plus LaTeX. The table below lists the extensions and rules.

| Feature | Rule |
|---|---|
| Highlight | `==text==`. Optional color emoji right after `==` (v1.14) |
| Strikethrough | `~~text~~` |
| Comment | `%%inline%%` or a block starting at line start. Fence is exactly two `%` (`RN:v1.13.2`). An unclosed block hides the rest of the note in reading view |
| Task | `- [ ]` / `- [x]`. Any character inside the brackets means done (`RN:v0.12.0`). Only `x` is struck through (`RN:v0.14.0`) |
| Lists | `-`, `*`, `+`; ordered `1.` or `1)`. Any type nests in any other. Escape a period with `1\.` |
| HR | 3+ `*`, `-` or `_`; spaces allowed |
| Code | Fences of 3+ backticks or tildes, nested by a longer fence or a different character; indented code. Highlighting uses Prism in reading view and CodeMirror in the editor |
| Tables | GFM. Outer pipes optional; at least two hyphens per delimiter cell; colon alignment. Escape `\|` inside cells for aliases or sizes. Single-column tables (`RN:v1.4.3`). Allowed right after a heading (`RN:v1.3.6`) |
| Images | `![[img.png\|100x145]]` or `\|100` (width keeps aspect). `![alt\|100](url)`. `![200](url)` (`RN:v1.13.2`) |
| Links/embeds | `[[note]]`, `[[note#h]]`, `[[note#^id]]`, `[[note\|text]]`, `![[note]]`, block id `^id` |
| Callouts | `> [!type] Title`; `+`/`-` makes it foldable; nestable; type is case-insensitive; unknown types fall back to `note`. 13 types plus aliases (`H:…/Callouts`) |
| Footnotes | `[^id]` plus a definition; continuation lines indented 2 spaces. Inline `^[…]` works in reading view only |
| Frontmatter | YAML (JSON accepted, saved as YAML). Must start at line 1 (`RN:v1.4.6`). Types: text, list, number, checkbox, date, datetime, tags |
| Tags | `#tag`: letters, digits, `_`, `-`, `/` (nested), Unicode and emoji. Needs at least one non-digit. Case-insensitive. No spaces |
| HTML | Sanitized. **No Markdown inside HTML blocks.** An HTML block ends at a blank line (`H:…/HTML content`) |
| Line breaks | Default non-strict: a single newline renders as a break. "Strict line breaks" opts into spec behavior (`H:…/Basic formatting syntax`) |
| Math | `$…$` and `$$…$$`. `$10` must not open math (`RN:v0.13.9`). Out of scope |

### 4.2 Views and modes (`H:Editing and formatting/Views and editing mode`)

- **Reading view** vs **Editing view**. Editing has two modes: Live Preview (default) and Source.
- Ctrl/Cmd+E toggles reading/editing. A command toggles Live Preview/Source. Mod-clicking the view switcher opens a side-by-side pair.
- Scroll position is preserved across switches (`RN:v0.8.1`).
- **Inline title:** the file name is shown as an editable heading-like title, but is not part of the file (`RN:v0.16.0`).
  - ↓ moves into the editor (or properties); ↑ on line 1 moves back to the title (`RN:v1.4.14`, `RN:v1.14.3`).
  - Enter/Tab commits the rename.
  - Editor commands are ignored while the title is focused (`RN:v1.0.1`).

### 4.3 Live Preview: what is hidden and when it is revealed

Baseline rule: formatting is shown, syntax hidden, and "when the cursor enters formatted content the syntax becomes visible" (`H:…/Views and editing mode`). The release notes refine this:

- **Inline marks** (`**`, `_`, `~~`, `==`, backticks, link brackets and URL) reveal while the selection is inside the span. A nested-expansion bug with math or images inside bold was fixed later (`RN:v1.13.2`). Formatting commands ignore surrounding whitespace in the selection (`RN:v0.13.9`).
- **Headings:** `#` is visible whenever the cursor is on the line (`RN:v0.13.1`). Empty headings keep `#` visible (`RN:v0.13.9`). Trailing `#` must parse (`RN:v1.6.1`). Selecting a heading must not grab the hidden `#` (`RN:v1.5.9`).
- **Escapes:** backslash escapes are hidden unless the cursor is on that line (`RN:v0.14.11`). Only special characters count as escaped (`RN:v1.7.2`).
- **Links:**
  - `[[#heading]]` hides the `#` to avoid confusion with tags (`RN:v0.13.10`).
  - Unresolved links render dimmer (`RN:v0.13.11`); external links get an icon (`RN:v0.13.1`).
  - Plain click opens a link (`RN:v0.13.25`); Mod+Alt+click edits it (`RN:v0.14.0`); middle-click opens a new tab (`RN:v0.13.11`).
- **Lists:**
  - The bullet is drawn as a dot, but the original character stays in the text and the dot is overlaid via `::after`, so width never jumps (`RN:v0.13.1`, `RN:v0.13.17`).
  - Ordered markers are right-aligned (`RN:v1.5.0`).
  - Task lines hide the bullet and show a checkbox widget (`RN:v0.13.1`). Clicking it toggles without moving the selection (`RN:v0.13.20`) and without unfolding (`RN:v1.6.0`).
  - Completed tasks are struck and greyed (`RN:v0.13.8`).
- **Block widgets:**
  - Horizontal rules (`RN:v0.13.1`); inline image embeds (`RN:v0.10.10`).
  - Tables: first a preview (`RN:v0.14.1`), later a full table editor (`RN:v1.5.0`).
  - Callouts; HTML blocks and iframes (`RN:v0.13.6`).
  - Code blocks styled when the cursor is outside, with a language label that copies on click (`RN:v0.13.6`, `RN:v0.13.18`) and a copy icon when there is no language (`RN:v1.1.14`).
  - Clicking a widget to edit scrolls to the widget's start (`RN:v0.16.0`). Up/Down must navigate around blocks sensibly (`RN:v0.13.8`).
- **Focus:** syntax hiding depends on editor focus (`RN:v0.13.20`). A blurred editor looks fully rendered.
- **Mouse:** expose a "mouse is down" state so reveal and hide does not reflow mid-drag (`API:5705`). Drag jumpiness was an early bug (`RN:v0.13.4`).
- **Styling:** margins added by themes broke CodeMirror selection (`RN:v0.13.9`). Empty duplicate `<span>`s around widgets broke padding and pseudo-elements (`RN:v0.13.20`).
- **Performance:**
  - Avoid "flashes of unstyled content" while scrolling large documents (`RN:v1.1.3`).
  - Keep cursor-move work cheap (`RN:v1.3.2`).
  - Never stop highlighting halfway down the document (`RN:v0.13.9`, `RN:v0.13.5`).
  - Large base64 images caused lag (`RN:v0.13.22`), as did very long lines (`RN:v0.12.5`).

### 4.4 Default keyboard shortcuts

Sources: `H:Editing and formatting/Editing shortcuts`, `H:User interface/Tabs`, plugin pages, and the release notes cited per row.

| Action | Win/Linux | macOS |
|---|---|---|
| New note | Ctrl+N | Cmd+N |
| Quick switcher | Ctrl+O | Cmd+O |
| Command palette | Ctrl+P | Cmd+P |
| Toggle reading/editing | Ctrl+E | Cmd+E |
| Search vault | Ctrl+Shift+F (selected text pre-fills) | Cmd+Shift+F |
| Find / Replace in file | Ctrl+F / Ctrl+H | Cmd+F / Cmd+Opt+F |
| Next / previous match | Ctrl+G / Ctrl+Shift+G (`RN:v0.13.20`); Shift+Enter in the find box (`RN:v1.1.0`) | Cmd+G / Cmd+Shift+G |
| New tab / close tab | Ctrl+T / Ctrl+W | Cmd+T / Cmd+W |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Tab 1-8 / last tab / reopen closed | Ctrl+1..8 / Ctrl+9 / Ctrl+Shift+T | Cmd+1..8 / Cmd+9 / Cmd+Shift+T |
| Back / forward | Ctrl+Alt+← / → (`RN:v0.5.0`) | Cmd+Opt+← / → |
| Rename active file | F2 | F2 |
| Bold / italic / insert link | Ctrl+B / Ctrl+I / Ctrl+K (`RN:v0.7.4`) | Cmd+B / Cmd+I / Cmd+K |
| Toggle checkbox | Ctrl+L (`RN:v1.0.0`) | Cmd+L |
| Open link under cursor in new tab | Ctrl+Enter (`RN:v1.0.0`) | Cmd+Enter |
| Paste as plain text | Ctrl+Shift+V | Cmd+Shift+V |
| Delete line (no selection) | Ctrl+Shift+K | Cmd+Shift+K |
| Copy / cut paragraph (no selection) | Ctrl+C / Ctrl+X | Cmd+C / Cmd+X |
| Redo | Ctrl+Shift+Z or Ctrl+Y | Cmd+Shift+Z |
| Extra cursor / rectangular select | Alt+click / Shift+Alt+drag or middle-drag (`H:…/Multiple cursors`) | Opt+click / Shift+Opt+drag |
| Indent / outdent | Tab / Shift+Tab | Tab / Shift+Tab |
| Font size | Ctrl+scroll (off by default, `RN:v1.5.4`) | Pinch (`RN:v0.12.2`) |

### 4.5 Lists, blockquotes, Enter and Tab ("Smart lists", default on)

**Enter in lists.**

- Enter continues the list marker, including `- [ ] ` (`RN:v0.5.0`). Enter on an empty item exits or outdents it.
- Escaping a sub-list with Enter twice renumbers the parent list (`RN:v1.1.13`).
- Auto-numbering stops at the end of the current list and never touches later lists (`RN:v0.13.19`).
- Toggling a numbered list numbers sequentially, in one undo step (`RN:v0.13.20`).
- If the text after the cursor already starts with a marker, do not insert a second one (`RN:v0.15.0`). The same applies when pasting a list item onto a line that already has a marker (`RN:v1.14.0`).
- Shift+Enter inserts a line break inside the item without a new marker (`H:…/Basic formatting syntax`).

**Indentation.**

- Tab / Shift+Tab indent or outdent the selected items (`H:…/Basic formatting syntax`).
- Indentation uses a tab character by default, otherwise 4 spaces (`H:User interface/Settings`).
- For list parsing a tab always counts as 4 columns, whatever its display width (`RN:v0.13.15`). The visual width is a separate setting (`RN:v1.8.0`).
- Past bugs:
  - Outdent leaving an extra space (`RN:v0.14.3`).
  - Converting numbered to bullet produced the text "undefined" (`RN:v0.9.12`, `RN:v0.13.20`).
  - Enter on an indented line lost the indent (`RN:v0.13.11`).

**Cursor keys.** Home and Cmd+← jump to the start of the item content, after the marker or checkbox (`RN:v0.16.0`, `RN:v0.16.3`, `RN:v1.1.0`).

**Blockquotes.** Enter on an empty quote line keeps the quote; Shift+Enter exits it (`RN:v0.13.27`). In a nested empty quote, Enter exits one level only (`RN:v0.13.3`).

**Other.**

- Auto-pair brackets and Markdown symbols (`$ = ~ %` and more) (`RN:v0.13.3`). Backspace removes both characters of a fresh pair (`RN:v0.13.8`).
- A "cycle bullet / checkbox / checked" command (`RN:v0.13.27`). Indentation guides (`RN:v0.14.0`).

### 4.6 Paste and drop

**Images and attachments.**

- A clipboard image becomes `Pasted image YYYYMMDDHHmmss.png` (14-digit timestamp, `RN:v0.8.15`) in the attachment folder, and an embed is inserted (`H:Editing and formatting/Attachments`).
- Browser "Copy image" imports the bytes rather than linking the URL (`RN:v0.12.5`).
- A file that is already inside the vault is linked, not duplicated (`RN:v0.14.3`).
- Attachment location (`H:…/Attachments`):
  - Vault root (default)
  - A specific folder
  - Same folder as the note
  - A named subfolder next to the note, created on demand
- Name de-duplication and parent creation as in `getAvailablePathForAttachment` (`API:4452-4462`).

**Drop.**

- OS files dropped into the editor are copied into the attachment folder and embedded. Holding Ctrl/Opt inserts a `file:///` link instead (`H:User interface/Drag and drop`, `RN:v0.11.3`).
- Explorer files dropped into the editor insert a link that respects the link-format preferences (`RN:v0.10.0`).

**URLs and HTML.**

- A URL pasted over a selection becomes `[selection](url)` (`RN:v1.11.0`), once per cursor with multiple cursors (`RN:v1.12.5`).
- HTML converts to Markdown on paste and drop (setting, default on; Mod+Shift+V bypasses) (`H:User interface/Settings`, `RN:v0.10.3`).
- HTML tables become Markdown tables (`RN:v1.3.0`), and `<style>` text is dropped (`RN:v0.10.9`).
- Copying from the editor also places HTML on the clipboard (`RN:v1.12.2`).

**Undo.** A paste must be a separate undo step; undoing a paste once also removed earlier typing (`RN:v0.12.14`).

### 4.7 Find/replace, multiple cursors, folding

- **Find in file** has Previous/Next, "Find all" (selects every match) and Replace / Replace all (`H:Editing and formatting/Find and replace`). Exiting find selects the last match (`RN:v0.14.11`).
- **Multiple cursors** come from Alt-click; Esc collapses them (`H:…/Multiple cursors`).
- **Folding:** headings and indented lists fold through a hover arrow (on by default) with Fold all / Unfold all commands (`H:…/Folding`). Fold state is persisted (`RN:v0.11.0`, `RN:v0.13.5`). Out of MVP.

### 4.8 IME and composition (Korean focus)

Fixes Obsidian shipped:

- Cursor jumping back with some IMEs in Live Preview (`RN:v0.13.31`).
- Duplicated characters on Windows/Linux (`RN:v0.13.32`) and on macOS (`RN:v0.13.11`).
- Characters inserted behind the cursor (`RN:v1.5.12`).
- Extra newline when typing on the line before a table (`RN:v1.5.9`).
- Broken IME on the line before a heading that starts with a space (`RN:v0.14.13`).
- Fold indicators moving while composing (`RN:v0.14.15`).
- IME popup positioned wrong for large headings (`RN:v0.9.15`, `RN:v0.10.0`).
- Enter used to confirm a candidate was treated as Enter in rename and prompts (`RN:v0.9.20`, `RN:v0.12.14`).
- iOS freeze when typing CJK (`RN:Mobile/v0.1.1`).
- Full-width `【【` treated as `[[` (`RN:v0.9.21`).

Korean-specific:

- Character matching for search and unlinked mentions (`RN:v0.11.1`).
- Word count counts Korean words rather than letters (`RN:v0.12.0`). Word count supports CJK (`H:Plugins/Word count`).
- The spellchecker splits words at CJK boundaries (`RN:v0.10.1`).

---

## 5. Persistence

**Autosave.**

- `requestSave` is debounced by 2 s (`API:9858`).
- Pending changes are saved before another file loads (`API:9871-9876`) and when closing or quitting. The app waits for the save (`RN:v1.3.2`) and for pending fs operations (`RN:v1.7.2`). Config writes are also awaited on quit to avoid corruption (`RN:v1.13.5`).
- Pop-out window close timing once skipped layout saves (`RN:v1.8.3`).
- The quit hook is best effort (`API:11120-11124`). Never rely on it alone; flush on blur and switch as well.

**Write path.**

- `Vault.process` / `DataAdapter.process` offer atomic read-modify-write for programmatic edits (`API:10382`, `API:3280-3295`). `DataWriteOptions` can preserve ctime and mtime (`API:3368`).
- *Undocumented:* whether user saves use temp-file-plus-rename. Recovery copies on failure (`RN:v0.14.0`) suggest defense in depth.
- Mobile once corrupted files larger than 5 MB on save (`RN:Mobile/v0.0.12`). Test large files.

**Failure handling.**

- A notice on save failure (`RN:v0.7.5`) and a recovery copy (`RN:v0.14.0`).
- An open that fails must not leave the old buffer bound to the new path (`RN:v0.11.6`).
- An error notice once named the wrong file (`RN:v0.14.0`). Carry the path with each save job.

**External modifications.**

- The vault auto-refreshes on external changes (`H:Files and folders/How Obsidian stores data`). Linux watching became recursive (`RN:v0.5.0`), the config folder is watched (`RN:v0.14.4`), and PDFs reload (`RN:v1.3.2`).
- With unsaved local edits, the disk and local versions are merged (`RN:v0.11.6`).
- Obsidian Sync documents the merge primitive it uses for Markdown: diff-match-patch. Other file types use last-modified-wins. An alternative mode writes `name (Conflicted copy <device> <YYYYMMDDHHMM>).md` (`H:Obsidian Sync/Troubleshoot Obsidian Sync`).
- An external change drops that file's undo history (`RN:v0.13.16`).
- Search, backlinks and graph refresh incrementally on vault changes (`RN:v0.8.10`, `RN:v0.8.11`).

**Self-event suppression** (ignoring watcher events caused by our own writes) is not documented. See technique T2.

**Safety net.** File Recovery takes snapshots at least 5 minutes apart and keeps them 7 days, stored outside the vault in global data. It restores only `.md`/`.canvas` and shows a diff (`H:Plugins/File recovery`). Edits made during the cooldown are retried later (`RN:v0.11.11`).

---

## 6. Navigation and search

### 6.1 Quick switcher (`H:Plugins/Quick switcher` plus release notes)

**Opening and results.**

- Mod+O opens it. Fuzzy matching takes letters in order, so `dn` matches "Daily notes". It matches names and aliases (`RN:v0.9.20`); alias rows show the real path (`RN:v0.9.21`).
- An empty query lists recent files, so Down+Enter toggles between two notes (`RN:v0.3.0`). Recents must include newly opened files (`RN:v0.6.5`).

**Keys.**

- Enter on no match creates the note. Shift+Enter creates even if something matches.
- Mod+Enter opens in a new tab; Mod+Shift+Enter creates in a new tab (`RN:v0.13.18`).
- Tab completes the next path segment (`RN:v1.6.0`). Page Up/Down and Home/End move through results (`RN:v1.2.0`).
- Esc restores the editor selection (`RN:v0.9.16`, `RN:v1.13.0`).

**Creation location.** New notes follow the "new note location" rule, including "relative to the current file" (`RN:v0.13.8`, `RN:v0.14.3`).

**Ranking.**

- Excluded files are down-ranked (`RN:v0.14.6`).
- Folder matches must not be punished much more than weak name matches (`RN:v0.12.6`).
- Word-start hits rank higher (`RN:v1.14.3`), and multi-word queries were improved (`RN:v1.12.0`).
- In vaults over 10k notes Obsidian used to fall back to a simpler algorithm (`RN:v0.12.0`). It later always uses fuzzy matching (`RN:v1.14.2`).

**Other.** Spellcheck is off in prompts (`RN:v1.7.0`). The switcher no longer reuses an existing tab (`RN:v0.16.2`).

### 6.2 Full-text search (`H:Plugins/Search`)

**Query syntax.**

- Space-separated words must all appear (AND). `OR`, parentheses, `-exclude`, `"exact phrase"` with `\"` escaping, and `/js-regex/`.
- Operators: `file:`, `path:`, `content:`, `match-case:`, `ignore-case:`, `tag:`, `line:`, `block:`, `section:`, `task:`, `task-todo:`, `task-done:`, and `[property:value]`. Operators are case-insensitive (`RN:v1.2.4`).
- Default is case-insensitive with a Match case toggle.

**Results UI.**

- Sort by name / modified / created.
- An empty box lists recent queries (`RN:v0.9.12`). Selected text pre-fills the query.
- Options: Explain search term, Collapse results, Show more context, Copy results. Options persist (`RN:v0.9.12`).

**Engine behavior.**

- Only rendered rows exist in the DOM (`RN:v0.8.0`).
- `file:`/`path:`-only queries skip reading content (`RN:v0.9.0`). Results update incrementally (`RN:v0.8.10`).
- The engine was once limited to 600 files/s before optimization (`RN:v0.8.3`) and was stress-tested at 10k files (`RN:v0.5.0`).
- It does not run while the pane is hidden (`RN:v0.13.7`).
- A file that fails to load must not hang search (`RN:v0.11.6`).

**CJK.**

- Chinese/Japanese exact match without spaces (`RN:v0.8.6`).
- Korean character-level matching for quoted searches (`RN:v0.11.1`).

### 6.3 History, tabs and outline

**History.**

- Each tab has its own back/forward history (`RN:v1.0.0`). Going back restores scroll and selection (`RN:v0.6.0`).
- Drag-to-open pushes history (`RN:v0.10.1`). Skipped or forgotten entries were recurring bugs (`RN:v0.12.4`, `RN:v0.6.7`, `RN:v1.7.3`).

**Tabs** (`H:User interface/Tabs`).

- Plain click navigates the current tab. Mod-click opens a new tab, Mod+Alt a split, Mod+Alt+Shift a window (`API:5487`).
- Pinned tabs open links elsewhere.
- Closing a pane focuses the most recently active one, not the leftmost (`RN:v0.10.3`).
- The layout persists across restarts. Background tabs are deferred (`RN:v1.7.2`).

**Outline** lists headings; a click navigates; dragging a heading moves its whole section; dropping a heading into the editor makes a heading link (`H:Plugins/Outline`, `RN:v0.13.5`).

---

## 7. Links

### 7.1 Formats (`H:Linking notes and files/Internal links`)

- **Wikilink:** `[[Note]]` or `[[Note.md]]`.
- **Markdown:** `[Note](Note%20name.md)` with URL-encoding, or `<…>` angle brackets.
- Non-Markdown targets need the extension (`[[fig.png]]`). Folder paths start at the vault root with `/`, even on Windows.
- A link to a missing note **with** a folder path creates the note at that path, not in the default location.

**Subpaths.**

- `#Heading`, nested `#H1#H2`, `#^blockid`. Block IDs use Latin letters, digits and `-`, and must follow a space at the end of the block. Structured blocks take the ID on its own line.
- In-note heading: `[[#`. Vault-wide heading search: `[[##`. Vault-wide block search: `[[^^`.

**Display text and aliases.**

- Display text uses `[[Note|text]]` or `[text](Note.md)`.
- Choosing an alias suggestion inserts `[[Real name|Alias]]` (`H:…/Aliases`).

**Wikilinks off.** With wikilinks disabled, `[[` autocomplete emits Markdown links instead.

**Characters that break links:** `# | ^ : %% [[ ]]`.

### 7.2 Resolution and generation

**New link format** (`H:User interface/Settings`, `RN:v0.8.0`):

- Shortest path when possible (default)
- Relative to the current file
- Absolute in vault

`fileToLinktext`: the file name if unique, otherwise the full path (`API:6484-6493`).

**Resolution.** `getFirstLinkpathDest(linkpath, sourcePath)` returns the "best match". Its example implies a source-relative match first, then any file whose path ends with the link path (`API:6448-6460`).

- *Observed but undocumented:* link matching ignores case and the `.md` extension. `getAbstractFileByPath` itself is case-sensitive (`API:10224`).

**Headings.** Heading matching normalizes punctuation and whitespace (`API:9527-9536`). Uppercase block IDs once failed to resolve (`RN:v0.14.0`, `RN:v0.10.9`); compare IDs case-insensitively.

### 7.3 Autocomplete

- `[[` opens fuzzy suggestions over files, aliases, headings and blocks (`RN:v0.6.0`). Selecting text and typing `[[` wraps it.
- The popup stays open even with no results, so Tab and Enter behave consistently (`RN:v0.11.4`).
- `#` and `|` do not accept the suggestion. Tab accepts first (`RN:v0.8.13`). Heading completion via `#` was restored for Markdown links (`RN:v0.8.14`).
- Pressing Tab inside `]]` must not insert an extra `]]` (`RN:v0.8.5`, `RN:v0.8.3`). Tab on a nested tag completes one segment at a time (`RN:v1.5.0`).
- Excluded files are down-ranked. Suggestions are sorted by best match (`RN:v0.9.8`).
- Attachments get no block suggestions (`RN:v0.9.20`).

### 7.4 Backlinks and unresolved links (`H:Plugins/Backlinks`, `H:Plugins/Outgoing links`)

- "Linked mentions" list files that link to this note. "Unlinked mentions" list plain-text occurrences of its name or aliases; one click converts a mention to a link, keeping the original casing (`RN:v0.13.20`) and the preferred format (`RN:v0.12.0`).
- Options: collapse, more context, sort, search filter, and "backlinks in document". The count appears in the status bar.
- Unresolved links get an `is-unresolved` class and render muted (`RN:v0.9.4`).
- Large vaults once lagged when switching files (`RN:v0.8.1`, `RN:v0.14.6`). Compute lazily and only while visible.

### 7.5 Rename → update links

- Setting "Automatically update internal links" is on by default; when off, the user is prompted (`H:…/Internal links`, `RN:v0.6.3`).
- Folder renames update links too (`RN:v0.8.3`).
- Rules (from fixes):
  - A rename that creates duplicate names upgrades affected links to absolute paths (`RN:v0.8.3`).
  - Markdown display text that equaled the old name follows the new name (`RN:v0.9.18`); likewise the wikilink alias (`RN:v1.2.1`).
  - Markdown links keep the `.md` extension (`RN:v0.9.18`) and do not over-encode (`RN:v0.12.4`).
  - Angle-bracket destinations survive (`RN:v1.7.0`). Display-text pipes inside tables stay escaped as `\|` (`RN:v1.6.4`).
  - Self-links `[[#h]]` stay as they are (`RN:v0.12.0`).
  - `$` in names broke replacement (`RN:v0.13.23`): a string-replace-pattern pitfall.
  - Open notes with links to the renamed file must update too (`RN:v0.6.6`).
- Rename heading and rename block ID also update references (`RN:v0.12.14`, `RN:v0.14.13`).
- Obsidian switched its parser to Remark to get exact link positions for rewriting (`RN:v0.8.5`). Renames were sped up for large vaults (`RN:v1.7.2`).

---

## 8. Rendering and typography

### 8.1 Reading-view pipeline

**Parser history.** markdown-it, then Remark, chosen for accurate source positions (`RN:v0.8.5`, which noted rendering changes because Remark was not fully CommonMark). mininote's markdown-it can still provide block line ranges through `token.map`.

**Section-based rendering.** Section-based post-processing with `getSectionInfo` line ranges, and partial `rerender` (`API:5862-6000`). Off-screen sections are virtualized; a fix stopped virtualization from dropping a live text selection (`RN:v0.8.13`). Large documents got much faster in reading view (`RN:v0.6.5`).

**Frontmatter.**

- Never rendered as YAML in reading view. A properties/metadata block shows instead (`RN:v1.1.3`).
- Invalid YAML shows an error state (`RN:v0.9.18`, `RN:v0.9.20`).
- Live Preview must not flash raw frontmatter while properties are being edited (`RN:v1.4.2`, `RN:v1.4.4`, `RN:v1.4.8`).

**Code blocks.**

- Prism highlighting in reading view; tabs preserved (`RN:v0.13.0`).
- Line wrapping matches the editor (`RN:v0.13.15`). A copy button is shown (`RN:v0.12.16`).

**Tasks.** Checkboxes toggle in reading view and write back to the file (`H:…/Basic formatting syntax`).

### 8.2 Sanitization and HTML rules

- All HTML is sanitized, for example scripts are removed (`H:Editing and formatting/HTML content`, `API:8003`).
- The first sanitizer broke table alignment and task checkboxes (`RN:v0.6.7`). The allowlist must keep `align`/`text-align` and `input[type=checkbox]`.
- Sanitizer speed mattered for large documents (`RN:v0.8.1`).
- HTML blocks: Markdown is not processed inside them, they end at a blank line, and normal whitespace collapsing applies (`RN:v0.13.27`).
- Multiple spaces and blank lines collapse in reading view (`H:…/Basic formatting syntax`).

### 8.3 Typography and spacing

**Font size.**

- Obsidian's default is **16px** (`RN:v0.12.0`). Themes are told to size text in `em`/`%` so everything scales from the user's base size. mininote's base is 15px.
- Heading size variables `--h1`.. exist (`RN:v0.13.27`). Headings in Live Preview and reading view should look the same (`RN:v1.3.6`). Headings must scale with the base size (`RN:v1.4.3`).
- Bold is computed relative to the current weight, so bold inside a heading is still bold (`RN:v1.6.0`).

**Readable line length.** On by default (`RN:v0.7.0`). The width is adjustable via CSS; a 700px threshold appears in `RN:v0.13.12`. It must apply immediately when a tab opens (`RN:v1.5.10`). There is a toggle command (`RN:v1.9.9`).

**Language attribute.** The UI language is written to `<html lang>` so CSS can target languages (`RN:v1.6.0`). For Korean this enables `:lang(ko)` rules such as `word-break: keep-all`.

**Editor/reading alignment.** Editor spacing was tuned to match reading view (`RN:v0.14.0`).

**Spacing bugs from per-element margins** (rationale for sibling rules):

- Consecutive tables stuck together (`RN:v0.8.10`).
- Extra space between a list and its sub-list (`RN:v1.3.7`).
- Missing space after blockquotes (`RN:v1.12.0`).
- Missing margin on code blocks and callouts inside embeds (`RN:v1.8.0`).
- Extra bottom padding on embeds (`RN:v0.13.27`).
- Oversized media-embed padding (`RN:v0.8.0`).
- Theme margins breaking editor selection (`RN:v0.13.9`).

### 8.4 Callouts, comments and footnotes

- **Callouts:** default title = type in title case. Title-only callouts are allowed. `+`/`-` folding; nesting; a right-click type switcher in Live Preview (`RN:v1.5.0`). Callout titles must work with strict line breaks (`RN:v0.14.8`).
- **Comments:** exactly two `%` (`RN:v1.13.2`).
- **Footnotes:** multi-line definitions may contain blank lines (`RN:v1.6.1`). Footnote refs containing spaces are not refs (`RN:v1.6.1`).

---

## 9. Performance

**Startup.**

- The metadata cache persists in IndexedDB, so restarts skip re-indexing (`H:…/How Obsidian stores data`).
- The first index shows a progress notice (`RN:v0.12.0`, `RN:v0.12.1`), and slow files are reported (`RN:v0.13.3`).
- A startup breakdown is available: initialization / vault / workspace / plugins (`H:Help and support`, `RN:v1.7.1`, `RN:v1.13.5`).

**Indexing and search.**

- Markdown files larger than **2 MB are not indexed**, to protect startup (`RN:v1.6.0`).
- Search renders visible rows only (`RN:v0.8.0`) and updates incrementally (`RN:v0.8.10`).
- Recomputing properties in the background caused periodic input lag (`RN:v1.14.0`). Keep background work off the input path.
- Word count recomputes at most twice per second (`RN:v0.13.11`).

**Tabs and editor.**

- Background tabs are deferred (`RN:v1.7.2`, `API:11255`).
- Several memory leaks came from not unloading editors and widgets (`RN:v0.13.20`, `RN:v0.13.27`, `RN:v1.1.10`, `RN:v1.13.6`).
- Live Preview works viewport-first (the "unstyled flash" fix in `RN:v1.1.3`; scroll performance in `RN:v1.2.4`).

**Big-vault fuzzy matching.** Fuzzy matching over more than 10k items was once throttled (`RN:v0.12.0`), then optimized (`RN:v1.14.2`, `RN:v1.14.3`). `prepareSimpleSearch` exists as the cheaper option (`API:7584`).

**File tree.** Many expanded rows are expensive (`RN:v0.15.2`, `RN:v1.8.8`); virtualize them.

---

## 10. Platform and desktop

**Window frame.**

- Default since v0.16 is a frameless window with no title text. Options: Obsidian frame / native frame / hidden frame; changing it requires a restart (`RN:v0.16.0`, `H:User interface/Settings`).
- macOS traffic lights can be offset via CSS variables (`RN:v1.12.0`, `RN:v1.12.2`). Double-clicking the tab bar maximizes or zooms the window (`RN:v1.0.1`, `RN:v0.8.15`). The title bar is 2px taller on macOS (`RN:v0.15.1`).
- Fullscreen must not leave dead click zones (`RN:v0.8.15`, `RN:v1.5.11`).

**Menus.** Native context menus are optional and on by default on macOS (`RN:v1.0.0`, `API:6233-6239`).

**Instances and windows.**

- A second launch re-opens the vault starter rather than spawning a new instance (`RN:v1.12.1`).
- Previously open vaults are restored (`RN:v0.10.0`). Windows that end up off-screen move back to the main display (`RN:v0.11.10`).
- Pop-out windows exist (`H:User interface/Pop-out windows`). Out of scope for us.

**Paths and names.**

- NFC normalization and NBSP handling (`API:6707`, `RN:v0.7.0`).
- OS filename limits are respected, with advice to use cross-platform-safe names (`H:Files and folders/Manage notes`).
- Characters illegal on another OS are skipped, not crashed on (`RN:v0.11.11`).
- Windows Defender can quarantine notes that contain code blocks (`H:Obsidian Sync/Troubleshoot Obsidian Sync`).
- Network drives needed fixes for loading images (`RN:v0.14.0`, `RN:v1.13.5`).

**Resource URLs.** Local files are served through `app://<random-id>/` (`API:7104-7111`), with `Vault.getResourcePath` (`API:10305`). This maps to Tauri's `convertFileSrc` plus the asset protocol scope.

**URI scheme.** `obsidian://open|new|search…` (`H:Extending Obsidian/Obsidian URI`). Linux needs a `.desktop` entry with `%u`. Actions now ask for confirmation, with an allow-list (`RN:v1.13.0`). Low priority for mininote.

**Other.**

- Hardware acceleration toggle. Translucency on macOS only (removed on Windows).
- `Ctrl+M` must not minimize on Windows (`RN:v1.2.4`). Linux middle-click paste must not fire spuriously (`RN:v1.3.2`).

---

## 11. Settings and defaults (`H:User interface/Settings` plus cited release notes)

| Group | Setting | Default |
|---|---|---|
| Editor | Default view for new tabs | Editing (`H:…/Views and editing mode`) |
| Editor | Default editing mode | Live Preview |
| Editor | Readable line length | On (`RN:v0.7.0`) |
| Editor | Strict line breaks | Off |
| Editor | Properties in document | Visible (also Hidden, Source) |
| Editor | Fold heading / fold indent | On |
| Editor | Line numbers | Not stated |
| Editor | Indentation guides | On (`RN:v0.14.0`) |
| Editor | Auto-pair brackets / Markdown syntax | On (implied) |
| Editor | Smart lists | On |
| Editor | Indent using tabs | On (else 4 spaces) |
| Editor | Indent visual width | Configurable |
| Editor | Convert pasted HTML | On (`RN:v0.10.3`) |
| Editor | Spellcheck | On in new vaults (`RN:v1.3.0`) |
| Editor | RTL | Off |
| Editor | Vim | Off |
| Files & links | Default file to open | Last opened files (`RN:v1.11.0`) |
| Files & links | New-note location | Vault root / same folder / specific folder (default not stated) |
| Files & links | New-attachment location | Vault root (`H:…/Attachments`) |
| Files & links | New link format | Shortest path (`RN:v0.8.0`) |
| Files & links | Auto-update internal links | On |
| Files & links | Use wikilinks | On |
| Files & links | Show all file types | Off |
| Files & links | Confirm file deletion | On |
| Files & links | Deleted files | System trash |
| Files & links | Delete attachments with note | Always / Ask / Never (`RN:v1.12.0`) |
| Files & links | Excluded files | Glob/folder list |
| Files & links | Override config folder | Dot-name |
| Files & links | Rebuild cache | Button |
| Appearance | Base color scheme | Adapt to system (`RN:v1.5.0`) |
| Appearance | Accent color | Yes |
| Appearance | Interface / text / monospace fonts | Yes |
| Appearance | Font size | 16px, per device |
| Appearance | Quick font-size adjust | Off (`RN:v1.5.4`) |
| Appearance | Inline title | On |
| Appearance | Tab title bar / ribbon | Configurable |
| Appearance | Zoom | Per vault |
| Appearance | Native menus | On for macOS |
| Appearance | Window frame | Hidden/frameless |
| Appearance | Translucency | Off |
| Appearance | Hardware acceleration | On |
| Appearance | CSS snippets | In config folder; hot-reload on save (`H:Extending Obsidian/CSS snippets`) |
| Core plugins | File recovery | 5 min interval / 7 days |
| Core plugins | Page preview | On; Mod+hover in editor (`H:Plugins/Page preview`) |
| Core plugins | Others | Quick switcher, command palette (recent and pinned commands), backlinks, outline, word count, etc. |

---

## 12. Undocumented: mininote must decide

- **Write strategy.** Atomic temp-file-plus-rename vs in-place write. Obsidian exposes ctime preservation (`API:3368`), which hints that timestamps matter. Decide how to keep "created time" sorting stable.
- **Watcher.** The library and debounce window are not documented, nor how self-generated events are ignored.
- **Link matching.** Case-insensitivity of link resolution is observed behavior, not specified.
- **Tree order.** Folders-first ordering, and the exact "Untitled N" numbering scheme.
- **Readable width.** The exact readable line width value (700px hinted).
- **Merge algorithm.** How the external-change merge is computed (likely 3-way; Sync uses diff-match-patch).
- **Conflicts.** What happens when a merge conflicts locally (Sync's conflict-file naming is the closest precedent).

---

## 13. Recommended MVP cut

**P0**

- Open a folder as a vault, with recent vaults and remembered last state.
- Tree:
  - Hide dot-entries and unsupported files.
  - Sort: folders first, then collator (numeric, base).
  - Create note/folder; inline rename (F2/Enter); trash with fallback.
  - Drag-move; context menu; reveal in OS.
  - Persist expanded state; virtualized rows.
- Autosave with debounce/flush, serialized writes, error indicator, and external-change reload/merge.
- CodeMirror 6 Live Preview for headings, emphasis, links, lists/tasks, code, quotes and hr. Smart-list Enter/Tab, IME-safe.
- Reading view with markdown-it plus sanitization and sibling-pair spacing. Base font 15px.
- Quick switcher (recent files, fuzzy, create). Wikilink resolution and `[[` autocomplete.
- Image paste/drop into an attachment folder.
- macOS overlay title bar; single instance; flush on close.

**P1**

- Rename → update links. Backlinks (linked).
- Vault full-text search (in Rust).
- Per-tab history (back/forward); find/replace (CodeMirror search).
- Callouts, footnotes, `==highlight==`, `%%comments%%`.
- Live Preview tables (read-only widget); outline.
- File-recovery-style local snapshots.

**P2**

- Tabs and splits, unlinked mentions, properties UI, tags pane, folding persistence, templates/daily notes, command palette, page preview, readable-width toggle.

**Skip**

- Canvas, Bases, graph, Sync/Publish, plugins and themes store, math/mermaid, PDF viewer, URI actions, pop-out windows, Vim.
