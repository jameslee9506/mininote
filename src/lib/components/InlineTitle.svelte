<script lang="ts">
  // The open file's name above the text, edited in place (EDIT-15), and under it the day
  // the file was created, or the reason a typed name was refused. The name is always one
  // line of text that wraps visually: a textarea sized by a hidden replica (CSS grid), never
  // by measuring layout. A new note's name is a placeholder until something is typed (TREE-04).
  import { tick, untrack } from "svelte";
  import { discardNewNote } from "../appCommands";
  import { t, type MessageKey } from "../i18n";
  import { editor } from "../state/editor.svelte";
  import { fresh } from "../state/newNote.svelte";
  import { ui } from "../state/ui.svelte";
  import { vault } from "../state/vault.svelte";
  import type { VaultPath } from "../types";
  import { fileKindOf, titleOf, validateName, withKeptExtension } from "../utils/names";
  import { basename, dirname, join, key, nfc } from "../utils/path";
  import { isComposing, isLinux } from "../utils/platform";

  /** Line breaks (and tabs) typed, pasted or dropped become spaces: the title is one line. */
  const LINE_BREAKS = /\r\n|[\r\n\t\u2028\u2029]/g;
  const NOTE_EXT = /\.(md|markdown)$/i;
  /** The creation date as the system writes a long date ("November 22, 2026"). */
  const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });
  /** How long a refusal stays under a title that went back to its name: a toast's time. */
  const ERROR_MS = 4000;

  /** What committing a typed title means: nothing, a refusal, or a rename to `target` (stored as `stored`). */
  type Plan = { kind: "same" } | { kind: "invalid"; message: MessageKey } | { kind: "ok"; target: string; stored: string };
  const SAME: Plan = { kind: "same" };

  let el: HTMLTextAreaElement | undefined = $state();

  const path = $derived(editor.path);
  /** Notes without ".md"; images, code and other files with their full name (TREE-15, TREE-16, TREE-17). */
  const original = $derived(path === null ? "" : titleFor(path));
  /**
   * The open note was made a moment ago and its text is untouched (TREE-04): its field is empty
   * over its name as a placeholder, and committing the empty field keeps that name.
   */
  const placeholder = $derived(fresh.open);
  /** The field's text while nothing is typed in it. */
  const rest = $derived(placeholder ? "" : original);
  /** The field's text: follows `rest` and resets whenever it changes (another file, a rename, a first edit of a new note). */
  let value = $derived(rest);
  /** Why the typed name was refused: shown under the title, where the date is (EDIT-15). */
  let error = $state<MessageKey | null>(null);
  let errorTimer: ReturnType<typeof setTimeout> | undefined;
  /** A rename this field started and that is still running (exact paths; `to` is where it should land). */
  let moving = $state.raw<{ from: VaultPath; to: VaultPath } | null>(null);
  /** The shown file is the one being renamed from here: its title is read-only and commits nothing meanwhile. */
  const locked = $derived(moving !== null && path !== null && (path === moving.from || path === moving.to));
  /** Set while leave() moves focus away on purpose, so the blur it causes commits nothing. */
  let leaving = false;
  /**
   * Text typed but not committed yet, with the file it names. The open file can change while
   * the title keeps focus (Mod+N, back/forward keys, mouse buttons 3/4, a search hit), with no
   * blur first; the text is then committed against that file (UI-4).
   */
  let draft: { from: VaultPath; text: string } | null = null;

  /**
   * The day the shown note or code file was created (EDIT-15), on macOS and Windows only:
   * a save keeps that date there, while Linux cannot set it, so every save would reset it.
   * A virtual note shows today, the day its first edit creates the file, so the text does
   * not move down while that edit is typed.
   */
  const created = $derived.by(() => {
    if (isLinux) return null;
    const ms = editor.virtual ? Date.now() : editor.created;
    if (ms === null) return null;
    // A date past what a Date holds would make formatting throw.
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  });

  /** The title shown for `p`. */
  function titleFor(p: VaultPath): string {
    const name = nfc(basename(p));
    return titleOf(name, fileKindOf(name));
  }

  /**
   * What committing `text` as the title of `p` means. The untouched text is unchanged even when
   * the stored name starts or ends with a space (UI-3), and so are another Unicode form of the
   * name and the full file name typed out ("Note.md"). The checks mirror vault.rename's, so an
   * invalid or taken name is known before the field closes (EDIT-15); vault.rename still decides.
   */
  function plan(p: VaultPath, text: string): Plan {
    const fileName = nfc(basename(p));
    const dot = fileName.lastIndexOf(".");
    const rawExt = dot > 0 ? fileName.slice(dot + 1) : "";
    const kind = fileKindOf(fileName);
    const isNote = kind === "note";
    const title = titleOf(fileName, kind);
    const name = nfc(text.trim());
    if (text === title || name === title) return SAME;
    if (name === "") return { kind: "invalid", message: "errNameInvalid" };
    // The name vault.rename is given: notes keep their own extension (it drops a typed ".md");
    // other files keep theirs when the name brings none (TREE-06)…
    let target: string;
    if (isNote) target = NOTE_EXT.test(name) ? name : `${name}.${rawExt || "md"}`;
    else target = withKeptExtension(name, fileName);
    // …and the name it stores.
    const stored = isNote ? `${target.replace(NOTE_EXT, "").trim()}${dot > 0 ? fileName.slice(dot) : ".md"}` : target;
    if (stored === fileName) return SAME;
    if (validateName(stored, { note: isNote }) !== null) return { kind: "invalid", message: "errNameInvalid" };
    const storedKey = key(stored);
    const siblings = vault.node(dirname(p))?.children ?? [];
    if (storedKey !== key(fileName) && siblings.some((c) => c.path !== p && key(c.name) === storedKey)) {
      return { kind: "invalid", message: "errNameExists" };
    }
    return { kind: "ok", target, stored };
  }

  // Safari-only attribute that Svelte's textarea typings lack.
  $effect(() => {
    el?.setAttribute("autocorrect", "off");
  });

  // A title typed for the new note keeps it from being discarded as blank (TREE-04).
  $effect(() => {
    fresh.titled = value.trim() !== "";
  });
  $effect(() => () => {
    fresh.titled = false;
    clearTimeout(errorTimer);
  });

  /** Shows why a name was refused, or nothing. A `passing` one goes by itself after a while. */
  function report(message: MessageKey | null, passing = false): void {
    clearTimeout(errorTimer);
    error = message;
    if (message !== null && passing) errorTimer = setTimeout(() => (error = null), ERROR_MS);
  }

  // F2: focus and select the title. ↑ from the body's first line focuses it
  // with the caret at the end instead (EDIT-15). Waiting a tick lets a note switch that
  // requested it land first, so the new title is the one selected.
  let seenFocusTick = ui.titleFocusTick;
  $effect(() => {
    const requested = ui.titleFocusTick;
    if (requested === seenFocusTick) return;
    seenFocusTick = requested;
    const select = untrack(() => ui.titleFocusSelect);
    void tick().then(() => {
      if (!el || editor.path === null) return;
      el.focus();
      if (select) el.select();
      else el.setSelectionRange(el.value.length, el.value.length);
    });
  });

  // UI-4: another file is shown while the field still holds uncommitted text. A refusal was
  // about the file shown before.
  $effect.pre(() => {
    const shown = path;
    untrack(() => {
      settleDraft(shown);
      report(null);
    });
  });

  /**
   * A draft typed for a file other than `shown` is committed against that file. Runs on every
   * file change, and first in commit(): the editor taking focus for the new file blurs this
   * field before any effect runs.
   */
  function settleDraft(shown: VaultPath | null): void {
    const d = draft;
    if (d === null || d.from === shown) return;
    draft = null;
    void commitDraft(d);
  }

  /** The editor is the place to go after the title, when it is showing (a note being edited, a code file); otherwise focus just leaves. */
  function leave(at?: "start"): void {
    leaving = true;
    try {
      if (editor.kind === "code" || (editor.kind === "note" && editor.viewMode === "edit")) editor.focusEditor(at);
      if (el && document.activeElement === el) el.blur();
    } finally {
      leaving = false;
    }
  }

  /**
   * Renames to the typed title. "body" (Enter, Tab, ↓ at the end) moves on to the text; an
   * invalid or taken name keeps the title in edit mode. "blur" reverts on failure. Either way
   * the reason shows under the title (EDIT-15). A new note's empty field is its name (TREE-04).
   */
  async function commit(exit: "body" | "blur"): Promise<void> {
    const from = editor.path;
    settleDraft(from);
    if (from === null || locked) return;
    const typed = value;
    draft = null;
    const verdict = editor.readOnly || (placeholder && typed.trim() === "") ? SAME : plan(from, typed);
    if (verdict.kind === "same") {
      value = rest;
      report(null);
      if (exit === "body") leave("start");
      return;
    }
    if (verdict.kind === "invalid") {
      // It stays for as long as the refused text does; under a title that went back, a while.
      report(verdict.message, exit === "blur");
      if (exit === "blur") value = rest;
      else draft = { from, text: typed };
      return;
    }
    report(null);
    const mine = { from, to: join(dirname(from), verdict.stored) };
    moving = mine;
    // The field closes before the rename starts (TREE-06), and the caret is in the body at once:
    // keys typed meanwhile edit the note, whose saves resume after the move, never the title or
    // a second rename (DS-3).
    if (exit === "body") leave("start");
    let to: VaultPath | null = null;
    try {
      // vault.rename reports refusals itself, and only re-targets a virtual note, which has no
      // file yet (EDIT-15, LINK-05).
      to = await vault.rename(from, verdict.target);
    } catch (e) {
      console.error("rename failed", e);
      ui.notify(t("errRename", { name: titleFor(from) }));
    } finally {
      if (moving === mine) moving = null;
    }
    if (to !== null || editor.path !== from) return;
    if (exit === "blur") {
      value = rest;
      return;
    }
    // Refused after all: back to the title with the typed text, unless the user went elsewhere.
    value = typed;
    draft = { from, text: typed };
    const active = document.activeElement;
    if (active === null || active === document.body || active.closest(".cm-editor") !== null) {
      ui.focusTitle({ select: false });
    }
  }

  /** Commits text typed for a file that is no longer shown, against that file (UI-4). */
  async function commitDraft(d: { from: VaultPath; text: string }): Promise<void> {
    const verdict = plan(d.from, d.text);
    if (verdict.kind === "same") return;
    if (verdict.kind === "invalid") {
      ui.notify(t(verdict.message));
      return;
    }
    try {
      await vault.rename(d.from, verdict.target);
    } catch (e) {
      console.error("rename failed", e);
      ui.notify(t("errRename", { name: titleFor(d.from) }));
    }
  }

  function caretAtEnd(field: HTMLTextAreaElement): boolean {
    return field.selectionStart === field.value.length && field.selectionEnd === field.value.length;
  }

  function onKeydown(e: KeyboardEvent & { currentTarget: HTMLTextAreaElement }): void {
    if (isComposing(e)) return;
    const plain = !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
    if (e.key === "Enter" || (plain && e.key === "Tab") || (plain && e.key === "ArrowDown" && caretAtEnd(e.currentTarget))) {
      e.preventDefault();
      void commit("body");
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (e.repeat) return;
      if (plain && !locked) discardNewNote(value);
      draft = null;
      value = rest;
      report(null);
      leave();
    }
  }

  function onInput(e: Event & { currentTarget: HTMLTextAreaElement }): void {
    const field = e.currentTarget;
    const raw = field.value;
    const clean = raw.replace(LINE_BREAKS, " ");
    if (clean !== raw) {
      const caret = raw.slice(0, field.selectionStart).replace(LINE_BREAKS, " ").length;
      field.value = clean;
      field.setSelectionRange(caret, caret);
    }
    value = clean;
    report(null);
    // A new note's field emptied again holds nothing to commit: its name stands (TREE-04).
    if (editor.path === null || (placeholder && clean.trim() === "")) draft = null;
    else draft = { from: editor.path, text: clean };
  }

  function onBlur(): void {
    // leave() moved focus on purpose (its commit already ran). The window losing focus is not
    // the title losing it: keep editing when the user comes back.
    if (leaving || !document.hasFocus()) return;
    void commit("blur");
  }
