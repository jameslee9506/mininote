# SilverBullet: functional and technique research for mininote

> Source: https://github.com/silverbulletmd/silverbullet at `01d6b0e` (2026-11-06, v2.12.1). Shallow clone analyzed.
> License: MIT (© Zef Hemel). Three editor files (`client/codemirror/util.ts`, `client/codemirror/syntax/hide_mark.ts`,
> `client/codemirror/syntax/list.ts`) say they were forked from Ixora (Pranav Karawale, Apache-2.0).
> No code is copied here. Behaviors are described in my own words, and repo-relative paths are cited as evidence.

## 0. TL;DR for mininote

SilverBullet is a self-hosted, browser-based (PWA) markdown PKM. Its server sync, Space Lua, query language and
object database are far outside mininote's scope. Its **CodeMirror 6 live-preview editor** is the most carefully
engineered open-source "clean markdown" implementation in this survey, and it maps directly onto our stack
(CM6 + `@lezer/markdown`). The Rust server also has ideas we can reuse in a Tauri backend: atomic writes, a
`notify` watcher with debounce and flood control, and Tantivy full-text search with Hangul/CJK bigram tokenization.

Most important takeaways:

1. **Every live-preview feature is its own `StateField<DecorationSet>`** built by walking the Lezer tree
   (`decoratorStateField`, `client/codemirror/util.ts`). It recomputes on every transaction, with two exceptions where it
   only *maps* the existing decorations: IME composition (`input.type.compose`) and an active selection "hold".
2. **Layout stability is the real engineering work**, not the hiding itself. Techniques used: fixed-width "column slots"
   for list/task/quote markers, heading markers that hang into the left gutter when revealed, fence lines that become
   transparent instead of collapsing, table source hidden line by line, a persisted `estimatedHeight` cache for block
   widgets, and a 100 ms "pointer preview hold" so text doesn't move under the mouse.
3. **Custom Lezer inline/block extensions** add `[[wikilink|alias]]`, `![[embed]]`, `==highlight==`, footnotes,
   multi-state tasks, frontmatter, and a GFM table parser whose `|` splitting respects `[[...|...]]` brackets.
4. **Autosave**: 1000 ms debounce, deferred while the IME is composing, flushed immediately before navigating away,
   retried every 10 s on failure. The only "saved" indicator is the title color (no text).
5. **External edits** are merged 3-way into the open buffer (base = last known disk text). Cursor and unsaved edits are
   preserved, the transaction is flagged so it does not re-trigger a save, and it is a single undo step.
6. **Link resolution**: an exact path match wins. Otherwise a case-insensitive basename/suffix lookup, with ties ranked by
   folder proximity (deliberately different from Obsidian). Renames rewrite every backlink in place.
7. **Quick switcher**: a tiered fuzzy scorer combined by geometric mean. It normalizes with NFD, which splits Hangul into
   jamo. That has a useful side effect and some noise (§11).
8. **No NFC/NFD normalization of file names or text exists anywhere.** mininote must add it at the Rust boundary.

## 1. Architecture snapshot (what to read and what to ignore)

| Layer | Path | Relevance |
|---|---|---|
| CM6 editor setup | `client/codemirror/editor_state.ts` | High: extension list, update/save hook, force-parse |
| Live preview ("clean mode") | `client/codemirror/editing/clean.ts`, `client/codemirror/syntax/*.ts` | Very high |
| Decoration helpers | `client/codemirror/util.ts`, `client/codemirror/editing/pointer_preview.ts` | Very high |
| Lezer grammar extensions | `client/markdown_parser/{parser,extended_task,table_parser,footnote}.ts` | Very high |
| Enter/indent/paste | `client/codemirror/editing/{markdown_enter,list_indent,editor_paste}.ts` | High |
| Save, reload, merge | `client/content_manager.ts`, `client/external_merge.ts`, `client/codemirror/cm_util.ts` | High |
| File change detection | `client/spaces/evented_space_primitives.ts`, `client/realtime_events.ts`, `server/src/watcher.rs`, `server/src/fs_guard.rs` | High |
| Disk I/O | `server-common/src/space/disk.rs`, `server-common/src/space/case.rs` | High (Rust, Tauri-relevant) |
| Fuzzy picker / tree | `plug-api/lib/fuzzy.ts`, `client/navigator/**`, `plug-api/ui/tree_{model,view}.ts(x)` | High |
| Link resolution / rename | `plug-api/lib/{ref,resolve,resolve_path,transclusion}.ts`, `plugs/index/{refactor,refactor_splice,relation}.ts` | High |
| Full-text search | `server-search/src/{limits.rs,sync.rs,fulltext/*}` | Medium-high (Tantivy) |
| Lua, queries, widgets, sync engine, auth, MCP, semantic search | many | Skip |

The client is TypeScript with CM6, Preact and esbuild. The server is a Rust Cargo workspace. The desktop app is a
separate closed-source product, so this repo has no native shell code (§9).

## 2. Vault / workspace

- **Model**: one "space" is one folder served by a server instance. A multi-space server with a dashboard exists
  (`server/src/multi/*`), but the client has **no in-app vault switcher**. Switching spaces means loading a different URL.
- **Per-space state** lives in a client-side IndexedDB key-value store (`client/data/datastore.ts`), scoped per space:
  - `["client","lastOpenedPath"]` is written on every navigation and used on cold boot to reopen the last page (`client/client.ts` ~L1451).
  - Per-page `lastOpened` timestamps are stored as an "augmentation" outside the index (`client/data/data_augmenter.ts`).
    They drive recency sorting in the picker.
  - Tree expansion sets are stored as `["navigator", view, "expanded"|"collapsed"]` (`client/navigator/ui/expansion.ts`).
  - A file snapshot (`name → lastModified`) is stored for change detection (`client/spaces/evented_space_primitives.ts`, key `$spaceSnapshot`).
  - A widget height cache is stored under `["cache","widgetMeta"]` (`client/widget_cache.ts`).
