<script lang="ts">
  // Context menu (TREE-09, VAULT-05): items and separators at ui.menu's point,
  // kept inside the window. An item with a submenu opens a second panel beside it
  // while the pointer rests on it, or with → (one level deep). An item may carry a
  // side button at its far edge, which acts on what the item names and leaves the
  // menu open. Focus never moves into the menu, so an action such as Rename can
  // focus its own input; keys are read at the window instead.
  import Icon from "./Icon.svelte";
  import { ui, type MenuAction, type MenuEntry, type MenuSideAction } from "../state/ui.svelte";
  import { t } from "../i18n";
  import { isComposing } from "../utils/platform";

  type Item = Exclude<MenuEntry, { separator: true }>;
  type Point = { left: number; top: number };

  /** Gap kept between the menu and the window edges. */
  const MARGIN = 4;
  /** How far a submenu lies over the main panel, so the pointer crosses no gap on its way in. */
  const OVERLAP = 3;
  /** The pointer rests this long on an item before its submenu opens. */
  const OPEN_MS = 120;
  /** An open submenu stays this long under a pointer on another item: the way into it may cross one. */
  const CLOSE_MS = 300;
  const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "Fn"]);

  let el: HTMLElement | undefined = $state();
  let subEl: HTMLElement | undefined = $state();
  let active = $state(-1);
  let pos = $state<Point | null>(null);
  /** The item whose submenu is open, or -1. */
  let sub = $state(-1);
  /** The highlighted item of the open submenu; -1 while the keys still move in the main panel. */
  let subActive = $state(-1);
  let subPos = $state<Point | null>(null);

  const menu = $derived(ui.menu);
  /** The items without leading, trailing or doubled separators, and without empty submenus. */
  const entries = $derived.by(() => {
    const out: MenuEntry[] = [];
    for (const entry of menu?.items ?? []) {
      if ("separator" in entry && (out.length === 0 || "separator" in out[out.length - 1])) continue;
      if ("submenu" in entry && entry.submenu.length === 0) continue;
      out.push(entry);
    }
    if (out.length > 0 && "separator" in out[out.length - 1]) out.pop();
    return out;
  });
  /** The open submenu: its parent item and its own items. */
  const opened = $derived.by(() => {
    const parent = sub < 0 ? undefined : entries[sub];
    return parent !== undefined && "submenu" in parent ? parent : null;
  });

  const enabled = (entry: MenuEntry | undefined): entry is Item =>
    entry !== undefined && !("separator" in entry) && !("run" in entry && entry.disabled === true);

  /** The node lies in the menu's anchor (`ui.showMenu`), whose own click closes the menu. */
  const onAnchor = (node: EventTarget | null): boolean => node instanceof Node && menu?.anchor?.contains(node) === true;

  /** The enabled item after `from` in `list` (before it for -1), wrapping around; `from` when there is none. */
  function next(list: readonly MenuEntry[], from: number, dir: 1 | -1): number {
    const n = list.length;
    let i = from < 0 ? (dir > 0 ? -1 : n) : from;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (enabled(list[i])) return i;
    }
    return from;
  }

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
    closeSub();
  });

  // The submenu, measured the same way: beside the main panel, on the side with room, its
  // first item level with the item that opened it.
  $effect(() => {
    const panel = subEl;
    const parent = sub < 0 ? null : el?.querySelector<HTMLElement>(`[data-index="${sub}"]`);
    if (!el || !panel || !parent) return;
    const main = el.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    const first = panel.firstElementChild;
    const inset = first instanceof HTMLElement ? first.offsetTop + panel.clientTop : 0;
    const right = main.right - OVERLAP;
    const left = right + width > window.innerWidth - MARGIN ? main.left + OVERLAP - width : right;
    const top = parent.getBoundingClientRect().top - inset;
    subPos = {
      left: Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN)),
    };
  });

  // ── Submenu ──────────────────────────────────────────────────

  let aimTimer: ReturnType<typeof setTimeout> | undefined;
  /** What the pending timer will do: open this item's submenu, or close the open one (-1). Null when none is pending. */
  let aimed: number | null = null;

  function cancelAim(): void {
    clearTimeout(aimTimer);
    aimed = null;
  }

  /**
   * Once the pointer has stayed its course for `ms`, the open submenu is item `i`'s (-1: none).
   * Further moves over the same item leave the running timer alone.
   */
  function aim(i: number, ms: number): void {
    if (aimed === i) return;
    cancelAim();
    if (i === sub) return;
    aimed = i;
    aimTimer = setTimeout(() => {
      aimed = null;
      if (i < 0) closeSub();
      else openSub(i, false);
    }, ms);
  }

  /** Opens the submenu of item `i` at once. With `keys`, the highlight moves into it, as → and Enter do. */
  function openSub(i: number, keys: boolean): void {
    const item = entries[i];
    if (!enabled(item) || !("submenu" in item)) return;
    cancelAim();
    if (sub !== i) {
      sub = i;
      subPos = null;
    }
    active = i;
    subActive = keys ? next(item.submenu, -1, 1) : -1;
  }

  function closeSub(): void {
    cancelAim();
    sub = -1;
    subActive = -1;
    subPos = null;
  }

  // ── Choosing ─────────────────────────────────────────────────

  /** Hides the menu first, then runs the item. */
  function run(item: MenuAction | undefined): void {
    if (!item || item.disabled) return;
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

  /**
   * A click on an item's side button. The menu is not hidden first: the action shows it again
   * as it now is (the positioning effect then drops the highlight), or hides it.
   */
  function runSide(side: MenuSideAction): void {
    void (async () => {
      try {
        await side.run();
      } catch (err) {
        console.error(err);
        ui.notify(t("errGeneric"));
      }
    })();
  }

  /** A click or Enter on an item of the main panel: its submenu opens, or it runs. */
  function choose(i: number, keys: boolean): void {
    const item = entries[i];
    if (!enabled(item)) return;
    if ("submenu" in item) openSub(i, keys);
    else run(item);
  }

  // ── Pointer ──────────────────────────────────────────────────

  function onItemMove(i: number): void {
    const item = entries[i];
    const on = enabled(item);
    active = on ? i : -1;
    subActive = -1;
    // A submenu opens after a short rest; an open one stays a little longer.
    aim(on && "submenu" in item ? i : -1, sub < 0 ? OPEN_MS : CLOSE_MS);
  }

  function onItemLeave(i: number): void {
    // The item of an open submenu, or of one about to open, stays highlighted.
    if (i !== sub && i !== aimed) active = -1;
  }

  /** The pointer is in the submenu's panel: it stays open, under its highlighted item. */
  function onSubMove(): void {
    cancelAim();
    active = sub;
  }

  // ── Keys ─────────────────────────────────────────────────────

  function onKeydown(e: KeyboardEvent): void {
    if (isComposing(e)) return;
    const items = opened?.submenu ?? [];
    /** The keys move in the submenu once one of its items is highlighted. */
    const inSub = subActive >= 0 && subActive < items.length;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
      case "Home":
      case "End": {
        const dir = e.key === "ArrowDown" || e.key === "Home" ? 1 : -1;
        const edge = e.key === "Home" || e.key === "End";
        if (inSub) subActive = next(items, edge ? -1 : subActive, dir);
        else {
          closeSub();
          active = next(entries, edge ? -1 : active, dir);
        }
        break;
      }
      case "ArrowRight":
        if (!inSub) openSub(active, true);
        break;
      case "ArrowLeft":
        closeSub();
        break;
      case "Enter":
        if (inSub) run(items[subActive]);
        else if (active >= 0) choose(active, true);
        else ui.hideMenu();
        break;
      case "Escape":
        ui.hideMenu();
        break;
      default:
        // Any other key dismisses the menu and goes on to where focus is. Space on the
        // anchor is left to the click it makes there, which closes the menu.
        if (!MODIFIER_KEYS.has(e.key) && !(e.key === " " && onAnchor(document.activeElement))) ui.hideMenu();
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  $effect(() => {
    const outside = (e: Event): boolean =>
      !(e.target instanceof Node && (el?.contains(e.target) || subEl?.contains(e.target)));
    const onMouseDown = (e: MouseEvent): void => {
      // A press on the anchor is left to its click, which closes the menu instead of opening it again.
      if (outside(e) && !onAnchor(e.target)) ui.hideMenu();
    };
    const onScroll = (e: Event): void => {
      if (outside(e)) ui.hideMenu();
      // The main panel scrolled under its submenu, which would no longer sit beside its item.
      else if (e.target === el) closeSub();
    };
    const hide = (): void => ui.hideMenu();
    window.addEventListener("keydown", onKeydown, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      cancelAim();
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
        <!-- The row carries the highlight and the pointer, so both hold under its side button; no press in it moves the focus. -->
        <div
          class="row"
          class:active={i === active}
          role="none"
          onmousedown={(e) => e.preventDefault()}
          onmousemove={() => onItemMove(i)}
          onmouseleave={() => onItemLeave(i)}
        >
          <button
            type="button"
            class="item"
            role="menuitem"
            tabindex="-1"
            data-index={i}
            aria-disabled={"run" in entry && entry.disabled ? "true" : undefined}
            aria-haspopup={"submenu" in entry ? "menu" : undefined}
            aria-expanded={"submenu" in entry ? i === sub : undefined}
            onclick={() => choose(i, false)}
          >
            <span class="item-label">
              {#if "icon" in entry && entry.icon}<Icon name={entry.icon} />{/if}
              {entry.label}
            </span>
            {#if "submenu" in entry}<span class="chevron"><Icon name="chevron-right" /></span>{/if}
          </button>
          {#if "side" in entry && entry.side}
            {@const side = entry.side}
            <button
              type="button"
              class="side"
              role="menuitem"
              tabindex="-1"
              aria-label={side.label}
              onclick={() => runSide(side)}
            >
              <Icon name={side.icon} size={12} />
            </button>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
  {#if opened}
    <div
      bind:this={subEl}
      class="menu menu-surface"
      style:left="{subPos?.left ?? 0}px"
      style:top="{subPos?.top ?? 0}px"
      style:visibility={subPos ? undefined : "hidden"}
      role="menu"
      tabindex="-1"
      aria-label={opened.label}
      onmousemove={onSubMove}
      oncontextmenu={(e) => e.preventDefault()}
    >
      {#each opened.submenu as item, j}
        <button
          type="button"
          class="item"
          class:active={j === subActive}
          role="menuitem"
          tabindex="-1"
          aria-disabled={item.disabled ? "true" : undefined}
          onmousedown={(e) => e.preventDefault()}
          onmousemove={() => (subActive = item.disabled ? -1 : j)}
          onmouseleave={() => (subActive = -1)}
          onclick={() => run(item)}>{item.label}</button
        >
      {/each}
    </div>
  {/if}
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

  /* An item of the main panel, with its side button if it has one. */
  .row {
    display: flex;
    flex: none;
    align-items: center;
    border-radius: var(--radius-s);
  }

  .item {
    display: flex;
    flex: none;
    align-items: center;
    gap: 12px;
    height: var(--row-h);
    padding: 0 10px;
    border-radius: var(--radius-s);
    color: var(--c-text);
    font-size: var(--fs-ui);
    text-align: left;
    white-space: nowrap;
  }

  .row > .item {
    flex: 1;
  }

  .row.active,
  .item.active {
    background: var(--c-bg-active);
  }

  /*
   * As far from the row's edges as from its top and bottom. It keeps its room and shows only
   * in the highlighted row; hidden, it takes no click, and none falls through to the item.
   */
  .side {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    margin-right: 4px;
    border-radius: var(--radius-s);
    color: var(--c-text-faint);
    visibility: hidden;
    transition:
      background-color var(--dur-fast),
      color var(--dur-fast);
  }

  .row.active > .side {
    visibility: visible;
  }

  .side:hover {
    background: var(--c-bg-hover);
    color: var(--c-text);
  }

  .side:active {
    background: var(--c-bg-active);
  }

  .item[aria-disabled="true"] {
    color: var(--c-text-faint);
  }

  .item:focus-visible {
    outline: none;
  }

  .item-label {
    display: flex;
    align-items: center;
    gap: var(--tree-icon-gap);
  }

  .item-label :global(.icon) {
    color: var(--c-text-muted);
  }

  /* The mark of an item that opens a submenu, at the far edge; its glyph ends short of its box. */
  .chevron {
    margin-left: auto;
    margin-right: -4px;
    color: var(--c-text-faint);
  }

  .separator {
    flex: none;
    height: 1px;
    margin: 4px 0;
    background: var(--c-border);
  }
</style>
