<script lang="ts">
  // Sidebar width handle (NAV-04). A zero-width flex item meant to sit right after
  // the sidebar: its 4 px hit area straddles the sidebar's edge. Hidden in the
  // narrow layout, where the sidebar overlays the content (PLAT-12).
  import { DEFAULT_SETTINGS, SIDEBAR_MAX, SIDEBAR_MIN, settings } from "../state/settings.svelte";

  let dragging = $state(false);
  let startX = 0;
  let startWidth = 0;
  /** Latest requested width, applied at most once per frame. */
  let pending: number | null = null;
  let frame = 0;

  function setWidth(width: number): void {
    const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
    if (next !== settings.values.sidebarWidth) settings.update({ sidebarWidth: next });
  }

  function applyPending(): void {
    frame = 0;
    if (pending !== null) setWidth(pending);
    pending = null;
  }

  function onpointerdown(e: PointerEvent & { currentTarget: HTMLDivElement }): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    startX = e.clientX;
    startWidth = settings.values.sidebarWidth;
    dragging = true;
  }

  function onpointermove(e: PointerEvent): void {
    if (!dragging) return;
    pending = startWidth + e.clientX - startX;
    if (frame === 0) frame = requestAnimationFrame(applyPending);
  }

  function stop(): void {
    if (!dragging) return;
    dragging = false;
    if (frame !== 0) cancelAnimationFrame(frame);
    applyPending();
  }

  $effect(() => () => {
    if (frame !== 0) cancelAnimationFrame(frame);
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="resizer"
  class:dragging
  role="separator"
  aria-orientation="vertical"
  {onpointerdown}
  {onpointermove}
  onpointerup={stop}
  onpointercancel={stop}
  onlostpointercapture={stop}
  ondblclick={() => setWidth(DEFAULT_SETTINGS.sidebarWidth)}
></div>

<style>
  .resizer {
    position: relative;
    z-index: var(--z-sidebar);
    flex: none;
    width: 4px;
    margin: 0 -2px;
    cursor: col-resize;
    touch-action: none;
  }

  /* A quiet line appears once the pointer rests on the handle, and while dragging. */
  .resizer::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 1px;
    width: 2px;
    background: transparent;
    transition: background-color var(--dur);
  }

  .resizer:hover::after {
    background: var(--c-border-strong);
    transition-delay: 150ms;
  }

  .resizer.dragging::after {
    background: var(--c-border-strong);
    transition-delay: 0s;
  }

  @media (max-width: 699px) {
    .resizer {
      display: none;
    }
  }
</style>
