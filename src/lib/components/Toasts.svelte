<script lang="ts">
  // Error toasts (DESIGN §4): a bottom-center stack of ui.toasts; ui.notify
  // dismisses each after 4 s, and a click dismisses it at once. A click never
  // takes focus away from the editor or an open modal.
  import { ui } from "../state/ui.svelte";

  /** Only the newest few are shown; older ones still expire on their own timers. */
  const MAX_VISIBLE = 5;

  const visible = $derived(ui.toasts.slice(-MAX_VISIBLE));
</script>

<div class="toasts" aria-live="assertive" aria-relevant="additions">
  {#each visible as toast (toast.id)}
    <button
      type="button"
      class="toast menu-surface"
      tabindex="-1"
      onmousedown={(e) => e.preventDefault()}
      onclick={() => ui.dismiss(toast.id)}>{toast.message}</button
    >
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 16px;
    z-index: var(--z-menu);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 0 16px;
    pointer-events: none;
  }

  .toast {
    max-width: min(480px, 100%);
    padding: 8px 12px;
    color: var(--c-text);
    font-size: var(--fs-ui);
    line-height: var(--lh-ui);
    text-align: left;
    overflow-wrap: anywhere;
    pointer-events: auto;
    animation: toast-in var(--dur) ease-out;
  }

  .toast:focus-visible {
    outline: none;
  }

  @keyframes toast-in {
    from {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
