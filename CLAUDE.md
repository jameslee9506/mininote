Mininote is a lightweight local Markdown notes app, Obsidian-like: a folder ("vault") of `.md` files with sub-folders, live-preview editing, and autosave. Code files in the folder open in a read-only viewer with syntax colors, and PDFs in a viewer that works like Chrome's.

**Stack:** Tauri 2 (Rust) + Svelte 5 (runes) + TypeScript + Vite + CodeMirror 6 + markdown-it + DOMPurify + PDF.js. Targets Windows, macOS, and Linux.

Read these docs before changing anything non-trivial:
- `docs/ARCHITECTURE.md`: process model, IPC contract, autosave protocol, editor/live-preview design, and shortcuts.
- `docs/DESIGN.md`: the monotone design system and the **between-blocks spacing system**.
- `docs/research/`: open-source analyses, `REQUIREMENTS.md` (functional spec with IDs), and `TECHNIQUES.md`.

## Commands

```bash
npm run check              # svelte-check + TypeScript (must be clean)
npm test                   # vitest unit tests (pure logic only)
(cd src-tauri && cargo check)   # Rust type-check (must be clean)
npm run tauri dev          # run the app (the owner runs this, not agents)
npm run tauri build        # release bundle
npm run release:prepare    # validate the versions and write the updater overlay (docs/releasing.md)
```

## Owner's working rules

- **Minimal verification.** Do not launch the app to verify. If the code is syntactically and logically sound, that is enough.
- **Tests stay small.** Write unit tests only where they really pay off, for pure logic: utils, link resolution, parsers, render plugins. Do not write integration or E2E tests.
- **No mobile builds.** Never run iOS/Android builds or simulators.
- Do not use Claude Artifacts or the auto-memory feature. Document durable knowledge here or in `docs/`.
- Commit messages are in English, with no `Co-Authored-By` lines.

## Versioning and releases

- Use stable `X.Y.Z` versions and matching `vX.Y.Z` tags; no prerelease or build suffixes. Nothing has been published yet: the first release must be installed by hand once, and every later one installs from inside the app.
- Keep `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` on the same version (`npm install --package-lock-only`, then `cargo check` in `src-tauri`), and commit the lockfiles with the bump. `npm run release:prepare` checks this.
- Pass the checks above before pushing a release commit and its tag. The tag starts `.github/workflows/release.yml`, which creates a **draft** release; publish it only after every platform job is green.
- A local reinstall is not a release: build the `.app`, sign it ad hoc and replace `/Applications/Mininote.app`, with no version bump and no tag (`docs/releasing.md`, "Install a local build").
- Never move or reuse a published tag; bump the version instead. Keep the app identifier and the updater signing key stable, or installed apps stop trusting updates. Setup and details: `docs/releasing.md`.
- The signing key is set up: `~/.tauri/mininote.key` (+ `.pub`), its password in the login keychain under the service `mininote-tauri-updater-key`, and the repository's Actions variable `TAURI_UPDATER_PUBLIC_KEY` plus secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Back them up; never generate a second key.

## Conventions

- **Svelte 5 runes only.** Use `$state`, `$derived`, `$effect`, `$props`, `onclick={...}`, and snippets. Never use `export let`, `$:`, `on:click`, slots, or `writable` stores. Runes outside components need a `.svelte.ts` file.
- **Stores** live in `src/lib/state/*.svelte.ts` and are singleton classes.
  - Use `$state.raw` for big collections, and replace them rather than mutating.
  - Never put CodeMirror or PDF.js objects in `$state`.
  - Write methods as arrow-function fields.
