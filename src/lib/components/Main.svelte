<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import Editor from "./Editor.svelte";
  import Icon from "./Icon.svelte";
  import ImageView from "./ImageView.svelte";
  import InlineTitle from "./InlineTitle.svelte";
  import Reader from "./Reader.svelte";
  import UpdateButton from "./UpdateButton.svelte";
  import { t } from "../i18n";
  import { editor } from "../state/editor.svelte";
  import { settings } from "../state/settings.svelte";
  import { ui } from "../state/ui.svelte";
  import { isMac } from "../utils/platform";
  import { debounce } from "../utils/timing";

  /** The document scroll container (ARCHITECTURE §9): title + editor/reader scroll together. */
  let docScrollEl: HTMLElement | null = $state(null);
  let editorSlotEl: HTMLElement | null = $state(null);

  const isNote = $derived(editor.path !== null && editor.kind === "note");
  const reading = $derived(isNote && editor.viewMode === "read");
  /** The single EditorView stays mounted; it is only hidden for images, reading view and the blank state. */
  const showEditor = $derived(isNote && editor.viewMode === "edit");
  const imagePath = $derived(editor.kind === "image" ? editor.path : null);

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
  <header class="strip" class:inset={reserveTrafficLights} data-tauri-drag-region={isMac ? "deep" : undefined}>
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
    <div class="grow"></div>
    {#if editor.readOnly && editor.path !== null}
      <span class="lock" role="img" aria-label={t("ariaReadOnly")}>
        <Icon name="lock" />
      </span>
    {/if}
    <UpdateButton />
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

  <div class="doc-scroll" role="presentation" bind:this={docScrollEl} onmousedown={onDocMouseDown}>
    <div class="doc-column">
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

  .editor-slot.hidden {
    display: none;
  }
</style>
