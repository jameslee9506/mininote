<script module lang="ts">
  import { isComposing } from "../utils/platform";

  // Ticks already acted on, and the scroll position: module-level because the tree
  // remounts whenever it is shown again (panel switch, sidebar toggle).
  let handledRevealTick = 0;
  let handledFocusTick = 0;
  let savedScroll = { root: "", top: 0 };

  /** The mounted tree, for the F2 listener below. */
  let mounted: { el: HTMLElement; renameSelected: () => void } | null = null;

  // F2 is also the global "rename the open note" shortcut, and the shell's capturing
  // window listener would consume it before the tree sees it. This listener is
  // registered at import time, so it runs first; it claims F2 only while focus is
  // inside the tree, where F2 renames the selected row (TREE-06, TREE-11).
  if (typeof window !== "undefined") {
    window.addEventListener(
      "keydown",
      (e) => {
        if (isComposing(e) || e.key !== "F2" || mounted === null) return;
        const focused = document.activeElement;
        if (!focused || !mounted.el.contains(focused)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
        if (focused === mounted.el && plain && !e.repeat) mounted.renameSelected();
      },
      true,
    );
  }
</script>

<script lang="ts">
  // The vault tree (ARCHITECTURE §9, TREE-03/06/08–11/13): a virtualized flat list
  // of vault.rows with keyboard navigation, context menus and drag-to-move.
  import { untrack } from "svelte";
  import TreeRow from "./TreeRow.svelte";
  import { newFolder, newNote } from "../appCommands";
  import { vault, type TreeRow as RowData } from "../state/vault.svelte";
  import { editor } from "../state/editor.svelte";
  import { ui, type MenuEntry } from "../state/ui.svelte";
  import { t } from "../i18n";
  import { isMac, revealLabelKey } from "../utils/platform";
  import { dirname, isAncestor, join } from "../utils/path";
  import type { TreeNode, VaultPath } from "../types";

  const uid = $props.id();

  /** Drag data type carrying the dragged VaultPath (TREE-10). */
  const DRAG_TYPE = "application/x-mininote-path";
  const OVERSCAN = 6;
  const PAD_TOP = 4;
  /** Blank rows below the last one keep the root's menu and drop target reachable. */
  const BLANK_ROWS = 2;
  const EDGE = 32;
  const SCROLL_STEP = 8;
  const HOVER_EXPAND_MS = 700;
  /** dragover repeats at least every ~550 ms while the pointer rests (HTML spec); longer silence ends auto-scroll. */
  const DRAG_SILENCE_MS = 1000;

  let scroller: HTMLDivElement | undefined = $state();
  let rowH = $state(28);
  let scrollTop = $state(0);
  let viewportH = $state(0);

  /** Path being dragged (its row stays rendered and dimmed). */
  let dragSource = $state<VaultPath | null>(null);
  /** Folder that would receive the drop ("" = root), or null when dropping is refused. */
  let dropDir = $state<VaultPath | null>(null);

  const rows = $derived(vault.rows);
  const indexOf = $derived.by(() => {
    const map = new Map<VaultPath, number>();
    for (let i = 0; i < rows.length; i++) map.set(rows[i].node.path, i);
    return map;
  });
  /** 1-based position among siblings (aria-posinset; virtualization hides the others). */
  const posinset = $derived.by(() => {
    const seen = new Map<VaultPath, number>();
    return rows.map((r) => {
      const n = (seen.get(r.node.parent) ?? 0) + 1;
      seen.set(r.node.parent, n);
      return n;
    });
  });
  /**
   * The new folder's draft row (TREE-05): drawn as the first child of its parent, which
   * createFolder expanded, before `rows[at]`; the rows from there on move down one row.
   * Nothing exists on disk until vault.commitFolder.
   */
  const draft = $derived.by((): { key: object; at: number; row: RowData } | null => {
    const c = vault.creating;
    if (c === null) return null;
    const parent = vault.node(c.parent);
    if (parent?.kind !== "dir") return null;
    let at = 0;
    let guides: readonly boolean[] = [];
    if (c.parent !== "") {
      const i = indexOf.get(c.parent);
      if (i === undefined || !rows[i].expanded) return null;
      at = i + 1;
      // The parent's line runs on below the draft row to its real children, if any.
      guides = [...rows[i].guides, (parent.children?.length ?? 0) > 0];
    }
    const node: TreeNode = {
      // Display only: the row carries no data-path, so no action can reach this path.
      path: join(c.parent, c.name),
      name: c.name,
      title: c.name,
      kind: "dir",
      fileKind: null,
      ext: "",
      mtime: 0,
      parent: c.parent,
      depth: parent.depth + 1,
      children: [],
    };
    return { key: c, at, row: { node, expanded: false, guides } };
  });
  /** Row `i` is an open folder with a child drawn right below it (the draft row counts). */
  const hasStem = (i: number): boolean => draft?.at === i + 1 || rows[i + 1]?.node.parent === rows[i].node.path;
  /**
   * Where the draft row stood when a press in the tree dropped it (TREE-05), kept empty until
   * that press ends: the rows below must not move up under the pointer before the mouseup,
   * click, contextmenu or dragstart that follow pick their row.
   */
  let heldGap = $state<number | null>(null);
  /** Index of the first row drawn one row lower: the draft row's, else a held gap's. */
  const gapAt = $derived(draft?.at ?? heldGap);
  /** Offset of row `i`, after the draft row (or its held gap) when there is one. */
  const rowTop = (i: number): number => PAD_TOP + (gapAt !== null && i >= gapAt ? i + 1 : i) * rowH;
  const contentH = $derived(PAD_TOP + (rows.length + (gapAt === null ? 0 : 1) + BLANK_ROWS) * rowH);
  /** scrollTop clamped to the content, so a shrinking list never renders an empty window. */
  const viewTop = $derived(Math.min(scrollTop, Math.max(0, contentH - viewportH)));
  const first = $derived(Math.max(0, Math.floor((viewTop - PAD_TOP) / rowH) - OVERSCAN));
  const last = $derived(Math.min(rows.length, Math.ceil((viewTop - PAD_TOP + viewportH) / rowH) + OVERSCAN));
  const selectedIndex = $derived(vault.selected === null ? -1 : (indexOf.get(vault.selected) ?? -1));
  const activeId = $derived(selectedIndex >= 0 ? `${uid}-${selectedIndex}` : undefined);

  /**
   * Rendered row indices: the scroll window plus pinned rows that must stay in the
   * DOM — the selection (aria-activedescendant), the rename input and the drag
   * source (its dragend event must still bubble here).
   */
  const visible = $derived.by(() => {
    const picked = new Set<number>();
    for (let i = first; i < last; i++) picked.add(i);
    for (const p of [vault.selected, vault.renaming, dragSource]) {
      const i = p === null ? undefined : indexOf.get(p);
      if (i !== undefined) picked.add(i);
    }
    return [...picked].sort((a, b) => a - b);
  });

  // Mount: measure, restore the scroll position, register for F2.
  $effect(() => {
    const el = scroller;
    if (!el) return;
    untrack(() => {
      const h = parseFloat(getComputedStyle(el).getPropertyValue("--row-h"));
      if (h > 0) rowH = h;
      viewportH = el.clientHeight;
      if (savedScroll.root === (vault.info?.root ?? "")) {
        el.scrollTop = savedScroll.top;
        scrollTop = el.scrollTop;
      }
    });
    const self = { el, renameSelected };
    mounted = self;
    return () => {
      if (mounted === self) mounted = null;
      stopAutoScroll();
      clearHoverExpand();
    };
  });

  // A press anywhere but the draft's input drops the draft on mousedown (TreeRow), and Svelte
  // redraws before the browser sends the press's later events, which are hit-tested anew. So
  // a press in the tree holds the draft's slot until it ends (heldGap). Window capture runs
  // before TreeRow's document listener and before the focus change that blurs the input.
  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onPress = (e: MouseEvent): void => {
      const d = draft;
      if (d === null || !(e.target instanceof Node) || !scroller?.contains(e.target)) return;
      clearTimeout(timer);
      heldGap = d.at;
    };
    const onRelease = (): void => {
      if (heldGap === null) return;
      clearTimeout(timer);
      // A task later: after this event's handlers, and after the click (or, on Windows, the
      // contextmenu) dispatched right after a mouseup.
      timer = setTimeout(() => (heldGap = null), 0);
    };
    const ends = ["mouseup", "contextmenu", "dragend"] as const;
    window.addEventListener("mousedown", onPress, true);
    for (const type of ends) window.addEventListener(type, onRelease, true);
    window.addEventListener("blur", onRelease);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", onPress, true);
      for (const type of ends) window.removeEventListener(type, onRelease, true);
      window.removeEventListener("blur", onRelease);
    };
  });

  // ui.focusTree(): take keyboard focus (never from an active rename or new-folder input).
  $effect(() => {
    const el = scroller;
    const tick = ui.treeFocusTick;
    if (!el || tick === handledFocusTick) return;
    handledFocusTick = tick;
    untrack(() => {
      if (vault.renaming !== null || vault.creating !== null) return;
      el.focus({ preventScroll: true });
      if (selectedIndex >= 0) scrollToIndex(selectedIndex, "center");
    });
  });

  // vault.revealInTree(): center the selected row unless it is fully visible.
  // No reveal while an inline rename or a new folder's name is being typed (TREE-03).
  $effect(() => {
    const el = scroller;
    const tick = vault.revealTick;
    if (!el || tick === handledRevealTick) return;
    handledRevealTick = tick;
    untrack(() => {
      if (vault.renaming === null && vault.creating === null && selectedIndex >= 0) scrollToIndex(selectedIndex, "center");
    });
  });

  // The draft row scrolls into view once, like a rename that starts off-screen.
  let draftShown: object | null = null;
  $effect(() => {
    const el = scroller;
    const d = draft;
    if (d === null) draftShown = null;
    if (!el || d === null || draftShown === d.key) return;
    draftShown = d.key;
    untrack(() => scrollToTop(PAD_TOP + d.at * rowH, "center"));
  });

  // createFolder expands the parent; should its row still be off the list (an ancestor
  // collapsed), the chain is expanded. A draft whose parent folder is gone is dropped,
  // never left pending.
  $effect(() => {
    const c = vault.creating;
    if (c === null || draft !== null) return;
    untrack(() => {
      if (vault.node(c.parent)?.kind !== "dir") vault.cancelFolder();
      else for (let d = c.parent; d !== ""; d = dirname(d)) vault.toggle(d, true);
    });
  });

  // A rename that starts off-screen (F2 after scrolling) scrolls its row in once.
  let renameShown: VaultPath | null = null;
  $effect(() => {
    const el = scroller;
    const path = vault.renaming;
    const i = path === null ? undefined : indexOf.get(path);
    if (path === null) renameShown = null;
    if (!el || path === null || i === undefined || renameShown === path) return;
    renameShown = path;
    untrack(() => scrollToIndex(i, "center"));
  });

  function safely(p: Promise<unknown>): void {
    p.catch((err) => {
      console.error(err);
      ui.notify(t("errGeneric"));
    });
  }

  /** Scrolls row `i` into view ("nearest" for keyboard moves); no-op when it is fully visible. */
  function scrollToIndex(i: number, mode: "nearest" | "center"): void {
    scrollToTop(rowTop(i), mode);
  }

  /** Scrolls the row drawn at offset `top` into view; no-op when it is fully visible. */
  function scrollToTop(top: number, mode: "nearest" | "center"): void {
    const el = scroller;
    if (!el) return;
    const bottom = top + rowH;
    const view = el.scrollTop;
    const height = el.clientHeight;
    if (top >= view && bottom <= view + height) return;
    let next: number;
    if (mode === "center") next = top - (height - rowH) / 2;
    else if (top < view) next = top <= PAD_TOP ? 0 : top;
    else next = bottom - height;
    el.scrollTop = Math.max(0, Math.round(next));
    scrollTop = el.scrollTop;
  }

  function onscroll(): void {
    if (!scroller) return;
    scrollTop = scroller.scrollTop;
    savedScroll = { root: vault.info?.root ?? "", top: scrollTop };
  }

  /** VaultPath of the row an event happened on, or null for the blank area. */
  function pathAt(target: EventTarget | null): VaultPath | null {
    const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
    const row = el?.closest<HTMLElement>("[data-path]");
    return row && scroller?.contains(row) ? (row.dataset.path ?? null) : null;
  }

  function nodeAt(target: EventTarget | null): TreeNode | undefined {
    const path = pathAt(target);
    return path === null ? undefined : vault.node(path);
  }

  // ── Actions ──────────────────────────────────────────────────

  function openFile(path: VaultPath): void {
    if (editor.path === path) {
      if (editor.kind === "note") editor.focusEditor();
      return;
    }
    safely(editor.open(path));
  }

  /** Enter / click: toggle a folder, open a file. */
  function activate(node: TreeNode): void {
    if (node.kind === "dir") vault.toggle(node.path);
    else openFile(node.path);
  }

  function startRename(path: VaultPath): void {
    if (!vault.node(path)) return;
    vault.selected = path;
    vault.renaming = path;
  }

  function renameSelected(): void {
    if (vault.selected !== null && indexOf.has(vault.selected)) startRename(vault.selected);
  }

  function remove(path: VaultPath): void {
    // A tree that had the keyboard keeps it (TREE-11): a confirmation dialog hands focus back
    // when it closes, and the note shown in place of a deleted open one does not take it. So
    // only focus that went nowhere comes back here; focus moved elsewhere during the trash and
    // re-list stays there, and an input in the tree keeps it.
    const el = scroller;
    safely(
      vault.remove(path).then(() => {
        if (!el?.isConnected) return;
        const now = document.activeElement;
        if (now === null || now === document.body) el.focus({ preventScroll: true });
      }),
    );
  }

  function onrenameend(refocus: boolean): void {
    if (refocus) scroller?.focus({ preventScroll: true });
  }

  // ── Mouse and context menus (TREE-09) ────────────────────────

  function onclick(e: MouseEvent): void {
    const node = nodeAt(e.target);
    if (!node) return;
    vault.selected = node.path;
    activate(node);
  }

  function fileMenu(node: TreeNode): MenuEntry[] {
    const path = node.path;
    return [
      { label: t("rename"), run: () => startRename(path) },
      { label: t(revealLabelKey()), run: () => safely(vault.revealInOs(path)) },
      { separator: true },
      { label: t("delete"), run: () => remove(path) },
    ];
  }

  function folderMenu(node: TreeNode): MenuEntry[] {
    const path = node.path;
    return [
      { label: t("newNote"), run: () => safely(newNote({ dir: path })) },
      { label: t("newFolder"), run: () => safely(newFolder(path)) },
      { separator: true },
      ...fileMenu(node),
    ];
  }

  function blankMenu(): MenuEntry[] {
    return [
      { label: t("newNote"), run: () => safely(newNote({ dir: "" })) },
      { label: t("newFolder"), run: () => safely(newFolder("")) },
      { separator: true },
      { label: t("collapseAll"), run: () => vault.collapseAll(), disabled: vault.expanded.size === 0 },
    ];
  }

  function oncontextmenu(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const node = nodeAt(e.target);
    if (!node) {
      ui.showMenu(e.clientX, e.clientY, blankMenu());
      return;
    }
    vault.selected = node.path;
    ui.showMenu(e.clientX, e.clientY, node.kind === "dir" ? folderMenu(node) : fileMenu(node));
  }

  // ── Keyboard (TREE-11) ───────────────────────────────────────

  function select(i: number): void {
    const row = rows[i];
    if (!row) return;
    vault.selected = row.node.path;
    scrollToIndex(i, "nearest");
  }

  /** Where the first arrow press lands when nothing is selected: the open file, else an end. */
  function startIndex(fallback: number): number {
    return (editor.path === null ? undefined : indexOf.get(editor.path)) ?? fallback;
  }

  function onkeydown(e: KeyboardEvent): void {
    if (isComposing(e)) return;
    if (e.target !== scroller) return; // the rename input handles its own keys
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    const cmdOnly = isMac && e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey;
    const n = rows.length;
    const cur = selectedIndex;
    const row = cur >= 0 ? rows[cur] : undefined;

    switch (e.key) {
      case "ArrowDown":
        if (cmdOnly) {
          // Finder's ⌘↓ opens.
          if (row && !e.repeat) activate(row.node);
          break;
        }
        if (!plain || n === 0) return;
        select(cur < 0 ? startIndex(0) : Math.min(cur + 1, n - 1));
        break;
      case "ArrowUp":
        if (!plain || n === 0) return;
        select(cur < 0 ? startIndex(n - 1) : Math.max(cur - 1, 0));
        break;
      case "Home":
        if (!plain || n === 0) return;
        select(0);
        break;
      case "End":
        if (!plain || n === 0) return;
        select(n - 1);
        break;
      case "ArrowRight":
        if (!plain) return;
        if (row?.node.kind === "dir") {
          if (!row.expanded) vault.toggle(row.node.path, true);
          else if (rows[cur + 1]?.node.parent === row.node.path) select(cur + 1);
        }
        break;
      case "ArrowLeft":
        if (!plain) return;
        if (row) {
          if (row.node.kind === "dir" && row.expanded) vault.toggle(row.node.path, false);
          else if (row.node.parent !== "") {
            const parent = indexOf.get(row.node.parent);
            if (parent !== undefined) select(parent);
          }
        }
        break;
      case "Enter":
        if (!plain) return;
        if (row && !e.repeat) activate(row.node);
        break;
      case "Delete":
        if (!plain) return;
        if (row && !e.repeat) remove(row.node.path);
        break;
      case "Backspace":
        // ⌘⌫ on macOS; a bare Backspace never deletes (TREE-08).
        if (!cmdOnly) return;
        if (row && !e.repeat) remove(row.node.path);
        break;
      case "Escape":
        if (!plain) return;
        vault.selected = null;
        if (editor.path !== null && editor.kind === "note") editor.focusEditor();
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  // ── Drag and drop (TREE-10) ──────────────────────────────────

  let hoverPath: VaultPath | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollDir = 0;
  let scrollFrame = 0;
  let lastDragOver = 0;

  function isTreeDrag(e: DragEvent): boolean {
    return dragSource !== null && (e.dataTransfer?.types.includes(DRAG_TYPE) ?? false);
  }

  /** The folder a drop here lands in: a folder row, a file's folder, or the root for blank space. */
  function dropTargetAt(e: DragEvent): { dir: VaultPath; collapsed: VaultPath | null } {
    const node = nodeAt(e.target);
    if (!node) return { dir: "", collapsed: null };
    if (node.kind === "file") return { dir: node.parent, collapsed: null };
    return { dir: node.path, collapsed: vault.expanded.has(node.path) ? null : node.path };
  }

  /** Dropping onto itself, into a descendant or into its current folder does nothing. */
  function canDrop(src: VaultPath, dir: VaultPath): boolean {
    return src !== "" && dir !== src && !isAncestor(src, dir) && dir !== dirname(src);
  }

  function hoverExpand(path: VaultPath | null): void {
    if (path === hoverPath) return;
    clearHoverExpand();
    hoverPath = path;
    if (path === null) return;
    hoverTimer = setTimeout(() => {
      hoverTimer = undefined;
      if (dragSource !== null) vault.toggle(path, true);
    }, HOVER_EXPAND_MS);
  }

  function clearHoverExpand(): void {
    clearTimeout(hoverTimer);
    hoverTimer = undefined;
    hoverPath = null;
  }

  function autoScroll(y: number): void {
    if (!scroller) return;
    const r = scroller.getBoundingClientRect();
    scrollDir = y < r.top + EDGE ? -1 : y > r.bottom - EDGE ? 1 : 0;
    if (scrollDir !== 0 && scrollFrame === 0) scrollFrame = requestAnimationFrame(stepScroll);
  }

  function stepScroll(): void {
    scrollFrame = 0;
    if (scrollDir === 0 || !scroller || performance.now() - lastDragOver > DRAG_SILENCE_MS) return;
    scroller.scrollTop += scrollDir * SCROLL_STEP;
    scrollFrame = requestAnimationFrame(stepScroll);
  }

  function stopAutoScroll(): void {
    scrollDir = 0;
    if (scrollFrame !== 0) cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  }

  function clearDropFeedback(): void {
    dropDir = null;
    clearHoverExpand();
    stopAutoScroll();
  }

  function endDrag(): void {
    dragSource = null;
    clearDropFeedback();
  }

  function ondragstart(e: DragEvent): void {
    const node = nodeAt(e.target);
    const dt = e.dataTransfer;
    if (!node || !dt || vault.renaming !== null) {
      e.preventDefault();
      return;
    }
    dt.setData(DRAG_TYPE, node.path);
    // Dropped into the editor (or any text field), a note or an image becomes a wikilink;
    // other files have no link that would resolve (TREE-16).
    if (node.kind === "file" && node.fileKind !== "other") dt.setData("text/plain", `[[${vault.linkTextFor(node.path)}]]`);
    dt.effectAllowed = "all";
    dragSource = node.path;
  }

  /** dragenter and dragover: only our own drags are accepted; OS file drops pass through. */
  function ondragover(e: DragEvent): void {
    if (!isTreeDrag(e) || dragSource === null) return;
    lastDragOver = performance.now();
    autoScroll(e.clientY);
    const { dir, collapsed } = dropTargetAt(e);
    const ok = canDrop(dragSource, dir);
    hoverExpand(ok ? collapsed : null);
    dropDir = ok ? dir : null;
    if (!ok || !e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function ondragleave(e: DragEvent): void {
    if (dragSource === null || !scroller) return;
    // Leave events also fire between child rows, and virtualized rows can vanish under
    // the pointer (so enter/leave counts drift): decide by the pointer position instead.
    const r = scroller.getBoundingClientRect();
    if (e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) return;
    clearDropFeedback();
  }

  function ondrop(e: DragEvent): void {
    if (!isTreeDrag(e)) return;
    e.preventDefault();
    const src = e.dataTransfer?.getData(DRAG_TYPE) || dragSource;
    const { dir } = dropTargetAt(e);
    endDrag();
    if (src && canDrop(src, dir)) safely(vault.move(src, dir));
  }
</script>

<div
  bind:this={scroller}
  bind:clientHeight={viewportH}
  class="tree"
  class:no-active={activeId === undefined}
  class:drop-root={dropDir === ""}
  role="tree"
  tabindex="0"
  aria-label={t("ariaFiles")}
  aria-activedescendant={activeId}
  {onscroll}
  {onkeydown}
  {onclick}
  {oncontextmenu}
  {ondragstart}
  ondragenter={ondragover}
  {ondragover}
  {ondragleave}
  {ondrop}
  ondragend={endDrag}
>
  <div class="spacer" role="none" style:height="{contentH}px">
    {#each draft === null ? [] : [draft] as d (d.key)}
      <TreeRow
        row={d.row}
        id="{uid}-draft"
        top={PAD_TOP + d.at * rowH}
        setsize={(vault.node(d.row.node.parent)?.children?.length ?? 0) + 1}
        posinset={1}
        selected={false}
        open={false}
        stuck={false}
        renaming={false}
        creating
        stem={false}
        dropTarget={false}
        dragging={false}
        {onrenameend}
      />
    {/each}
    {#each visible as i (rows[i].node.path)}
      {@const row = rows[i]}
      {@const path = row.node.path}
      <TreeRow
        {row}
        id="{uid}-{i}"
        top={rowTop(i)}
        setsize={vault.node(row.node.parent)?.children?.length ?? 1}
        posinset={posinset[i]}
        selected={vault.selected === path}
        open={editor.path === path}
        stuck={editor.stuck.has(path)}
        renaming={vault.renaming === path}
        stem={hasStem(i)}
        dropTarget={dropDir === path}
        dragging={dragSource === path}
        {onrenameend}
      />
    {/each}
  </div>
</div>

<style>
  .tree {
    flex: 1;
    min-height: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }

  /* The focused row carries the ring; the container shows it only with nothing selected. */
  .tree:focus-visible {
    outline: none;
  }

  .tree.no-active:focus-visible {
    outline: 1px solid var(--c-focus);
    outline-offset: -1px;
  }

  .tree:focus-visible :global([role="treeitem"][aria-selected="true"]) {
    outline: 1px solid var(--c-focus);
    outline-offset: -1px;
  }

  .tree.drop-root {
    outline: 1px solid var(--c-border-strong);
    outline-offset: -1px;
  }

  .spacer {
    position: relative;
  }
</style>