- **Config** lives *inside the space* as Lua-defined settings (`libraries/Library/Std/Config.md`, `docs/CONFIG.md`).
- **For mininote**: keep a small app-level JSON in the Tauri app-data dir with recent vaults and the last vault. Keep
  per-vault state (last file, expanded folders, per-file cursor/scroll, recent files) in app data keyed by a vault
  hash, not inside the vault, so the user's folder stays clean (SilverBullet's equivalent is per-origin IndexedDB).

## 3. File tree ("Space tree" navigator view)

Evidence: `client/navigator/views/space_tree.ts`, `plug-api/ui/tree_model.ts`, `plug-api/ui/tree_view.tsx`,
`client/navigator/ui/{keyboard,tree_commands,expansion}.ts`, `server-common/src/space/disk.rs`.

- **Folders are derived, not listed.** The tree is built from the flat list of file paths. Intermediate folders are
  synthesized from `/`-separated prefixes, so **empty folders cannot exist**, and deleting a file also removes the empty
  parent directories on disk (`clean_orphaned` in `disk.rs`). A node can be both a page and a folder ("dual": `Foo.md`
  plus `Foo/…`). Clicking a folder opens the page of the same name and expands it (`selectableFolders: true`).
- **What is listed** (`walk_listable`, `disk.rs`): recursive walk that follows symlinks. Dot-directories and dot-files
  are always skipped, as are files **without an extension**, plus gitignore-style `SB_SPACE_IGNORE` patterns (empty by default).
  The space's own `.gitignore` is deliberately *not* read. Pages carrying `pageDecoration.hide` or `tree.hide` are hidden.
- **Sort**: by name, using **codepoint order by default**. `Intl.Collator` is used only if the `queryCollation` config is
  enabled (`plug-api/lib/collation.ts`). Folders are *not* sorted first (`foldersFirst: false`). An optional numeric
  `priority` per page reorders siblings, and the sort is stable.
- **Row actions** (hover buttons): "New page here" (folders only; the prompt is prefilled with `Folder/`, and confirming
  the bare prefill counts as cancel), "Rename" (a modal prompt, not inline), and "Delete" (`confirm("Delete X?")`,
  hidden for pure folders). **There is no trash**: delete is a hard `remove_file`.
- **Drag and drop** (`planMove`, `tree_view.tsx`):
  - Dropping on a file row means "into that file's parent folder" (Finder style). Dropping on empty tree area means the root.
  - The move is refused (no-op) when dropping onto itself, into its own subtree, or into its current parent.
  - **Collision** if the target name already exists as *any* node, folder or file, to prevent silently merging subtrees.
    It shows "X already exists".
  - **Spring-loading**: hovering a collapsed folder for **700 ms** expands it. After a drop the target folder is expanded
    so the moved row doesn't vanish.
  - External OS files dropped on the tree are uploaded into the target folder, with an "Upload to X" hint.
  - Folder moves become a prefix rename (`index.renamePrefixCommand`), and every file is moved with link rewriting.
- **Keyboard** (follows the WAI-ARIA tree pattern):
  - Up/Down (and Ctrl-P/N), PageUp/PageDown (±5), Home/End.
  - Right expands a folder, or steps into it if already open. Left collapses, or jumps to the parent.
  - Enter opens, Space "peeks" (opens without leaving the tree), Escape closes.
  - Typing filters the tree. Filtering prunes non-matching branches, force-expands everything, and sorts by best
    descendant score (`pruneTree`). While filtering, manual expand/collapse is ignored.
- **Expansion persistence**: per view, saved on every toggle. There are two keys because under "expand all" mode the set
  stores what the user *collapsed*, and reading one as the other would invert the tree. `followEditor: true` reveals
  the current file.
- **Virtualization**: sibling lists longer than **200** rows render progressively. A window of rows sits between two
  spacers sized as measured average row height (initial estimate **36 px**) times the hidden row count. An
  `IntersectionObserver` with a **600 px** rootMargin grows the window, which is capped at **1000** rows. The selected
  and current rows are always kept inside the window.
- **Name validation** (`isValidName`/`isValidPath` built on the ref grammar in `plug-api/lib/ref.ts`), with case-only
  renames handled specially (§6). Rejected names:
  - names containing `@ # | < > $`, `[[` or `]]`
  - leading `.` or `^`
  - `.` or `..` segments, or `//`
  - double extensions ending in `.md` (`foo.png.md`)

## 4. Editor

