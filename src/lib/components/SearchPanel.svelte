<script module lang="ts">
  /** Focus request already handled; module-level because the panel remounts with the sidebar. */
  let handledFocusTick = 0;
</script>

<script lang="ts">
  // Full-text search (SRCH-01/02): the search field at the top of the sidebar, always shown,
  // and results grouped by note that stand in for the file tree while a query is typed.
  // Hits are bold spans cut from the UTF-16 offsets — never {@html} (READ-04). An empty
  // result leaves the area blank (NAV-08): the input text turns faint instead, and
  // screen readers hear "No results".
  import { tick, untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { ui } from "../state/ui.svelte";
  import { vault } from "../state/vault.svelte";
  import { editor } from "../state/editor.svelte";
  import { isIpcError, searchText } from "../ipc/commands";
  import type { SearchFileResult, SearchMatch, VaultPath } from "../types";
  import { t } from "../i18n";
  import { isComposing } from "../utils/platform";
  import { basename, dirname, extname, nfc } from "../utils/path";
  import { fileKindOf, titleOf } from "../utils/names";
  import { debounce } from "../utils/timing";

  const uid = $props.id();
  const DEBOUNCE_MS = 200;
  /** Notes per response (SRCH-01). */
  const LIMIT = 200;
  /** Notes rendered at first; more are added as the list scrolls. */
  const PAGE = 40;
  /** Characters kept before the first hit when a snippet is cut for the narrow column. */
  const LEAD = 18;

  /** A selectable result: a note (line null) or one of its matching lines. */
  interface Target {
    path: VaultPath;
    line: number | null;
    /** The line's first hit, which the editor selects when it opens the note there (SRCH-01). */
    hit?: string;
    /** Index of the note in `results`. */
    file: number;
  }

  interface Segment {
    text: string;
    hit: boolean;
  }

  let input: HTMLInputElement | undefined = $state();
  let list: HTMLDivElement | undefined = $state();
  let results = $state.raw<SearchFileResult[]>([]);
  /** The results answer the current query (false while typing or waiting). */
  let answered = $state(false);
  let shown = $state(PAGE);
  let active = $state(0);
  /** Request sequence: only the newest response is shown. */
  let seq = 0;

  const searching = $derived(ui.searching);
  const index = $derived.by(() => {
    const targets: Target[] = [];
    const bases: number[] = [];
    results.forEach((r, file) => {
      bases.push(targets.length);
      targets.push({ path: r.path, line: null, file });
      for (const m of r.matches) targets.push({ path: r.path, line: m.line, hit: firstHit(m), file });
    });
    return { targets, bases };
  });
  const visibleResults = $derived(results.slice(0, shown));
  const noResults = $derived(searching && answered && results.length === 0);
  const activeId = $derived(searching && index.targets.length > 0 ? `${uid}-${active}` : undefined);

  async function run(query: string): Promise<void> {
    const id = ++seq;
    let found: SearchFileResult[] = [];
    try {
      found = (await searchText(query, false, LIMIT)).results;
    } catch (e) {
      if (id !== seq) return;
      // no_vault: the vault was switched mid-search; the new vault re-runs the query.
      if (!isIpcError(e, "no_vault")) {
        console.error(e);
        ui.notify(t("errGeneric"));
      }
    }
    if (id !== seq) return;
    results = found;
    answered = true;
    shown = PAGE;
    // Enter opens the first hit; a note matched only by name opens as a whole.
    active = found.length > 0 && found[0].matches.length > 0 ? 1 : 0;
    if (list) list.scrollTop = 0;
  }

  const schedule = debounce((query: string) => void run(query), DEBOUNCE_MS);

  let firstRun = true;
  let lastRoot: string | undefined;
  $effect(() => {
    const query = ui.searchQuery.trim();
    const root = vault.info?.root;
    untrack(() => {
      answered = false;
      if (root !== lastRoot) {
        // Never offer another vault's paths.
        lastRoot = root;
        results = [];
      }
      if (query === "") {
        schedule.cancel();
        seq++;
        results = [];
      } else if (firstRun) {
        // Mounted with a query (the sidebar shown again): no need to wait for the debounce.
        void run(query);
      } else {
        schedule(query);
      }
      firstRun = false;
    });
  });

  $effect(() => () => {
    schedule.cancel();
    seq++;
  });

  // ui.showSearch(): focus the input and select the query, so typing replaces it.
  $effect(() => {
    const el = input;
    const request = ui.searchFocusTick;
    if (!el || request === handledFocusTick) return;
    handledFocusTick = request;
    el.focus();
    el.select();
  });

  /**
   * The text of a snippet's first hit (ranges clipped like segments() does). Snippets keep the
   * line's own text, so the editor finds it in the line and selects it (SRCH-01, NAV-05).
   */
  function firstHit(m: SearchMatch): string | undefined {
    let best: [number, number] | undefined;
    for (const [s, e] of m.ranges) {
      const from = Math.max(0, s);
      const to = Math.min(e, m.text.length);
      if (to > from && (best === undefined || from < best[0])) best = [from, to];
    }
    return best && m.text.slice(best[0], best[1]);
  }

  function openTarget(i: number): void {
    const target = index.targets[i];
    if (!target) return;
    active = i;
    const opening =
      target.line === null
        ? editor.open(target.path)
        : editor.open(target.path, { line: target.line, select: target.hit });
    opening.catch((err) => {
      console.error(err);
      ui.notify(t("errGeneric"));
    });
  }

  async function move(delta: number): Promise<void> {
    const n = index.targets.length;
    if (n === 0) return;
    active = Math.min(n - 1, Math.max(0, active + delta));
    const file = index.targets[active].file;
    if (file >= shown) shown = file + PAGE;
    await tick();
    document.getElementById(`${uid}-${active}`)?.scrollIntoView({ block: "nearest" });
  }

  /** Clears the field, which brings the tree back, and hands it the keyboard. */
  function leave(): void {
    ui.showFiles();
    ui.focusTree();
  }

  /** Keys in the input, or in the list after a click on its blank area or scrollbar. */
  async function onkeydown(e: KeyboardEvent): Promise<void> {
    if (isComposing(e)) return;
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    switch (e.key) {
      case "Enter": {
        e.preventDefault();
        if (e.repeat) return;
        const query = ui.searchQuery.trim();
        if (query === "") return;
        if (!answered) {
          // Typed faster than the debounce: search now, then open its first hit.
          schedule.cancel();
          await run(query);
          if (!answered || ui.searchQuery.trim() !== query) return;
        }
        openTarget(active);
        return;
      }
      case "ArrowDown":
      case "ArrowUp":
        if (!plain) return;
        e.preventDefault();
        // With nothing to search, ↓ steps from the field into the tree below it.
        if (!searching) {
          if (e.key === "ArrowDown") ui.focusTree();
          return;
        }
        await move(e.key === "ArrowDown" ? 1 : -1);
        return;
      case "Escape":
        e.preventDefault();
        leave();
        return;
    }
  }

  function onscroll(): void {
    const el = list;
    if (!el || shown >= results.length) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 300) shown += PAGE;
  }

  /** Index of the result an event happened on, or -1. */
  function targetAt(e: MouseEvent): number {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-target]") : null;
    return el ? Number(el.dataset.target) : -1;
  }

  /** Clicking a result keeps the focus in the input until the note opens. */
  function onmousedown(e: MouseEvent): void {
    if (targetAt(e) >= 0) e.preventDefault();
  }

  function onclick(e: MouseEvent): void {
    const i = targetAt(e);
    if (i >= 0) openTarget(i);
  }

  function titleFor(path: VaultPath): string {
    return titleOf(nfc(basename(path)), fileKindOf(extname(path)));
  }

  /**
   * Splits a snippet into plain and hit segments. Overlapping or out-of-range offsets
   * are clipped. A hit far into the line moves the start close to it, behind "…".
   */
  function segments(m: SearchMatch): Segment[] {
    const text = m.text;
    const clamp = (n: number) => Math.max(0, Math.min(n, text.length));
    const ranges = m.ranges
      .map(([s, e]): [number, number] => [clamp(s), clamp(e)])
      .filter(([s, e]) => e > s)
      .sort((a, b) => a[0] - b[0]);
    let start = ranges.length > 0 && ranges[0][0] > LEAD ? ranges[0][0] - LEAD : 0;
    const unit = text.charCodeAt(start);
    if (start > 0 && unit >= 0xdc00 && unit <= 0xdfff) start--; // never split a surrogate pair
    const out: Segment[] = [];
    if (start > 0) out.push({ text: "…", hit: false });
    let pos = start;
    for (const [s, e] of ranges) {
      if (e <= pos) continue;
      const from = Math.max(s, pos);
      if (from > pos) out.push({ text: text.slice(pos, from), hit: false });
      out.push({ text: text.slice(from, e), hit: true });
      pos = e;
    }
    if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
    return out;
  }
