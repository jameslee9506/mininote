# mininote — Functional Requirements

This spec synthesizes the seven open-source analyses in this folder (2026-11-08). It says **what** mininote must do, under stable IDs. [TECHNIQUES.md](TECHNIQUES.md) says **how** to build the hard parts in our stack. `docs/ARCHITECTURE.md` and `docs/DESIGN.md` are the implementation plan; §14 lists where this spec asks them to change.

**Sources.** Each tag points to a research note in this folder, and `§` numbers refer to that note's sections.

| Tag | Project | Note |
|---|---|---|
| OB | Obsidian (help vault, release notes, API typings) | `obsidian-baseline.md` |
| ZT | Zettlr | `zettlr.md` |
| SB | SilverBullet | `silverbullet.md` |
| MT | MarkText | `marktext.md` |
| MS | mdSilo | `mdsilo.md` |
| CM | ixora + ink-mde (CodeMirror 6 live-preview libraries) | `cm6-live-preview-libs.md` |
| OT, WR | Otterly and Writer Computer (Tauri 2 apps) | `tauri-notes-discovery.md` |

**Priorities.**
- **P0**: needed for the first usable release (MVP).
- **P1**: right after the MVP.
- **P2**: later, and only if it stays light.

Anything not listed is out of scope (§13).

**Format.** Each requirement has a title, the behavior (acceptance criteria), edge cases, a one-line **Decision** when the sources disagree, and its sources. An ID never changes meaning. New requirements get new numbers, and a dropped requirement is marked *withdrawn*; its number is never reused.

**[critic]** marks text that the adversarial completeness review (2026-11-08) added or changed. *Changed:* introduces a correction to earlier text. "Verified" means the claim was checked against the installed crate or package source.

---

## 0. Product principles

1. **Plain files, never rewritten.** A vault is any local folder, and notes are UTF-8 `.md` files in nested folders. mininote changes only what the user typed. Opening and saving an untouched note leaves it byte-identical: line endings, BOM, trailing newline, escapes and list markers all stay. There are no smart quotes, no autocorrect, no reformatting and no forced final newline.
2. **The vault stays clean.** The app writes into the vault only what the user creates: notes, folders, pasted attachments, and (rarely) conflict copies. Settings, sessions and caches live in the OS app-data folder.
3. **Obsidian-like, but light.** One window and one vault, with a folder tree, an editor with live preview, a reading view, a quick switcher and links. Plugins, graph view, canvas, sync, publishing, math, diagrams, tabs and split panes are out (§13).
4. **Minimal monotone UI.**
   - Colors are grays and white, with a dark variant. There is no accent color.
   - There are no visible labels, toolbars, status bar, "Saved" text, placeholders or tooltips. Icons carry `aria-label`s.
   - Text appears only where it *is* content (note names, document text) or where it is essential (settings labels, confirmations of irreversible actions, error messages).
5. **15 px base.** All type sizes and spacing derive from `--fs-content` (15 px by default), so changing the base size scales everything.
6. **Saved while typing.** There is no save button, save dialog or "unsaved changes" prompt. An edit reaches disk within about 2 seconds, including while a Hangul syllable is still composing [critic] (EDIT-11); notes over 2 MB take up to 10 s [critic] (SAVE-11). Nothing typed is lost on note switch, close, quit or external edits.
7. **Clean Markdown with spacing between blocks.** Vertical space exists only *between* adjacent blocks, and the pair (previous, next) decides how much. Blocks never own margins.
8. **Fast on every desktop.** Tauri 2 (the system webview) with an HTML/CSS UI. macOS and Windows at launch, Linux soon after. Typing never stutters, and the tree shows within a second.
9. **Korean first.**
   - Hangul IME composition never triggers commands or loses characters.
   - NFC and NFD Hangul file names behave the same.
   - Search and the switcher match Korean correctly.