### 4.1 Markdown flavor (Lezer extensions, `client/markdown_parser/parser.ts`)
- Base is `@lezer/markdown` (CommonMark) plus its `Strikethrough`, `Superscript` and `Subscript`. SilverBullet adds its own:
  - **WikiLink**: an inline parser that runs *after Emphasis*, i.e. before the stock Link parser. A one-character
    precheck (`[` or `!`) keeps it cheap. An anchored lazy regex captures leading `[[` or `![[`, the ref, an optional
    `|alias`, and `]]`. It emits `WikiLink` with children `WikiLinkMark`/`WikiLinkPage`/`WikiLinkAlias`. A leading `!`
    wraps the whole node in an `Image` node, so embeds reuse the image pipeline. Links are single-line, and inline code
    wins because the InlineCode parser runs first.
  - **Highlight `==x==`**: implemented as a delimiter (`addDelimiter`) with `HighlightMark` children, so nesting with
    emphasis works like `**`.
  - **Tasks**: a leaf-block parser that applies only when the parent is a `ListItem` and the content starts with
    `[state]` followed by a space or end of line. The state can be any text without `]` or `:`, so `[TODO]` and
    `[DONE]` are allowed (`extended_task.ts`).
  - **Tables**: a GFM-style parser. The delimiter row must have the same cell count as the header. `|` inside brackets
    (`[[a|b]]`, `[attr: v]`) does *not* split cells, because bracket depth is tracked (`table_parser.ts`). This is a real
    usability win over Obsidian, which needs `\|`.
  - **Footnotes**: `[^id]` refs (not followed by `:`), `[^id]: body` definitions with 4-space/tab continuation lines,
    and inline `^[text]` (`footnote.ts`).
  - **Frontmatter**: recognized only at document position 0 with exactly `---`, and runs before HorizontalRule. The YAML
    is parsed as a nested tree (legacy yaml StreamLanguage). An unterminated block is not frontmatter.
  - Also: naked URLs (only `http(s)://`), `#hashtags`, `@mentions`, `$anchors`, `${lua}` directives, HTML blocks,
    git-style conflict markers. The ones mininote doesn't need can be skipped.
- Callouts/admonitions: the Obsidian `> [!type] Title` form and the GitHub `> **type** Title` form, detected by regex on
  `Blockquote` nodes (`syntax/admonition.ts`). There is no foldable `[!type]-` variant.
- **Embeds**: `![[file]]` and `![alt](url)` are both `Image` nodes. A dimension suffix in the alias is supported:
  `|300`, `|300x200`, `|30%`, `alias|300x200` (`plug-api/lib/transclusion.ts`). Embedded `.md` pages are rendered
  inline, with their frontmatter stripped.

### 4.2 Live-preview mechanics (the core)
- **Plugin set** (`editing/clean.ts`): one decoration StateField per construct. A "show raw markdown" toggle keeps only
  the semantic ones (wikilink status coloring and similar) and drops all hiding.
- **`decoratorStateField(mapper)`** (`util.ts`) does this on each transaction:
  1. If it's an IME composition transaction, map the old decorations through the changes. Do **not** recompute.
  2. If it's a pointer-selection transaction, or the `pointerPreviewHeld` field is true, map only.
  3. Otherwise rebuild everything from `syntaxTree(state)`.
  Because these are StateFields rather than ViewPlugins, **block widgets and line-hiding replaces are allowed**. CM6
  forbids those from ViewPlugins.
- **Reveal rule** (`isCursorInRange`): source is shown when *any* selection range overlaps the node range
  **inclusively**. A cursor touching either edge (just before `**` or just after the closing `**`) also reveals.
  Nested emphasis uses the outermost node's range.
- **Alt/Option-click** always reveals source (`revealSource` plus an effect). In read-only mode this is the *only* way,
  and hidden ranges become atomic so the caret never "walks through" invisible characters (`readOnlyAtomicRanges`).
- **Pointer preview hold** (`editing/pointer_preview.ts`):
  - A capture-phase `mousedown` on the content sets "hold". While held, decorations are only mapped, so the layout
    stays frozen during drag-select and double-click.
  - On `mouseup` the hold is released after **100 ms** (0 ms with Alt). That lets a click reach a link widget before
    revealing its source moves the DOM.
  - Keyboard selection changes (CM6 gives arrow moves the `select` user event) also hold, and release 100 ms after the
    last move, so holding an arrow key doesn't flicker every line it crosses.
  - Any document change or effect drops the hold immediately. Window blur releases it.

| Construct | Cursor outside | Cursor inside / notes |
|---|---|---|
| `*em*`, `**strong**`, `` `code` ``, `==hl==`, `~~del~~`, `^sup^`, `~sub~` | mark characters replaced by nothing | raw markers shown (`hide_mark.ts`) |
| ATX heading | `#…# ` hidden, line class sets size | marker revealed inside a fixed-width slot that **hangs into the left gutter** (h1 2ch … h6 7ch), so the title doesn't shift. No hang under an 800 px container. A lone `#` line is styled as a hashtag, not a giant H1 |
| `---` (hr) | text hidden, line gets a top border, margins balanced | raw `---` |
| `\x` escape | backslash hidden | shown |
| `[text](url)` | `[` and `](url)` hidden, title wrapped in an `<a>` **mark** (not a widget, so the text stays real) | empty title: no preview at all |
| `[[page\|alias]]` | whole link replaced by an anchor widget showing alias, or the last path segment (`shortWikiLinks`) | raw text with status class: missing/invalid/ambiguous |
| `- [ ]`/`[x]` | replaced by checkbox widget; checked → strike-through mark on the task text (leading spaces skipped) | raw `[x]`; custom states show text plus a ▾ that opens completion |
| `-`/`*`/`+` bullet | replaced by a `•` widget at the same source position | marker styled as "cursor" |
| `>` quote | marker replaced by an equal-width spacer; bars painted as a CSS gradient, one per nesting level | raw `> ` pinned to the same 2 columns |
| fenced code | fence lines kept but **text made transparent**, language label floated right, copy button | raw fences |
| table | all source lines hidden (`display:none` except the first, whose content is replaced) plus a **block widget** with the HTML table | raw pipes in monospace |
| `![](…)`, `![[…]]` | source hidden, block widget renders image/media/transcluded page | raw |
| footnote `[^1]`, `^[x]` | "…" widget, hover tooltip renders the definition, click jumps to it | raw |
| frontmatter | fence lines transparent; URLs, wikilinks and mailto inside YAML strings become link widgets | raw YAML |

