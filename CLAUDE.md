# mininote

mininote is a lightweight local Markdown notes app, Obsidian-like: a folder ("vault") of `.md` files with sub-folders, live-preview editing, and autosave. Code files in the folder open in a read-only viewer with syntax colors.

**Stack:** Tauri 2 (Rust) + Svelte 5 (runes) + TypeScript + Vite + CodeMirror 6 + markdown-it + DOMPurify. Targets Windows, macOS, and Linux.

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
- A local reinstall is not a release: build the `.app`, sign it ad hoc and replace `/Applications/mininote.app`, with no version bump and no tag (`docs/releasing.md`, "Install a local build").
- Never move or reuse a published tag; bump the version instead. Keep the app identifier and the updater signing key stable, or installed apps stop trusting updates. Setup and details: `docs/releasing.md`.
- The signing key is set up: `~/.tauri/mininote.key` (+ `.pub`), its password in the login keychain under the service `mininote-tauri-updater-key`, and the repository's Actions variable `TAURI_UPDATER_PUBLIC_KEY` plus secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Back them up; never generate a second key.

## Conventions

- **Svelte 5 runes only.** Use `$state`, `$derived`, `$effect`, `$props`, `onclick={...}`, and snippets. Never use `export let`, `$:`, `on:click`, slots, or `writable` stores. Runes outside components need a `.svelte.ts` file.
- **Stores** live in `src/lib/state/*.svelte.ts` and are singleton classes.
  - Use `$state.raw` for big collections, and replace them rather than mutating.
  - Never put CodeMirror objects in `$state`.
  - Write methods as arrow-function fields.
- **Contracts.**
  - `src/lib/types.ts` mirrors the Rust DTOs.
  - `src/lib/ipc/*` mirrors the Rust command and event names.
  - `src/lib/editor/host.ts` is the only bridge from CodeMirror extensions to app state; editor modules never import stores.
  - Lezer node names (`WikiLink`, `WikiLinkMark`, `WikiLinkTarget`, `WikiLinkAlias`, `WikiEmbed`, `Highlight`, `HighlightMark`) are defined in `src/lib/editor/syntax.ts`.
  - What counts as a code file, and its language, is the table in `src/lib/utils/codeFiles.ts`. Its extensions, names and name prefixes are mirrored in `src-tauri/src/fs_ops.rs` (`CODE_EXTS`, `CODE_NAMES`, `CODE_NAME_PREFIXES`); change both together, and give a new language a loader in `src/lib/editor/code/languages.ts`. `codeFiles.test.ts` fails when the two sides differ.
  - A code file is never written: its editor state is read-only (`editor/code/state.ts`), and the editor store saves only controllers of kind `"note"`.
  - The block dialect (no setext headings, no lazy continuation lines) has two halves that must agree: `Dialect` in `src/lib/editor/syntax.ts` and `src/lib/markdown/plugins/dialect.ts`. Change both, and their tests, together.
  - The icon set (`settings.iconTheme`, SET-08) is CSS only: the settings store puts it on `<html>` as `data-icons`, and `tokens.css` maps that to `--tree-folder` and `--tree-folder-fill`. Components use those two variables and never read the setting. A new set needs its rule there, its name in `IconTheme` and in the store's list, and an option in the settings modal.
  - Command ids (`src/lib/appCommands.ts`) and `EDITOR_SHORTCUTS` ids (`src/lib/editor/commands.ts`) are persisted: the user's shortcuts are stored under them. Never rename one.
- **Paths.**
  - A `VaultPath` is vault-relative, `/`-separated, and byte-identical to the backend listing. Never normalize it for I/O.
  - For display and matching, use `nfc()` and `key()` from `utils/path.ts`. Comparisons are case- and NFC-insensitive.
- **IME.** Every custom key handler returns early on `isComposing(e)` (`e.isComposing || e.keyCode === 229`). Korean input must never trigger Enter, Escape, Tab, or arrow actions mid-composition. Inside the editor, `src/lib/editor/ime.ts` keeps every `keyCode` 229 keydown away from CodeMirror's keymaps: WKWebView composes Hangul without composition events, so CodeMirror's own guard does not see it.
- **UI text.**
  - Every string goes through `t()` in `src/lib/i18n.ts` (English).
  - Keep documentation and comments in English. Use Unicode escapes for Hangul fixtures and character tables so Unicode and IME coverage stays intact.
  - Show no visible labels unless essential. Icons carry `aria-label`, not `title`.
  - Report errors only, through `ui.notify`.
- **CSS.**
  - Use only the variables in `src/styles/tokens.css`, and only grays. The two exceptions are the `--c-syn-*` syntax colors, used by the code view's highlight style and nothing else (DESIGN §6), and `--c-icon-folder-tint`, the folder color of the "Color" icon set and nothing else (DESIGN §4).
  - A Markdown construct looks the same in the reading view (`markdown.css`) and the editor (`editor.css`): both take its measures from the `--md-*` tokens. Change the token, never one stylesheet.
  - In the editor a blank line is a body line. Never shrink or restyle it; block gaps are padding on a block's first line (`livePreview/flow.ts`, DESIGN §3.2).
  - Inside rendered Markdown, blocks have **no margins**. Vertical space comes only from sibling-pair rules (`CONTAINER > :where(A + B)`).
  - Inside CodeMirror lines, use padding, never margins.
- **Rust.**
  - Every filesystem command is `async` and runs `spawn_blocking`.
  - Every path goes through `vault::resolve` (no escaping the root).
  - Errors are `{ kind, message }`.
- **Dependencies.** Keep the dependency footprint small, and ask before adding new ones.
