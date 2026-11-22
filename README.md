# mininote

A lightweight, local Markdown notes app inspired by Obsidian. Open any folder as a vault, browse its `.md` files in a tree, and write with autosave.

- **A quiet, monochrome interface**: shades of gray, with icons wherever a text label is unnecessary. All interface text is in English.
- **15px text by default**: rendered Markdown defines vertical spacing *between adjacent blocks* using sibling-pair rules.
- **Windows · macOS · Linux**: built with Tauri 2, using the system webview to keep the app small.

## Getting started

Requirements: Node 20.19+ (or 22.12+, 24+) and a stable Rust toolchain (1.90+). On Linux, install the [Tauri system dependencies](https://tauri.app/start/prerequisites/), including WebKitGTK.

```bash
npm install
npm run tauri dev      # Run in development mode
npm run tauri build    # Create release bundles (dmg, msi/nsis, deb/AppImage, etc.)
```

Type checks and unit tests:

```bash
npm run check          # Svelte and TypeScript checks
npm test               # Unit tests (Vitest)
(cd src-tauri && cargo check && cargo test --lib)
```

## Features

| Area | Features |
|---|---|
| Vaults | Open a folder, revisit recent vaults, and restore the last note and scroll position. Open another window to work in another folder; every window comes back at the next launch. Settings live in the app's configuration folder, outside the vault. |
| File tree | Natural sorting with folders first, inline creation and renaming, drag to move, copy and paste to duplicate a file, deletion through the OS trash, keyboard navigation, and virtual scrolling. |
| Editor | Obsidian-style live preview powered by CodeMirror 6, hiding syntax away from the cursor. Supports tables, images, checkboxes, `[[wikilinks]]` with completion, `==highlights==`, find and replace, and images pasted or dropped as attachments. A typed arrow such as `->` becomes `→`. A copy button in the top strip copies the whole text of the open note or code file. Handles Korean IME composition safely. |
| Saving | Atomic saves 0.4 seconds after typing stops, or at least every 2 seconds while typing continues. External changes reload automatically; if there are unsaved edits, the disk version is kept as a conflict copy. Failed saves leave a recovery copy. |
| Reading view | Toggle with `Mod+E`. Markdown is rendered with markdown-it and sanitized with DOMPurify. |
| Code files | Source, configuration and plain-text files open in a read-only viewer with syntax colors for the common languages, line numbers and find. The code font is a setting. |
| Appearance | System, light or dark theme, three icon sets for the tree, the font size and the line width. The text, the large headings and code each take a font of your choice, such as a classic serif for the headings. |
| PDFs | PDFs open in a viewer that works like Chrome's: continuous pages, a toolbar with the page number, zoom, fit and rotate, a side panel with thumbnails and the document outline, text selection, links and find (`Mod+F`). A link to a PDF in a note opens it. |
| Search | Quick switcher (`Mod+O`) with fuzzy matching, including Hangul initial consonants; full-text search in Rust (`Mod+Shift+F`); and a command palette (`Mod+P`). |
| Updates | Signed releases on GitHub. The app checks once at launch; when a newer version exists, an update icon appears that downloads it, installs it and restarts. Settings show the running version. |
| Command line | `mininote .` opens a folder from a terminal, and `mininote notes/todo.md` opens a file in its folder: in the window that shows that folder already, else in an empty or a new window. Commands such as `mininote ls`, `read`, `append` and `edit` list, read and change notes right in the terminal, for scripts and AI agents. See [below](#command-line). |

## Keyboard shortcuts (`Mod` = ⌘ on macOS, Ctrl elsewhere)

| Shortcut | Action |
|---|---|
| `Mod+N` / `Mod+Shift+N` | New note / new folder |
| `⌥⌘N` (macOS) · `Ctrl+M` | New window |
| `Mod+W` | Close the window |
| `Esc` | Move an untouched new note with its default title and empty body to the trash |
| `Mod+O` · `Mod+P` · `Mod+Shift+F` | Quick switcher · command palette · full-text search |
| `Mod+E` | Toggle reading and editing views |
| `Mod+B` / `Mod+\` | Toggle sidebar |
| `Mod+,` | Open settings |
| `Mod+[` `Mod+]` (macOS) · `Alt+←/→` · `Mod+Alt+←/→` | Go back / forward |
| `F2` | Rename the current note |
| `Mod+C` / `Mod+V` on a file in the tree | Copy its path / paste a copy of that file into the selected folder |
| `Mod+Shift+B` · `Mod+I/K` · `Mod+Shift+X/H` | Bold · italic / link · strikethrough / highlight |
| `Mod+L` | Toggle checkbox |
| `Mod+1…6` / `Mod+0` | Set heading level / plain paragraph |
| `Mod+Enter` | Open the link under the cursor |
| `Mod+F` | Find and replace in the current note; find in the current PDF |
| `Mod+=` / `Mod+-` / `Mod+0` | Zoom a PDF in / out / back to the default |

## Command line

```bash
mininote .                 # Open the current folder
mininote notes/todo.md     # Open the folder notes and show todo.md in it
mininote ~/work ~/journal  # One window for each folder
```

When the first word is a command, mininote works on the notes of a vault right in the terminal and opens no window. A script or an AI agent can use it this way, whether the app is running or not:

```bash
mininote vaults                                # The vaults mininote knows: name and path
mininote ls -R --vault notes                   # Every file of the vault "notes"
mininote read journal/today.md                 # Print a note
mininote create ideas/cli.md --text "# CLI"    # A new note; fails if the path is taken
echo "- call Mina" | mininote append todo.md   # Add a line to a note, or create the note
mininote edit todo.md --old "- call Mina" --new "- [x] call Mina"
mininote write todo.md < draft.md              # Replace the whole text of a note
mininote mkdir archive/2026                    # A new folder
mininote mv todo.md archive/2026/todo.md       # Rename or move
mininote rm archive/2026/todo.md               # Into the system's trash
mininote search meeting notes --json           # Full-text search, as JSON
```

- **The vault** is the one `--vault` names, by its name or by the path of a folder. Without it, a command works in the vault the current folder belongs to, else in the vault opened last.
- **Paths** are relative to the vault's folder, as `mininote ls` prints them. Hidden files are out of reach, and only notes (`.md`, `.markdown`) are written.
- **Text** comes from `--text`, or from standard input. `write` replaces the text of a note, `append` adds to it, and `edit` replaces one exact piece of it (`--all` for every place it is in).
- **Output** is plain lines, or JSON with `--json`. Errors go to standard error, and the exit status is 0, 1 for a failure, or 2 for a command that was not understood. `mininote --help` and `mininote <command> --help` explain each command.
- A running app shows what a command changed, as it shows any other program's change.
- A folder or a file named like a command opens as `mininote ./ls`.

The command is not installed with the app:

- **macOS**: turn on *“mininote” terminal command* in the settings (`Mod+,`). It writes `/usr/local/bin/mininote`, for which macOS may ask for an administrator's password once. Turning it off removes the file.
- **Linux**: the `.deb` and `.rpm` packages put `mininote` in the PATH. For the AppImage, link the file into a folder of your PATH under that name.
- **Windows**: add the install folder to the PATH; the installer does not do it yet. The app has no console of its own, so a command's output is read through a pipe or a file (`mininote vaults | more`).

## Documentation

- [Architecture](docs/ARCHITECTURE.md): structure, IPC contracts, autosave and sync protocols, and editor and live-preview design.
- [Design system](docs/DESIGN.md): monochrome design tokens and spacing between blocks.
- [Releasing](docs/releasing.md): versioning, the updater signing key, and the GitHub Releases pipeline behind in-app updates.
- [Research](docs/research/): analyses of Obsidian, Zettlr, SilverBullet, MarkText, mdSilo, Otterly, and related projects; [functional requirements](docs/research/REQUIREMENTS.md); and [implementation techniques](docs/research/TECHNIQUES.md).
- [Development conventions](CLAUDE.md): project rules and coding conventions.
