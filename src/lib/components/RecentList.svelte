<script module lang="ts">
  /** Focus request already handled; module-level because the list remounts with the sidebar. */
  let handledFocusTick = 0;
</script>

<script lang="ts">
  // The notes changed last (NAV-10): what the sidebar header's toggle shows where the file tree
  // stands. The newest comes first, each note with the time it was changed, so the list tells
  // which notes are being written, by this window or by another program. The selection is the
  // tree's (`vault.selected`): the row of the open note is the selected one in either list.
  import { editor } from "../state/editor.svelte";
  import { fresh } from "../state/newNote.svelte";
  import { startOfDay, timeStyle } from "../state/recent";
  import { ui } from "../state/ui.svelte";
  import { vault } from "../state/vault.svelte";
  import type { VaultPath } from "../types";
  import { t } from "../i18n";
  import { key, nfc } from "../utils/path";
  import { isComposing } from "../utils/platform";

  const uid = $props.id();

  /** The system's short forms: a time of day, a day of this year, a date of another year. */
  const FORMATS = {
    time: new Intl.DateTimeFormat(undefined, { timeStyle: "short" }),
    day: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }),
    date: new Intl.DateTimeFormat(undefined, { dateStyle: "short" }),
  };

  let list: HTMLDivElement | undefined = $state();
  /** Midnight of the current day: a note changed before it shows its date. */
  let today = $state(startOfDay(Date.now()));

  const rows = $derived(vault.recent);
  /**
   * The titles more than one row has. Those rows show their folder too, as the vault menu
   * shows the path of same-named vaults; the others need nothing beside their name.
   */
  const twins = $derived.by(() => {
    const once = new Set<string>();
    const twice = new Set<string>();
    for (const r of rows) {
      const k = key(r.node.title);
      if (once.has(k)) twice.add(k);
      else once.add(k);
    }
    return twice;
  });
  const selectedIndex = $derived(vault.selected === null ? -1 : rows.findIndex((r) => r.node.path === vault.selected));
  const activeId = $derived(selectedIndex >= 0 ? `${uid}-${selectedIndex}` : undefined);

  // While the list is on screen, the vault learns the times of what other programs write.
  $effect(() => vault.watchRecent());

  // What was changed "today" shows its date once the day is over.
  $effect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      const now = Date.now();
      const start = startOfDay(now);
      today = start;
      const next = new Date(start);
      next.setDate(next.getDate() + 1);
      timer = setTimeout(arm, next.getTime() - now + 1000);
    };
    arm();
    return () => clearTimeout(timer);
  });

  // ui.focusList(): take the keyboard.
  $effect(() => {
    const el = list;
    const tick = ui.recentFocusTick;
    if (!el || tick === handledFocusTick) return;
    handledFocusTick = tick;
    el.focus({ preventScroll: true });
  });

  /**
   * Shows a note. With `enter`, the keyboard goes into its text, also when it is the open note
   * already. A click passes false: the keyboard stays in the list, and the row of the open
   * note opens nothing (NAV-04), as in the tree.
   */
  function openNote(path: VaultPath, enter: boolean): void {
    if (editor.path === path) {
      if (enter && editor.kind === "note") editor.focusEditor();
      return;
    }
    editor.open(path, { focus: enter ? "editor" : "none" }).catch((err) => {
      console.error(err);
      ui.notify(t("errGeneric"));
    });
  }

  function select(i: number): void {
    const row = rows[i];
    if (!row) return;
    vault.selected = row.node.path;
    document.getElementById(`${uid}-${i}`)?.scrollIntoView({ block: "nearest" });
  }

  /** Where the first arrow press lands when no row is selected: the open note, else an end. */
  function startIndex(fallback: number): number {
    const i = rows.findIndex((r) => r.node.path === editor.path);
    return i >= 0 ? i : fallback;
  }

  function onkeydown(e: KeyboardEvent): void {
    if (isComposing(e)) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const n = rows.length;
    const cur = selectedIndex;
    switch (e.key) {
      case "ArrowDown":
        if (n === 0) return;
        select(cur < 0 ? startIndex(0) : Math.min(cur + 1, n - 1));
        break;
      case "ArrowUp":
        if (n === 0) return;
        select(cur < 0 ? startIndex(n - 1) : Math.max(cur - 1, 0));
        break;
      case "Home":
        if (n === 0) return;
        select(0);
        break;
      case "End":
        if (n === 0) return;
        select(n - 1);
        break;
      case "Enter":
        if (cur >= 0 && !e.repeat) openNote(rows[cur].node.path, true);
        break;
      case "Escape":
        vault.selected = null;
        if (editor.path !== null && (editor.kind === "note" || editor.kind === "code")) editor.focusEditor();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  /**
   * A click opens the note and leaves the keyboard in the list, never in the note (NAV-04): the
   * arrows and Enter go on from the clicked row. The press moved it here already, the list
   * being the focusable element under a row; the click makes sure of it.
   */
  function onclick(e: MouseEvent): void {
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-path]") : null;
    const path = row?.dataset.path;
    // The row of a new note with nothing typed in it changes nothing: the keyboard stays in the note (TREE-04).
    if (fresh.holds(path)) return;
    if (document.activeElement !== list) list?.focus({ preventScroll: true });
    if (path === undefined) return;
    vault.selected = path;
    openNote(path, false);
  }
</script>

<div
  bind:this={list}
  class="recent"
  class:no-active={activeId === undefined}
  role="listbox"
  tabindex="0"
  aria-label={t("ariaRecent")}
  aria-activedescendant={activeId}
  {onkeydown}
  {onclick}
>
  {#each rows as r, i (r.node.path)}
    {@const path = r.node.path}
    {@const folder = twins.has(key(r.node.title)) ? nfc(r.node.parent) : ""}
    <div
      id="{uid}-{i}"
      class="row"
      class:selected={vault.selected === path}
      class:open={editor.path === path}
      class:stuck={editor.stuck.has(path)}
      role="option"
      aria-selected={vault.selected === path}
      data-path={path}
    >
      <span class="name">{r.node.title}</span>
      {#if folder}<span class="folder">{folder}</span>{/if}
      <span class="time">{FORMATS[timeStyle(r.mtime, today)].format(r.mtime)}</span>
    </div>
  {/each}
</div>

<style>
  .recent {
    flex: 1;
    min-height: 0;
    padding: 4px 4px 8px;
    overflow-x: hidden;
    overflow-y: auto;
  }

  /* The selected row carries the ring; the list shows it only with nothing selected. */
  .recent:focus-visible {
    outline: none;
  }

  .recent.no-active:focus-visible,
  .recent:focus-visible .row.selected {
    outline: 1px solid var(--c-focus);
    outline-offset: -1px;
  }

  /* A tree row without its icon: the names start where the tree's icons do. */
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--row-h);
    padding: 0 var(--tree-pad-x);
    border-radius: var(--radius-s);
    color: var(--c-text);
    white-space: nowrap;
    transition: background-color var(--dur-fast);
  }

  .row:hover {
    background: var(--c-bg-hover);
  }

  .row.selected {
    background: var(--c-bg-active);
  }

  .row.open {
    color: var(--c-text-strong);
    font-weight: 500;
  }

  .row.stuck {
    color: var(--c-text-muted);
  }

  .name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .folder,
  .time {
    color: var(--c-text-muted);
    font-size: var(--fs-ui-small);
    font-weight: 400;
  }

  .folder {
    flex: 0 1 auto;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .time {
    flex: none;
    font-variant-numeric: tabular-nums;
  }
</style>
