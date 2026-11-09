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
| Vaults | Open a folder, revisit recent vaults, and restore the last note and scroll position. Settings live in the app's configuration folder, outside the vault. |
| File tree | Natural sorting with folders first, inline creation and renaming, drag to move, deletion through the OS trash, keyboard navigation, and virtual scrolling. |
| Editor | Obsidian-style live preview powered by CodeMirror 6, hiding syntax away from the cursor. Supports tables, images, checkboxes, `[[wikilinks]]` with completion, `==highlights==`, find and replace, and images pasted or dropped as attachments. Handles Korean IME composition safely. |
| Saving | Atomic saves 0.4 seconds after typing stops, or at least every 2 seconds while typing continues. External changes reload automatically; if there are unsaved edits, the disk version is kept as a conflict copy. Failed saves leave a recovery copy. |
| Reading view | Toggle with `Mod+E`. Markdown is rendered with markdown-it and sanitized with DOMPurify. |
| Search | Quick switcher (`Mod+O`) with fuzzy matching, including Hangul initial consonants; full-text search in Rust (`Mod+Shift+F`); and a command palette (`Mod+P`). |

## Keyboard shortcuts (`Mod` = ⌘ on macOS, Ctrl elsewhere)

| Shortcut | Action |
|---|---|
| `Mod+N` / `Mod+Shift+N` | New note / new folder |
| `Esc` | Move an untouched new note with its default title and empty body to the trash |
| `Mod+O` · `Mod+P` · `Mod+Shift+F` | Quick switcher · command palette · full-text search |
| `Mod+E` | Toggle reading and editing views |
| `Mod+B` / `Mod+\` | Toggle sidebar |
| `Mod+,` | Open settings |
| `Mod+[` `Mod+]` (macOS) · `Alt+←/→` · `Mod+Alt+←/→` | Go back / forward |
| `F2` | Rename the current note |
| `Mod+Shift+B` · `Mod+I/K` · `Mod+Shift+X/H` | Bold · italic / link · strikethrough / highlight |
| `Mod+L` | Toggle checkbox |
| `Mod+1…6` / `Mod+0` | Set heading level / plain paragraph |
| `Mod+Enter` | Open the link under the cursor |
| `Mod+F` | Find and replace in the current note |

## Documentation

- [Architecture](docs/ARCHITECTURE.md): structure, IPC contracts, autosave and sync protocols, and editor and live-preview design.
- [Design system](docs/DESIGN.md): monochrome design tokens and spacing between blocks.
- [Research](docs/research/): analyses of Obsidian, Zettlr, SilverBullet, MarkText, mdSilo, Otterly, and related projects; [functional requirements](docs/research/REQUIREMENTS.md); and [implementation techniques](docs/research/TECHNIQUES.md).
- [Development conventions](CLAUDE.md): project rules and coding conventions.
