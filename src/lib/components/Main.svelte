<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import Editor from "./Editor.svelte";
  import Icon from "./Icon.svelte";
  import ImageView from "./ImageView.svelte";
  import InlineTitle from "./InlineTitle.svelte";
  import PdfToolbar from "./PdfToolbar.svelte";
  import PdfView from "./PdfView.svelte";
  import Reader from "./Reader.svelte";
  import UnsupportedView from "./UnsupportedView.svelte";
  import UpdateButton from "./UpdateButton.svelte";
  import { t } from "../i18n";
  import { editor } from "../state/editor.svelte";
  import { settings } from "../state/settings.svelte";
  import { ui } from "../state/ui.svelte";
  import type { VaultPath } from "../types";
  import { isMac } from "../utils/platform";
  import { debounce } from "../utils/timing";

  /** How long the copy button shows a check after a copy (NAV-09). */
  const COPIED_MS = 1500;

  /** The document scroll container (ARCHITECTURE §9): title + editor/reader scroll together. */
  let docScrollEl: HTMLElement | null = $state(null);
  let editorSlotEl: HTMLElement | null = $state(null);
  let scrolled = $state(false);

  function trackScroll(scroller: HTMLElement) {
    const update = () => {
      scrolled = scroller.scrollTop > 0;
    };
    update();
    scroller.addEventListener("scroll", update);
    return () => scroller.removeEventListener("scroll", update);
  }

  const isNote = $derived(editor.path !== null && editor.kind === "note");
  /** A code file: the editor view shows it too, read-only (TREE-17). */
  const isCode = $derived(editor.path !== null && editor.kind === "code");
  const reading = $derived(isNote && editor.viewMode === "read");
  /** The single EditorView stays mounted; it is only hidden for images, PDFs and unsupported files, reading view and the blank state. */
  const showEditor = $derived((isNote && editor.viewMode === "edit") || isCode);
  const imagePath = $derived(editor.kind === "image" ? editor.path : null);
  /** A PDF takes the whole pane below the strip, which carries its controls (TREE-20). */
  const pdfPath = $derived(editor.kind === "pdf" ? editor.path : null);
  /** A file that is not a note, an image, a PDF or a code file: listed, but not opened (TREE-16). */
  const otherPath = $derived(editor.kind === "other" ? editor.path : null);

  /** Reading-view text, recomputed on doc changes while (and only while) it is visible. */
  const readerText = $derived.by(() => {
    if (!reading) return "";
    void editor.revision;
    void editor.path;
    void editor.loading;
    try {
      return editor.getText();
    } catch {
      return "";
    }
  });

  // ── Copying the text (NAV-09) ────────────────────────────────

  /** A note or a code file: the files that are text, which the copy button copies. */
  const isText = $derived(isNote || isCode);
  /** There is text to copy. `revision` grows with every change of the document. */
  const hasText = $derived.by(() => {
    if (!isText) return false;
    void editor.revision;
    return editor.hasText();
  });
  /** The file whose text was copied a moment ago: while it is the open one, its button shows a check. */
  let copiedPath: VaultPath | null = $state(null);
  const copied = $derived(copiedPath !== null && copiedPath === editor.path);
  /** Takes the check away `COPIED_MS` after the last call, so after the last copy. */
  const uncheck = debounce(() => {
    copiedPath = null;
  }, COPIED_MS);
  $effect(() => () => uncheck.cancel());

  /**
   * Puts the whole text of the open note or code file on the clipboard: the document as the
   * editor holds it, so with the edits not saved yet and with LF line breaks, whichever view
   * shows it. The write starts within the click: the webviews refuse one that no user gesture
   * stands behind.
   */
  async function copyText(): Promise<void> {
    const path = editor.path;
    const text = editor.getText();
    if (path === null || text === "") return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.error(err);
      ui.notify(t("errCopy"));
      return;
    }
    copiedPath = path;
    uncheck();
  }

  // macOS: with the sidebar hidden, the traffic lights sit over this strip, so it keeps their
  // area free, except in full screen where they are gone (NAV-04).
  let fullscreen = $state(false);
  const reserveTrafficLights = $derived(isMac && !settings.values.sidebarVisible && !fullscreen);

  $effect(() => {
    if (!isMac) return;
    const win = getCurrentWindow();
    let alive = true;
    const check = debounce(() => {
      win.isFullscreen().then(
        (value) => {
          if (alive) fullscreen = value;
        },
        () => {},
      );
    }, 250);
    check();
    window.addEventListener("resize", check);
    return () => {
      alive = false;
      check.cancel();
      window.removeEventListener("resize", check);
    };
  });

  /** A click in the blank area below the text puts the caret at the end of the note. */
  function onDocMouseDown(e: MouseEvent): void {
    if (e.button !== 0 || !showEditor || !docScrollEl || !editorSlotEl) return;
    if (!(e.target instanceof Node) || editorSlotEl.contains(e.target)) return;
    if (e.target instanceof Element && e.target.closest("textarea")) return; // the inline title
    const scroller = docScrollEl.getBoundingClientRect();
    if (e.clientX >= scroller.left + docScrollEl.clientWidth) return; // the scrollbar
    if (e.clientY <= editorSlotEl.getBoundingClientRect().bottom) return;
    e.preventDefault();
    editor.focusEditor("end");
  }