- **Contracts.**
  - `src/lib/types.ts` mirrors the Rust DTOs.
  - `src/lib/ipc/*` mirrors the Rust command and event names.
  - Each window has its own vault (`Vaults` in `vault.rs`, keyed by window label), and a folder is open in one window at most. Commands take the calling `WebviewWindow`. An event about one window's vault goes to that window only (`emit_to`), and the frontend listens through `ipc/events.ts`, which uses `getCurrentWebviewWindow().listen()`: a global `listen()` also hears other windows' events.
  - Settings are written as patches of what one window changed (`settings_update`), and every window hears each one (`settings:changed`); never write the whole document from a window.
  - A window learns what to show by asking for its plan (`window_startup`): when its page starts, and at every `window:open`, which carries nothing (PLAT-14, ARCHITECTURE §6.9). What a command line asks for goes through `windows::open` and its `Plans`; never send a folder or a file to a window inside an event. A page shows its window with `window_show`, not `getCurrentWindow().show()`: the backend decides which window comes forward.
  - The `mininote` terminal command is a script the app writes on macOS (`cli.rs › shell`), and only when its switch in the settings is turned on: nothing installs it otherwise. The script's `HEAD` is how the app knows its own file; never change it.
  - A command line that begins with a subcommand (`mininote ls`, `read`, `edit`…; PLAT-15, ARCHITECTURE §6.10) is answered by `headless.rs` before there is an app: `run()` asks it first, and it exits.
    - A subcommand calls the function its IPC command calls (`fs_ops`, `search`). Never write a file operation a second time for it.
    - It reads the settings for the known vaults and never writes them.
    - A new subcommand goes into its table (`SUBS`). The macOS script asks the program what a subcommand is (`--is-subcommand`) and names none.
    - Scripts and agents depend on the names, the options, the plain output, the JSON fields and the exit statuses (0, 1, 2): add to them, never rename or reshape one.
    - Nothing there prints with `println!` or `eprintln!`: a closed pipe would panic.
  - `src/lib/editor/host.ts` is the only bridge from CodeMirror extensions to app state; editor modules never import stores.
  - Lezer node names (`WikiLink`, `WikiLinkMark`, `WikiLinkTarget`, `WikiLinkAlias`, `WikiEmbed`, `Highlight`, `HighlightMark`) are defined in `src/lib/editor/syntax.ts`.
  - What counts as a code file, and its language, is the table in `src/lib/utils/codeFiles.ts`. Its extensions, names and name prefixes are mirrored in `src-tauri/src/fs_ops.rs` (`CODE_EXTS`, `CODE_NAMES`, `CODE_NAME_PREFIXES`); change both together, and give a new language a loader in `src/lib/editor/code/languages.ts`. `codeFiles.test.ts` fails when the two sides differ.
  - A code file is never written: its editor state is read-only (`editor/code/state.ts`), and the editor store saves only controllers of kind `"note"`.
  - A PDF (TREE-20, ARCHITECTURE §10.5) has no controller in the editor store: `editor.kind` is `"pdf"`, and the `pdf` store (`state/pdf.svelte.ts`) holds the PDF.js document and viewer for `PdfView.svelte`. The toolbar and the keys only ask that store.
    - PDF.js is loaded by `pdf/engine.ts` alone, from the `legacy` builds, library first and viewer second. The files it fetches at run time are served and published by `vite.config.ts › pdfAssets`; a new kind of file goes into both.
    - The bytes come through `binary_read`, never through the asset protocol.
    - `styles/pdf.css` holds the part of `pdfjs-dist/web/pdf_viewer.css` the pages need, written out without nesting. Never import that stylesheet whole: it styles `.sidebar` and `.dialog`. After an upgrade of `pdfjs-dist`, compare the two, and keep the three files in `pdfjs-dist` (`pdf.mjs`, `pdf_viewer.mjs`, the worker) on one version: the viewer refuses another.
    - A session ends with `setDocument(null)` before its `AbortController` (`pdf.#dispose`), or later text layers lose their selection listeners.
  - A link (symlink) that leads to a regular file is a file of the vault (TREE-18, ARCHITECTURE §6.8): listed, read, searched and written as that file, and renamed, moved or deleted as the link itself. `vault::resolve` rejects a path that goes through a link, never one that ends at one. Only `note_read`, `note_write` and the source of `path_copy` follow it, and no link is ever followed into a folder. In Rust, choose between `symlink_metadata` (the entry) and `metadata` (its file) deliberately. The listing gives the watcher each such link by its file (`VaultState::links`) and the frontend the file of each image link (`ListResult.realPaths`), which only `vault.assetUrl` reads.
  - The block dialect (no setext headings, no lazy continuation lines) has two halves that must agree: `Dialect` in `src/lib/editor/syntax.ts` and `src/lib/markdown/plugins/dialect.ts`. Change both, and their tests, together.
  - The icon set (`settings.iconTheme`, SET-08) is CSS only: the settings store puts it on `<html>` as `data-icons`, and `tokens.css` maps that to `--tree-folder` and `--tree-folder-fill`. Components use those two variables and never read the setting. A new set needs its rule there, its name in `IconTheme` and in the store's list, and an option in the settings modal.
  - The document's fonts are CSS only too: the settings store sets `--font-content` (the text font, SET-09), `--font-heading` (the heading font), `--font-h1` to `--font-h4` (each that heading font or the text font, as `headingFontLevels` says; the inline title takes h1's) and `--font-mono` (the code font, SET-07) on `<html>`, and stylesheets use those variables. The chrome stays in `--font-text`. The font rules and the probe that lists installed families are in `utils/fonts.ts`.
  - Command ids (`src/lib/appCommands.ts`) and `EDITOR_SHORTCUTS` ids (`src/lib/editor/commands.ts`) are persisted: the user's shortcuts are stored under them. Never rename one.
  - A new note is not kept until something is typed in it (TREE-04, ARCHITECTURE §8.3). The `fresh` store (`state/newNote.svelte.ts`) says whether the open note is that note (`open`: its title is a placeholder) and whether no title is typed either (`blank`: Esc, or a click in the sidebar, deletes it). What decides is `canDiscardNewNote` (`state/newNote.ts`): the exact path, vault epoch and editor revision of the creation, never the name. Delete such a note with `vault.discard`, after `editor.settled()`; a removal of the shown note cuts short an open that has not shown its file yet.
