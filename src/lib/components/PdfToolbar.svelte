<script lang="ts">
  // The PDF controls of the main strip (TREE-20, DESIGN §7), laid out as Chrome's PDF toolbar:
  // the panel button and the file's name at the left; in the middle the page field, the zoom
  // with its two buttons, the fit button and the turn button. They only ask the pdf store.
  import Icon from "./Icon.svelte";
  import { t } from "../i18n";
  import { formatZoom, MAX_ZOOM, MIN_ZOOM, parsePage, parseZoom } from "../pdf/zoom";
  import { pdf } from "../state/pdf.svelte";
  import type { VaultPath } from "../types";
  import { basename, nfc } from "../utils/path";
  import { isComposing } from "../utils/platform";

  let { path }: { path: VaultPath } = $props();

  const name = $derived(nfc(basename(path)));
  const ready = $derived(pdf.phase === "ready");

  /** What is being typed into a field; null while it shows the view's own value. */
  let pageDraft: string | null = $state(null);
  let zoomDraft: string | null = $state(null);

  /** Two zooms that show the same percentage are the same zoom. */
  const atLeast = (zoom: number, limit: number): boolean => Math.round(zoom * 100) >= Math.round(limit * 100);
  const canZoomIn = $derived(!atLeast(pdf.zoom, MAX_ZOOM));
  const canZoomOut = $derived(!atLeast(MIN_ZOOM, pdf.zoom));
  /** The fit button offers the fit the view does not have: the whole page first, as Chrome's does. */
  const offersWidth = $derived(pdf.fit === "page-fit");

  function commitPage(): void {
    const page = pageDraft === null ? null : parsePage(pageDraft, pdf.pages);
    pageDraft = null;
    if (page !== null) pdf.goToPage(page);
  }

  function commitZoom(): void {
    const zoom = zoomDraft === null ? null : parseZoom(zoomDraft);
    zoomDraft = null;
    if (zoom !== null) pdf.setZoom(zoom);
  }

  /** Enter takes the typed value and Escape drops it; both give the keyboard back to the pages. */
  function onFieldKeydown(e: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (isComposing(e)) return;
    if (e.key !== "Enter" && e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") pageDraft = zoomDraft = null;
    // The blur commits what is left of the draft.
    e.currentTarget.blur();
    pdf.focus();
  }

  /** A button never takes the keyboard from the pages, where the arrow keys scroll. */
  const keepFocus = (e: MouseEvent): void => e.preventDefault();
</script>

<div class="pdf-toolbar">
  <div class="lead">
    {#if ready}
      <button
        type="button"
        class="icon-btn"
        aria-label={t("ariaPdfPanel")}
        aria-pressed={pdf.panelOpen}
        onmousedown={keepFocus}
        onclick={pdf.togglePanel}
      >
        <Icon name="menu" />
      </button>
    {/if}
    <span class="name">{name}</span>
  </div>

  {#if ready}
    <div class="controls">
      <input
        class="num page"
        type="text"
        inputmode="numeric"
        autocomplete="off"
        spellcheck="false"
        aria-label={t("ariaPdfPage")}
        style:--digits={Math.max(2, String(pdf.pages).length)}
        value={pageDraft ?? String(pdf.page)}
        onfocus={(e) => {
          pageDraft = String(pdf.page);
          e.currentTarget.select();
        }}
        oninput={(e) => (pageDraft = e.currentTarget.value)}
        onkeydown={onFieldKeydown}
        onblur={commitPage}
      />
      <span class="of">/ {pdf.pages}</span>

      <span class="sep"></span>

      <button type="button" class="icon-btn" aria-label={t("ariaPdfZoomOut")} disabled={!canZoomOut} onmousedown={keepFocus} onclick={pdf.zoomOut}>
        <Icon name="minus" />
      </button>
      <input
        class="num zoom"
        type="text"
        inputmode="decimal"
        autocomplete="off"
        spellcheck="false"
        aria-label={t("ariaPdfZoom")}
        value={zoomDraft ?? formatZoom(pdf.zoom)}
        onfocus={(e) => {
          zoomDraft = formatZoom(pdf.zoom);
          e.currentTarget.select();
        }}
        oninput={(e) => (zoomDraft = e.currentTarget.value)}
        onkeydown={onFieldKeydown}
        onblur={commitZoom}
      />
      <button type="button" class="icon-btn" aria-label={t("ariaPdfZoomIn")} disabled={!canZoomIn} onmousedown={keepFocus} onclick={pdf.zoomIn}>
        <Icon name="plus" />
      </button>

      <span class="sep extra"></span>

      <button
        type="button"
        class="icon-btn extra"
        aria-label={offersWidth ? t("ariaPdfFitWidth") : t("ariaPdfFitPage")}
        onmousedown={keepFocus}
        onclick={pdf.toggleFit}
      >
        <Icon name={offersWidth ? "fit-width" : "fit-page"} />
      </button>
      <button type="button" class="icon-btn extra" aria-label={t("ariaPdfRotate")} onmousedown={keepFocus} onclick={pdf.rotate}>
        <Icon name="rotate-left" />
      </button>
    </div>
  {/if}

  <!-- The third column keeps the controls in the middle. -->
  <div></div>
</div>

<style>
  .pdf-toolbar {
    flex: 1;
    min-width: 0;
    align-self: stretch;
    display: grid;
    grid-template-columns: minmax(28px, 1fr) auto minmax(0, 1fr);
    align-items: center;
    column-gap: 8px;
    overflow: hidden;
    container-type: inline-size;
  }

  .lead {
    display: flex;
    align-items: center;
    gap: 2px;
    min-width: 0;
  }

  .lead .icon-btn {
    flex: none;
  }

  .lead .icon-btn[aria-pressed="true"] {
    color: var(--c-text);
  }

  .name {
    min-width: 0;
    padding: 0 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--c-text-muted);
  }

  .controls {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .num {
    height: 24px;
    padding: 0 4px;
    border: 1px solid var(--c-border);
    border-radius: var(--radius-s);
    background: transparent;
    color: var(--c-text-muted);
    font-size: var(--fs-ui-small);
    font-variant-numeric: tabular-nums;
    text-align: center;
  }

  .num:focus {
    border-color: var(--c-border-strong);
    color: var(--c-text);
    outline: none;
  }

  .page {
    width: calc(var(--digits) * 1ch + 14px);
  }

  .zoom {
    width: 48px;
  }

  .of {
    padding: 0 4px;
    color: var(--c-text-muted);
    font-size: var(--fs-ui-small);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .sep {
    flex: none;
    width: 1px;
    height: 16px;
    margin: 0 6px;
    background: var(--c-border);
  }

  /* A narrow pane keeps the page and the zoom, and lets the name and then the two last buttons go. */
  @container (max-width: 400px) {
    .name {
      display: none;
    }
  }

  @container (max-width: 300px) {
    .extra {
      display: none;
    }
  }
</style>
