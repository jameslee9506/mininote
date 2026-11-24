<script lang="ts">
  // The page thumbnails of the PDF panel (TREE-20, DESIGN §7): one small sheet per page with its
  // number under it, the current page marked. A click shows that page and gives the list the
  // keyboard, where the arrow keys show the previous and the next page, as in Chrome.
  //
  // Only the sheets in or near view are drawn, one at a time, and a long document keeps a
  // limited number of drawings: the sheets are plain elements, and their canvases come and go
  // outside of Svelte's state.
  import { t } from "../i18n";
  import { pdf } from "../state/pdf.svelte";
  import { matchShortcut } from "../utils/keys";
  import { isComposing } from "../utils/platform";

  /** Drawings kept at once; beyond it, those farthest from the current page go first. */
  const MAX_DRAWN = 120;
  /** `--pdf-thumb-width`, should the token be unreadable. */
  const DEFAULT_WIDTH = 108;

  let root: HTMLDivElement | undefined = $state();

  const numbers = $derived(Array.from({ length: pdf.pages }, (_, i) => i + 1));

  /**
   * A press gives the keyboard to the list, never to the sheet's button: Chromium would focus
   * the button and WebKit would not, and the list's keys must work in both.
   */
  const takeFocus = (e: MouseEvent): void => {
    e.preventDefault();
    root?.focus({ preventScroll: true });
  };

  /** ↑ and ← show the previous page, ↓ and → the next; the other keys scroll the list. */
  function onkeydown(e: KeyboardEvent): void {
    if (e.defaultPrevented || isComposing(e)) return;
    const back = matchShortcut(e, "ArrowUp") || matchShortcut(e, "ArrowLeft");
    if (!back && !matchShortcut(e, "ArrowDown") && !matchShortcut(e, "ArrowRight")) return;
    e.preventDefault();
    if (back) pdf.previousPage();
    else pdf.nextPage();
  }

  // Drawing. Runs again for another set of pages and after a turn, which changes every sheet.
  $effect(() => {
    const el = root;
    const pages = pdf.pages;
    void pdf.rotation;
    if (!el || pages === 0) return;

    const width = parseFloat(getComputedStyle(el).getPropertyValue("--pdf-thumb-width")) || DEFAULT_WIDTH;
    const sheets = new Map<number, HTMLElement>();
    for (const thumb of el.querySelectorAll<HTMLElement>(".thumb")) {
      const sheet = thumb.querySelector<HTMLElement>(".sheet");
      if (sheet) sheets.set(Number(thumb.dataset.page), sheet);
    }
    /** A page's canvas, or null for a page that was tried and could not be drawn. */
    const drawn = new Map<number, HTMLCanvasElement | null>();
    const near = new Set<number>();
    let alive = true;
    let busy = false;

    const release = (page: number): void => {
      const canvas = drawn.get(page);
      drawn.delete(page);
      if (!canvas) return;
      canvas.remove();
      // Frees the backing store at once, without waiting for the collector.
      canvas.width = canvas.height = 0;
    };

    const evict = (): void => {
      if (drawn.size <= MAX_DRAWN) return;
      const here = pdf.page;
      const far = [...drawn.keys()].filter((page) => !near.has(page)).sort((a, b) => Math.abs(b - here) - Math.abs(a - here));
      for (const page of far) {
        if (drawn.size <= MAX_DRAWN) break;
        release(page);
      }
    };

    const draw = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        while (alive) {
          let next: number | null = null;
          for (const page of near) if (!drawn.has(page) && (next === null || page < next)) next = page;
          if (next === null) return;
          const sheet = sheets.get(next);
          const canvas = document.createElement("canvas");
          drawn.set(next, null);
          const aspect = sheet ? await pdf.drawThumbnail(next, canvas, width) : null;
          if (!alive) return;
          if (aspect !== null && sheet && drawn.has(next)) {
            sheet.style.aspectRatio = String(aspect);
            sheet.append(canvas);
            drawn.set(next, canvas);
          }
          evict();
        }
      } finally {
        busy = false;
      }
    };

    const seen = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) near.add(page);
          else near.delete(page);
        }
        void draw();
      },
      { root: el, rootMargin: "100% 0px" },
    );
    for (const thumb of el.querySelectorAll(".thumb")) seen.observe(thumb);

    return () => {
      alive = false;
      seen.disconnect();
      for (const page of [...drawn.keys()]) release(page);
      // A sheet takes its own page's shape once drawn; the next run starts from the default again.
      for (const sheet of sheets.values()) sheet.style.aspectRatio = "";
    };
  });

  // The current page's sheet is marked and kept in view.
  $effect(() => {
    const el = root;
    const page = pdf.page;
    void pdf.pages;
    if (!el) return;
    const thumb = el.querySelector<HTMLElement>(`.thumb[data-page="${page}"]`);
    if (!thumb) return;
    thumb.setAttribute("aria-current", "page");
    thumb.scrollIntoView({ block: "nearest" });
    return () => thumb.removeAttribute("aria-current");
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (the list takes the keyboard, so that its arrow keys turn the pages) -->
<div class="thumbs" role="region" aria-label={t("ariaPdfThumbnails")} tabindex="0" bind:this={root} style:--aspect={pdf.aspect} {onkeydown}>
  {#each numbers as page (page)}
    <button
      type="button"
      class="thumb"
      tabindex="-1"
      data-page={page}
      aria-label={t("ariaPdfPageNumber", { page })}
      onmousedown={takeFocus}
      onclick={() => pdf.goToPage(page)}
    >
      <span class="sheet"></span>
      <span class="number">{page}</span>
    </button>
  {/each}
</div>

<style>
  .thumbs {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 12px 0;
  }

  /* As on the pages: the marked sheet shows where the keyboard goes, and a ring would frame the list at every key. */
  .thumbs:focus-visible {
    outline: none;
  }

  .thumb {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 0;
  }

  /* The page in small: paper, whatever the theme. */
  .sheet {
    display: block;
    width: var(--pdf-thumb-width);
    aspect-ratio: var(--aspect);
    background: var(--c-pdf-page);
    box-shadow: 0 0 0 1px var(--c-border);
  }

  .sheet :global(canvas) {
    display: block;
    width: 100%;
    height: 100%;
  }

  .number {
    color: var(--c-text-muted);
    font-size: var(--fs-ui-small);
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }

  .thumb:hover .sheet {
    box-shadow: 0 0 0 1px var(--c-border-strong);
  }

  .thumb:global([aria-current="page"]) .sheet {
    box-shadow: 0 0 0 2px var(--c-text-muted);
  }

  .thumb:global([aria-current="page"]) .number {
    color: var(--c-text-strong);
    font-weight: 500;
  }
</style>
