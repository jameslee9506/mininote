<script lang="ts">
  // The PDF view (TREE-20, ARCHITECTURE §10.5, DESIGN §7): the pages one under the other on a
  // gray ground, scrolled as one document, with Chrome's panel of thumbnails and outline at the
  // left and a find bar at the top right. PDF.js draws the pages into `.pdfViewer`; the pdf
  // store drives it, and the toolbar in the main strip (PdfToolbar) asks the same store.
  import { untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import PdfOutline from "./PdfOutline.svelte";
  import PdfThumbnails from "./PdfThumbnails.svelte";
  import { t } from "../i18n";
  import { pdf } from "../state/pdf.svelte";
  import { ui } from "../state/ui.svelte";
  import type { VaultPath } from "../types";
  import { matchShortcut } from "../utils/keys";
  import { basename, nfc } from "../utils/path";
  import { isComposing } from "../utils/platform";

  let { path }: { path: VaultPath } = $props();

  const name = $derived(nfc(basename(path)));

  /** The element that scrolls the pages. PDF.js requires it to be absolutely positioned. */
  let container: HTMLDivElement | undefined = $state();
  let findInput: HTMLInputElement | undefined = $state();
  let passwordInput: HTMLInputElement | undefined = $state();
  let password = $state("");

  const ready = $derived(pdf.phase === "ready");
  /** The outline tab exists only for a document that has one. */
  const hasOutline = $derived(pdf.outline.length > 0);
  const showOutline = $derived(pdf.panel === "outline" && hasOutline);

  $effect(() => {
    const el = container;
    const file = path;
    if (!el) return;
    untrack(() => pdf.open(file, el));
    return () => pdf.close(el);
  });

  // The find bar takes the keyboard whenever it is asked for, with its text selected.
  $effect(() => {
    if (pdf.findFocus === 0 || !pdf.findOpen) return;
    const input = findInput;
    if (!input) return;
    input.focus();
    input.select();
  });

  // A protected document asks for its password where the keyboard is free to go.
  $effect(() => {
    if (pdf.phase !== "password") return;
    void pdf.wrongPassword;
    const input = passwordInput;
    const active = document.activeElement;
    if (input && (active === null || active === document.body || active === input)) input.focus();
  });

  /** A press never takes the keyboard from where it is: the pages, or the find field. */
  const keepFocus = (e: MouseEvent): void => e.preventDefault();

  // ── Keys ─────────────────────────────────────────────────────

  const ZOOM_IN_KEYS = ["Mod-=", "Mod-+", "Mod-Shift-=", "Mod-Shift-+"];
  const ZOOM_OUT_KEYS = ["Mod--", "Mod-Shift--", "Mod-Shift-_"];
  const any = (e: KeyboardEvent, specs: readonly string[]): boolean => specs.some((spec) => matchShortcut(e, spec));

  /**
   * The zoom keys work wherever the keyboard is while a PDF is shown (the tree, the pages, a
   * field): nothing else in the app answers them. Modals and dialogs keep them inert.
   */
  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || isComposing(e) || !ready) return;
    if (ui.modal !== null || ui.confirmDialog !== null || ui.menu !== null) return;
    if (any(e, ZOOM_IN_KEYS)) pdf.zoomIn();
    else if (any(e, ZOOM_OUT_KEYS)) pdf.zoomOut();
    else if (matchShortcut(e, "Mod-0")) pdf.setFit("auto");
    else return;
    e.preventDefault();
  }

  /**
   * Keys of the pages. The arrow, Page and Home/End keys and Space scroll natively. Without a
   * sideways scroll, ← and → show the previous and the next page, as in Chrome.
   */
  function onPagesKeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || isComposing(e) || !ready) return;
    if (matchShortcut(e, "Escape")) {
      if (!pdf.findOpen) return;
      e.preventDefault();
      pdf.closeFind();
      return;
    }
    const back = matchShortcut(e, "ArrowLeft");
    if ((!back && !matchShortcut(e, "ArrowRight")) || pdf.scrollsSideways()) return;
    e.preventDefault();
    if (back) pdf.previousPage();
    else pdf.nextPage();
  }

  function onFindKeydown(e: KeyboardEvent): void {
    if (isComposing(e)) return;
    if (matchShortcut(e, "Escape")) pdf.closeFind();
    else if (matchShortcut(e, "Enter") || matchShortcut(e, "Mod-g") || matchShortcut(e, "F3")) pdf.findNext();
    else if (matchShortcut(e, "Shift-Enter") || matchShortcut(e, "Mod-Shift-g") || matchShortcut(e, "Shift-F3")) pdf.findPrevious();
    else if (matchShortcut(e, "Mod-f")) findInput?.select();
    else return;
    // Handled here: the app's own find and Escape handlers see nothing of it.
    e.preventDefault();
    e.stopPropagation();
  }

  function onPasswordKeydown(e: KeyboardEvent): void {
    if (isComposing(e) || !matchShortcut(e, "Enter")) return;
    e.preventDefault();
    const typed = password;
    password = "";
    pdf.submitPassword(typed);
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="pdf-view">
  {#if ready && pdf.panelOpen}
    <aside class="panel">
      {#if hasOutline}
        <div class="tabs" role="tablist">
          <button
            type="button"
            class="icon-btn"
            role="tab"
            aria-label={t("ariaPdfThumbnails")}
            aria-selected={!showOutline}
            onmousedown={keepFocus}
            onclick={() => (pdf.panel = "thumbnails")}
          >
            <Icon name="thumbnails" />
          </button>
          <button
            type="button"
            class="icon-btn"
            role="tab"
            aria-label={t("ariaPdfOutline")}
            aria-selected={showOutline}
            onmousedown={keepFocus}
            onclick={() => (pdf.panel = "outline")}
          >
            <Icon name="outline" />
          </button>
        </div>
      {/if}
      <div class="panel-body">
        {#if showOutline}
          <PdfOutline />
        {:else}
          <PdfThumbnails />
        {/if}
      </div>
    </aside>
  {/if}

  <div class="stage">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a scrolling region takes the keyboard, so that its keys scroll it) -->
    <div class="pages" role="region" aria-label={name} tabindex="0" bind:this={container} onkeydown={onPagesKeydown}>
      <div class="pdfViewer"></div>
    </div>

    {#if pdf.findOpen}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions (the keys of the field and its buttons, handled in one place) -->
      <div class="find" role="search" onkeydown={onFindKeydown}>
        <input
          class="find-input"
          class:none={pdf.findMissed}
          type="text"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          aria-label={t("ariaFind")}
          bind:this={findInput}
          value={pdf.findQuery}
          oninput={(e) => pdf.setFindQuery(e.currentTarget.value)}
        />
        {#if pdf.findQuery !== ""}
          <span class="count">{pdf.findCurrent}/{pdf.findTotal}</span>
        {/if}
        <button type="button" class="icon-btn" aria-label={t("ariaPrevious")} onmousedown={keepFocus} onclick={pdf.findPrevious}>
          <Icon name="arrow-up" />
        </button>
        <button type="button" class="icon-btn" aria-label={t("ariaNext")} onmousedown={keepFocus} onclick={pdf.findNext}>
          <Icon name="arrow-down" />
        </button>
        <button type="button" class="icon-btn" aria-label={t("ariaClose")} onmousedown={keepFocus} onclick={pdf.closeFind}>
          <Icon name="close" />
        </button>
      </div>
    {/if}

    {#if pdf.phase === "password"}
      <div class="notice">
        <span class="glyph"><Icon name="lock" /></span>
        <input
          class="field password"
          class:invalid={pdf.wrongPassword}
          type="password"
          autocomplete="off"
          aria-label={t("pdfPassword")}
          aria-invalid={pdf.wrongPassword}
          placeholder={t("pdfPassword")}
          bind:this={passwordInput}
          bind:value={password}
          onkeydown={onPasswordKeydown}
        />
      </div>
    {:else if pdf.phase === "failed"}
      <!-- A toast said why; the view only shows that there is nothing to see. -->
      <div class="notice">
        <span class="glyph"><Icon name="pdf" /></span>
      </div>
    {/if}
  </div>
</div>

<style>
  .pdf-view {
    flex: 1;
    min-height: 0;
    display: flex;
    /* The layers of the pages and the find bar stack among themselves, under the app's overlays. */
    isolation: isolate;
  }

  /* ── Panel: thumbnails and outline ───────────────────────────── */

  .panel {
    flex: none;
    display: flex;
    flex-direction: column;
    width: var(--pdf-panel-width);
    background: var(--c-bg-alt);
    border-right: 1px solid var(--c-border);
  }

  .tabs {
    flex: none;
    display: flex;
    justify-content: center;
    gap: 2px;
    padding: 6px 0 2px;
  }

  .tabs .icon-btn[aria-selected="true"] {
    background: var(--c-bg-active);
    color: var(--c-text);
  }

  /* Its one child, the thumbnails or the outline, fills it and scrolls. */
  .panel-body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* ── Pages ───────────────────────────────────────────────────── */

  .stage {
    position: relative;
    flex: 1;
    min-width: 0;
  }

  .pages {
    position: absolute;
    inset: 0;
    overflow: auto;
    background: var(--c-bg-alt);
  }

  /* The ring would frame the whole pane for every key press; the pages show where the keyboard is. */
  .pages:focus-visible {
    outline: none;
  }

  /* ── Find bar: the editor's find panel, for the pages ────────── */

  .find {
    position: absolute;
    top: 8px;
    /* Clear of the scrollbar. */
    right: 18px;
    z-index: var(--z-popover);
    display: flex;
    align-items: center;
    gap: 2px;
    width: min(340px, calc(100% - 36px));
    padding: 4px;
    background: var(--c-bg-elev);
    border: 1px solid var(--c-border);
    border-radius: var(--radius-m);
    box-shadow: var(--shadow-elev);
  }

  .find-input {
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 6px;
    border: none;
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--c-text);
  }

  .find-input.none {
    color: var(--c-text-faint);
  }

  .count {
    flex: none;
    padding: 0 4px;
    color: var(--c-text-muted);
    font-size: var(--fs-ui-small);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* ── Password, and a document that did not open ──────────────── */

  .notice {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding-top: 12vh;
    background: var(--c-bg-alt);
  }

  .glyph {
    color: var(--c-text-faint);
  }

  .password {
    width: min(240px, calc(100% - 32px));
  }

  .password.invalid {
    border-style: dashed;
    border-color: var(--c-border-strong);
  }
</style>