- **Paths.**
  - A `VaultPath` is vault-relative, `/`-separated, and byte-identical to the backend listing. Never normalize it for I/O.
  - For display and matching, use `nfc()` and `key()` from `utils/path.ts`. Comparisons are case- and NFC-insensitive.
- **IME.** Every custom key handler returns early on `isComposing(e)` (`e.isComposing || e.keyCode === 229`). Korean input must never trigger Enter, Escape, Tab, or arrow actions mid-composition. Inside the editor, `src/lib/editor/ime.ts` keeps every `keyCode` 229 keydown away from CodeMirror's keymaps: WKWebView composes Hangul without composition events, so CodeMirror's own guard does not see it.
- **UI text.**
  - Every string goes through `t()` in `src/lib/i18n.ts` (English).
  - Keep documentation and comments in English. Use Unicode escapes for Hangul fixtures and character tables so Unicode and IME coverage stays intact.
  - Show no visible labels unless essential. Icons carry `aria-label`, not `title`.
  - Report errors only, through `ui.notify`. A name refused in the inline title is the exception: its reason shows under the title (EDIT-15).
- **CSS.**
  - Use only the variables in `src/styles/tokens.css`, and only grays. The three exceptions are the `--c-syn-*` syntax colors, used by the code view's highlight style and nothing else (DESIGN §6), `--c-icon-folder-tint`, the folder color of the "Color" icon set and nothing else (DESIGN §4), and `--c-error`, the red of a refused name under the inline title and nothing else (DESIGN §4). What the app draws on a PDF's page takes the `--c-pdf-*` grays, which have one value for both themes (DESIGN §7).
  - A Markdown construct looks the same in the reading view (`markdown.css`) and the editor (`editor.css`): both take its measures from the `--md-*` tokens. Change the token, never one stylesheet.
  - In the editor a blank line is a body line. Never shrink or restyle it; block gaps are padding on a block's first line (`livePreview/flow.ts`, DESIGN §3.2).
  - Inside rendered Markdown, blocks have **no margins**. Vertical space comes only from sibling-pair rules (`CONTAINER > :where(A + B)`).
  - Inside CodeMirror lines, use padding, never margins.
- **Rust.**
  - Every filesystem command is `async` and runs `spawn_blocking`.
  - Every path goes through `vault::resolve` (no escaping the root).
  - Errors are `{ kind, message }`.
- **Dependencies.** Keep the dependency footprint small, and ask before adding new ones.