- **Multi-line hiding** (`hideBlockSource`, `util.ts`): one `Decoration.replace` spanning several lines is atomic in CM6,
  so arrowing up into it from below snaps to its start. SilverBullet instead hides each line separately: the line that
  hosts the widget gets its content replaced, and every other line gets a `display:none` line class. Each line stays
  addressable.
- **Click handling** (`editor_state.ts`):
  - A rendered link navigates **without moving the cursor**.
  - If the pointer moved more than **4 px** between mousedown and click, it was a drag and nothing happens.
  - A click whose position is more than one character width away from the resolved text position is ignored. This
    prevents accidental activation next to wide widgets.
  - Cmd/Ctrl-click opens the link in a new window.
- **Widget DOM reuse**: each widget implements `eq()` on its content, so the per-keystroke decoration rebuild doesn't
  recreate the DOM. The checkbox resolves its document position at click time (`posAtDOM`) instead of trusting a
  constructor-time offset.

### 4.3 Keyboard, lists, indentation
- Default extensions:
  - `history`, `drawSelection`, `dropCursor`, `closeBrackets` (default `([{`, configurable)
  - `indentOnInput`, `highlightSpecialChars`, `lineWrapping`
  - `codeFolding` (no gutter; list items fold from the end of their first line)
  - indent unit is **2 spaces** (`editor_state.ts`)
- **Enter** (`editing/markdown_enter.ts`, adapted from lang-markdown's continue-markup command):
  - continues bullets, ordered lists (renumbering the following items) and quotes
  - a task item continues as `- [ ] ` (state reset to unchecked)
  - **item text ending in `:` creates an indented child item** (bullet +2 spaces; ordered restarts at 1)
  - **never inserts a blank line** for loose lists
  - Enter on an empty item removes the marker, or outdents to the parent's next marker when nested
  - two empty `>` lines exit the quote
  - inside fenced code it's a plain newline
  - it first calls `ensureSyntaxTree` (500 ms budget), because a fresh state is only partly parsed
- **Backspace**: lang-markdown's `deleteMarkupBackward` (removes list/quote markup in one stroke).
  **Tab/Shift-Tab**: accept an open completion first, otherwise indent/outdent.
- **Hanging indent for wrapped lines** (`editing/list_indent.ts`, CSS in `client/styles/editor.scss`):
  - A line decoration sets `--sb-list-indent` (marker-zone width in editor columns), and `.cm-line` uses
    `padding-left: X; text-indent: -X`.
  - Marker runs are wrapped in inline-block **column slots** (min-width N×1ch, monospace), so swapping `*`→`•` or
    `[ ]`→checkbox never shifts the text.
  - A U+2060 word joiner after the marker stops a long first word (such as a URL) from wrapping away from its bullet.
  - Ordered lists reserve the *widest* number's width, right-aligned like `<ol>`.
  - A just-typed `* ` that CommonMark doesn't yet treat as an item (empty items can't interrupt a paragraph) gets its
    slot early, so typing the first letter doesn't make the line jump.
- Formatting toggles (`plugs/editor/text.ts`):
  - With no selection: insert a marker pair and put the cursor between, or step over the marker if the cursor sits on one.
  - With a selection: wrap it, or unwrap if markers sit at or just outside its edges, and keep the inner text selected.
- **Shortcuts**:
  - Cmd/Ctrl: K page picker, / command palette, O tree, F find (CM search panel), B bold, I italic.
  - Shift-Ctrl-S strikethrough, Ctrl-Alt-M highlight.
  - Back/forward: Cmd-[ / Cmd-] on macOS, Alt-Left/Right elsewhere.
  - Cmd/Ctrl-Enter follows the link under the cursor. Cmd/Ctrl-Shift-Enter creates the page under the cursor.
  - Ctrl-Space starts completion.
  (`client/editor_commands.ts`, `plugs/editor/editor.plug.yaml`, `client/navigator/commands.ts`)
- **Smart quotes** are on by default (`“” ‘’`). They are skipped inside code, frontmatter, HTML tags and Lua.
  mininote can skip this feature; it rarely helps Korean text.

### 4.4 Paste and drop (`editing/editor_paste.ts`, `editing/tree_file_drop.ts`)
- Pasting a URL over a selection produces `[selection](url)`.
- Pasting rich HTML converts it with Turndown (ATX headings, `*` bullets, fenced code, GFM tables and task items) and
  strips HTML comments. This is skipped when **Shift** is held or the cursor is in code or frontmatter.
- Pasting an image or file:
  - A name prompt appears, prefilled with a timestamp name (`YYYY-MM-DD_HH-MM-SS.ext`) resolved against the current
    page's folder.
  - Name validation runs, then an "already exists, keep name to replace" loop.
  - The size limit is **10 MiB** (`maximumDocumentSize`).
  - Finally `![[path]]` is inserted for images, or `[[path]]` for other files.
- Dropping OS files runs the same upload flow, but inserts at the *last cursor* rather than the drop point (an
  acknowledged TODO). Dropping a tree row onto the editor inserts a link at the drop coordinates.
- **WebKit caret bug**: after a paste plus decoration rebuild, WebKit can keep drawing the old caret. The fix nudges the
  selection one character and restores it in a microtask, with history disabled. **Relevant to Tauri on macOS and Linux.**

### 4.5 IME / composition handling (important for Korean)
- Decorations are only mapped (not rebuilt) during `input.type.compose` transactions (`util.ts`). Rebuilding widgets
  next to an active composition is what breaks IMEs.