</script>

<div class="main">
  <header class="strip" class:scrolled class:inset={reserveTrafficLights} data-tauri-drag-region={isMac ? "deep" : undefined}>
    <!-- Always here: the sidebar header holds only its four icons (NAV-04), so the mouse hides it from this strip too. -->
    <button type="button" class="icon-btn" aria-label={t("ariaToggleSidebar")} onclick={() => ui.toggleSidebar()}>
      <Icon name="sidebar" />
    </button>
    <button type="button" class="icon-btn" aria-label={t("ariaBack")} disabled={!editor.canBack} onclick={() => void editor.back()}>
      <Icon name="arrow-left" />
    </button>
    <button
      type="button"
      class="icon-btn"
      aria-label={t("ariaForward")}
      disabled={!editor.canForward}
      onclick={() => void editor.forward()}
    >
      <Icon name="arrow-right" />
    </button>
    {#if pdfPath !== null}
      <PdfToolbar path={pdfPath} />
    {:else}
      <div class="grow"></div>
    {/if}
    <!-- A file that cannot be written, and every code file: the code view never edits. -->
    {#if (editor.readOnly || isCode) && editor.path !== null}
      <span class="lock" role="img" aria-label={t("ariaReadOnly")}>
        <Icon name="lock" />
      </span>
    {/if}
    <UpdateButton />
    {#if isText}
      <!-- mousedown is cancelled so the keyboard and the selection stay where they are, in the text. -->
      <button
        type="button"
        class="icon-btn"
        aria-label={copied ? t("ariaCopied") : t("ariaCopyText")}
        disabled={!hasText}
        onmousedown={(e) => e.preventDefault()}
        onclick={() => void copyText()}
      >
        <Icon name={copied ? "check" : "copy"} />
      </button>
    {/if}
    {#if isNote}
      <button
        type="button"
        class="icon-btn"
        aria-label={reading ? t("ariaEditingView") : t("ariaReadingView")}
        onclick={() => editor.toggleViewMode()}
      >
        <Icon name={reading ? "pencil" : "book"} />
      </button>
    {/if}
  </header>

  {#if pdfPath !== null}
    <!-- One view per document: each PDF gets a viewer of its own. -->
    {#key pdfPath}
      <PdfView path={pdfPath} {trackScroll} />
    {/key}
  {/if}
  <!-- Stays mounted under a PDF, hidden: the single EditorView lives in it. -->
  <div
    class="doc-scroll"
    class:hidden={pdfPath !== null}
    role="presentation"
    bind:this={docScrollEl}
    {@attach pdfPath === null ? trackScroll : undefined}
    onmousedown={onDocMouseDown}
  >
    <div class="doc-column" class:code={isCode}>
      {#if settings.values.inlineTitle}
        <InlineTitle />
      {/if}
      <div class="editor-slot" class:hidden={!showEditor} bind:this={editorSlotEl}>
        <!-- Mounted once the scroller exists, so the editor attaches with it on its first render. -->
        {#if docScrollEl}
          <Editor scroller={docScrollEl} />
        {/if}
      </div>
      {#if reading}
        <Reader text={readerText} from={editor.path} />
      {/if}
      {#if imagePath !== null}
        <ImageView path={imagePath} />
      {/if}
      {#if otherPath !== null}
        <UnsupportedView path={otherPath} />
      {/if}
    </div>
  </div>
</div>

<style>
  .main {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--c-bg);
  }

  .strip {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    height: var(--header-h);
    padding: 0 8px;
  }

  .strip.scrolled {
    box-shadow: inset 0 -1px var(--c-border);
  }

  /* Room for the macOS traffic lights while the sidebar (their usual home) is hidden. */
  .strip.inset {
    padding-left: 76px;
  }

  .grow {
    flex: 1;
    align-self: stretch;
  }

  .lock {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    color: var(--c-text-faint);
  }

  .doc-scroll {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    scrollbar-gutter: stable;
  }

  /* The text measure is --content-max; the padding sits outside it (EDIT-13). */
  .doc-column {
    box-sizing: content-box;
    max-width: var(--content-max);
    margin: 0 auto;
    padding: var(--content-pad-top) var(--content-pad-x) var(--content-pad-bottom);
  }

  /*
   * A code file gets the wider of the text measure and the code measure (DESIGN §6). With
   * the "Full" line width, --content-max is `none`: the max() is then invalid, and an
   * invalid max-width computes to its initial value, which is `none` as well.
   */
  .doc-column.code {
    max-width: max(var(--content-max), var(--code-max));
  }

  .doc-scroll.hidden,
  .editor-slot.hidden {
    display: none;
  }
</style>
