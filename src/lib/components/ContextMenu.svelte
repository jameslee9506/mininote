<script lang="ts">
  // Context menu (TREE-09): text-only items and separators at ui.menu's point,
  // kept inside the window. Focus never moves into the menu, so an action such
  // as Rename can focus its own input; keys are read at the window instead.
  import { ui, type MenuEntry } from "../state/ui.svelte";
  import { t } from "../i18n";
  import { isComposing } from "../utils/platform";

  type Item = Extract<MenuEntry, { label: string }>;

  /** Gap kept between the menu and the window edges. */
  const MARGIN = 4;
  const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn"]);

  let el: HTMLElement | undefined = $state();
  let active = $state(-1);
  let pos = $state<{ left: number; top: number } | null>(null);

  const menu = $derived(ui.menu);
  /** The items without leading, trailing or doubled separators. */
  const entries = $derived.by(() => {
    const out: MenuEntry[] = [];
    for (const entry of menu?.items ?? []) {
      if ("separator" in entry && (out.length === 0 || "separator" in out[out.length - 1])) continue;
      out.push(entry);
    }
    if (out.length > 0 && "separator" in out[out.length - 1]) out.pop();
    return out;
  });

  const runnable = (entry: MenuEntry | undefined): entry is Item => entry !== undefined && !("separator" in entry) && !entry.disabled;

  // Measure once rendered: open away from the window edges like a native menu
  // (left of / above the point), then clamp into the viewport. Items never wrap,
  // so the size does not depend on the position used for the first pass.
  $effect(() => {
    const m = menu;
    if (!m) return;
    if (entries.length === 0) {
      // Nothing to show: never leave an invisible menu that swallows keys.
      ui.hideMenu();
      return;
    }
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const maxLeft = window.innerWidth - width - MARGIN;
    const maxTop = window.innerHeight - height - MARGIN;
    const left = m.x > maxLeft ? m.x - width : m.x;
    const top = m.y > maxTop ? m.y - height : m.y;
    pos = { left: Math.max(MARGIN, Math.min(left, maxLeft)), top: Math.max(MARGIN, Math.min(top, maxTop)) };
    active = -1;
  });

  function step(dir: 1 | -1): void {
    const n = entries.length;
    let i = active < 0 ? (dir > 0 ? -1 : n) : active;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (runnable(entries[i])) {
        active = i;
        return;
      }
    }
  }

  /** Hides the menu first, then runs the item. */
  function choose(i: number): void {
    const item = entries[i];
    if (!runnable(item)) return;
    ui.hideMenu();
    void (async () => {
      try {
        await item.run();
      } catch (err) {
        console.error(err);
        ui.notify(t("errGeneric"));
      }
    })();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (isComposing(e)) return;
    switch (e.key) {
      case "ArrowDown":
        step(1);
        break;
      case "ArrowUp":
        step(-1);
        break;
      case "Home":
        active = -1;
        step(1);
        break;
      case "End":
        active = -1;
        step(-1);
        break;
      case "Enter":
        if (active >= 0) choose(active);
        else ui.hideMenu();
        break;
      case "Escape":
        ui.hideMenu();
        break;
      default:
        // Any other key dismisses the menu and goes on to where focus is.
        if (!MODIFIER_KEYS.has(e.key)) ui.hideMenu();
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  $effect(() => {
    const outside = (e: Event): boolean => !(e.target instanceof Node && el?.contains(e.target));
    const onMouseDown = (e: MouseEvent): void => {
      if (outside(e)) ui.hideMenu();
    };
    const onScroll = (e: Event): void => {
      if (outside(e)) ui.hideMenu();
    };
    const hide = (): void => ui.hideMenu();
    window.addEventListener("keydown", onKeydown, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("keydown", onKeydown, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  });
</script>

{#if menu && entries.length > 0}
  <div
    bind:this={el}
    class="menu menu-surface"
    style:left="{pos?.left ?? menu.x}px"
    style:top="{pos?.top ?? menu.y}px"
    style:visibility={pos ? undefined : "hidden"}
    role="menu"
    tabindex="-1"
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#each entries as entry, i}
      {#if "separator" in entry}
        <div class="separator" role="separator"></div>
      {:else}
        <button
          type="button"
          class="item"
          class:active={i === active}
          role="menuitem"
          tabindex="-1"
          aria-disabled={entry.disabled ? "true" : undefined}
          onmousedown={(e) => e.preventDefault()}
          onmousemove={() => (active = entry.disabled ? -1 : i)}
          onmouseleave={() => (active = -1)}
          onclick={() => choose(i)}>{entry.label}</button
        >
      {/if}
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: var(--z-menu);
    display: flex;
    flex-direction: column;
    min-width: 180px;
    max-height: calc(100vh - 8px);
    overflow-y: auto;
    padding: 4px;
  }

  .item {
    flex: none;
    height: var(--row-h);
    padding: 0 10px;
    border-radius: var(--radius-s);
    color: var(--c-text);
    font-size: var(--fs-ui);
    text-align: left;
    white-space: nowrap;
  }

  .item.active {
    background: var(--c-bg-active);
  }

  .item[aria-disabled="true"] {
    color: var(--c-text-faint);
  }

  .item:focus-visible {
    outline: none;
  }

  .separator {
    flex: none;
    height: 1px;
    margin: 4px 0;
    background: var(--c-border);
  }
</style>