- The save hook (`createEditorUpdateHandler`, `editor_state.ts`):
  - While `view.composing`, it marks the view "composingDirty" and updates the UI dirty state, but does **not** save.
  - The first update after composition ends triggers the save.
  - `ContentManager.save` re-checks `composing` when its timer fires, and reschedules another 1000 ms if still composing.
- After a save, the "refresh widgets" no-op dispatch is skipped while composing (`content_manager.ts`).
- Pickers, the tree and inputs ignore keydown while `event.isComposing`, so Enter that confirms a Hangul candidate
  doesn't submit (`components/filter.tsx`, `navigator/ui/keyboard.ts`, `plug-api/ui/input.tsx`).
  - Not handled: Safari/WebKit (commonly reported) can deliver the confirming Enter with `isComposing === false` but
    `keyCode === 229`. mininote should check both.

## 5. Persistence

- **Autosave timing** (`client/content_manager.ts`):
  - **1000 ms** trailing debounce (`autoSaveInterval`). Every change resets the timer, and the write happens only if
    `unsavedChanges` is set.
  - The page path is captured *before* any await, so a save resuming after navigation can't write buffer A under page B.
  - `save(true)` (immediate) runs before navigating away (`leaveCurrentPage`), before rename, and before
    `saveOverDiskChanges`.
  - A separate "editor:updated" event is throttled to 1000 ms.
- **Write errors**: the user sees the notification "Could not save page, retrying again in 10 seconds" and the save
  retries every **10 s**. A permission error shows a read-only notice instead. There is no blocking dialog.
- **Dirty indicator**: only the page-title color changes. Saved is `#111`, unsaved `#5e5e5e`, loading `#7a7a7a`. Dark
  theme: `#fff`, `#c7c7c7`, `#c7c7c7` (`client/styles/{colors,theme}.scss`). This is a perfect monotone fit for mininote.
- **Create-on-first-edit**: navigating to a missing page shows an empty buffer that is **not written** until the user
  types (`content_manager.ts` "Mock up the page"). Clicking a dangling link therefore never leaves empty files behind.
- **Atomic writes** (`server-common/src/space/disk.rs`):
  - Write to a dot-prefixed temp file next to the target, named `.<name>.sb-write-<pid>-<counter>`. Optionally set its
    mtime. Then `rename` over the target, and delete the temp file on error.
  - The dot prefix keeps temp files out of listings and the watcher. The per-process counter stops concurrent writers
    from truncating each other's temp file.
  - Parent dirs are created as needed. Deleting removes empty parents.
- **External modification detection**:
  - Server: `notify` watcher → per-path **75 ms** quiet-period debounce (25 ms tick) → re-validated with the same
    visibility rules as listings.
  - More than **20** events in one batch collapses into a single `resync` event, which means "re-list everything"
    (git checkout, bulk sync).
  - A new directory is scanned for files that never produced their own events (inotify limitation).
  - If native watching is unavailable, it polls every **30 s** (`server/src/watcher.rs`).
  - Client: events are coalesced in **250 ms** windows. ≥4 changes, or any resync, triggers one full listing; otherwise
    each file's metadata is probed (`client/realtime_events.ts`).
  - Fallback polling: the open file every **3 s + jitter** (`client/space.ts`) and the whole listing every
    **10 s + jitter** (`client/client.ts`).
- **Ignoring self-generated events** uses two layers:
  1. The client keeps a persisted snapshot `path → lastModified`. A write stores the mtime the write returned, so the
     watcher's later probe sees an identical mtime and fires nothing. The in-write event carries an `ownWrite` flag,
     and the reload listener ignores those (`evented_space_primitives.ts`, `client.ts` L551-575).
  2. The server records expected writes keyed by **(path, sha256 of content)** with a 30 s TTL, and labels watcher
     events as `user` or `external` (`server/src/fs_guard.rs`). Hash-based matching is robust to mtime granularity.
