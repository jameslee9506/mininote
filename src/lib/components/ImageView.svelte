<script lang="ts">
  // Bare viewer for image files (TREE-15): centered, scaled down to fit but never up,
  // no controls, no caption. SVG only ever loads through <img>, so its scripts never run.
  import { vault } from "../state/vault.svelte";
  import type { VaultPath } from "../types";
  import { basename, nfc } from "../utils/path";

  let { path }: { path: VaultPath } = $props();

  const name = $derived(nfc(basename(path)));
  /**
   * `?v=<mtime>` reloads the image after it changes on disk (TECHNIQUES §8). Same URL
   * form as the editor's and the reading view's images, so they share one cache entry.
   */
  const src = $derived.by(() => {
    const node = vault.node(path);
    const url = vault.assetUrl(path);
    return node ? `${url}?v=${Math.trunc(node.mtime)}` : url;
  });
  /** Set by a failed load; a new path or version clears it. */
  let broken = $derived.by(() => {
    void src;
    return false;
  });
</script>

<div class="image-view">
  {#if broken}
    <div class="broken" role="img" aria-label={name}></div>
  {:else}
    <img {src} alt={name} draggable="false" onerror={() => (broken = true)} />
  {/if}
</div>

<style>
  .image-view {
    display: flex;
    justify-content: center;
  }

  img {
    max-width: 100%;
    max-height: calc(100vh - var(--header-h) - 2 * var(--content-pad-top));
    height: auto;
  }

  /* Unreadable or broken file: a muted empty box (READ-05). */
  .broken {
    width: min(100%, 320px);
    aspect-ratio: 4 / 3;
    background: var(--c-bg-code);
    border-radius: var(--radius-m);
  }
</style>