</script>

<div class="head" class:hidden={path === null}>
  <div class="title" class:stuck={editor.saveStuck} data-value={value}>
    <textarea
      bind:this={el}
      rows={1}
      {value}
      placeholder={placeholder ? original : undefined}
      readonly={editor.readOnly || locked}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      writingsuggestions="false"
      aria-label={t("ariaTitle")}
      aria-invalid={error !== null}
      oninput={onInput}
      onkeydown={onKeydown}
      onblur={onBlur}
    ></textarea>
  </div>
  <div class="under">
    {#if created !== null}
      <time class="created" class:covered={error !== null} datetime={created.toISOString()}>{DATE.format(created)}</time>
    {/if}
    {#if error !== null}
      <p class="error" role="alert">{t(error)}</p>
    {/if}
  </div>
</div>

<style>
  /* The title and the date under it, with a fixed gap to the body (DESIGN §4). */
  .head {
    padding-bottom: var(--inline-title-gap);
  }

  .head.hidden {
    display: none;
  }

  /* Heading style, aligned with the text column, in the font of an h1 (SET-09). */
  .title {
    display: grid;
    font-family: var(--font-h1);
    font-size: var(--fs-h1);
    font-weight: var(--fw-heading);
    line-height: var(--lh-heading);
    letter-spacing: -0.01em;
    color: var(--c-text-strong);
  }

  /* Unsaved changes stuck for more than 2 s (SAVE-09). */
  .title.stuck {
    color: var(--c-text-muted);
  }

  /* The line under the title: the date, and over it the reason a name was refused. */
  .under {
    position: relative;
  }

  /* The day the file was created: small and muted, with no label (EDIT-15). */
  .created {
    display: block;
    font-size: var(--fs-ui);
    line-height: var(--lh-ui);
    color: var(--c-text-muted);
  }

  .created.covered {
    visibility: hidden;
  }

  /*
   * Why the typed name was refused (EDIT-15), in the one red of the chrome. It takes the date's
   * line, or hangs in the gap to the body where no date shows, so the text never moves.
   */
  .error {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    margin: 0;
    overflow: hidden;
    font-size: var(--fs-ui);
    line-height: var(--lh-ui);
    color: var(--c-error);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The replica: same text, same wrapping, invisible; it gives the grid cell its height. */
  .title::after {
    content: attr(data-value) " ";
    visibility: hidden;
    white-space: pre-wrap;
  }

  .title > textarea,
  .title::after {
    grid-area: 1 / 1 / 2 / 2;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
    font: inherit;
    letter-spacing: inherit;
    line-height: inherit;
    overflow-wrap: break-word;
    overflow-wrap: anywhere;
    word-break: keep-all;
  }

  .title > textarea {
    display: block;
    width: 100%;
    overflow: hidden;
    resize: none;
    background: transparent;
    color: inherit;
    caret-color: var(--c-caret);
  }

  .title > textarea:focus-visible {
    outline: none;
  }

  /* A new note's name until one is typed, a step back like every placeholder (TREE-04). */
  .title > textarea::placeholder {
    color: var(--c-text-faint);
    opacity: 1;
  }
</style>