- **Conflict policy for the open buffer** (`external_merge.ts`, `ContentManager.applyExternalPatches`):
  - If disk equals the buffer, do nothing. If the buffer is still equal to the base, apply the external diff directly.
  - Otherwise compute diffs base→disk and base→buffer and **map the external changes through the local ones** (local
    insertions win ties). The diff is `fast-diff`, slid to line boundaries (`cm_util.ts`).
  - The transaction is annotated `externalUpdate` (the save hook skips it, so there's no echo save) and
    `isolateHistory("full")` (a single undo reverts exactly the external change).
  - A patch with an older mtime than one already applied is dropped, which guards against out-of-order reloads.
  - If both sides touched the same line chunk, the update is withheld and retried at the next save.
  - For mininote this simplifies to "3-way merge if possible, else keep local and let the file reload on the next idle".

## 6. Links

- **Ref grammar** (`plug-api/lib/ref.ts`):
  - A name without an extension gets `.md` appended. An "extension" is the last `.` followed only by ASCII
    alphanumerics. **Pitfall**: `Meeting 2024.01` would be treated as a non-markdown file with extension `01`.
  - Supported suffixes: `#Header`, `@123` (char offset), `@L10C5` (line/column), `$anchor`. A leading `^` means
    "meta page". `[[#Header]]` links within the same page.
- **Resolution** (`plug-api/lib/resolve_path.ts`):
  1. An exact path match always wins and is never reported ambiguous.
  2. Otherwise, case-insensitive suffix matching against a **basename index**. A bare name is just the shortest suffix,
     so `api/Auth` matches `docs/api/Auth.md`.
  3. With several candidates, prefer exact-case matches. If still more than one, rank by **deepest shared folder with
     the linking file**, then shallowest path, then lexicographic, and flag the link *ambiguous*. The source notes this
     deliberately reverses Obsidian's "vault root wins" rule.
- **Link status in the editor**: default, `missing` (red, "Create X" tooltip), `invalid`, or `ambiguous` (tooltip shows
  the candidate count). Missing is only flagged once the file list has loaded, to avoid a red flash at startup
  (`syntax/wiki_link_processor.ts`).
- **Clicking an ambiguous link** opens a "Which page?" picker listing candidate folders. The document text is not
  rewritten (`plugs/editor/navigate.ts`).
- **Write side** (`linkWriteFormat`, default `full-path`):
  - `shortest` writes the bare name only if its basename is unique, otherwise the full path.
  - `shortest-suffix` writes the shortest suffix that resolves uniquely.
- **Autocomplete** (`plugs/editor/complete.ts`):
  - Triggers on `[[` plus a prefix without `] @ $ # : { }`. Markdown-link URL completion uses `[..](`.
  - Candidates are pages, non-markdown documents, and **"aspiring" pages** (linked but not created; labeled
    "Linked but not created", sorted last).
  - Aliases and display names appear as extra entries that insert `Name|Alias`.
  - The boost is **−log2(days since modified + 1)**. For markdown links, a same-folder relative path gets +5.
  - CM6's built-in fuzzy filter ranks the typed prefix.
- **Backlinks**: every page is parsed on change, and "relation" records are emitted with source range, alias and snippet
  (`plugs/index/relation.ts`). Unresolved targets become `aspiring-page` records, which feed completion and the
  picker's "Create" rows. Ambiguous ones become `ambiguous-link` records.
- **Rename → update links** (`plugs/index/refactor.ts`, `refactor_splice.ts`, `refactor_case.ts`):
  - Save first. Validate the name. Check conflicts **case-insensitively while excluding the file's own old path**,
    which allows case-only renames, and give a distinct "differs only in casing" error.
  - Rename is implemented as write-new then delete-old. For a case-only rename, the old path is deleted only after
    confirming the new casing actually exists on disk (a failed re-case on Windows must not delete the only copy).
  - If the folder changed, the moved page's relative markdown links are rewritten. Attachments that are referenced only
    by this page and live in the same folder are moved too.
  - Backlinks are grouped per page and rewritten in place. Aliases, `#header`/`@pos`/`$anchor` suffixes, `![[`
    embeds, `<...>`-wrapped URLs, and absolute vs relative form are all preserved.
  - A file whose text didn't change is not rewritten, so mtimes don't churn.
  - The result is shown as "Renamed X to Y, updated N backlinks".

## 7. Rendering & typography

- **There is no separate reading view.** The live-preview editor *is* the reading surface, and read-only mode keeps it
  rendered. A custom markdown→HTML renderer (`client/markdown_renderer/markdown_render.ts`) is used for tables,
  transclusions, footnote tooltips and widgets.
- **Sanitization** (`markdown_renderer/sanitize_html.ts`): a deny-list removes `script`, `iframe`, `object`, `embed` and
  `base` along with their content. All `on*` attributes are removed. URL attributes only allow
  http/https/mailto/tel (app schemes are allowed for `<a href>`, browser-internal schemes never). Control characters
  are stripped before the scheme check. With markdown-it, mininote should prefer `html:false` or DOMPurify.
- **Editor CSS** (`client/styles/editor.scss`, `theme.scss`):
  - Defaults: font 18 px (configurable), iA Writer Mono, content max-width 800 px, padding 5px 20px.
  - Headings: H1 1.5em, H2 1.2em, H3 1.1em, H4–6 1em, all bold. Heading lines get 2 px vertical padding.
  - Code, frontmatter and raw tables use a monospace face.
  - Checkboxes are drawn with `appearance:none` at 1.3em, because Safari pins native checkboxes at about 13 px.
  - Wiki-link "chips" use `padding:0 5px; margin:0 -5px`, so the background grows without moving text.
  - Quote bars are a `repeating-linear-gradient` background sized to nesting depth: no extra DOM, and multiple levels
    work. `@property` registers `--editor-column` as a `<length>`, so `ch` resolves against the editor font rather than
    a heading's font.
- **Block spacing**: in the editor, the blank lines in the source *are* the spacing. Only headings (2 px padding) and the
  hr (balanced ±1em margins) add any. In rendered markdown panels SilverBullet uses **per-element margins**
  (`p, ul, ol, blockquote, pre, table { margin: 0 0 .6em }`, `li .15em`, headings `.8em 0 .35em`) plus
  first-child/last-child resets (`client/styles/_view_content.scss`). That is exactly the approach mininote wants to
  avoid, so use sibling-pair rules instead.
- **Block widgets need care**: CM6 measures block widget height **without margins**. SilverBullet wraps widget content in
  `display: flow-root` so inner margins stay inside the measured box and clicks below land on the right line
  (`client/styles/_page_widget.scss`). Async-rendered widgets reserve `min-height` equal to their estimated height until filled.

## 8. Performance

- **Cost model**: about 20 decoration StateFields, each iterating the *whole* syntax tree on every non-composition
  transaction, including cursor moves. That is fine for typical notes but O(doc × plugins) per keystroke.
  - Mitigations: widget `eq()` reuse, mapping during composition and holds, and expensive renders done async.
  - For mininote: one combined field doing a **single tree pass** (or ViewPlugins over `visibleRanges` for purely inline
    marks) is cheaper.
- **First paint**:
  - `forceParseVisibleRegion` synchronously parses up to viewport end (or the restored scroll position) **+2500 chars
    with a 100 ms budget** in the same task as `setState`.
  - A fresh state parses only about 3000 chars, and the background parser waits for idle, which is a fixed **500 ms in
    WebKit** (no `requestIdleCallback`). Without the force-parse, users see raw markdown flash (`editor_state.ts`).
    Highly relevant for Tauri on macOS and Linux.
- **Scroll restore** (`content_manager.ts`):
  - The scroller is hidden (`visibility:hidden`) until CM's first measure (one rAF).
  - A `MutationObserver` re-applies `scrollTop` while async widgets render.
  - This stops at the first user scroll (listener attached after 100 ms) or after 2 s.
- **Page switch**: one long-lived `EditorView`; each page gets a fresh `EditorState` via `setState`, so **undo history
  resets per visit**. Before switching, a stray DOM selection is cleared, otherwise the browser collapses the caret to
  the end. mininote could cache states per file (LRU) to keep undo across switches.
- **Widget heights**: `estimatedHeight` comes from a persisted LRU cache (1000 entries, flushed with a 2 s throttle).
  The table fallback is rows × 42 px. Without it, large tables entering the viewport make CM revise heights and the
  scroll jumps by thousands of pixels (`syntax/table.ts`, `widget_cache.ts`).
- **Startup**: a cheap page-list cache from the raw file listing appears before the index completes. Widgets render
  "loading" placeholders until the index and page list are ready (`widgetRenderMode`).
- **Pickers**: incremental re-ranking. When the new phrase only appends to the old one within the same scoring tier
  bracket, only the previous matches are re-ranked (`client/navigator/ui/incremental_rank.ts`).

## 9. Platform / desktop

- The native desktop shell is closed-source, so window chrome, menus and single-instance handling are not visible.
  Only integration hooks exist: `silverbulletDesktop.resolveSpaceFileDrop` and a native file-drag callback in the tree.
- **Case-insensitive file systems** (`server-common/src/space/case.rs`, `disk.rs`):
  - Detected once with a hidden probe file (write a lowercase name, stat the uppercase one).
  - True on-disk casing is recovered with `fcntl(F_GETPATH)` on macOS, `canonicalize` (GetFinalPathNameByHandle) on
    Windows, and a `read_dir` walk elsewhere.
  - Writes re-case aliased entries outermost-first, so `notes/a.md` → `Notes/A.md` actually takes effect. Deletes
    addressed to a stale casing are ignored instead of destroying the file now living under the new casing.
  - Case folding is ASCII-only, which is irrelevant for Hangul.
- **Paths**: the watcher root is canonicalized (macOS `/tmp` → `/private/tmp`). Relative names always use `/`, with `\`
  converted. Lexical containment rejects absolute paths and `..`. Symlinks are deliberately followed.
- **WebKit-specific workarounds** worth copying: the post-paste caret nudge, force-parse on navigation (no
  `requestIdleCallback`), and custom-drawn checkboxes.
- **Unicode**: no NFC/NFD handling at all (only the fuzzy matcher calls `normalize("NFD")`).

## 10. Settings (user-configurable, with defaults)

From `libraries/Library/Std/Config.md`:
- **Fonts**: editor size `18`, monospace `ia-writer-mono`, UI font and editor font selectable.
- **Editor**: `autoCloseBrackets` = `"([{"`, `shortWikiLinks` = `true`, `linkWriteFormat` = `"full-path"`,
  `smartQuotes.enabled` = `true` (`“ ” ‘ ’`).
- **Collation**: `queryCollation.enabled` = `false` (codepoint sort), with locale and Intl.Collator options.
- **Other**: vim mode (with custom maps), dark mode (defaults to `prefers-color-scheme`), "show raw markdown" toggle,
  custom task states, key rebinding per command, action buttons, mobile keyboard bar.
- **Ignored paths**: the `SB_SPACE_IGNORE` env var (gitignore syntax). Max upload size is 10 MiB.

## 11. Korean-specific findings (IME, Hangul, NFC/NFD)

- **Fuzzy picker** (`plug-api/lib/fuzzy.ts`): it normalizes with `NFD`, strips `\p{Diacritic}`, then lowercases. Verified
  with Node: the word "Hangul" in Korean (U+D55C U+AE00) becomes 6 conjoining jamo (U+1112 U+1161 U+11AB U+1100 U+1173 U+11AF). Consequences:
  - (+) **Partial syllables match as prefixes**: U+D558 matches the start of U+D55C U+AE00. That is ideal while the last syllable is still
    being composed.
  - (−) A lone compatibility jamo (U+314E, which is what you get mid-composition) does **not** match.
  - (−) Length thresholds count jamo, not syllables. A 2-syllable query (6 units) already enables subsequence matching
    and 1-edit typo tolerance, and one jamo edit changes a whole syllable, so results get noisy.
  - mininote: score on NFC syllables, and add a secondary match based on decomposed jamo or initial consonants instead of NFD everywhere.
- **Full-text tokenizer** (`server-search/src/fulltext/tokenizer.rs`, `script.rs`): CJK runs, Hangul included, become
  **overlapping bigrams**: a four-syllable Hangul word yields three overlapping two-syllable tokens. A lone CJK character is one token, scripts split at
  boundaries (for example, `iPhone` followed by a Hangul suffix becomes separate Latin and Hangul tokens), and the minimum query length is 2 chars except a single CJK character.
  This is a good, dependency-free baseline for Korean without a morphological analyzer. Text must be **NFC first**:
  decomposed jamo would form bigrams that never match NFC queries.
- **File names**: links, basename index and rename conflicts all compare exact strings (after ASCII lowercase). An NFD
  file name (common for files that came through older macOS tools or zip archives) would never resolve from a typed
  NFC wikilink target. Verified: the NFD and NFC strings differ even after lowercasing. mininote should NFC-normalize every
  path at the Rust boundary, keep a map back to the real on-disk name for I/O, and compare names NFC + case-folded.
- **Sort order**: codepoint ordering puts Hangul after all Latin text and orders by Unicode value. Use
  `Intl.Collator('ko', {numeric:true})` instead.

## 12. Recommendations for mininote

**Adopt**
- One decoration source built in a single Lezer tree pass, delivered as a StateField (needed for block widgets and line
  hiding), with SilverBullet's rules: map-only during composition, map-only while the pointer/keyboard selection is
  held, inclusive cursor-overlap reveal.
- Pointer-preview hold (freeze on mousedown, release 100 ms after mouseup), plus the 4 px drag guard and the
  "near the text" click guard.
- The layout-stability toolkit:
  - column slots for markers, plus a word joiner after them
  - hanging heading markers (with a narrow-width fallback)
  - transparent fence and frontmatter lines instead of collapsing them
  - per-line `display:none` for multi-line hidden blocks
  - `estimatedHeight` cache for tables and images
  - `flow-root` widget roots
- Markdown links as *marks* (title stays real, editable text). Wikilinks as atomic widgets that show the alias or the
  last segment.
- The Lezer wikilink extension pattern (a char precheck, then an anchored regex, `after: "Emphasis"`, `!` → Image
  wrapper) and the bracket-aware table cell splitter.
- The Enter behavior (empty item exits, `:` creates a child, no blank lines in loose lists, renumbering) and
  `deleteMarkupBackward`.
- Autosave: 1 s debounce, compose-deferral, immediate flush on switch/blur/quit, path captured before await, silent
  retry, dirty state shown by title shade only.
- Atomic dot-temp + rename writes. A watcher with per-path debounce plus a flood→resync rule. Self-write suppression by
  recorded mtime or content hash.
- 3-way merge of external edits, annotated to skip saving and isolated in undo.
- Link resolution (exact, then basename/suffix, then proximity ranking), create-on-first-edit for missing targets, and
  rename that rewrites backlinks while preserving alias/suffix/embed.
- The tiered fuzzy scorer (exact > prefix > substring > subsequence > typo, with boundary bonuses and a geometric mean
  over tokens), with Korean adjustments.
- Tantivy plus a CJK-bigram tokenizer in Rust for full-text search, with a 3 s deadline, max 50 results, at most 3
  excerpts per file of 240 chars, highlights as UTF-16 ranges, and newer queries cancelling older ones.

**Avoid / do differently**
- About 20 separate full-tree StateFields recomputed on every cursor move.
- Per-element margins plus first/last-child resets for rendered blocks. Use sibling-pair spacing.
- Codepoint sort order and no NFC normalization.
- Rename as copy+delete. Use an OS `rename` in Rust, and two-step via a temp name for case-only renames on
  case-insensitive file systems.
- Hard delete without a trash. Use the OS trash (`trash` crate) for a desktop app.
- Inserting dropped files at the last cursor instead of the drop point.
- A modal-prompt rename in the tree. Use inline rename.
- Undo history lost on every page switch.

## 13. Constants cheat-sheet

| Constant | Value | Where |
|---|---|---|
| Autosave debounce / retry | 1000 ms / 10 s | `client/content_manager.ts` |
| Pre-navigation index wait cap | 2 s | `client/content_manager.ts` |
| Pointer preview release | 100 ms (0 with Alt) | `client/codemirror/editing/pointer_preview.ts` |
| Click drag threshold | 4 px | `client/codemirror/editor_state.ts` |
| Force-parse lookahead / budget | +2500 chars / 100 ms | `client/codemirror/editor_state.ts` |
| Enter `ensureSyntaxTree` budget | 500 ms | `client/codemirror/editing/markdown_enter.ts` |
| Watcher debounce / tick / flood / poll | 75 ms / 25 ms / >20 / 30 s | `server/src/watcher.rs` |
| Expected-write TTL / hash cache | 30 s / 10 000 | `server/src/fs_guard.rs` |
| Client event batch / full-list threshold | 250 ms / ≥4 | `client/realtime_events.ts` |
| Poll: open file / listing | 3 s+jitter / 10 s+jitter | `client/space.ts`, `client/client.ts` |
| Search deadline / min chars / max results / max file | 3 s / 2 (1 CJK) / 50 / 1 MiB | `server-search/src/limits.rs` |
| Search terms / query bytes / concurrency | 16 / 4096 / 8 (+1 s queue) | `server-search/src/limits.rs` |
| Name boost / passages / excerpt / lead | ×2.0 / 3 / 240 / 80 chars | `server-search/src/fulltext/{query,passage}.rs` |
| Index apply window / reconcile | 500 ms fixed / 10 min | `server-search/src/sync.rs` |
| Tree spring-load / chunk / row est. / max window | 700 ms / 200 / 36 px / 1000 | `plug-api/ui/tree_view.tsx` |
| Table height fallback | rows × 42 px | `client/codemirror/syntax/table.ts` |
| Widget height cache | 1000 entries, 2 s flush | `client/widget_cache.ts` |
| Max upload/document | 10 MiB | `plug-api/constants.ts` |
| Heading sizes / hang | 1.5/1.2/1.1/1 em; 2–7 ch | `client/styles/editor.scss` |
| Editor font / width | 18 px / 800 px | `client/styles/theme.scss` |
| Fuzzy tiers | 1.0 / .95–.9 / .8–.75 / .30–.65 / .25–.15 | `plug-api/lib/fuzzy.ts` |
| Fuzzy field weights | basename 1.0, displayName .9, path .85, aliases .85 | `client/lib/fuzzy_search.ts` |
| Completion recency boost | −log2(days+1) | `plugs/editor/complete.ts` |
