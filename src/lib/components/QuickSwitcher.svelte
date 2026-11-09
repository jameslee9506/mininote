<script lang="ts">
  // Quick switcher (NAV-01, NAV-02): fuzzy-find a note by title, folder or path;
  // the empty query lists recent notes. Shift+Enter, or Enter when nothing
  // matches exactly, creates the typed note.
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";
  import Modal, { highlight, skipFocusRestore } from "./Modal.svelte";
  import { editor } from "../state/editor.svelte";
  import { settings } from "../state/settings.svelte";
  import { compareNodes } from "../state/tree";
  import { ui } from "../state/ui.svelte";
  import { vault } from "../state/vault.svelte";
  import { t } from "../i18n";
  import type { TreeNode, VaultPath } from "../types";
  import { fuzzyMatch, type FuzzyResult } from "../utils/fuzzy";
  import { key, nfc } from "../utils/path";
  import { isComposing } from "../utils/platform";

  /** Results shown at most (ARCHITECTURE §12); the create row comes on top. */
  const LIMIT = 50;
  /** A folder match counts a little less than a title match (NAV-02). */
  const FOLDER_WEIGHT = 0.8;
  /** Small bonus for recently opened notes, fading with age (NAV-02). */
  const RECENT_BOOST = 10;
  /** Result row height (DESIGN §4), used to size PageUp/PageDown. */
  const ROW_H = 32;

  interface Candidate {
    node: TreeNode;
    /** NFC folder path, "" at the vault root. */
    folder: string;
    /** NFC "folder/title": what a token containing "/" is matched against. */
    path: string;
    titleKey: string;
    pathKey: string;
  }

  interface Match {
    score: number;
    titleHits: number[];
    folderHits: number[];
  }

  interface Row extends Candidate, Match {
    /** The title (or, for a query containing "/", the path) equals the query. */
    exact: boolean;
  }

  const uid = $props.id();
  let query = $state("");
  let selected = $state(0);
  let list: HTMLElement | undefined = $state();
  let lastPointer = "";

  // Read once: sessions are not reactive, and opening a note closes the switcher.
  const recent: readonly VaultPath[] = vault.info ? settings.session(vault.info.root).recent : [];

  function toCandidate(node: TreeNode): Candidate {
    const folder = nfc(node.parent);
    const path = folder === "" ? node.title : `${folder}/${node.title}`;
    return { node, folder, path, titleKey: key(node.title), pathKey: key(path) };
  }

  const candidates = $derived(vault.notes.map(toCandidate));
  const q = $derived(query.trim());
  const rows: Row[] = $derived(q === "" ? recentRows() : rankedRows(q));
  const showCreate = $derived(q !== "" && !rows.some((r) => r.exact));
  const rowCount = $derived(rows.length + (showCreate ? 1 : 0));
  const active = $derived(rowCount === 0 ? -1 : Math.min(selected, rowCount - 1));

  /** Empty query: recently opened notes with the current one last, then recently modified ones (NAV-01). */
  function recentRows(): Row[] {
    const picked: TreeNode[] = [];
    const seen = new Set<VaultPath>();
    const add = (node: TreeNode | undefined): void => {
      if (node?.fileKind !== "note" || seen.has(node.path) || picked.length >= LIMIT) return;
      seen.add(node.path);
      picked.push(node);
    };
    const current = editor.path;
    for (const p of recent) if (p !== current) add(vault.node(p));
    if (current !== null) add(vault.node(current));
    if (picked.length < LIMIT) {
      const rest = vault.notes.filter((n) => !seen.has(n.path)).sort((a, b) => b.mtime - a.mtime || compareNodes(a, b));
      for (const n of rest.slice(0, LIMIT - picked.length)) add(n);
    }
    return picked.map((node) => ({ ...toCandidate(node), score: 0, titleHits: [], folderHits: [], exact: false }));
  }

  /**
   * Every whitespace-separated token must match (NAV-02): a token containing "/"
   * against the whole path, any other against the title or, weighted lower, the folder.
   */
  function matchCandidate(tokens: readonly string[], c: Candidate, folderCache: Map<string, FuzzyResult | null>[]): Match | null {
    const m: Match = { score: 0, titleHits: [], folderHits: [] };
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.includes("/")) {
        const r = fuzzyMatch(token, c.path);
        if (!r) return null;
        m.score += r.score;
        const titleStart = c.folder === "" ? 0 : c.folder.length + 1;
        for (const p of r.positions) {
          if (p >= titleStart) m.titleHits.push(p - titleStart);
          else if (p < c.folder.length) m.folderHits.push(p);
        }
        continue;
      }
      const inTitle = fuzzyMatch(token, c.node.title);
      let inFolder: FuzzyResult | null = null;
      if (c.folder !== "") {
        // Many notes share a folder: match each folder once per token.
        const cached = folderCache[i].get(c.folder);
        inFolder = cached !== undefined ? cached : fuzzyMatch(token, c.folder);
        if (cached === undefined) folderCache[i].set(c.folder, inFolder);
      }
      if (inTitle && (!inFolder || inTitle.score >= inFolder.score * FOLDER_WEIGHT)) {
        m.score += inTitle.score;
        m.titleHits.push(...inTitle.positions);
      } else if (inFolder) {
        m.score += inFolder.score * FOLDER_WEIGHT;
        m.folderHits.push(...inFolder.positions);
      } else {
        return null;
      }
    }
    return m;
  }

  /** Exact matches first, then score; ties go to the shorter title, the shorter path, then collator order (NAV-02). */
  function rankedRows(text: string): Row[] {
    const tokens = text.split(/\s+/).filter((s) => s !== "");
    const folderCache = tokens.map(() => new Map<string, FuzzyResult | null>());
    const queryKey = key(text);
    const byPath = text.includes("/");
    const recentIndex = new Map(recent.map((p, i) => [p, i]));
    const current = editor.path;
    const ranked: Row[] = [];
    for (const c of candidates) {
      const m = matchCandidate(tokens, c, folderCache);
      if (!m) continue;
      const age = c.node.path === current ? undefined : recentIndex.get(c.node.path);
      if (age !== undefined) m.score += RECENT_BOOST * (1 - age / recent.length);
      ranked.push({ ...c, ...m, exact: (byPath ? c.pathKey : c.titleKey) === queryKey });
    }
    ranked.sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.score - a.score ||
        a.node.title.length - b.node.title.length ||
        a.path.length - b.path.length ||
        compareNodes(a.node, b.node),
    );
    return ranked.slice(0, LIMIT);
  }

  function reset(): void {
    selected = 0;
    if (list) list.scrollTop = 0;
  }

  function select(i: number): void {
    selected = i;
    void tick().then(() => list?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.scrollIntoView({ block: "nearest" }));
  }

  /**
   * Follows real pointer moves only: not rows scrolling or appearing under a
   * resting pointer, and not the first report after opening.
   */
  function hover(e: MouseEvent, i: number): void {
    const at = `${e.clientX},${e.clientY}`;
    if (at === lastPointer) return;
    const first = lastPointer === "";
    lastPointer = at;
    if (!first) selected = i;
  }

  const keepFocus = (e: MouseEvent): void => e.preventDefault();

  /**
   * The opened note takes focus itself; when nothing has focus once the open or
   * create settles (it failed, or the note was already open), the editor gets it.
   */
  function refocusEditor(): void {
    if (document.activeElement === null || document.activeElement === document.body) editor.focusEditor();
  }

  function openNote(path: VaultPath): void {
    skipFocusRestore();
    ui.closeModal();
    editor.open(path).then(refocusEditor, refocusEditor);
  }

  /** Creates the typed note (NAV-01); an existing note at that location opens instead. */
  function create(): void {
    if (q === "") return;
    const target = vault.linkTargetPath(q);
    if (target === null) {
      ui.notify(t("errNameInvalid"));
      return;
    }
    const targetKey = key(target);
    const existing = vault.node(target) ?? vault.notes.find((n) => key(n.path) === targetKey);
    if (existing?.fileKind === "note") {
      openNote(existing.path);
      return;
    }
    skipFocusRestore();
    ui.closeModal();
    vault.createNoteFromLink(q).then(refocusEditor, refocusEditor);
  }

  function activate(i: number): void {
    if (i < 0) return;
    if (i < rows.length) openNote(rows[i].node.path);
    else if (showCreate) create();
  }

  /** Escape or a click outside: the editor gets its focus and selection back (NAV-01). */
  function close(): void {
    ui.closeModal();
    editor.focusEditor();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (isComposing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) create();
      else activate(active);
      return;
    }
    if (e.shiftKey) return;
    const page = Math.max(1, Math.floor((list?.clientHeight ?? 0) / ROW_H) - 1);
    let next: number;
    switch (e.key) {
      case "ArrowDown":
        next = active + 1 >= rowCount ? 0 : active + 1;
        break;
      case "ArrowUp":
        next = active <= 0 ? rowCount - 1 : active - 1;
        break;
      case "PageDown":
        next = Math.min(rowCount - 1, active + page);
        break;
      case "PageUp":
        next = Math.max(0, active - page);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = rowCount - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (rowCount > 0) select(next);
  }