10. **Minimal verification.** Type checks and unit tests for pure logic only. No integration or E2E tests, and nobody launches the app to verify (the owner's rule). Tricky behavior therefore belongs in pure, testable functions.

**When sources disagree**, decide in this order:
1. Never lose data, local or external.
2. Prefer the option with less UI.
3. Keep vaults Obsidian-compatible.
4. Take the simplest implementation.

---

## 1. Vault (VAULT)

#### VAULT-01 · Open a folder as the vault · P0
- **Behavior.**
  - With no vault open, the window shows only a centered open-folder icon button and, below it, the names of recent vaults (VAULT-05).
  - The native folder dialog picks the folder. The backend canonicalizes it and requires a readable directory, which becomes the window's single root.
  - The tree appears from a metadata-only listing. Nothing waits for indexing.
- **Edge cases.**
  - Symlinked root: the canonical path is the identity, and the folder name is shown.
  - A drive root or the home folder is allowed. The listing stops at 100,000 entries and skips dot-folders, so the app stays responsive.
  - An unreadable or vanished folder shows an error toast and keeps the empty state.
  - [critic] When the listing hits the cap, one error toast says so, because silently missing notes look like data loss. Re-lists of such a vault are throttled (PERF-05).
  - [critic] Nested vaults need nothing special. A folder inside another vault, or one that contains an Obsidian vault, opens like any folder, and each canonical path keeps its own session.
  - [critic] On Windows, a mapped network drive canonicalizes to its UNC form (`\\server\share\…`). That form is the identity, so asset URLs and reveal must accept UNC roots (Obsidian needed fixes for images on network drives [OB §10]).
- **Decision.** Allow any folder and cap the listing, instead of refusing the home folder as ZT does. Users keep notes in odd places, and the cap protects performance.
- **Sources.** OB §2, ZT §2, MT §1, OT §3, MS §1.

#### VAULT-02 · Reopen the last vault · P0
- **Behavior.** On launch, reopen the last vault directly. If it is missing or unreadable, show the empty state, where the missing entry appears muted in the recent list.
- **Edge cases.** [critic] On macOS, the automatic reopen of a vault inside Documents, Desktop, Downloads or iCloud Drive, or on a removable or network volume, can raise the OS privacy prompt. If access is denied, the vault counts as unreadable; the app adds no explanation text.
- **Decision.** Reopen automatically (OB, MT, MS, WR) instead of showing a vault picker on every launch (OT). It saves steps for single-vault users.
- **Sources.** OB §2, MT §1, MS §1, OT §3.

#### VAULT-03 · Restore the session · P0
- **Behavior.** Per vault, restore:
  - the last open note, with its selection and scroll position;
  - the expanded folders;
  - the edit or reading mode;
  - the recently opened list (NAV-01).

  Window bounds are global (PLAT-04). State is saved with a debounce of about 1 s and flushed on quit.
- **Edge cases.**
  - A remembered note that no longer exists opens nothing.
  - Selections are clamped to the current document length.
  - Expanded entries for missing folders are dropped.
  - A moved vault gets a new identity and starts fresh. This is accepted.
- **Sources.** OB §2, §6.3; MT §1; ZT §2, §5.1; WR (tauri-notes-discovery §3).

#### VAULT-04 · App state lives outside the vault · P0
- **Behavior.** Settings and per-vault sessions are stored in the OS app-config folder, keyed by the vault's canonical path, and use vault-relative paths inside. mininote never creates a dot-folder or settings file inside the vault.
- **Edge cases.** [critic] Sessions are kept only for vaults on the recent list (VAULT-05). Removing a vault from the list deletes its session, so app data never grows without bound.
- **Decision.** Use app data (OB's own advice, MT, WR) instead of in-vault folders such as `.obsidian`, `.otterly` or Zettlr's `.ztr-directory`. This avoids git churn and sync conflicts, and puts no files in the vault that the user did not create.
- **Sources.** OB §2, ZT §2 (avoid), MT §1, OT §3, MS §1.

#### VAULT-05 · Recent vaults and switching · P1
- **Behavior.**
  - Up to 10 recent vaults, most recent first. They appear on the empty state and in the vault menu, which opens from the vault name in the sidebar footer.
  - Actions: open; remove from the list (never deletes files); open another folder.
  - Switching flushes saves, then replaces the window's vault.
  - [critic] If that flush fails, recovery copies are written first (SAVE-10), then every save retry of the old vault is cancelled. File commands carry the vault epoch (PLAT-08), so nothing started for the old vault can write into the new one.
- **Sources.** OB §2, MS §1, OT §3.

#### VAULT-06 · Vault becomes unavailable · P1
- **Behavior.** If the root is deleted, unmounted or loses permissions while open:
  - the tree empties and shows only a muted retry icon;
  - the open note stays in the editor and its unsaved text is kept;
  - saves keep retrying (SAVE-08) until the root returns or the user switches vaults;
  - [critic] the root is never recreated. A save or create whose root is missing fails with `root_unavailable` and never runs `create_dir_all`, which would rebuild an unmounted drive's path (for example under `/Volumes`) on the system disk. The unsaved text also goes to a recovery copy (SAVE-10, P0), so this data-safety part is P0 even though the rest of VAULT-06 is P1.
- **Sources.** MT §1 (unavailable + retry), OB §5 (ejected drive).

#### VAULT-07 · One vault per window · P0 (constraint)
- Multi-root workspaces (ZT, MT) and multiple windows (OT) are out of scope. A second launch focuses the existing window (PLAT-05).
- [critic] The single-instance part of PLAT-05 is therefore P0. Two processes on one vault would race on the same notes and on the settings file.

---

## 2. File tree (TREE)

#### TREE-01 · What the tree lists · P0
- **Listed.**
  - Folders.
  - Notes (`.md`, `.markdown`, in any letter case), shown without the extension.
  - Images (`png jpg jpeg gif webp svg bmp avif`), in muted text with their extension.
  - Everything else is hidden. Names are NFC-normalized for display only.
- **Hidden.**
  - Any entry whose name starts with `.`. This covers `.git`, `.obsidian`, `.trash`, `.DS_Store` and our own temp files.
  - Symlinks and Windows junctions, which are also never followed.
  - Names that are not valid UTF-8, because they cannot cross IPC safely.
  - [critic] On Windows, entries with the Hidden or System attribute (`$RECYCLE.BIN`, `System Volume Information`, `desktop.ini`). This is the platform's own equivalent of dot files, and a drive root is an allowed vault (VAULT-01).
- **Edge cases.**
  - Empty folders are listed, because they are real directories. SilverBullet cannot show them.
  - A `node_modules` folder is listed like any other. The entry cap (VAULT-01) protects performance.
  - [critic] An unreadable sub-folder (permission denied, a macOS privacy-protected folder) is listed without children. It never aborts the listing [ZT §10].
  - [critic] Cloud placeholders (iCloud files under "Optimize Mac Storage", OneDrive Files On-Demand) list normally, because the listing reads metadata only. Reading one downloads it and can block for seconds [WR in OT §2.1], so opening is asynchronous (SAVE-03) and search skips them (SRCH-01).
- **Decision.** Show images (OB) instead of hiding them (ZT, WR). Users paste screenshots and must be able to see, move and delete them.
- **Sources.** OB §3, ZT §3.1, MT §2, OT §4.1, MS §2, SB §3.

#### TREE-02 · Sort order · P0
- **Behavior.**
  - Folders come first, then files.
  - Within each group, names are compared in NFC with one shared `Intl.Collator(["ko", "en"], { numeric: true, sensitivity: "base" })`. So `2` sorts before `10`, case and accents are ignored, and Hangul follows standard Korean alphabetical order.
  - Ties fall back to the codepoint order of the NFC name, then to the raw name, so the order is deterministic.
- **Edge cases.**
  - NFD and NFC spellings of the same name sort together.
  - The collator is created once. ZT creates one per comparison, which is slow.
- **Sources.** OB §3, WR (tauri-notes-discovery §4.1), MS §2, MT §2, ZT §3.2, SB §11 (avoid codepoint order).

#### TREE-03 · Expand, collapse and reveal · P0
- **Behavior.**
  - Clicking a folder row toggles it, and its folder icon switches between closed and open.
  - An expanded folder is joined to its children by straight guide lines (DESIGN §4).
  - Expanded folders persist per vault (VAULT-03). They are re-keyed on rename and pruned on delete.
  - Opening a note from anywhere (switcher, link, history, search) expands its ancestors. The row scrolls into view, centered, but only when it is not already fully visible.
  - A header icon collapses all folders.
- **Edge cases.**
  - There is no reveal while an inline rename is active.
  - Reveal waits until the listing has loaded.
- **Sources.** OB §3, MT §2, ZT §3.4, OT §4.1 (avoid in-memory-only state).

#### TREE-04 · Create a note · P0
- **Behavior.**
  - Mod+N, the header icon, or a folder's context menu immediately creates `Untitled.md` on disk. The create is exclusive and never overwrites.
  - The location is the clicked folder; otherwise the active note's folder; otherwise the vault root (setting, SET-02).
  - The base name is localized (`t("untitled")`). Collisions get `Untitled 1`, `Untitled 2` and so on, checked ignoring case and Unicode form.
  - The note opens in editing mode with the caret at the start of the body, ready for typing. Clicking the inline title or pressing F2 edits the name (EDIT-15).
  - Esc in the title or body trashes the new note while its body is still untouched and empty and its title is the generated default (including a numeric suffix). It follows TREE-08, including the optional deletion confirmation and previous-note navigation. Existing notes and notes revisited after navigating away are excluded; editing and then clearing or undoing the body does not make a note eligible again. A custom title being typed is reverted on Esc instead. Menus, dialogs, find panels and completions take Esc first; IME composition and key repeat never delete a note.
- **Edge cases.**
  - The sidebar or inline title may be hidden; the body still takes focus. Creating from reading view or an image also opens the editor before focusing it.
  - If creation fails, an error toast appears and nothing opens.
- **Decision.** Create the real file at once (OB, WR). The alternatives are worse: an unsaved draft (OT) is never autosaved, which breaks principle 6, and a name-first inline row (ZT, MT) delays writing.
- **Sources.** OB §3, §4.2; WR (tauri-notes-discovery §4.1); OT §4.3 (avoid); ZT §3.3; MT §2.

#### TREE-05 · Create a folder · P0
- **Behavior.** Mod+Shift+N, the header icon, or the folder context menu opens an inline input row inside the target folder, which expands. Enter creates the folder. Esc, blur or an empty name cancels and creates nothing.
- **Decision.** Unlike notes, folders are created only on commit. An empty "Untitled" folder holds nothing worth keeping.
- **Sources.** OB §3, MT §2, ZT §3.3.

#### TREE-06 · Inline rename · P0
- **Start.**
  - F2 on the focused tree row, or on the open note (which focuses the inline title), or the context menu.
  - The row text becomes an input at the same position and size, with the stem selected. Notes hide `.md`; other files keep their extension outside the selection.
- **Commit and cancel.**
  - Enter commits, and so does blur when the name is valid and changed.
  - Esc, a right-click, or blur with an invalid or unchanged name cancels.
  - The input closes before the asynchronous rename starts, so it cannot submit twice.
  - Enter and Esc do nothing during IME composition.
- **Effects.**
  - Pending saves for the note, or for anything under the folder, are flushed first.
  - Afterwards the open editor, history, editor-state cache, recent list and expanded set are re-pointed. Folder prefixes are matched with a trailing `/`.
  - Links are updated by LINK-07 (P1).
- **Edge cases.**
  - A case-only rename (`a.md` → `A.md`) works on case-insensitive filesystems.
  - An existing target is refused: the input is marked invalid and an error toast appears. Nothing is ever overwritten or deleted.
  - A name that differs from the current one only in Unicode form counts as unchanged.
  - [critic] A typed `.md` (any case) at the end of a note's new name is dropped, so `Note.md` never becomes `Note.md.md`.
- **Decision.** Commit on blur when the name is valid (MT), instead of cancelling on blur (ZT). A typed name should not be lost to a stray click.
- **Sources.** OB §3, MT §2, ZT §3.3, SB §6, OT §4.1, MS §2.

#### TREE-07 · Name validation · P0
- **Rules.** These apply to create, rename, the inline title, switcher-create and attachments.
  - Trim first.
  - Length: 1–200 characters **and** at most 255 bytes of UTF-8 including the extension, which is the ext4 and APFS limit (about 80 Hangul syllables).
  - No control characters, and none of `\ / : * ? " < > |`.
  - No leading `.`, and no trailing `.` or space.
  - Not a Windows reserved name (`CON PRN AUX NUL COM1-9 LPT1-9`, with or without extension). This holds on every OS, so vaults stay portable.
  - Notes also reject `# ^ [ ] |`, which break `[[links]]`.
  - [critic] Bidirectional controls (U+202A–U+202E, U+2066–U+2069) and zero-width characters (U+200B–U+200D, U+FEFF) are rejected too. They make two names look identical, or disguise an extension.
- **Edge cases.**
  - Files that already have such names (created by another app) are still listed, opened and edited. Only in-app creation is blocked.
  - The trailing-dot check runs after trimming.
  - [critic] A reserved name is matched on the part before the first dot, with trailing spaces removed and case ignored (`nul.md`, `Con .md`, `aux.tar.md`). The list also includes `COM0`, `LPT0`, `COM¹`–`COM³`, `LPT¹`–`LPT³`, `CONIN$` and `CONOUT$`.
  - [critic] Generated names stay inside the 255 bytes: a conflict copy (SAVE-06) truncates the stem to make room for its 27-byte suffix, and temp files never embed the note's name (SAVE-04).
  - [critic] On Windows, an absolute path longer than 259 characters (deep Hangul folders reach it) still reads and writes, because Rust switches to verbatim paths. Trash and reveal may fail there; that is an error toast, never a silent permanent delete (TREE-08).
- **Decision.** Reject link-breaking characters instead of warning about them (OB). A note that cannot be linked contradicts a link-based app, and a rejection needs no warning UI.
- **Sources.** OB §0, §3, §7.1; MT §2; OT §4.1 (avoid stripping text after the last dot); MS §2.

#### TREE-08 · Delete · P0
- **Behavior.**
  - Triggers: the context menu, the Delete key (all OS), or Cmd+Backspace (macOS) on the focused row. A bare Backspace never deletes, key repeat is ignored, and the root cannot be deleted.
  - A file goes to the OS trash at once.
  - A non-empty folder asks first, with Cancel as the default button.
  - If the OS trash is unavailable (some Linux setups, network drives), the app asks for confirmation to delete permanently, with Cancel as the default.
  - [critic] *Changed:* the open note is flushed first (SAVE-02), so the trashed copy holds the latest text. Its save controller is then frozen, and disposed only after the trash succeeds. If trashing fails, or the permanent-delete confirmation is cancelled, nothing is lost. No save may run after a successful delete, because it would recreate the file [MS §4]. The earlier wording ("a pending save is cancelled") contradicted SAVE-02 and lost the pending text whenever the trash failed.
  - [critic] A folder delete does the same for every open, cached or pinned dirty note under it (prefix match with a trailing `/`).
  - The editor then shows the previous history entry, or nothing, and the selection is cleared.
- **Setting.** "Confirm before deleting" (off by default) adds a confirmation for files too.
- **Edge cases.**
  - [critic] On macOS, trash through `NSFileManager`. The `trash` crate's default asks Finder through AppleScript, which can raise an Automation privacy prompt (verified in `trash` 5.2). A denied prompt would make every delete look like "trash unavailable" and push users toward permanent deletes.
  - [critic] The backend itself refuses to trash or delete the vault root (PLAT-08). The UI rule alone does not stop injected script.
- **Decision.** Do not confirm single files (Finder's model), unlike OB, MT and ZT, which always confirm. The trash makes the action reversible, and principle 4 asks for fewer dialogs. Folders still confirm, because one key could trash hundreds of notes.
- **Sources.** OB §3, MT §2, WR (tauri-notes-discovery §2.3), MS §2 (cancel the save first; [critic] the lesson is that no save may run after the delete), OT §2.3 (avoid permanent delete).

#### TREE-09 · Context menus · P0
- **Items.** Text only, with no icons and no shortcut hints.
  - Note or image: Rename, Delete, Reveal in Finder / Show in Explorer / Show in file manager (label per OS), Copy path (P1).
  - Folder: New note, New folder, Rename, Delete, Reveal.
  - Empty tree area: New note and New folder, both in the root.
- **Edge cases.**
  - A right-click cancels a pending inline rename.
  - Opening the menu from the keyboard (ContextMenu key, Shift+F10) is P1.
- **Sources.** OB §3, MT §2, OT §4.1, ZT §3.3.

#### TREE-10 · Drag and drop to move · P1
- **Behavior.**
  - Drag one row onto a folder. Dropping onto a note means that note's folder, and dropping onto empty tree space means the root.
  - Hovering a collapsed folder for 700 ms expands it. Within 32 px of the top or bottom edge, the tree scrolls automatically.
  - Dropping onto itself, onto a descendant, or onto its current parent does nothing.
  - A name collision at the destination is refused with an error toast.
  - Open notes are flushed first and re-pointed afterwards. Links follow (LINK-07).
- **Edge cases.**
  - dragenter and dragleave also fire for child elements, so count the depth.
  - Tree drags must not reach the editor's drop handler, and vice versa (EDIT-08).
- **Decision.** Refuse collisions (MT, OT) instead of auto-renaming. A silent rename is surprising.
- **Sources.** MT §2, ZT §3.3, OT §4.1, SB §3, OB §3.

#### TREE-11 · Keyboard navigation · P1
- **Behavior.** With the tree focused:
  - Up and Down move over the visible rows, in exactly the order they are rendered.
  - Right expands a folder, or steps into it if it is already open. Left collapses it or steps to the parent.
  - Home and End jump to the first and last row.
  - Enter opens a note and focuses the editor, or toggles a folder.
  - F2 renames. Delete or Cmd+Backspace deletes.
  - Esc returns focus to the editor.
  - Arrow keys with modifiers are not captured.
  - [critic] Mod+Shift+E focuses the tree at the open note's row, revealing it, from anywhere. Without it, the only keyboard route into the tree is Esc, then Tab out of the editor (EDIT-04).
  - [critic] Rows expose the tree pattern to assistive technology: `role="tree"` and `treeitem`, `aria-level`, `aria-expanded` and `aria-selected`, plus `aria-setsize` and `aria-posinset`, because virtualization (TREE-13) removes the other rows from the DOM.
- **Decision.** Enter opens on every platform, instead of renaming on macOS as OB does to follow Finder. One mapping works everywhere and matches the switcher.
- **Sources.** OB §3, ZT §3.4, SB §3, MT §2 (missing), OT §4.1 (missing).

#### TREE-12 · Follow external changes · P0
- **Behavior.**
  - Files and folders created, deleted or renamed outside mininote appear in the tree within about half a second.
  - Bursts of changes (git checkout, sync clients) produce a single refresh.
  - The expanded set and the selection survive refreshes.
  - [critic] Watchers miss changes on network volumes (SMB, NFS and AFP report only changes made by this machine), after the inotify fallback, and when Windows drops a burst. So when the window regains focus, the open note is checked against its baseline with one stat, and a change goes through SAVE-06. On a network volume, or after a watcher fallback, the tree also re-lists on focus.
  - [critic] A platform "rescan" notice (inotify queue overflow, FSEvents "must scan subdirectories") counts as a burst and triggers one full re-list.
- **Sources.** MT §2, OB §5, SB §5, ZT §5.3, MS §4.

#### TREE-13 · Virtualized rows · P1
- **Behavior.** Only visible rows are in the DOM, each 28 px high. Scrolling through 10,000 expanded rows stays smooth.
- **Sources.** OB §3, §9; OT §4.1; MS §2.

#### TREE-14 · More tree features · P2
- Sort modes by modification or creation time, ascending or descending, with folders always sorted by name.
- Multi-select with bulk move and delete.
- Duplicate.
- A "Move to…" folder picker.
- Sticky headers for open folders.
- Importing OS files dropped on the tree.
- A "show all file types" toggle.

Sources: OB §3, ZT §3.3–3.4, MT §2.

#### TREE-15 · Open an image file · P0 [critic]
- **Behavior.**
  - Clicking an image row, or following a link to an image, shows it in the main area: centered, scaled down to the column but never up, with no controls and no caption.
  - The inline title shows the full file name, and renaming works as for notes (EDIT-15). Mod+E, find and the editor shortcuts do nothing.
  - The image reloads when the file changes on disk (`?v=<mtime>`, TECHNIQUES §8).
- **Edge cases.**
  - SVG files are shown only through `<img>`, never inlined and never placed in `<object>`, `<iframe>` or `<embed>`, so scripts inside them never run.
  - An unreadable or broken image shows the muted empty box (READ-05).
- **Decision.** TREE-01 lists images so that users can see, move and delete them, but nothing said what opening one does. A bare viewer is the least UI.
- **Sources.** OB §3, ARCHITECTURE.md §9 (`ImageView.svelte`).

---

## 3. Editing (EDIT)

Live-preview rendering is specified separately, in §4 (LIVE).

#### EDIT-01 · The text is the document · P0
- **Behavior.**
  - CodeMirror edits the raw Markdown. Saving writes exactly the buffer, with the original line endings and BOM restored (EDIT-02).
  - The editor never reformats: no smart quotes, no autocorrect, no trailing-whitespace trimming, no forced final newline, and no list renumbering beyond what an explicit command does.
- **Acceptance.** Opening and saving an untouched note leaves the file byte-identical.
- **Edge cases.** [critic] The editor's content element sets `autocorrect="off"`, `autocapitalize="off"` and `writingsuggestions="false"` (WebKit's inline predictions on macOS 14 and later), with `spellcheck` from EDIT-14. The OS then never rewrites text either.
- **Sources.** OT §4.2 (SRC-001…013), MS §11 (avoid), MT §3.1 (avoid).

#### EDIT-02 · Line endings, BOM and encoding · P0
- **Behavior.**
  - On load, detect a UTF-8 BOM and the line ending. The first ending found wins: CRLF, LF or CR.
  - The editor works in LF. On save, the detected line ending and the BOM are restored.
  - Files that are not valid UTF-8 are refused with an error toast and are never opened for editing.
- **Edge cases.**
  - Mixed line endings are normalized to the first-found style on the first save. This is accepted.
  - The number of trailing newlines is kept automatically, because the text is never touched.
  - [critic] UTF-16 files (BOM `FF FE` or `FE FF`, which Windows Notepad's "Unicode" option writes) and files containing NUL bytes count as not UTF-8 [MT §4.4].
  - [critic] An external change that only switches the line endings or the BOM (git's `autocrlf` on checkout, for example) updates the remembered style, so the next save keeps it instead of flipping the whole file back (SAVE-06).
- **Decision.** Refuse non-UTF-8 files instead of guessing their encoding (MT). A wrong guess can corrupt files. Legacy EUC-KR/CP949 support is P2 (EDIT-17).
- **Sources.** ZT §5.2, MT §4.4, OT §4.2.

#### EDIT-03 · Smart lists and quotes · P0
- **Enter** in a list item continues the list with the same indentation:
  - `-`, `*` and `+` repeat.
  - `1.` becomes `2.`, and only the following items of that list are renumbered.
  - `- [ ]` and `- [x]` continue as `- [ ] `.
  - On an empty item, Enter outdents one level. At the top level it removes the marker, which leaves the list.
  - Enter never turns a tight list into a loose one.
- **Shift+Enter** inserts a line break inside the item, with continuation indentation and no marker.
- **Blockquotes.** Enter continues `> `. Two empty quote lines in a row leave the quote.
- **Backspace** right after list or quote markup removes one level of it. A list marker first turns into spaces, then goes away.
- **Edge cases.**
  - Inside fenced code, Enter is a plain newline.
  - If the text after the caret already starts with a marker, no second marker is added.
  - Nothing list-related happens on the Enter that commits a Hangul syllable.
- **Decision.** Use lang-markdown's commands, configured so that Enter on an empty second item leaves the list (as OB and SB do). By default lang-markdown inserts a blank line instead.
- **Sources.** CM §12, OB §4.5, SB §4.3, MT §3.5, OT §4.2.

#### EDIT-04 · Indent and outdent · P0
- **Behavior.**
  - In a list item, Tab indents the item *and its whole subtree* under the previous sibling. On a first item it does nothing.
  - Shift+Tab outdents the subtree.
  - Elsewhere, Tab inserts a tab character at the caret, or indents the selected lines. Shift+Tab outdents.
  - An open completion takes Tab first.
  - The indent unit is a tab character displayed 4 columns wide.
- **Edge cases.**
  - Files indented with spaces keep their spaces on lines the user does not touch.
  - For list structure, a tab always counts as 4 columns.
  - Tab never moves focus out of the editor. [critic] One exception stays: CodeMirror's escape hatch, in which Tab within 2 s after Esc moves focus out (verified in `@codemirror/view` 6.43). It is the only keyboard way out of the editor, so app-level Esc handling must not call `preventDefault()` when it has nothing to close. CodeMirror's `Ctrl-m` / `Shift-Alt-m` binding (`toggleTabFocusMode`) is removed, because it turns Tab into focus movement with no visible state.
- **Decision.** Use a tab character (OB's default) rather than 2 or 4 spaces. It is always deep enough for CommonMark nesting under `1. `, and it matches Obsidian vaults.
- **Sources.** OB §4.5, CM §12, OT §4.2, MT §3.5, ZT §4.3.

#### EDIT-05 · Formatting shortcuts · P0 (B, I, K) / P1 (the rest)
- **Toggle rule.**
  - With a selection: wrap it, or unwrap it when the markers sit just inside or just outside the selection. The inner text stays selected.
  - With an empty caret: insert a pair of markers with the caret between them, or step over the closing marker when the caret is right before it.
- **P0.**
  - Mod+Shift+B: `**bold**` (Mod+B toggles the sidebar).
  - Mod+I: `*italic*`.
  - Mod+K: link, as `[selection](|)` with the caret inside the parentheses.
- **P1.**
  - Mod+Shift+X: strikethrough.
  - Mod+Shift+H: `==highlight==`.
  - Mod+1 to Mod+6: heading level. Mod+0: plain paragraph.
  - Mod+L: cycle a task (`- x` → `- [ ] x` → `- [x] x` → `- [ ] x`).
  - There is no inline-code shortcut on Cmd+\`, because macOS uses that key to cycle windows.
- **Sources.** ZT §4.3, SB §4.3, OT §4.2, OB §4.4, MT §3.10.

#### EDIT-06 · Auto-pairing · P1
- **Behavior.**
  - Only `(` and `[` close automatically, so typing `[[` gives `[[]]`.
  - Typing a closer over an auto-inserted closer overwrites it, and Backspace inside an empty pair removes both characters.
  - Quotes and Markdown symbols are not paired.
- **Edge cases.** There is no pairing during IME composition.
- **Decision.** Keep the set minimal, instead of OB's pairing of quotes and symbols. Korean text uses quotes heavily, and characters the user did not type go against the spirit of EDIT-01.
- **Sources.** OB §4.5, MT §3.6, SB §4.3.

#### EDIT-07 · Paste · P1
- **Behavior.**
  - Text pastes as plain text by default.
  - A single URL pasted over a non-empty, single-line selection, outside code and links, becomes `[selection](url)` in one undo step.
  - When the clipboard holds both text and an image (as Office copies do), the text wins.
- **P2.** Converting pasted HTML to Markdown. It needs turndown, and plain text is predictable.
- **Sources.** CM §12, MT §3.7, SB §4.4, OB §4.6, ZT §4.4.

#### EDIT-08 · Paste and drop images as attachments · P1
- **Behavior.**
  - Triggers: a clipboard image when the clipboard holds no text, or image files dropped from the OS onto the editor.
  - Each image is written as a new file named `Pasted image YYYYMMDDHHmmss.<ext>`, adding ` 1`, ` 2` and so on if the name is taken.
  - It goes to the attachment location (SET-02). The default is the vault folder `attachments/`, created when first needed.
  - The editor inserts `![](relative/path)` at the caret (for a paste) or at the drop point. The path is relative to the note and uses `/`. Spaces, parentheses and [critic] `%`, `#` and `?` are percent-encoded; Hangul stays as is. [critic] Without `%`, a real name containing `%20` would decode to a space, and `#` or `?` would be read as an anchor or a query.
  - There is no dialog.
- **Edge cases.**
  - [critic] *Changed:* files dropped from the OS are always copied. With `dragDropEnabled: false`, OS drops arrive as DOM `File` objects without paths (TECHNIQUES §12), so the app cannot tell that a file is already inside the vault. Dragging the file's tree row inserts a link instead. The earlier rule ("a dropped file already inside the vault is linked") could not be implemented.
  - [critic] Dropped files that are not images are ignored.
  - Several images are inserted together once every write has finished, at a position mapped through any edits made in the meantime.
  - A tree item dropped on the editor inserts `[[title]]` (P1).
- **Decision.** Skip the naming dialog that OT and SB show; MT and OB show none. Pasting must be instant.
- **Sources.** OB §4.6, ZT §4.4, MT §3.7, SB §4.4, CM §12, OT §5 (avoid the dialog and the ASCII-only name sanitizer), MS §2.

#### EDIT-09 · Find and replace in the note · P0 (find) / P1 (replace)
- **Behavior.**
  - Mod+F opens a small panel pinned at the top right, with one unlabeled input.
  - Typing highlights the matches in gray.
  - Enter goes to the next match and Shift+Enter to the previous one. Mod+G and Mod+Shift+G do the same.
  - Esc closes the panel and leaves the current match selected.
  - Matching ignores case by default.
  - Replace (P1) adds a second input, with replace-one and replace-all. [critic] Mod+H on Windows and Linux, and Mod+Alt+F on macOS, open find with replace, as in Obsidian [OB §4.4]. In the replace input, Enter replaces the current match and moves on, and Mod+Enter replaces all. There are no buttons.
- **Edge cases.**
  - Enter during IME composition does not jump.
  - Pressing Mod+F again refocuses the input and selects its text.
  - The selected match reveals its syntax, like any selection. [critic] For that, the editor counts as focused while the find input has focus (LIVE-01). Otherwise everything renders, and a match inside hidden syntax, such as a URL behind a rendered link, is invisible.
  - [critic] When nothing matches, the input text turns faint. There is no match count.
  - [critic] Mod+F in reading view switches to editing with the find panel open.
  - [critic] The panel is our own (`search({ createPanel })`), because CodeMirror's default panel carries text labels and buttons.
  - [critic] NFD Hangul inside a note's text (pasted from an old macOS file name, for example) is not found by an NFC query. This is accepted, because content is never normalized (EDIT-01).
- **Sources.** CM §12 (ink-mde panel), OB §4.7, MT §3.8, ZT §4.5, OT §4.2.

#### EDIT-10 · Per-note undo, selection and scroll · P0
- **Behavior.**
  - Each of the 20 most recently opened notes keeps its own editor state: undo history, selection and scroll position. Switching back to a note restores it.
  - Undo never crosses from one note into another.
  - An external change to a cached note that is not open discards its cached state.
  - [critic] *Except* a note whose flush failed when the user switched away (SAVE-02). It stays dirty in the cache and is pinned: the 20-note limit never evicts it, it keeps retrying (SAVE-08), and an external change goes through SAVE-06 against its cached text instead of discarding it.
  - [critic] The cache, the save controllers and history are keyed by the exact stored `VaultPath` (PLAT-06), so `A.md` and `a.md` on a case-sensitive volume never share a state.
- **Sources.** OB §0 (20 files), OT §4.7, SB §8 (avoid losing undo), ZT §5.1.

#### EDIT-11 · IME-safe editing · P0
- **Behavior.** Korean (and Japanese or Chinese) composition must never duplicate or drop characters, move the caret, add stray newlines, or trigger commands. In particular:
  1. Every app-level key handler ignores events where `isComposing` is set or `keyCode` is 229.
  2. Live-preview decorations are only mapped, never rebuilt, while composing. They are rebuilt once after `compositionend`.
  3. [critic] *Changed:* autosave runs on its normal schedule during composition. A save only reads the document; it never dispatches a transaction or touches the editor DOM. Whatever does dispatch into the editor waits for `compositionend`: external reloads and merges (SAVE-06), LINK-07 edits of the open note, and refresh effects. The Korean IME keeps the last syllable composing until the next non-Hangul key, so the earlier rule ("autosave never runs mid-composition; it reschedules") could leave a sentence unsaved through any pause, broke principle 6's 2 s bound, and would flash SAVE-09's unsaved shade during ordinary typing. SB defers saves only because its save path dispatches a refresh into the editor [SB §4.5]; ours does not.
  4. List continuation and completion acceptance never act on the Enter that commits a syllable.
  5. [critic] A key that commits a syllable (Enter, Tab, Esc, an arrow) acts at most once. It either acts or needs a second press; it never acts twice, never drops the syllable, and Tab never moves focus out of the editor or an input.
  6. [critic] Mod-chords that arrive flagged as composing are ignored, so the user presses them again. Switching notes or moving focus mid-composition can drop the syllable.
- **Acceptance.** Checked by hand before each release: macOS (WKWebView), Windows (WebView2) and Linux (WebKitGTK with fcitx or ibus).
- **Sources.** OB §4.8, SB §4.5, MT §3.9, CM §10, OT §4.2, MS §3.3 (missing), ZT §4.6.

#### EDIT-12 · Multiple cursors · P1
- **Behavior.**
  - Alt+click adds a cursor. Mod+click never does, because it opens links.
  - Mod+D selects the next occurrence.
  - Esc returns to a single cursor.
- **Edge cases.** [critic] Several Linux window managers (Xfce, Cinnamon and others) take Alt+click for moving windows, so it never reaches the app there. Mod+D still adds cursors, and moving the caret into a link reveals it (LIVE-06).
- **Sources.** OB §4.4, §4.7; ZT §4.3.

#### EDIT-13 · Wrapping and text column · P0
- **Behavior.** Lines always soft-wrap. The text column is centered, with a readable width of 720 px by default (SET-02).
- **Sources.** OB §8.3, MT §7.

#### EDIT-14 · Spellcheck · P1
- **Behavior.** Off by default; a setting turns it on. Code is never spellchecked.
- **Decision.** Off by default, whereas OB turns it on. The system spellchecker is poor for Korean, and red squiggles are visual noise.
- **Sources.** OB §11, CM §7, MS §10.

#### EDIT-15 · Inline title · P0
- **Behavior.**
  - The note's file name, without `.md`, is shown above the text in heading style. It is not part of the file.
  - Clicking it, or pressing F2, edits it.
  - Enter, Tab or ↓ commits the rename and moves to the body. ↑ on the body's first line moves to the title. Esc reverts, except that it cancels an untouched new note with its default title (TREE-04).
  - An invalid or colliding name keeps the title in edit mode and shows an error toast.
  - Editor shortcuts are inactive while the title has focus.
  - [critic] Blur commits a valid, changed name, as in TREE-06. An invalid one reverts on blur, with the error toast.
  - [critic] Pasted line breaks become spaces; the title is always one line.
  - [critic] For a virtual note (LINK-05), committing a name only changes its target path. Nothing is written until the first edit of the body.
  - A setting can hide it (P1).
- **Sources.** OB §4.2, DESIGN.md §4.

#### EDIT-16 · Source mode · P1
- **Behavior.** A setting switches the editor to plain Markdown with styling only: no hiding and no widgets. Undo history and selection are kept.
- **Sources.** OB §4.2, OT §4.2, SB §4.2.

#### EDIT-17 · Later editing features · P2
- Pasting HTML as Markdown.
- Folding headings and lists.
- Renumbering ordered lists after indent or outdent.
- Opening legacy EUC-KR/CP949 files read-only.
- Wrapping a selection in Markdown symbols when one is typed.

---

## 4. Live preview (LIVE)

#### LIVE-01 · Reveal rule · P0
- **Behavior.** While the editor has focus, a construct shows its raw syntax when any selection range touches it, with both ends inclusive. Otherwise the syntax is hidden and the construct is rendered. The reveal unit depends on the construct:
  - inline constructs (emphasis, strong, strikethrough, code, highlight, link, wikilink): the outermost element;
  - heading markers, quote markers, list markers, task boxes and horizontal rules: the line;
  - fenced code and tables: the whole block;
  - frontmatter: never hidden, always shown muted.

  When the editor does not have focus, everything is rendered. [critic] The editor counts as focused while its find panel has focus (EDIT-09).
- **No reflow under the mouse, no lag under the keyboard.**
  - Decorations freeze while the primary mouse button is down, and thaw at its release: a drag never selects text that moves under the pointer, and a click shows the raw syntax the moment it completes.
  - A double or triple click selects the word or line at the caret the first click placed, not at the pointer, because that click's release may have revealed marks that shift the text under the pointer.
  - Keyboard moves never freeze: the caret landing on a heading or inside a construct reveals it in the same update. *Changed:* the earlier 100 ms hold after a keyboard line change made every ↑/↓ reveal a beat late, and it had already been dropped for same-line moves, which step through hidden characters (hidden ranges are not atomic) and could otherwise type into hidden markup.
  - A document change or window blur ends the freeze at once.
- **[critic] Block widgets.** Tables and images (P1) reveal only when a selection end (anchor or head) lies inside them, not when a selection merely spans them. Select All, or a drag across a table, must not turn the table into raw source and reflow the page.
- **Failure isolation.** If building decorations throws, the note shows as plain text, and editing keeps working.
- **Decision.** Reveal on any touching selection (OB, ZT, SB) instead of only on an empty caret (OT). It matches Obsidian, and the freeze rules remove most of the reflow that OT's rule avoids.
- **Sources.** OB §4.3, SB §4.2, ZT §4.2, CM §5, OT §4.2, MT §3.3.

#### LIVE-02 · Inline formatting · P0 (highlight P1)
- **Behavior.**
  - `**strong**`, `*em*` or `_em_`, `~~strike~~` and `` `code` `` hide their marks and style the text: strong at weight 600, emphasis in italics, strikethrough muted and struck through, and code as a gray monospace pill.
  - `==highlight==` (P1) gets a light gray background.
  - Nested marks follow their outermost element.
  - Adjacent elements, as in `**a**_b_`, hide independently.
- **Edge cases.**
  - Unclosed markers stay plain text.
  - A caret right after a closing mark reveals the element, so Backspace can reach the mark.
- **Sources.** CM §4.1, SB §4.2, OB §4.3, ZT §4.2.

#### LIVE-03 · Headings · P0
- **Behavior.**
  - In ATX headings, the `#` run and the spaces after it are hidden unless the selection is on that line.
  - The whole line gets the heading size and weight (DESIGN.md type scale), so the line box and the caret match the heading.
  - A heading with no text keeps its `#` visible.
  - A closing `#` sequence is hidden too. No hidden range ever crosses the end of the line.
  - Setext headings are styled; their underline line is muted, not hidden.
- **Sources.** OB §4.3, SB §4.2, CM §4.2 (crash bug), ZT §4.2.

#### LIVE-04 · List markers · P0
- **Behavior.**
  - `-`, `*` and `+` bullets show as `•` at exactly the marker's width, so revealing a marker never moves the text. A marker reveals when the selection touches it.
  - Ordered numbers stay visible and muted.
  - Task items hide their bullet (LIVE-05).
- **Sources.** OB §4.3, CM §6.1, SB §4.2, ZT §4.2.

#### LIVE-05 · Task checkboxes · P0
- **Behavior.**
  - In a bullet or ordered list item, `[ ]`, `[x]` and `[X]` render as a custom-drawn 14 px gray checkbox.
  - Clicking it changes exactly one character (`x` ↔ space) as a normal, undoable edit, and leaves the selection and focus where they were.
  - Checked items show muted, struck-through text.
  - The raw `[ ]` reveals when the selection touches it.
- **Edge cases.**
  - An empty task (`- [ ]` with no text) still shows a checkbox.
  - The document position is looked up at click time, not when the widget was built.
- **Sources.** CM §6.2, OB §4.3, ZT §4.2, SB §4.2, OT §4.2.

#### LIVE-06 · Links · P0
- **Behavior.**
  - In `[text](url "title")`, the `[` and the `](url "title")` are hidden, and the text is styled as a link: gray, with a 1 px underline. The text stays real, editable text.
  - Autolinks `<https://…>` hide only their angle brackets. Bare URLs are styled as links.
- **Clicks.** Targets follow LINK-01.
  - A plain click on a rendered (not revealed) link follows it without moving the caret, unless the pointer moved more than 4 px, which makes it a drag.
  - Mod+click follows a link in any state.
  - Alt+click on a rendered link places a single caret inside it, which reveals it. It does not add a cursor.
  - On a revealed link, a plain click edits normally.
- **Edge cases.**
  - An empty link text (`[](url)`) is never hidden.
  - Reference-style links (`[text][ref]`, `[text]`) stay plain text. Resolving their definitions is P2.
  - [critic] Moving the caret into a rendered link with the keyboard reveals it. That is also how to edit links where the window manager takes Alt+click (EDIT-12).
- **Sources.** OB §4.3, SB §4.2, ZT §4.2, CM §4.4.

#### LIVE-07 · Blockquotes · P0
- **Behavior.**
  - Every quote line, including lazy continuation lines, gets a left bar on the line box (so wrapped rows keep it) and muted text.
  - `> ` is hidden on each line the selection is not on. Reveal works per line, not per block.
  - Nested quotes show one bar per level.
- **Decision.** Reveal per line (CM's recommendation) instead of per block (ixora). Long quotes then do not jump when the caret enters them.
- **Sources.** CM §5, §7; SB §4.2; ZT §4.2.

#### LIVE-08 · Fenced code · P0
- **Behavior.**
  - Code lines use monospace at the code size, on a gray rounded box. The box's first and last lines come from document lines, not viewport lines.
  - While the selection is outside the block, the fence lines keep their height, but their text (including the language name) is transparent. With the selection inside, the fences show muted.
  - There are no syntax colors, to stay monotone.
  - Spellcheck is off.
- **Edge cases.**
  - An unclosed fence runs to the end of the document.
  - Indented code blocks get only the background.
- **Decision.** Make fence text transparent (SB), instead of collapsing the fence lines or using a nested editor card (OT). Reveal causes no reflow, and no block widgets are needed.
- **Sources.** SB §4.2, CM §4.3, §7; OT §4.2; ZT §4.2.

#### LIVE-09 · Horizontal rules · P0
- **Behavior.**
  - A `---`, `***` or `___` line hides its text and draws a 1 px rule on the line box, which keeps its normal height.
  - It reveals when the selection is on the line.
  - A setext underline and frontmatter fences are never treated as rules.
- **Sources.** SB §4.2, OB §4.3, ZT §4.2.

#### LIVE-10 · Frontmatter · P0
- **Behavior.**
  - Frontmatter starts at line 1 with a line that is exactly `---` (trailing spaces allowed) and ends at the next line that is `---` or `...`. Without a closing fence, it is not frontmatter.
  - Its lines show muted, in monospace.
  - Nothing inside is treated as Markdown: no horizontal rule, setext heading, emphasis or link rendering.
- **Out of scope.** A properties editor.
- **Sources.** CM §3, §11; ZT §4.1; SB §4.1; OB §4.1, §8.1.

#### LIVE-11 · Images · P1
- **Behavior.**
  - A line holding only `![alt](src)` or `![[file]]` shows the image (at most 100% wide) in place of its source while the selection is off that line.
  - With the selection on the line, the source shows and the image stays below it.
  - ↑ and ↓ from the neighbouring lines put the caret on the image's source line (CodeMirror's own motion would skip the widget); Shift extends the selection there.
  - Images inside running text show only their source. Inline previews are P2.
  - A broken image shows a muted empty box, with no text.
  - Paths resolve as in LINK-03 and READ-05.
- **Edge cases.**
  - The image's height is reserved from a cached aspect ratio, so scrolling does not jump while images load.
  - Editing text above an image never reloads it.
  - [critic] The widget builds its DOM through properties (`src`, `alt`), never `innerHTML` from note text. Its `src` passes the same resolver and scheme allowlist as READ-04 and READ-05 (`asset:`, `http(s):`, `data:image/…`).
- **Sources.** CM §6.4, SB §4.2, ZT §4.2, OT §4.2.

#### LIVE-12 · Tables · P1
- **Behavior.**
  - While the selection is outside a GFM table, the table renders as a static HTML table, keeping its alignment and scrolling horizontally.
  - Clicking a cell puts the caret at that cell's source position, which reveals the raw table in monospace.
  - ↑ from the line below and ↓ from the line above put the caret on the table's last or first source line, revealing it, instead of skipping the table; Shift extends the selection there.
  - There is no in-place cell editor.
- **Edge cases.**
  - A `|` inside a wikilink in a table must be escaped (`\|`), as in Obsidian.
  - Table heights are estimated from a cache, so scrolling does not jump.
  - [critic] Cell contents render through the reading view's sanitized pipeline (READ-04), or as plain text, never as raw HTML, because a cell may contain raw HTML from the note.
- **Decision.** Use a read-only widget (SB) rather than an editable grid (ZT, OT, OB). There are no nested editors to maintain.
- **Sources.** SB §4.2, §8; ZT §4.2; OT §4.2; OB §4.3.

#### LIVE-13 · List gutters and hanging indent · P1
- **Behavior.**
  - A list line sits in the reading view's gutter: its text starts at 1.5em per list level, whatever the source indentation. The measured width of its prefix (indentation, marker, task box, hidden quote marks) hangs for wrapped rows, and padding fills the rest, so `10.` lands its text where `9.` does.
  - Wrapped rows of a list item align with the item's text, not with the start of the line. Swapping a marker for a bullet or a checkbox never moves the text.
  - The later lines of an item (continuation text, nested quotes, code, tables) sit in the same gutter, and nested quote bars and code boxes start there. A verbatim block (code, HTML) gives up only the item's content indent, so its own indentation stays.
- **Sources.** CM §6.3, SB §4.3, ZT §4.2.

#### LIVE-14 · Wikilinks · P0
- **Behavior.**
  - In `[[target]]`, `[[target|alias]]` and `[[target#heading]]`, the brackets (and `target|` when there is an alias) are hidden unless touched.
  - The visible text is the alias, or else the target as typed.
  - Clicks follow LIVE-06.
  - Unresolved targets get a dashed, muted underline. It is applied only after the file list has loaded, so nothing flashes at startup.
  - `![[image]]` embeds render as images (LIVE-11, P1). Note embeds show as links; transclusion is P2.
- **Sources.** SB §4.2, §6; OB §4.3, §7.4; ZT §4.2.

#### LIVE-15 · Spacing between blocks in the editor · P0
- **Behavior.**
  - The editor follows the reading view's pair gaps (READ-03): between two blocks of a flow container (the document, a list item, a quote, a list for its items) the space is the same `--gap-*` token in both views.
  - A blank source line between two blocks is `--gap-blank` tall (the smallest pair gap) and stays editable; trailing blank lines keep their normal height. The first line of the block below pads the rest of the pair gap, so one blank line between paragraphs shows exactly `--gap-block`, and a heading directly followed by text shows `--gap-after-heading` with or without a blank line. Extra blank lines add `--gap-blank` each.
  - The space is padding, computed from the syntax tree only, never from the selection, so moving the caret never reflows the text.
  - No `.cm-line` and no widget root has a vertical margin.
  - Code boxes, quote bars and block widgets start below the pair padding. Inner padding does not count as a gap. An hr line is a text line with the rule across its middle; half of it counts toward each gap.
- **Edge cases.**
  - CodeMirror must never use a line whose height differs from body text (headings, code, frontmatter, padded block starts, whitespace in a shrunk blank line) to estimate line height (TECHNIQUES §1.7).
  - A list's items are spaced as the renderer spaces them: tight, loose (a blank line between items or between two blocks of an item), or holding blocks (`has-blocks`), decided per list from the tree.
  - A block widget's pair is read from the tree when the decorations are composed, so an edit above it never leaves its gap stale.
- **Sources.** DESIGN.md §3.2, CM §14, OT §4.6, OB §8.3, ZT §8.

#### LIVE-16 · First paint without raw Markdown · P0
- **Behavior.**
  - When a note opens, the visible region is parsed before the first paint, so live-preview styling is there immediately.
  - Regions parsed later in the background get their decorations as soon as the parser reaches them, without waiting for a keystroke.
- **Sources.** SB §8, CM §9.

#### LIVE-17 · Later live-preview features · P2
- Callouts (`> [!type] Title`).
- Footnotes.
- `%%comments%%`.
- Hidden escape backslashes.
- Sized images (`|300`).
- Note embeds.
- A heading `#` marker hanging in the left gutter.

Math and diagrams are out of scope.

---

## 5. Saving and external changes (SAVE)

#### SAVE-01 · Autosave timing · P0
- **Behavior.**
  - Each user edit schedules a save 400 ms after the last edit, and at most 2,000 ms after the first unsaved edit.
  - Mod+S saves immediately, without any feedback.
  - [critic] *Changed:* saves run during IME composition too, because they only read the document (EDIT-11 item 3). The earlier rule ("saves never run during IME composition; they reschedule") could postpone saving indefinitely.
  - Programmatic changes, such as external reloads, never schedule a save.
- **Decision.** 400 ms with a 2 s maximum wait (MS uses 500 ms / 2 s). The alternatives are OB's 2 s, SB's 1 s and OT's 2 s debounces, or autosave off by default (ZT, MT). This gives "saved while typing" with a bounded loss window.
- **Sources.** MS §4, OB §5, SB §5, OT §4.3, ZT §5.2, MT §4.1.

#### SAVE-02 · Flush points · P0
- **Behavior.** Pending changes are saved immediately, and in-flight writes awaited:
  - before opening another note;
  - before renaming, moving or trashing the open note or one of its folders;
  - when the window loses focus or becomes hidden;
  - when the window is closed;
  - when the app quits by any path we can intercept: macOS Cmd+Q (through a custom menu item), Ctrl+Q on Windows and Linux, the last window closing, OS shutdown requests.

  Closing and quitting never show a dialog. If a flush fails or hangs, closing still proceeds after a short timeout, and the unsaved text is kept in a recovery copy (SAVE-10). [critic] SAVE-10 is therefore P0.
- **Edge cases.**
  - macOS Dock › Quit and logout cannot be intercepted. The blur flush (the window loses focus first) and the short debounce cover them.
  - [critic] Windows shutdown or restart, and logout on any OS, may not raise a preventable exit in Tauri either. Treat them like Dock › Quit.
  - [critic] Opening another note waits for the flush for at most 2 s. If the flush fails or hangs, the switch proceeds, and the note stays dirty and pinned in the editor-state cache (EDIT-10), still retrying.
- **Sources.** OT §2.7, §5; MS §4; OB §5; SB §5; MT §4.7 (avoid dialogs).

#### SAVE-03 · Ordered, identity-bound writes · P0
- **Behavior.**
  - Only one write per file is in flight. Queued saves collapse into one, with the latest text.
  - Each save captures its file path and text when it starts, and never reads "the current file" later.
  - A note is marked clean only if its text did not change while the write was in flight.
  - A failed open never leaves the previous note's text bound to the new path.
  - [critic] A save reads the text of its own note's `EditorState`: the view's state for the open note, the cached state for an inactive one. It never reads "the view", which may show another note by then; a retry after a failed save fires after the user has switched.
  - [critic] Opens are sequenced. A slower, earlier open (a cloud placeholder, a network drive) never replaces a later one, and the current note stays visible until the new read arrives.
- **Sources.** OB §0, §5 (blanked note, lost characters, saves into the wrong file); OT §4.3; MS §4; SB §5; ZT §12.

#### SAVE-04 · Atomic, durable writes · P0
- **Behavior.**
  - Every write goes to a uniquely named, dot-prefixed temp file in the same folder. The temp file is flushed to disk (fsync), takes the original's permissions, and is renamed over the target.
  - On Windows, a rename blocked by a sharing or permission error is retried after 10, 20, 40, 80 and 160 ms.
  - On failure, the temp file is removed and the target is left untouched.
  - Temp files never appear in the tree or in watcher events.
  - [critic] The temp name does not embed the note's name (for example `.mn~<pid>-<n>.tmp`). A Hangul name near the 255-byte limit (TREE-07) would make `.<name>.mn~…` too long, and every save of that note would fail.
  - [critic] The temp file receives the original's creation time before the rename (`FileTimes::set_created` in Rust's std on macOS and Windows; verified on macOS), so a note's "created" date survives saves [OB §12]. Extended attributes (Finder tags) and hard links are not preserved; accepted.
  - [critic] A target without write permission (Unix mode bits, the Windows read-only attribute, the macOS locked flag) is never replaced. On Unix the rename would succeed, because it needs only folder permission, and would silently defeat the protection. The write fails with `read_only` (SAVE-08).
- **Edge cases.**
  - [critic] *Changed:* if the parent folder has vanished (deleted outside the app), the write returns `not_found` and SAVE-07's delete rule applies. A clean note closes. A dirty note's next save creates the file again through `note_create`, which recreates missing folders inside the vault, as MarkText does [MT §4.3]. The earlier text ("handled as an external delete … folders are not recreated silently") contradicted SAVE-07 and would have retried forever. The vault root itself is never recreated (VAULT-06).
  - [critic] Leftover temp files from a crash or power loss (ours, older than one hour) are deleted when their folder is next listed. Otherwise they show up in `git status` and in sync clients, against principle 2.
  - [critic] If the folder does not allow creating the temp file but the file itself is writable (some shared folders), the save writes in place (truncate, write, fsync) rather than failing forever. It is not atomic, so it is only a fallback.
- **Sources.** MT §4.3 (fsync; zero-filled files), OT §2.3 (Windows retry), MS §4, SB §5, OB §5.

#### SAVE-05 · Our own writes are not "external" · P0
- **Behavior.** A write by mininote never comes back as an external change:
  - The backend remembers the size and modification time of each write it made, and drops watcher events that still match them.
  - The frontend also ignores any change whose content equals the last text it saved or loaded.
  - [critic] Coarse timestamps. On FAT32 and exFAT (2 s) and some network shares, a same-size external edit within one tick matches the recorded metadata, and ticking a task in another app is a same-size edit. The registry and the save-time baseline therefore also keep a content hash, computed in Rust on read and write. When the mtime has no sub-second part, the hash decides [ZT §12, MT §4.3].
  - [critic] In-app renames and moves are recorded too, so their echoes (a `remove` of the old path) are dropped (SAVE-07).
- **Decision.** Use a metadata record plus a content comparison (SB, MS, MT) instead of "ignore the next event" lists (ZT, OT). Those lists leak and can swallow a real external edit.
- **Sources.** SB §5, MS §4, MT §4.6, ZT §5.3 (pitfall), OT §5 (pitfall).

#### SAVE-06 · External change to the open note · P0
- **Same text** as the buffer or as the last saved text: ignore the change and update the baseline.
- **Buffer clean:** reload in place by applying only the changed range.
  - The cursor, selection and scroll position stay put, and there is no UI.
  - Undo reverts only the user's own edits, never the reload.
- **Buffer dirty** (unsaved local edits, about 2 s worth at most): never silently drop either side.
  - **P0.** Keep the local text in the editor. Write the disk version as a conflict copy, `<name> (conflict YYYYMMDD-HHmmss).md`, in the same folder. Then save the local text over the file. One error toast names the conflict copy.
    - [critic] Order: the copy is written first, with an exclusive create. Only after it succeeds is the local text saved over the file. If the copy cannot be written (name too long, disk full, no permission), the original stays untouched, the local text stays dirty and goes to a recovery copy (SAVE-10), and the error toast says so.
    - [critic] The copy is byte-identical to the disk version: the same bytes, or re-encoded with that version's own line ending and BOM. It keeps the original extension and truncates the stem so the name fits in 255 bytes (TREE-07). The suffix is never localized.
    - [critic] Repeated conflicts on one note within 60 s (a formatter or a second app rewriting the file after every save) update that note's newest conflict copy instead of adding files.
  - **P1.** First try an automatic three-way merge, using the last saved text as the base. If the local and external edits do not overlap, apply the external edit to the buffer and save, with no copy. Fall back to the conflict copy when they overlap.
- **Save-time check.** Before each write, if the file changed since our baseline (an external change the watcher has not reported yet), the rules above run instead of the write.
- **[critic] Composition.** A reload or merge never dispatches into the editor while an IME composition is active. It runs right after `compositionend` (EDIT-11).
- **[critic] Partial files.** If the file's size or mtime changes between the stats before and after the read, another program is still writing in place. Read again after 100 ms rather than act on a partial file [MT §4.5]. A clean reload that would empty a non-empty note waits until the file has stayed empty for 1 s, because cloud clients briefly leave empty files while syncing, and a reload is not undoable.
- **[critic] Line endings only.** A change of only the line endings or the BOM (the same text after normalization) updates the remembered style (EDIT-02).
- **[critic] Sync clients' own conflict files** (`(conflicted copy …)` from Dropbox, a `-<PC name>` suffix from OneDrive, `.sync-conflict-…` from Syncthing, ` 2` from iCloud) are ordinary notes. mininote neither merges nor hides them.
- **Decision.** Write a conflict copy, following OB Sync's precedent. The alternatives each lose data or add UI: "local wins" (ARCHITECTURE §8.2) drops the external edit, a reload prompt (ZT, MT, OT) adds a dialog, and "disk wins" (WR) drops typing. Sync clients and `git pull` really do race with typing, and a copy loses nothing without asking anything.
- **Sources.** OB §0, §5; SB §5; MT §4.5; ZT §5.3; OT §4.3; MS §4 (avoid last-writer-wins).

#### SAVE-07 · External rename or delete of the open note · P0
- **Rename or move**, seen as a watcher rename pair, or as a delete plus a create of identical content in one batch: the editor follows the new path silently and keeps its state.
- **Save-by-rename editors** (vim and others rename the file away, then write a new one): if the original path exists again at the end of the batch, treat it as a change to that path (SAVE-06), not as a move.
- **Delete:**
  - If the buffer is clean, close the note and show the previous history entry, or nothing.
  - If the buffer is dirty, keep it open. The next save recreates the file, [critic] including missing parent folders inside the vault (SAVE-04).
- **[critic] Confirm before acting.** A `remove` event for the open note is confirmed by reading the note's current path. On a case-insensitive volume, our own case-only rename reports `remove(A.md)`, which matches the renamed `a.md` by `key()`. Acting on the event alone would close the note (clean) or start a bogus conflict copy (dirty).
- **Sources.** MS §4 (vim-style saves), MT §4.5 (keep the buffer), OT §4.3 (avoid closing dirty notes), ZT §5.3, OB §3.

#### SAVE-08 · Save failures · P0
- **Behavior.**
  - The note stays dirty, and the save is retried after 1, 2 and 5 seconds, then every 10 s, and on every flush.
  - One error toast appears per run of failures.
  - [critic] *Changed from P1 to P0:* a note whose file is not writable when it opens is opened read-only. `note_read` reports it, and a faint lock icon in the top strip is the only sign. A file that becomes read-only while open fails its next save with `read_only`: the note turns read-only, its unsaved text goes to a recovery copy (SAVE-10), and one error toast appears. Retrying cannot succeed, and replacing the file would defeat the protection (SAVE-04).
- **Sources.** SB §5; OB §0, §5; MS §11 (silent failures); ZT §5.2 (marked clean on failure).

#### SAVE-09 · Unsaved state without text · P1
- **Behavior.** No "saved" text appears anywhere. When a note has had unsaved changes for more than 2 s (a stuck or failing save), its title in the tree and the inline title turn a lighter gray. They return to normal once the note is saved. [critic] Because saves run during composition (EDIT-11), the shade marks only stuck or failing saves, never a typing pause with a syllable still composing.
- **Sources.** SB §5 (title shade), DESIGN.md §1.

#### SAVE-10 · Recovery copies · P0 [critic] (was P1; snapshots stay P2)
- **Behavior.**
  - [critic] *Priority:* the P0 close path (SAVE-02) and the P0 failure rules (SAVE-04, SAVE-06, SAVE-08, VAULT-06) all fall back on recovery copies.
  - When a save fails, or closing goes ahead without a successful flush, the unsaved text is written to the app-data folder. There is one file per note path, keeping only the newest.
  - Next time that note opens, if its recovery copy is newer than the file and differs from it, the note opens from the file and a conflict copy is made from the recovery text (the same rule as SAVE-06).
  - [critic] The recovery copy stores the baseline (mtime, size, hash) it was based on. If the file still matches that baseline at the next open, the recovery text is simply restored as a dirty buffer and saved, without a conflict copy. Only when the file changed as well does the conflict-copy rule above apply.
  - [critic] A note's recovery copy is deleted after that note saves successfully, and after it has been restored or turned into a conflict copy. Otherwise every later open would make another conflict copy.
  - [critic] Writing a recovery copy has its own timeout (TECHNIQUES §4), so a stuck disk can never keep the window open.
  - Periodic snapshots, like OB's File Recovery, are P2.
- **Edge cases.** [critic] Recovery copies leave the vault's volume (an encrypted disk image, for example). They exist only after a failure and are deleted once the note saves. Copies whose note no longer exists are pruned after 30 days.
- **Sources.** OB §5, MT §4.2.

#### SAVE-11 · Large and unusual files · P1
- **Behavior.**
  - Notes over 2 MB open in source mode, without live preview, and are skipped by indexing and search snippets.
  - Files over 20 MB are refused with an error toast.
  - [critic] Notes over 2 MB save with a 2 s debounce and a 10 s maximum wait, so serializing, sending and fsyncing several megabytes never happens several times a second.
- **Sources.** OB §9 (2 MB index limit), ZT §9 (10 MB), OT §4.7.

---

## 6. Navigation (NAV)

#### NAV-01 · Quick switcher · P0
- **Behavior.**
  - Mod+O opens a centered modal: one input with no placeholder, above up to 50 results. Each result shows the title and, muted on the right, its folder path. Matched characters are bold.
  - With an empty query, it lists recently opened notes (most recent first, current note last), then recently modified ones.
  - Up and Down move. Enter opens. Esc closes and gives the editor back its focus and selection.
  - Keys do nothing while composing.
- **Create.**
  - When no result's title equals the query, a last row shows a plus icon and the typed name. Enter on that row creates the note, in the new-note location or at the typed path; folders in `a/b/name` are created too.
  - Shift+Enter always creates.
  - A newly created note opens in editing mode with the body focused, as in TREE-04.
  - Names are validated (TREE-07).
  - [critic] Every `/`-separated segment is validated, and `.`, `..` and a leading `/` are rejected. Existing folders are matched by `key()` and their stored names reused, so `Projects/x` goes into an existing `projects/` instead of creating a case twin on Linux.
- **Sources.** OB §6.1, SB §0, OT §4.4, MT §5, MS §5.

#### NAV-02 · Switcher ranking · P0 (Hangul extras P1)
- **Behavior.**
  - The query splits on spaces, and every token must match.
  - Each token is scored against the title and against the folder path, with the title weighted higher. Match tiers, best first:
    1. exact;
    2. prefix;
    3. prefix at a word boundary;
    4. substring;
    5. in-order subsequence, with bonuses for consecutive characters and word starts.
  - Recently opened notes get a small boost.
  - Ties go to the shorter title, then the shorter path, then collator order.
  - Everything is compared in NFC and lowercase.
- **Hangul (P1).** Examples use Unicode escape notation.
  - A query of initial consonants matches full syllables: `\u314E\u3131` → `\uD55C\uAE00`.
  - A partial last syllable, still being composed, matches as a prefix: `\uD558` → `\uD55C\uAE00`, `\uD55C\uAD6C` → `\uD55C\uAD6D`.
- **Sources.** OT §4.4 (tiers), SB §0, §11, §13 (fuzzy tiers), OB §6.1, MT §5 (avoid unranked regex).

#### NAV-03 · Back and forward · P1
- **Behavior.**
  - Every note opened by a link, the switcher, the tree or search is pushed onto a history. Back and forward restore a note with its selection and scroll position.
  - Keys:
    - Cmd+[ and Cmd+] on macOS;
    - Alt+← and Alt+→ on Windows and Linux;
    - Mod+Alt+← and Mod+Alt+→ everywhere (Obsidian's keys);
    - the mouse back and forward buttons.
  - Entries for deleted notes are skipped, and renamed ones are re-pointed.
  - [critic] CodeMirror's default keymap binds `Mod-[` and `Mod-]` (indent) and, on Windows and Linux, `Alt-←` and `Alt-→` (syntax moves). The history keys take precedence (PLAT-10).
- **Decision.** Add the browser-style keys alongside Obsidian's, because Ctrl+Alt+arrows rotate the screen with some Windows graphics drivers.
- **Sources.** OB §6.3, SB §4.3, ZT §6, WR (tauri-notes-discovery §4.4).

#### NAV-04 · Sidebar and top strip · P0
- **Behavior.**
  - Mod+B (also Mod+\) toggles the sidebar. Its width is adjustable between 180 and 480 px, and persisted.
  - The sidebar header holds faint icons: new note, new folder, collapse all. The search field sits below it, above the file tree, always visible (SRCH-01).
  - The main area's top strip holds faint icons: show sidebar (when hidden), back and forward, reading view.
  - On macOS both strips are window drag regions.
  - [critic] On macOS, with the sidebar hidden, the main strip reserves the traffic lights' area; otherwise they sit on top of the show-sidebar icon. In full screen, where the traffic lights are hidden, the reserved space collapses, leaving no dead click zone [OB §10].
- **Sources.** DESIGN.md §4, MT §9, OB §10.

#### NAV-05 · Open at a position · P0
- **Behavior.** Opening a note from a search result or a `#heading` link scrolls the target into view and puts the caret there.
- **Sources.** OB §6.2, ZT §6, MT §5.

#### NAV-06 · Command palette · P1
- **Behavior.** Mod+P lists every command, ranked with the switcher's scorer. Enter runs the selected one.
- **Sources.** OB §6, MT §5.

#### NAV-07 · Later navigation features · P2
- A heading jump: an outline mode inside the switcher, rather than a panel.
- Tabs.

Split panes and multiple windows are out of scope.

#### NAV-08 · Empty states · P0 [critic]
- **Behavior.** Every empty state is blank, with no hint text, logo or illustration (principle 4):
  - a vault is open but no note is (a fresh vault, or after the open note was deleted): blank paper in the main area; the top strip keeps its icons, and Mod+N and Mod+O work;
  - an empty vault: an empty tree area, whose context menu still works (TREE-09);
  - an empty note: no placeholder;
  - no search results: nothing below the input. The switcher shows only its create row (NAV-01), and find shows faint input text (EDIT-09).
- **Decision.** No requirement said what these states show, and each one invites a "No file open" or "No results" line otherwise.
- **Sources.** Principle 4, DESIGN.md §1.

---

## 7. Search (SRCH)

#### SRCH-01 · Search the whole vault · P1
- **Behavior.**
  - The search field is always shown at the top of the sidebar, above the file tree. While it holds a query the results take the tree's place; clearing it (Escape, or its ×) brings the tree back and focuses it. Mod+Shift+F focuses the field, with the text selected in the editor pre-filled.
  - The query runs 200 ms after typing stops, and a newer query cancels an older one.
  - Terms separated by whitespace must all appear (AND), and `"quoted phrases"` match as written.
  - Matching ignores case.
  - Results are grouped by note. Notes whose name matches come first, then the others by number of matches.
  - Each note shows up to 20 line snippets, with the matches in bold. Clicking a snippet opens the note at that line with the match selected (NAV-05).
  - Limits: 200 notes per response; files over 5 MB are skipped.
- **Edge cases.**
  - One unreadable file never aborts the search.
  - Highlight offsets are in UTF-16 code units, which keeps them correct for Hangul.
  - A snippet line over 240 characters is trimmed around the first hit.
  - [critic] Cloud placeholders (macOS dataless files, Windows files marked recall-on-access or offline) are skipped, so a search never downloads a whole iCloud or OneDrive vault [WR in OT §2.1].
  - [critic] Snippets and names are rendered as text. The bold matches are spans built from the offsets, never `{@html}` (READ-04).
- **Sources.** OB §6.2, ZT §6, MT §5, SB §5, §11, OT §4.4, MS §5.

#### SRCH-02 · Korean-correct matching · P1
- **Behavior.**
  - Matching works on characters, not whole words: a query for the Korean word for "note" also finds that word with a grammatical particle attached.
  - A single Hangul character is a valid query.
  - The query and the text are both NFC-normalized, so NFD text still matches.
- **Decision.** Match characters instead of building a word index (FTS5's `unicode61`, jieba). Those tokenizers split Hangul wrongly (the OT and MS pitfalls).
- **Sources.** OB §6.2 (RN v0.11.1), SB §11, OT §4.4, MS §5.

#### SRCH-03 · Later search features · P2
- Operators: `path:`, `file:`, `-exclude`, `/regex/`.
- A case-sensitivity toggle.
- Recent queries.
- A persistent full-text index, only if vaults grow past about 20,000 notes, and then with Hangul bigrams.

Replace across files is out of scope.

---

## 8. Links (LINK)

#### LINK-01 · Markdown links · P0
- **Behavior.** For `[text](target)`:
  - `http(s):` and `mailto:` targets [critic] (and `tel:`, which READ-04 already allows) open in the OS default app, and the webview never navigates.
  - A relative `.md` target opens in mininote. It is percent-decoded (the `<…>` form is allowed) and resolved against the note's folder first, then the vault root.
  - `#anchor` scrolls to the heading with that Unicode-aware slug; Hangul is kept.
  - [critic] *Changed:* images open in the viewer (TREE-15). Other local files inside the vault (P1) open in the OS default app only when their extension is on an allowlist of document and media types: PDF, plain text, CSV, office and Hangul (`hwp`, `hwpx`) documents, images other than SVG, audio and video. Any other file is revealed in the file manager instead, never opened. The earlier rule ("other local files open in the OS default app") would run a linked `.command`, `.exe` or `.lnk` from a shared vault with one click, while LINK-09 deferred the safeguard to P2.
  - A missing `.md` target behaves like an unresolved wikilink (LINK-05).
  - [critic] One shared, unit-tested `classifyHref()` makes these decisions for the editor and the reading view alike. `http(s):`, `mailto:` and `tel:` open externally; vault paths open in mininote; everything else does nothing. That includes `file:`, `javascript:`, `data:`, drive paths, UNC paths (`\\host\share`, which can leak Windows credentials over SMB) and custom schemes (`obsidian:`, `ms-…:`).
- **Edge cases.**
  - Malformed percent sequences are used as written.
  - When a file literally named `C#.md` exists, it wins over reading `#` as an anchor.
  - [critic] Relative targets are normalized against the note's folder (`./`, `../`) before lookup. A target that climbs above the vault root counts as unresolved and is never handed to the OS.
- **Sources.** MT §6, ZT §4.2, OB §7.1, CM §4.4.

#### LINK-02 · Wikilink syntax · P0
- **Behavior.**
  - Forms: `[[target]]`, `[[target|alias]]`, `[[target#heading]]` and `[[#heading]]` (same note). Each fits on one line, and `.md` is optional.
  - Folder paths use `/`, either from the vault root or relative to the note with `./` and `../`.
  - Inline code wins over wikilink syntax.
  - Inside tables, the alias pipe is written `\|`.
  - Mod+Enter opens the link under the caret. [critic] Elsewhere it keeps CodeMirror's default binding (insert a blank line below).
- **Sources.** OB §7.1, SB §4.1, ZT §4.1, OT §4.5.

#### LINK-03 · Resolution · P0
- **Rule.** Strip `#…` and `|…`, then compare in NFC, ignoring case. Try in order:
  1. the exact vault path, with or without `.md`;
  2. the path relative to the linking note;
  3. a basename or path-suffix match, preferring the linking note's folder, then the shortest path, then collator order.

  Image targets match their full file name.
- **Edge cases.**
  - The result is deterministic even with duplicate names.
  - A dotted name such as `Meeting 2024.01` is not mistaken for a file extension (the SB pitfall).
- **Decision.** Use Obsidian-compatible resolution (OB, and ZT's advice) instead of SB's ranking by folder proximity. Links written in Obsidian must resolve the same way here.
- **Sources.** OB §7.2, SB §6, ZT §7, OT §4.5, MS §6.

#### LINK-04 · `[[` completion · P0
- **Behavior.**
  - Typing `[[` opens suggestions of notes and images, ranked as in NAV-02, each showing the title and a muted folder path.
  - Enter or Tab inserts the shortest link text that resolves uniquely (the title alone, or `folder/title`). An existing `]]` is reused, and the caret ends up after it.
  - Typing `|` or `#` does not accept a suggestion. Esc closes the list.
  - The accept keys do nothing during composition.
  - There are no suggestions inside code or frontmatter.
  - [critic] The inserted link text uses the NFC display form, even when the stored name is NFD (HFS+), so the app never puts decomposed Hangul into note text. Tree drags and LINK-07 rewrites follow the same rule.
- **P1.** Heading suggestions after `#`.
- **Sources.** OB §7.3, ZT §7, SB §6, OT §4.5, MS §3.

#### LINK-05 · Unresolved links · P0
- **Behavior.**
  - Clicking an unresolved link opens an empty note for that target: at the link's folder path if it has one, otherwise in the linking note's folder.
  - The file is created on disk only when the user types the first character. Navigating away before that leaves nothing behind.
  - [critic] The target is validated when the link is clicked: each segment against TREE-07, and the result must stay inside the vault. An invalid target (`[[a:b]]`, `[[CON]]`, `[[../x]]`) shows the error toast and opens nothing. A virtual note that could never be saved would collect typing only to lose it.
  - [critic] Folder segments match existing folders by `key()` and reuse their stored names (NAV-01).
- **Decision.** Create on first edit (SB) instead of on click (OB, OT). Following links to look around must not litter the vault with empty notes.
- **Sources.** SB §5, OB §7.1, OT §4.5, MS §11 (avoid creating a note as soon as `]]` is typed).

#### LINK-06 · Backlinks · P2
- **Behavior.** A quiet, collapsed "linked mentions" list at the end of the note, grouped by source note with one line of context each. It is computed only when expanded. Unlinked mentions are out of scope. [critic] The list has no "linked mentions" heading (principle 4): a hairline separator, then the list.
- **Sources.** OB §7.4, MS §6, ZT §7, OT §4.5.

#### LINK-07 · Renames update links · P1
- **Behavior.** After an in-app rename or move of a note or folder, every wikilink and relative Markdown link to it is rewritten automatically, without a prompt:
  - Only the target part changes. The alias, `#heading`, a leading `!`, the `<…>` form, the presence of `.md` and `%20` encoding are all kept.
  - Display text equal to the old name follows the new name.
  - If the new name is ambiguous, the link switches to the path form.
  - Links inside code are untouched.
  - Open notes change through the editor (undoable), closed notes through the normal atomic write. Files whose text would not change are not written.
  - An error toast reports any files that failed.
  - External renames do not rewrite links.
  - [critic] Closed notes are re-encoded with their own line endings and BOM, so only the link bytes change.
  - [critic] Cloud placeholders are not scanned (SRCH-01); the error toast counts them as not checked.
  - [critic] Undo in the open note reverts only that note's rewrite. There is no undo for the rename itself; accepted.
- **Decision.** Rewrite automatically (OB's default) instead of asking first (ZT). There is no dialog.
- **Sources.** OB §7.5, SB §6, MS §6, OT §4.5, ZT §7.

#### LINK-08 · Heading links · P1
- **Behavior.**
  - `[[note#Heading]]` jumps to the first heading whose normalized text matches: ignoring case, in NFC, with punctuation removed and whitespace collapsed.
  - `[x](#slug)` uses Unicode-aware slugs.
- **Sources.** OB §7.2, MT §3.2, ZT §6 (avoid ASCII-only slugs), CM §15.

#### LINK-09 · Later link features · P2
- Note embeds (`![[note]]`).
- Block references (`^id`).
- Hover previews.
- Tags: `#tag` styling and search.
- Aliases from frontmatter.
- [critic] *Superseded:* a confirmation before opening executable files. LINK-01's allowlist never opens them.

---

## 9. Reading view and typography (READ)

#### READ-01 · Reading view · P0
- **Behavior.** Mod+E toggles the current note between editing and reading. The reading view renders the same text with markdown-it:
  - CommonMark plus GFM tables, strikethrough, task lists and autolinks;
  - `breaks: true`, so a single newline is a line break, matching Obsidian's default and the editor;
  - wikilinks, `==highlight==`, and frontmatter as a muted monospace block, fences included.

  It re-renders only while visible. Link clicks follow LINK-01 to LINK-05. Keeping the first visible line when switching modes is P1.
- **Sources.** OB §4.2, §8.1; MT §3.11; ARCHITECTURE.md §11.

#### READ-02 · Typography · P0
- **Behavior.**
  - Base size 15 px (`--fs-content`), line height 1.7.
  - Heading sizes from the DESIGN.md scale, all relative to the base.
  - System fonts with Korean fallbacks (Apple SD Gothic Neo, Malgun Gothic, Noto Sans KR), with the Latin face listed first. Monospace for code.
  - A readable width of 720 px, centered.
  - `<html lang>` follows the UI language.
  - Korean prose uses `word-break: keep-all` with `overflow-wrap: anywhere`.
  - The editor and the reading view share tokens, so a note looks the same in both.
- **Sources.** OB §8.3, MS §7 (font order), CM §14, DESIGN.md §2.

#### READ-03 · Spacing between blocks · P0
- **Behavior.**
  - Rendered blocks have zero margins.
  - Vertical space comes only from sibling-pair rules (`CONTAINER > :where(A + B)`) inside flow containers: the root, `blockquote`, `li`, `.callout-body` and footnotes.
  - Gaps are unitless multiples of `--fs-content` (DESIGN.md §3.1).
  - Nothing sets `margin-bottom`.
  - Tight and loose lists differ by a `loose` class added at render time, so no `:has()` is needed.
  - Wrappers such as `.table-wrap` take part like any other block.
- **Acceptance.**
  - The first child of any container has no space above it.
  - Nested quotes and lists never double their spacing.
  - Two consecutive tables get the default gap.
  - The gaps above and below a code block are symmetric.
  - Changing the base size scales every gap.
- **Sources.** DESIGN.md §3; MT §7, OB §8.3, MS §7, SB §7 and ZT §8 (all counterexamples that use per-element margins).

#### READ-04 · Sanitizing and navigation lockdown · P0
- **Behavior.**
  - All rendered HTML passes through DOMPurify.
  - Raw HTML in notes is allowed, because Obsidian notes use `<br>`, `<sup>`, `<kbd>` and `<details>`. But `script`, `style`, `iframe`, `object`, `embed`, `form` and `base` elements are removed, along with every `on*` and `style` attribute.
  - URL attributes allow only `http(s)`, `mailto`, `tel`, relative paths, `#` anchors and the local asset scheme.
  - The webview never navigates: every link click is intercepted.
  - The CSP forbids inline scripts.
  - [critic] Only the reading view uses `{@html}`. Every other surface that shows note text or file names (tree, switcher, search snippets, toasts, editor widgets, table cells) builds its DOM from text. On macOS and Linux, files created by other apps may have `<` and `>` in their names.
  - [critic] Also removed: `dialog` elements and the `popover`, `popovertarget`, `popovertargetaction` and `autofocus` attributes, because top-layer overlays could cover the app's own UI. The CSP adds `object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`; `base-uri` and `form-action` do not fall back to `default-src`.
  - [critic] Injected script could still call any IPC command, so the backend is the last line: destructive commands refuse the vault root, and every path is validated (PLAT-08).
  - [critic] Middle-click and Mod- or Shift-click on a link never open a window. wry denies new-window requests when no handler is set (verified for WebView2 in wry 0.57), and none is set.
- **Decision.** Allow raw HTML and sanitize it with DOMPurify (OB, MT) rather than turning HTML off (`html: false`, MS). Obsidian vaults stay readable, and sanitizing, the CSP and the navigation lock together keep it safe.
- **Sources.** OB §8.2, MT §7, §9, MS §7, SB §7, ZT §10.

#### READ-05 · Local images · P0
- **Behavior.**
  - `![](relative)` and `![[image]]` display local images. The path is tried relative to the note first, then relative to the vault root, then (for bare names) through the LINK-03 lookup.
  - The resolved path is the name as listed on disk, so NFC/NFD differences never break images.
  - Images load through Tauri's asset protocol, scoped to the open vault.
  - Remote `http(s)` images load, as in Obsidian.
  - A broken image shows a muted box.
  - [critic] SVG loads only through `<img>`, here and in the editor (TREE-15).
- **Sources.** OT §2.5, MS §9, CM §6.4, ZT §10, OB §10.

#### READ-06 · Code blocks and tables · P0
- **Behavior.**
  - Code blocks use monospace on gray, wrap long lines as the editor does, show the language as a faint label at the top right, and have no syntax colors. Their vertical padding is one code line, the height of the editor's fence lines.
  - Tables keep their GFM alignment and scroll horizontally inside `.table-wrap`.
- **Sources.** DESIGN.md §5, OB §8.1.

#### READ-07 · Task checkboxes in reading view · P0
- **Behavior.** Tasks render as the same custom-drawn checkbox as in the editor. Clicking one toggles that line of the source through the editor, so the change is undoable and then autosaved. [critic] Before toggling, the editor checks that the line at `data-line` really is a task item, because raw HTML in a note can forge `data-line` attributes.
- **Sources.** OB §8.1, MS §2.

#### READ-08 · CJK-friendly emphasis · P1
- **Behavior.** Emphasis next to Hangul works even when the emphasized text ends in punctuation. A Hangul word inside quotation marks or parentheses, wrapped in `**`, still renders bold when a Korean particle immediately follows the closing `**`. This holds in both the editor and the reading view, because both parsers apply the same rule.
- **Edge cases.** Other Markdown renderers, such as GitHub's, may not render these cases as bold. The source itself stays standard Markdown.
- **Risk.** [critic] Both halves lean on parser internals (markdown-it's `md.inline.State` and `scanDelims`). Pin markdown-it and keep the shared fixtures; if an upgrade breaks the override, drop the feature to P2 rather than patch deeper. It is the most over-scoped item for a light app.
- **Sources.** MT §3.2, §11.

#### READ-09 · Later rendering features · P2
- Footnotes, callouts and `%%comments%%`.
- Grayscale syntax highlighting.
- Printing and PDF export.

Math and diagrams are out of scope.

---

## 10. Settings (SET)

#### SET-01 · Storage · P0
- **Behavior.**
  - Settings live in one JSON file in the OS app-config folder.
  - Writes are atomic, debounced, and flushed on quit.
  - On load, defaults fill in missing keys, and unknown keys are dropped.
  - Nothing is written before loading finishes, so defaults never overwrite stored settings.
  - [critic] `tauri-plugin-store` 2.5 does not meet the atomic-write rule. It saves with a plain `fs::write` (truncate, then write, no fsync) and silently ignores a file it cannot parse, so its next save replaces that file with defaults (verified in the crate source). Save settings through our own atomic write, or accept that a crash during a settings write can reset them.
  - [critic] A settings file that cannot be parsed is renamed aside (`settings.json.bad`) before defaults are used. It is never overwritten in place [MT §1, §4.2].
- **Sources.** MS §8, §10; ZT §5.2, §11; OB §11.

#### SET-02 · Settings window · P1
- **Behavior.** Mod+, opens a modal with one row per setting (label on the left, control on the right) and no descriptions. Changes apply immediately.
  - Theme: System, Light or Dark.
  - Font size: 12–24 px, default 15.
  - Readable width: on or off (720 px).
  - New-note location: current folder or vault root.
  - Attachment location: the `attachments` folder, next to the note, or the vault root.
  - Inline title.
  - Spellcheck.
  - Source mode.
  - Confirm before deleting.
  - Shortcuts: the last row opens the shortcut list (SET-06).
- **Sources.** OB §11, MT §10, OT §4.9, DESIGN.md §4.

#### SET-03 · Light and dark themes · P0
- **Behavior.** Both themes are gray scales of the same tokens. "System", the default, follows the OS setting and switches live.
- **Sources.** MT §9, MS §7, ZT §10, CM §14.

#### SET-04 · Interface language · P0
- **Behavior.** The interface is always in English, regardless of the OS language, and `<html lang>` is `en`. The few UI strings go through `t()`. Notes and file names continue to support Unicode, including Korean.
- **Sources.** ARCHITECTURE.md §3, OB §8.3.

#### SET-05 · Later settings · P2
- A line-height setting.
- An option to indent with spaces.

#### SET-06 · Custom shortcuts · P1
- **Behavior.**
  - Settings → Shortcuts lists every global command and the editor commands of EDIT-05 plus Mod+Enter (open link), each with its keys. The general commands come first, then the editor's.
  - "+" listens for a key; Escape cancels. A command can hold several keys. A key's × removes it, and an empty list unbinds the command. ↺ appears once a command differs from its defaults and restores them.
  - Changes apply at once and persist in the settings file (SET-01) as the user's changes only. Commands left alone follow future default changes.
  - A key belongs to one command at most. A taken key is refused, with a toast naming its command.
  - Usable keys are function keys and keys held with Mod (or Control on macOS, or Alt on Windows and Linux). Shift-only and Option-only chords type characters (PLAT-10), and bare keys type, edit or move the caret.
  - Reserved keys are refused: clipboard, undo/redo, select all, find with its next/previous keys, replace, and on macOS the app-menu keys (Quit, Hide, Hide Others, Minimize, Full Screen) and Cmd+\`.
  - While a key is being recorded, no shortcut runs and no engine key acts (reload, print). Korean input stays safe: keys are recorded by the same physical-key fallback that matches them.
  - Fixed: find and replace, Tab/Enter/Backspace editing, ↑ to the title, mouse buttons, browser keys, and on macOS the menu's Cmd+Q.
- **Sources.** OB §11 (Hotkeys), SET-05.

---

## 11. Platform (PLAT)

#### PLAT-01 · Targets · P0 (macOS, Windows) / P1 (Linux)
- **Behavior.**
  - At launch: macOS 11 or later (WKWebView) and Windows 10/11 (WebView2).
  - Next: Linux (WebKitGTK 4.1), as an AppImage and a .deb package.
  - One codebase for all three.
- **Edge cases.**
  - No CSS `:has()`, `@property` or native CSS nesting, because older WKWebView and WebKitGTK builds lack them.
  - [critic] The build targets `safari15` outside Windows (`vite.config.ts`), so macOS 11 needs Safari 15 or later installed: Big Sur shipped with Safari 14, and WKWebView follows the installed Safari. Linux needs a WebKitGTK of the same age (Ubuntu 22.04's 2.36 or later).
  - [critic] Linux: on some NVIDIA setups, WebKitGTK's DMA-BUF renderer paints a blank window. The known workaround is `WEBKIT_DISABLE_DMABUF_RENDERER=1`, set before GTK starts (as in PLAT-11), only when an NVIDIA proprietary driver is present.
- **Sources.** OT §2, OB §10, MS §9.

#### PLAT-02 · Window chrome · P0
- **Behavior.**
  - On macOS: an overlay title bar with the title hidden. The traffic lights sit in the 40 px sidebar header, which is a drag region, and double-clicking a drag region zooms the window.
  - On Windows and Linux: the native frame.
  - There are no HTML window buttons.
  - [critic] The window title is the open note's name (NFC, no extension), or the vault name when no note is open. macOS hides it, but Mission Control, the Window menu, Alt+Tab, the taskbar and the Windows and Linux title bars show it [MS §9, MT §9].
- **Decision.** Use the native frame on Windows and Linux (OT, and ZT's native option) instead of custom HTML controls (MT, and ZT's default). It means less code, and keeps native snapping and accessibility.
- **Sources.** WR (tauri-notes-discovery §2.6), OB §10, MT §9, ZT §10.

#### PLAT-03 · No white flash at startup · P0
- **Behavior.** The window is created hidden, with the theme's background color, and shown after the first paint.
- **Sources.** MT §8, MS §9, WR (tauri-notes-discovery §2.6).

#### PLAT-04 · Window size and position · P0
- **Behavior.** The size, position and maximized state are restored. A window that would land off-screen, for example after a monitor was removed, moves onto a visible display. [critic] Wayland does not let apps place windows, so there only the size and maximized state are restored.
- **Sources.** OB §10, MT §9, ZT §10.

#### PLAT-05 · Single instance · P0 [critic] (was P1; file association stays P2)
- **Behavior.** A second launch focuses the existing window. Opening `.md` files from the OS (file association, "Open with") is P2.
- [critic] *Priority:* VAULT-07 (P0) relies on it, and `tauri-plugin-single-instance` is already a dependency.
- **Sources.** OB §10, OT §2.8, ZT §10.

#### PLAT-06 · Unicode file names · P0
- **Behavior.**
  - Paths used for file I/O stay byte-identical to what the OS listed.
  - Display, matching, sorting and comparison use NFC.
  - New names are written in NFC.
  - After a create or rename, the app adopts the name the backend reports, because HFS+ stores NFD even when NFC was requested.
  - Two paths are "the same" when their NFC forms match ignoring case. On Linux, where both can exist, an exact match is preferred.
  - [critic] Lookup versus identity. `key()` finds an entry from an untrusted spelling: a typed link, a watcher path, switcher input, a collision check. Once found, the entry is identified by its exact stored `VaultPath`, which keys editor states, save controllers, history and recovery copies, and an exact match always beats a key match. Otherwise `A.md` and `a.md` on ext4, or NFC and NFD twins on NTFS, would share one buffer, and one file would be overwritten with the other's text.
  - [critic] `key()` also maps no-break spaces (U+00A0, U+202F) to a plain space, as Obsidian's `normalizePath` does [OB §0, §10]. macOS types U+00A0 with Option+Space.
- **Sources.** OB §0, §10; SB §11; MT §9; MS §9; OT §4.8; ZT §10. All of them report missing NFC handling as a bug.

#### PLAT-07 · Case-insensitive filesystems · P0
- **Behavior.**
  - Collision checks ignore case and Unicode form.
  - Case-only renames go through a temporary name [critic] only when a direct rename does not take effect (below).
  - On case-sensitive Linux volumes, two files that differ only in case are both listed, and links prefer the exact-case match.
  - [critic] "Same entry" is decided by file identity: device and inode on Unix, and on Windows `fs::canonicalize`, which reads the stored name back through the file handle. Comparing canonical path strings is not enough on Linux, where `realpath` keeps the given case on case-insensitive mounts (exFAT, ext4 casefold) [MT §9].
  - [critic] A case-only rename is first tried directly (APFS, HFS+ and NTFS accept it), and the stored name is read back. Only if it did not change (Linux FAT and exFAT treat it as a no-op) is the temporary name used. That name keeps the note's extension, so a crash between the two steps leaves a visible note rather than a file the tree hides.
- **Sources.** SB §9, OB §3, OT §4.1, MS §11.

#### PLAT-08 · Filesystem safety · P0
- **Behavior.**
  - The webview has no filesystem plugin.
  - Every file command takes a vault-relative path. The backend rejects `..`, absolute paths and drive or UNC prefixes, and checks that the result stays inside the root.
  - Commands run off the main thread.
  - Capabilities stay minimal: core, dialog, opener, store, window-state, single-instance.
  - [critic] Component rules depend on the platform. Everywhere: reject empty, `.` and `..` components, absolute paths and NUL. On Windows only: also drive and UNC prefixes, `\`, `:` and reserved device names (TREE-07). On macOS and Linux, `\` and `:` are ordinary file-name characters. Rejecting them on every OS, as ARCHITECTURE §6.1 does, would make every read fail for exactly the notes that TREE-07 promises to keep openable.
  - [critic] No existing component of a resolved path may be a symlink or junction (one `symlink_metadata` per component, as Otterly checks for writes [OT §2.2]). TREE-01 never follows links, but a purely lexical check would let a typed link or a switcher-created `linked/x` read or write outside the vault through a symlinked folder.
  - [critic] The backend refuses to delete, trash or rename the vault root (the empty path), whatever the frontend asks.
  - [critic] Every file command carries the epoch of the vault it was issued for, and the backend rejects a mismatch (`stale_vault`). A retry, link rewrite or recovery that outlives a vault switch can then never write into the next vault [OT §2.2 (`vault_id` per command), WR epoch in OT §2.4].
  - [critic] Reveal and the LINK-01 opener run from Rust, on a path that passed these checks [OT §2.2].
- **Sources.** OT §2.1–2.3, MS §9 (avoid unscoped commands), WR (tauri-notes-discovery §2.2, avoid).

#### PLAT-09 · Opening things outside the app · P0
- **Behavior.** Web links and `mailto:` open in the OS default app. "Reveal" selects the item in Finder, Explorer or the Linux file manager.
- **Sources.** OT §2.2, ZT §10, MT §9.

#### PLAT-10 · Keyboard conventions · P0
- **Behavior.**
  - `Mod` is Cmd on macOS and Ctrl elsewhere.
  - No Option-only chords on macOS, because they type characters. No Ctrl+Alt+letter on Windows, because that is AltGr.
  - Cmd+\` stays free on macOS.
  - The macOS app menu includes the standard Edit items (WKWebView needs them for clipboard shortcuts) and a custom Quit that flushes first.
  - Windows and Linux have no menu bar. Ctrl+Q quits after flushing.
  - [critic] Shortcuts match on `e.key` and fall back to the physical key (`e.code`) when `e.key` is not ASCII. In Hangul mode, or with the Korean macOS layout, `e.key` can be a jamo or `₩` (on the backslash key), and Mod+\ would silently fail. CodeMirror's keymap already falls back this way (verified).
  - [critic] CodeMirror's `defaultKeymap` and `searchKeymap` bind keys this spec reuses (verified in `@codemirror/commands` and `@codemirror/search`): `Mod-i` (select parent syntax), `Mod-[` and `Mod-]` (indent), `Alt-←` and `Alt-→` (syntax moves, Windows and Linux), `Mod-Enter` (insert blank line), `Ctrl-m` / `Shift-Alt-m` (tab-focus toggle), `Mod-Alt-g` (a go-to-line panel with a text label) and `Mod-/` (HTML comment). Our bindings take precedence, and the last three are removed.
- **Sources.** MT §3.10, OT §2.8, ARCHITECTURE.md §6.5.

#### PLAT-11 · Korean input in the Linux AppImage · P1
- **Behavior.** Before GTK starts, if the app runs as an AppImage and the bundled input-method cache lacks the configured module (fcitx or ibus), point GTK at the system cache so Korean input works.
- **Sources.** MS §9.

#### PLAT-12 · Narrow windows · P1
- **Behavior.**
  - The minimum window size is 520×360.
  - Below about 700 px wide, the sidebar is hidden by default and opens over the content when toggled.
  - The content padding shrinks.
  - The page never scrolls horizontally.
- **Sources.** ZT §8, DESIGN.md §4.

#### PLAT-13 · No browser behavior · P0 [critic]
- **Behavior.** The webview never acts like a browser:
  - No reload, print or webview navigation from the keyboard. The capture listener cancels F5, Mod+R, Mod+Shift+R, Mod+P (until NAV-06 takes it) and Alt+←/→. Tauri 2.12 leaves WebView2's browser accelerator keys on (wry's default, verified), and a reload throws away up to 2 s of typing, every undo history and the editor-state cache.
  - The engine's own context menu, which offers Reload (and Back on WebView2 and WebKitGTK), appears only over editable or selected text. Elsewhere it is suppressed, and the tree has its own menu (TREE-09).
  - Pinch zoom, Ctrl+wheel zoom and swipe navigation stay off (Tauri's defaults). Anchor jumps never touch `location` or `history`.
  - App chrome is neither text-selectable nor draggable (`user-select: none` outside the editor, inputs and the reading view).
- **Edge cases.** If the page reloads anyway (a webview crash, a missed key), startup is idempotent: `vault_open` replaces the watcher, and no listener is registered twice.
- **Decision.** Nothing in the spec covered the engine defaults, and each one is either a data-loss path (reload) or stray UI (print, zoom, native menus).
- **Sources.** ZT §10 and MT §9 (navigation lockdown), OB §10 (Ctrl+M must not minimize).

---

## 12. Performance (PERF)

These are targets for a mid-range laptop. The owner checks them; no automated tests do.

#### PERF-01 · Startup · P0
- First paint within 500 ms of launch.
- Tree visible within 1 s for 10,000 entries, from one metadata-only listing that reads no file contents.
- The last note restored within 300 ms after that.

Sources: MT §8, ZT §9, OT §4.7, WR.

#### PERF-02 · Typing · P0
- A keystroke paints within one frame (16 ms) in notes up to 200 KB.
- No per-keystroke work grows with document length: no `doc.toString()` per transaction, decorations only for visible ranges, and one decoration pass.

Sources: CM §9, OB §4.3, MS §8.

#### PERF-03 · Opening a note · P0
A note up to 100 KB is interactive within 50 ms of the click and styled on first paint (LIVE-16). Source: SB §8.

#### PERF-04 · Big notes · P1
Notes up to 2 MB edit smoothly with live preview; larger ones fall back to source mode (SAVE-11). Sources: OT §4.7, OB §9.

#### PERF-05 · Big vaults · P1
With 10,000 notes:
- the switcher updates within 30 ms per keystroke;
- the tree scrolls smoothly (TREE-13);
- bursts of watcher events cause at most one full refresh per 250 ms;
- [critic] for a truncated or very large listing, the refresh interval grows to at least twice the last listing's duration, so a home-folder vault whose `Library` churns never re-lists continuously.

Sources: OB §9, SB §5, ZT §9.

#### PERF-06 · Search speed · P1
First results within 300 ms for 5,000 notes with a warm disk cache. Stale queries are cancelled. Sources: OB §6.2, ZT §6.

#### PERF-07 · Footprint · P1
- An installer under 15 MB.
- Idle memory well below an Electron app's.
- At most 20 cached editor states.

Sources: ARCHITECTURE.md §1, OB §0.

#### PERF-08 · Background work never blocks input · P0
- Listing, reading, writing, watching and searching run on Rust threads, never on the main thread.
- There are no synchronous IPC calls.
- Long JS work is split into chunks.

Sources: OT §2.1, §5; MS §9.

---

## 13. Out of scope

- Plugins or an extension API; a theme store; CSS snippets.
- Graph view, canvas, databases and Bases, a properties editor, query languages.
- Sync, collaboration, publishing, a web clipper, AI features, encryption.
- Math (KaTeX, MathJax), Mermaid and other diagrams.
- Tabs and split panes (tabs P2 at most); multiple windows and pop-outs.
- A slash menu, a floating formatting toolbar, block handles, a status bar, a word count display.
- Vim and Emacs modes; smart quotes and autocorrect; typewriter and focus modes.
- Multi-root workspaces; editing files outside a vault.
- Mobile apps.
- Daily notes and templates (P2 at most); spaced repetition, citations, Zettelkasten IDs.
- Replace across files; a persistent full-text index (see SRCH-03).
- [critic] Following symlinks or junctions inside a vault (TREE-01 hides them). Obsidian users who link shared folders into a vault will not see those folders.

---

## 14. Changes requested to ARCHITECTURE.md and existing code

The current plan already matches most of this spec. Where it differs, this spec asks for the following. TECHNIQUES.md gives the details.

| # | Topic | Current plan | Requested | Req |
|---|---|---|---|---|
| 1 | Dirty buffer plus an external change | Local wins (the external edit is overwritten) | Conflict copy (P0), three-way merge (P1). `note_write` takes the expected baseline (mtime + size) and returns a `conflict` error | SAVE-06 |
| 2 | Open note deleted externally | Cancel the save and close | Close only if clean; if dirty, keep the buffer and recreate the file | SAVE-07 |
| 3 | Save-by-rename editors (vim) | Follow the rename event | Treat as a modification when the original path exists again | SAVE-07 |
| 4 | BOM | Stripped and not reported | Add `FileContent.bom` and restore the BOM on save | EDIT-02 |
| 5 | Name length | 1–200 characters | Also at most 255 UTF-8 bytes including the extension | TREE-07 |
| 6 | Parser base | `markdownLanguage` | `commonmarkLanguage` + `GFM`, so no `~sub~`, `^sup^` or `:emoji:` | EDIT-01, LIVE-02 |
| 7 | Enter in lists | lang-markdown's default keymap | `insertNewlineContinueMarkupCommand({ nonTightLists: false })` with `addKeymap: false` | EDIT-03 |
| 8 | Multi-cursor modifier | CodeMirror's default, Mod+click | `clickAddsSelectionRange` set to Alt | EDIT-12, LIVE-06 |
| 9 | Line-height estimate | Not addressed | Wrap the content of lines that are taller or shorter than body text in a mark (TECHNIQUES §1.7) | LIVE-15 |
| 10 | Image widgets | Inline widget from the ViewPlugin | Block widget from the StateField, with `estimatedHeight` (only static decorations shape the height map) | LIVE-11 |
| 11 | Unresolved wikilink click | Create the note, then open it | Create on first edit | LINK-05 |
| 12 | Path equality | Not fully specified | Always compare with `key()`; adopt the names the backend reports after create or rename | PLAT-06 |
| 13 | Back/forward keys | Mod+Alt+arrows | Also Cmd+[ / Cmd+] on macOS and Alt+arrows on Windows/Linux | NAV-03 |
| 14 | Reading-view checkbox | `<input disabled>` | An element that receives clicks; a disabled input may swallow them | READ-07 |
| 15 | Table alignment | markdown-it's `style="text-align"` | Convert to classes, because `style` attributes are sanitized away | READ-04, READ-06 |
| 16 | Close handler | Flush, then destroy | try/catch plus a timeout so the window always closes; a recovery copy on failure | SAVE-02, SAVE-10 |
| 17 | Search case folding | `to_lowercase` plus a character-index map | A per-character map that tolerates lowercasing that changes length | SRCH-01 |
| 18 | Delete confirmation | A `confirmDelete` setting | Off by default for files; folders and permanent deletes always confirm | TREE-08 |
| 19 | [critic] Saves during IME composition | Rescheduled until composition ends (§8.1) | Saves run while composing; only dispatches into the editor wait | EDIT-11, SAVE-01 |
| 20 | [critic] Delete order | Cancel the pending save, then trash (TECHNIQUES §11) | Flush, freeze, trash, and dispose the controller only on success | TREE-08 |
| 21 | [critic] Missing parent folder on save | `note_write` refuses; `note_create` recreates any parent | Recreate folders inside the root only; a missing root returns `root_unavailable` | SAVE-04, SAVE-07, VAULT-06 |
| 22 | [critic] Temp names | `.<name>.mn~` and `from.mn-tmp-<n>` | A temp name that never embeds the note's name; a case-rename temp that keeps the extension; stale temps cleaned | SAVE-04, PLAT-07 |
| 23 | [critic] Path guard | Rejects `\` and `:` on every OS; lexical only | Per-platform component rules, no symlink components, the root protected, a vault epoch per command | PLAT-08 |
| 24 | [critic] Symlinked write targets | Written through, non-atomically | Unreachable: never listed, and rejected by the path guard | PLAT-08, TREE-01 |
| 25 | [critic] Self-write registry | `(mtime, Instant)` with a 2 s TTL | `(size, mtime, hash)` per path in an LRU; renames recorded too | SAVE-05 |
| 26 | [critic] Watcher | Follows symlinks (notify's default); no row for rescan events | `with_follow_symlinks(false)`; `Flag::Rescan` → `any`; a re-check on window focus | TREE-12 |
| 27 | [critic] Exit fallback timer | 1,500 ms | 4,000 ms, longer than the frontend's flush plus recovery-copy budget | SAVE-02 |
| 28 | [critic] Trash on macOS | The `trash` crate's default (Finder through AppleScript) | `DeleteMethod::NsFileManager` | TREE-08 |
| 29 | [critic] Settings store | `tauri-plugin-store` (`fs::write`; parse errors ignored) | An atomic write; an unparsable file is set aside | SET-01 |
| 30 | [critic] Read-only files | Replaced by the atomic rename | Refused with `read_only`; opened read-only | SAVE-04, SAVE-08 |
| 31 | [critic] Save payload | A JSON string argument | Raw bytes with path, baseline and epoch in headers | SAVE-03 |
| 32 | [critic] Engine defaults | WebView2 accelerator keys and the engines' context menus left on | Cancelled or suppressed | PLAT-13 |
| 33 | [critic] Shortcut matching | `e.key` only; CodeMirror's default keymap kept whole | `e.key`, then the physical key; conflicting defaults overridden or removed | PLAT-10 |

---

## 15. Priority index

**P0**
- VAULT-01–04, VAULT-07, [critic] VAULT-06 (never recreating the root).
- TREE-01–09, TREE-12, [critic] TREE-15.
- EDIT-01–05 (B, I, K), EDIT-09 (find), EDIT-10, EDIT-11, EDIT-13, EDIT-15.
- LIVE-01–10, LIVE-14, LIVE-15, LIVE-16.
- SAVE-01–08 ([critic] including read-only notes), [critic] SAVE-10 (recovery copies).
- NAV-01, NAV-02, NAV-04, NAV-05, [critic] NAV-08.
- LINK-01–05.
- READ-01–07.
- SET-01, SET-03, SET-04.
- PLAT-01 (macOS, Windows), PLAT-02, PLAT-03, PLAT-04, PLAT-06–10, [critic] PLAT-05 (single instance), PLAT-13.
- PERF-01, PERF-02, PERF-03, PERF-08.

**P1**
- VAULT-05, VAULT-06.
- TREE-10, TREE-11, TREE-13.
- EDIT-05 (the other shortcuts), EDIT-06, EDIT-07, EDIT-08, EDIT-09 (replace), EDIT-12, EDIT-14, EDIT-16.
- LIVE-02 (highlight), LIVE-11, LIVE-12, LIVE-13.
- SAVE-06 (merge), SAVE-09, SAVE-11. ([critic] SAVE-10 moved to P0.)
- NAV-02 (Hangul extras), NAV-03, NAV-06.
- SRCH-01, SRCH-02.
- LINK-04 (headings), LINK-07, LINK-08.
- READ-08.
- SET-02, SET-06.
- PLAT-01 (Linux), PLAT-11, PLAT-12. ([critic] PLAT-05 single instance moved to P0.)
- PERF-04–07.

**P2**
- TREE-14, EDIT-07 (HTML paste), EDIT-17, LIVE-17, SAVE-10 (snapshots), NAV-07, SRCH-03, LINK-06, LINK-09, READ-09, SET-05, PLAT-05 (file association).
