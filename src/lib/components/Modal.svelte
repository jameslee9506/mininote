<script module lang="ts">
  /*
   * Shared shell of every modal (switcher, palette, settings, confirmations):
   * a panel 14vh from the top over a transparent click catcher (DESIGN §4).
   * The module also holds the focus bookkeeping shared by stacked modals and
   * the list helpers used by the switcher and the command palette.
   */

  interface OpenModal {
    panel: HTMLElement | null;
  }

  /** Open modals, innermost last; only the innermost one reacts to keys. */
  const stack: OpenModal[] = [];
  /** Element focused before the first modal opened; refocused when the last one closes. */
  let returnFocus: HTMLElement | null = null;

  /**
   * Call right before closing when the closing action moves focus itself (for
   * example by opening a note). The element focused before the modal opened is
   * then not refocused, so keys typed meanwhile cannot land in the old note.
   */
  export function skipFocusRestore(): void {
    returnFocus = null;
  }

  export interface Segment {
    text: string;
    hit: boolean;
  }

  /**
   * Splits `text` into runs of matched and unmatched characters, given the
   * UTF-16 `positions` a fuzzy match reported. Surrogate pairs stay whole.
   */
  export function highlight(text: string, positions: readonly number[]): Segment[] {
    if (positions.length === 0) return [{ text, hit: false }];
    const hit = new Array<boolean>(text.length).fill(false);
    for (const p of positions) if (p >= 0 && p < text.length) hit[p] = true;
    for (let i = 1; i < text.length; i++) {
      const lo = text.charCodeAt(i);
      const hi = text.charCodeAt(i - 1);
      if (lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff && (hit[i] || hit[i - 1])) {
        hit[i] = hit[i - 1] = true;
      }
    }
    const out: Segment[] = [];
    for (let start = 0, i = 1; i <= text.length; i++) {
      if (i === text.length || hit[i] !== hit[start]) {
        out.push({ text: text.slice(start, i), hit: hit[start] });
        start = i;
      }
    }
    return out;
  }
</script>

<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { isComposing } from "../utils/platform";

  interface Props {
    /** Panel width in px; narrow windows shrink it. */
    width?: number;
    /** Accessible name of the dialog. */
    label: string;
    /** Escape or a click outside; the owner decides what closing means. */
    onclose: () => void;
    children: Snippet;
  }

  let { width = 560, label, onclose, children }: Props = $props();

  let panel: HTMLElement | undefined = $state();
  const self: OpenModal = { panel: null };
  // A modal opened on top of another one also paints above it, whatever the DOM order.
  const layer = stack.length;

  const isTop = (): boolean => stack[stack.length - 1] === self;

  function tabbables(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")].filter(
      (el) => el.tabIndex >= 0 && !el.matches(":disabled") && el.getClientRects().length > 0,
    );
  }

  function onKeydown(e: KeyboardEvent): void {
    if (isComposing(e) || e.defaultPrevented || !isTop() || !panel) return;
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    } else if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // Keep Tab inside the panel: wrap at both ends, and pull focus back in if it escaped.
      const items = tabbables(panel);
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (!first) {
        e.preventDefault();
        panel.focus({ preventScroll: true });
      } else if (!(current instanceof Node) || !panel.contains(current)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey ? current === first || current === panel : current === last) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    }
  }

  $effect(() => {
    const el = panel;
    if (!el) return;
    // Focusing fires focus/blur listeners synchronously; nothing they read may become a dependency.
    return untrack(() => open(el));
  });

  function open(el: HTMLElement): () => void {
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    if (stack.length === 0) returnFocus = opener;
    self.panel = el;
    stack.push(self);
    if (!el.contains(active)) {
      (el.querySelector<HTMLElement>("[data-autofocus]") ?? el).focus({ preventScroll: true });
    }
    window.addEventListener("keydown", onKeydown);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      const i = stack.indexOf(self);
      if (i >= 0) stack.splice(i, 1);
      const top = stack[stack.length - 1]?.panel;
      const target = top ? (opener?.isConnected && top.contains(opener) ? opener : top) : returnFocus;
      if (!top) returnFocus = null;
      // The panel is already detached here. Refocus only when focus went down
      // with it, never when the closing action moved focus somewhere on purpose.
      const current = document.activeElement;
      if (target?.isConnected && (current === null || current === document.body)) target.focus({ preventScroll: true });
    };
  }
</script>

<div class="modal" style:z-index="calc(var(--z-modal) + {layer})">
  <div class="catcher" aria-hidden="true" onmousedown={(e) => e.preventDefault()} onclick={() => onclose()}></div>
  <div
    bind:this={panel}
    class="panel menu-surface"
    style:width="min({width}px, calc(100vw - 32px))"
    role="dialog"
    aria-modal="true"
    aria-label={label}
    tabindex="-1"
  >
    {@render children()}
  </div>
</div>

<style>
  .modal {
    position: fixed;
    inset: 0;
  }

  /* No backdrop tint (DESIGN §4): the catcher is transparent and only closes the modal. */
  .catcher {
    position: absolute;
    inset: 0;
  }

  .panel {
    position: absolute;
    top: 14vh;
    left: 0;
    right: 0;
    margin: 0 auto;
    max-height: calc(86vh - 16px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: var(--radius-l);
    animation: modal-in var(--dur-fast) ease-out;
  }

  .panel:focus-visible {
    outline: none;
  }

  @keyframes modal-in {
    from {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .panel {
      animation: none;
    }
  }

  /* ── List primitives shared by the quick switcher and the command palette ── */

  .panel :global(.ml-input) {
    flex: none;
    width: 100%;
    height: 44px;
    padding: 0 16px;
    border: none;
    background: transparent;
    color: var(--c-text-strong);
    caret-color: var(--c-caret);
    font-size: var(--fs-content);
  }

  .panel :global(.ml-input:focus-visible) {
    outline: none;
  }

  .panel :global(.ml-list) {
    flex: 1 1 auto;
    min-height: 0;
    max-height: 420px;
    overflow-y: auto;
    padding: 4px;
    border-top: 1px solid var(--c-border);
  }

  .panel :global(.ml-row) {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    height: 32px;
    padding: 0 10px;
    text-align: left;
    border-radius: var(--radius-s);
    color: var(--c-text);
    font-size: var(--fs-ui);
    white-space: nowrap;
  }

  .panel :global(.ml-row.selected) {
    background: var(--c-bg-active);
  }

  .panel :global(.ml-main) {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .panel :global(.ml-aside) {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--c-text-muted);
    font-size: var(--fs-ui-small);
  }

  .panel :global(.ml-hit) {
    color: var(--c-text-strong);
    font-weight: var(--fw-strong);
  }
</style>