</script>

{#snippet marked(text: string, hits: readonly number[])}
  {#each highlight(text, hits) as s}{#if s.hit}<span class="ml-hit">{s.text}</span>{:else}{s.text}{/if}{/each}
{/snippet}

<Modal label={t("cmdQuickSwitcher")} onclose={close}>
  <input
    class="ml-input"
    type="text"
    data-autofocus
    bind:value={query}
    oninput={reset}
    onkeydown={onKeydown}
    role="combobox"
    aria-label={t("ariaSearch")}
    aria-expanded={rowCount > 0}
    aria-controls={rowCount > 0 ? `${uid}-list` : undefined}
    aria-autocomplete="list"
    aria-activedescendant={active >= 0 ? `${uid}-${active}` : undefined}
    spellcheck="false"
    autocomplete="off"
    autocorrect="off"
    autocapitalize="off"
    writingsuggestions="false"
  />
  {#if rowCount > 0}
    <div bind:this={list} id="{uid}-list" class="ml-list" role="listbox" aria-label={t("cmdQuickSwitcher")}>
      {#each rows as row, i (row.node.path)}
        <button
          type="button"
          id="{uid}-{i}"
          data-index={i}
          class="ml-row"
          class:selected={i === active}
          role="option"
          tabindex="-1"
          aria-selected={i === active}
          onmousedown={keepFocus}
          onmousemove={(e) => hover(e, i)}
          onclick={() => activate(i)}
        >
          <span class="ml-main">{@render marked(row.node.title, row.titleHits)}</span>
          {#if row.folder !== ""}
            <span class="ml-aside">{@render marked(row.folder, row.folderHits)}</span>
          {/if}
        </button>
      {/each}
      {#if showCreate}
        {@const i = rows.length}
        <button
          type="button"
          id="{uid}-{i}"
          data-index={i}
          class="ml-row"
          class:selected={i === active}
          role="option"
          tabindex="-1"
          aria-selected={i === active}
          aria-label={t("create", { name: nfc(q) })}
          onmousedown={keepFocus}
          onmousemove={(e) => hover(e, i)}
          onclick={() => create()}
        >
          <!-- A plus icon and the typed name (NAV-01); the verb is only in the label. -->
          <span class="create-icon"><Icon name="note-plus" /></span>
          <span class="ml-main">{nfc(q)}</span>
        </button>
      {/if}
    </div>
  {/if}
</Modal>

<style>
  .create-icon {
    flex: none;
    color: var(--c-text-muted);
  }
</style>