</script>

<div class="panel" class:searching>
  <div class="bar">
    <span class="glyph"><Icon name="search" /></span>
    <input
      bind:this={input}
      class="field"
      class:none={noResults}
      type="text"
      value={ui.searchQuery}
      oninput={(e) => (ui.searchQuery = e.currentTarget.value)}
      {onkeydown}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      aria-label={t("ariaSearch")}
      aria-controls={searching ? `${uid}-results` : undefined}
      aria-activedescendant={activeId}
    />
    {#if ui.searchQuery !== ""}
      <!-- mousedown is cancelled so the field keeps the focus; the tree takes it on purpose. -->
      <button
        type="button"
        class="icon-btn clear"
        aria-label={t("ariaClearSearch")}
        onmousedown={(e) => e.preventDefault()}
        onclick={leave}
      >
        <Icon name="close" size={12} />
      </button>
    {/if}
  </div>
  {#if searching}
    <div
      bind:this={list}
      id="{uid}-results"
      class="results"
      role="listbox"
      tabindex="-1"
      aria-label={t("ariaSearch")}
      aria-activedescendant={activeId}
      {onscroll}
      {onmousedown}
      {onclick}
      {onkeydown}
    >
      {#each visibleResults as r, f (r.path)}
        {@const base = index.bases[f]}
        {@const folder = nfc(dirname(r.path))}
        <div
          id="{uid}-{base}"
          class="file"
          class:active={active === base}
          role="option"
          tabindex="-1"
          aria-selected={active === base}
          data-target={base}
        >
          <span class="name">{titleFor(r.path)}</span>
          {#if folder}<span class="folder">{folder}</span>{/if}
        </div>
        {#each r.matches as m, j}
          {@const k = base + 1 + j}
          <div
            id="{uid}-{k}"
            class="line"
            class:active={active === k}
            role="option"
            tabindex="-1"
            aria-selected={active === k}
            data-target={k}
          >
            {#each segments(m) as s}{#if s.hit}<b>{s.text}</b>{:else}{s.text}{/if}{/each}
          </div>
        {/each}
      {/each}
    </div>
  {/if}
  <div class="visually-hidden" aria-live="polite">{noResults ? t("noResults") : ""}</div>
</div>

<style>
  /* Just the field over the tree; with results, the whole column. */
  .panel {
    display: flex;
    flex: none;
    flex-direction: column;
    min-height: 0;
  }

  .panel.searching {
    flex: 1;
  }

  /* The glyph sits where the tree rows put their icons, so the column lines up. */
  .bar {
    position: relative;
    flex: none;
    padding: 2px 8px 6px;
  }

  .glyph {
    position: absolute;
    top: 2px;
    left: 14px;
    display: flex;
    align-items: center;
    height: 28px;
    color: var(--c-text-faint);
    pointer-events: none;
  }

  .field {
    padding-left: 28px;
    padding-right: 26px;
  }

  .field.none {
    color: var(--c-text-faint);
  }

  .clear {
    position: absolute;
    top: 4px;
    right: 10px;
    width: 24px;
    height: 24px;
  }

  .results {
    flex: 1;
    min-height: 0;
    padding: 0 4px 8px;
    overflow-x: hidden;
    overflow-y: auto;
  }

  .file {
    display: flex;
    align-items: center;
    gap: 8px;
    height: var(--row-h);
    padding: 0 8px;
    border-radius: var(--radius-s);
    color: var(--c-text-strong);
    font-weight: 500;
    white-space: nowrap;
  }

  .file:not(:first-child) {
    margin-top: 6px;
  }

  .name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .folder {
    flex: 0 1 auto;
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--c-text-muted);
    font-size: var(--fs-ui-small);
    font-weight: 400;
  }

  .line {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    padding: 3px 8px 3px 16px;
    border-radius: var(--radius-s);
    color: var(--c-text-muted);
    word-break: break-word;
    overflow-wrap: anywhere;
  }

  .line b {
    border-radius: 2px;
    background: var(--c-bg-mark);
    color: var(--c-text-strong);
    font-weight: 600;
  }

  .file:hover,
  .line:hover {
    background: var(--c-bg-hover);
  }

  .file.active,
  .line.active {
    background: var(--c-bg-active);
  }
</style>
