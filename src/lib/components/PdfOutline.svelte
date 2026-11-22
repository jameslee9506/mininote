<script lang="ts">
  // The document outline of the PDF panel (TREE-20, DESIGN §7): the PDF's own bookmarks as a
  // tree. A click on an entry shows the place it names; its chevron shows its sub-entries.
  import { SvelteSet } from "svelte/reactivity";
  import Icon from "./Icon.svelte";
  import { t } from "../i18n";
  import { pdf, type PdfOutlineItem } from "../state/pdf.svelte";

  /** The entries whose sub-entries are shown: none at first, as in Chrome. */
  const open = new SvelteSet<PdfOutlineItem>();

  function toggle(item: PdfOutlineItem): void {
    if (!open.delete(item)) open.add(item);
  }

  /** A click never takes the keyboard from the pages. */
  const keepFocus = (e: MouseEvent): void => e.preventDefault();
</script>

{#snippet level(items: readonly PdfOutlineItem[], depth: number)}
  {#each items as item}
    <div class="row" style:--depth={depth}>
      {#if item.items.length > 0}
        <button
          type="button"
          class="twist"
          tabindex="-1"
          aria-label={t("ariaPdfOutlineToggle")}
          aria-expanded={open.has(item)}
          onmousedown={keepFocus}
          onclick={() => toggle(item)}
        >
          <Icon name="chevron-right" />
        </button>
      {:else}
        <span class="twist"></span>
      {/if}
      <button type="button" class="entry" tabindex="-1" onmousedown={keepFocus} onclick={() => pdf.goToOutline(item)}>
        {item.title}
      </button>
    </div>
    {#if item.items.length > 0 && open.has(item)}
      {@render level(item.items, depth + 1)}
    {/if}
  {/each}
{/snippet}

<div class="outline">
  {@render level(pdf.outline, 0)}
</div>

<style>
  .outline {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 6px 0;
  }

  .row {
    display: flex;
    align-items: center;
    min-height: var(--row-h);
    padding-left: calc(4px + var(--depth) * var(--indent));
    padding-right: 6px;
  }

  .row:hover {
    background: var(--c-bg-hover);
  }

  .twist {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: var(--row-h);
    color: var(--c-text-faint);
  }

  button.twist:hover {
    color: var(--c-text);
  }

  .twist :global(svg) {
    transition: transform var(--dur-fast);
  }

  .twist[aria-expanded="true"] :global(svg) {
    transform: rotate(90deg);
  }

  .entry {
    flex: 1;
    min-width: 0;
    padding: 5px 0;
    color: var(--c-text);
    font-size: var(--fs-ui);
    line-height: var(--lh-ui);
    text-align: left;
    overflow-wrap: anywhere;
  }
</style>
