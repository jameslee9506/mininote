<script lang="ts">
  // One virtualized tree row (DESIGN §4): guide lines, an icon for its kind and the title,
  // or the inline input while `renaming` (TREE-06) or while it is a new folder's draft row,
  // `creating` (TREE-05). FileTree positions the row and handles its clicks, menus and
  // drags by delegation; this component owns only the input.
  import Icon, { type IconName } from "./Icon.svelte";
  import { vault, type TreeRow as RowData } from "../state/vault.svelte";
  import { ui } from "../state/ui.svelte";
  import { t, type MessageKey } from "../i18n";
  import { isComposing, isMac } from "../utils/platform";
  import { key, nfc } from "../utils/path";
  import { validateName, withKeptExtension } from "../utils/names";

  interface Props {
    row: RowData;
    /** Element id, referenced by the tree's aria-activedescendant. */
    id: string;
    /** Offset from the top of the virtual list, in px. */
    top: number;
    setsize: number;
    posinset: number;
    selected: boolean;
    /** This file is open in the editor. */
    open: boolean;
    /** The note's unsaved changes are stuck for over 2 s (SAVE-09): lighter title. */
    stuck: boolean;
    renaming: boolean;
    /**
     * The draft row of vault.creating: its input creates the folder on Enter, and Esc, blur,
     * a click elsewhere or an empty name create nothing (TREE-05).
     */
    creating?: boolean;
    /** An open folder with its children drawn below: its guide line starts under the icon. */
    stem: boolean;
    dropTarget: boolean;
    dragging: boolean;
    /** The inline input closed; `refocus` asks the tree to take keyboard focus back. */
    onrenameend: (refocus: boolean) => void;
  }

  let {
    row,
    id,
    top,
    setsize,
    posinset,
    selected,
    open,
    stuck,
    renaming,
    creating = false,
    stem,
    dropTarget,
    dragging,
    onrenameend,
  }: Props = $props();

  const node = $derived(row.node);
  /**
   * A folder that opens and closes, a page for notes, a picture for images, a page of code, a blank
   * page for anything else. The icon set (SET-08) restyles the folder in CSS; the glyphs stay these.
   */
  const icon: IconName = $derived.by(() => {
    if (node.kind === "dir") return row.expanded ? "folder-open" : "folder";
    if (node.fileKind === "note") return "note";
    if (node.fileKind === "code") return "code";
    return node.fileKind === "image" ? "image" : "file";
  });

  let invalid = $state(false);
  /** Set once the current edit committed or cancelled; later blur/teardown events are ignored. */
  let done = false;
  /** Draft row: vault.commitFolder is running. Keys, blur and clicks elsewhere wait for its answer. */
  let committing = $state(false);
  /** Draft row: it was removed while committing, so a refused name drops the draft. */
  let orphaned = false;
  /** Draft row: the vault.creating it edits, so a newer draft is never cancelled by this one. */
  let draftOf: unknown = null;
  /** The input of the current edit. */
  let inputEl: HTMLInputElement | null = null;

  type Verdict = { kind: "cancel" } | { kind: "invalid"; message: MessageKey } | { kind: "ok"; name: string };

  /**
   * Interprets the typed text. Notes are edited without their extension and a typed
   * ".md"/".markdown" is dropped (TREE-06). Other files keep their extension when the
   * new name brings none (`withKeptExtension`). The result is what `vault.rename`
   * expects (the title for notes, the full name otherwise). Empty or unchanged
   * (ignoring Unicode form) cancels.
   */
  function judge(raw: string): Verdict {
    const isNote = node.fileKind === "note";
    // Untouched: exactly what edit() put in, even for a name that starts or ends with a space (UI-3).
    if (nfc(raw) === (isNote ? node.title : node.name)) return { kind: "cancel" };
    let name = isNote ? raw.trim().replace(/\.(md|markdown)$/i, "").trim() : raw.trim();
    if (name === "") return { kind: "cancel" };
    if (node.kind === "file" && !isNote) name = withKeptExtension(name, node.name);
    if (nfc(name) === (isNote ? node.title : node.name)) return { kind: "cancel" };
    const full = isNote ? `${name}.${node.ext}` : name;
    if (validateName(full, { note: isNote }) !== null) return { kind: "invalid", message: "errNameInvalid" };
    const fullKey = key(full);
    const siblings = vault.node(node.parent)?.children ?? [];
    if (siblings.some((s) => s.path !== node.path && key(s.name) === fullKey)) {
      return { kind: "invalid", message: "errNameExists" };
    }
    return { kind: "ok", name };
  }

  /**
   * Closes the input BEFORE the asynchronous rename starts, so it can never submit
   * twice. If rename mode moved to another row meanwhile, this edit is dropped.
   */
  function finish(refocus: boolean, newName: string | null): void {
    if (done) return;
    done = true;
    const { path, title } = node;
    const mine = vault.renaming === path;
    if (mine) vault.renaming = null;
    onrenameend(refocus);
    if (mine && newName !== null) {
      vault.rename(path, newName).catch((e) => {
        console.error(e);
        ui.notify(t("errRename", { name: title }));
      });
    }
  }

  /** Blur and click-away: commit a valid, changed name; cancel anything else (TREE-06). */
  function commitQuietly(input: HTMLInputElement): void {
    if (done) return;
    const v = judge(input.value);
    finish(false, v.kind === "ok" ? v.name : null);
  }

  /** Enter: an invalid name keeps the input open, marked invalid, with an error toast. */
  function commitLoudly(input: HTMLInputElement): void {
    const v = judge(input.value);
    if (v.kind === "invalid") {
      invalid = true;
      ui.notify(t(v.message));
      return;
    }
    finish(true, v.kind === "ok" ? v.name : null);
  }

  /** Draft row, anything but a commit: drops the draft, so nothing is created (TREE-05). */
  function cancelCreate(refocus: boolean): void {
    if (done) return;
    done = true;
    if (vault.creating === draftOf) vault.cancelFolder();
    onrenameend(refocus);
  }

  /**
   * Draft row, Enter: an empty name cancels. Otherwise the vault validates and creates the
   * folder, or refuses with a toast and keeps the draft, so the row stays open, marked invalid.
   */
  function commitCreate(input: HTMLInputElement): void {
    if (done || committing) return;
    const name = nfc(input.value.trim());
    if (name === "") {
      cancelCreate(true);
      return;
    }
    committing = true;
    const end = onrenameend;
    vault.commitFolder(name).then(
      (path) => settleCreate(path !== null, end),
      (e) => {
        console.error(e);
        ui.notify(t("errCreate", { name }));
        settleCreate(false, end);
      },
    );
  }

  function settleCreate(created: boolean, end: (refocus: boolean) => void): void {
    committing = false;
    if (created) {
      // The new folder is selected and revealed; the keyboard goes back to the tree, unless it
      // was moved during the commit (a click elsewhere, or another input in the tree).
      done = true;
      const active = document.activeElement;
      end(active === null || active === document.body || active === inputEl);
    } else if (orphaned) cancelCreate(false);
    else invalid = true;
  }

  /** Mounts the editor: fills it, focuses it and pre-selects the stem. */
  function edit(input: HTMLInputElement) {
    done = false;
    invalid = false;
    orphaned = false;
    draftOf = creating ? vault.creating : null;
    inputEl = input;
    const text = node.fileKind === "note" ? node.title : node.name;
    const dot = node.kind === "file" && node.fileKind !== "note" ? text.lastIndexOf(".") : -1;
    input.value = text;
    input.focus({ preventScroll: true });
    input.setSelectionRange(0, dot > 0 ? dot : text.length);

    // Capture phase: still runs when other handlers stop propagation or prevent the
    // default focus change (window drag regions do both). Right-click cancels, and so
    // does any click elsewhere while naming a new folder (FileTree keeps the dropped
    // draft row's slot until a press in the tree ends, so no row moves under the pointer).
    const onDocumentMouseDown = (e: MouseEvent) => {
      if (e.target instanceof Node && input.contains(e.target)) return;
      if (creating) {
        if (!committing) cancelCreate(false);
        return;
      }
      const secondary = e.button === 2 || (isMac && e.button === 0 && e.ctrlKey);
      if (secondary) finish(false, null);
      else commitQuietly(input);
    };
    document.addEventListener("mousedown", onDocumentMouseDown, true);

    return {
      destroy() {
        document.removeEventListener("mousedown", onDocumentMouseDown, true);
        if (done) return;
        // Removed without a blur (sidebar hidden, panel switched): same rule as blur.
        if (!creating) commitQuietly(input);
        else if (committing) orphaned = true;
        else cancelCreate(false);
      },
    };
  }

  function onInputKeydown(e: KeyboardEvent & { currentTarget: HTMLInputElement }): void {
    if (isComposing(e)) return;
    // Keys typed here never reach the tree's navigation handler.
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.repeat) return;
      if (creating) commitCreate(e.currentTarget);
      else commitLoudly(e.currentTarget);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (!creating) finish(true, null);
      else if (!committing) cancelCreate(true);
    }
  }

  function onInputBlur(e: FocusEvent & { currentTarget: HTMLInputElement }): void {
    // Switching to another app blurs the input too; it gets the focus back on return.
    if (!document.hasFocus()) return;
    if (!creating) commitQuietly(e.currentTarget);
    else if (!committing) cancelCreate(false);
  }

  const stop = (e: Event) => e.stopPropagation();
</script>

<div
  {id}
  class="row"
  class:folder={node.kind === "dir"}
  class:muted={node.fileKind === "image" || node.fileKind === "other"}
  class:selected
  class:open
  class:stuck
  class:drop-target={dropTarget}
  class:dragging
  style:top="{top}px"
  style:--depth={node.depth}
  role="treeitem"
  aria-level={node.depth + 1}
  aria-setsize={setsize}
  aria-posinset={posinset}
  aria-selected={selected}
  aria-expanded={node.kind === "dir" ? row.expanded : undefined}
  data-path={creating ? undefined : node.path}
  draggable={!renaming && !creating}
>
  {#each row.guides as runsOn, level}
    {#if runsOn}<span class="guide" style:--level={level}></span>{/if}
  {/each}
  {#if node.depth > 0}<span class="guide elbow" style:--level={node.depth - 1}></span>{/if}
  {#if stem}<span class="guide stem" style:--level={node.depth}></span>{/if}
  <span class="icon"><Icon name={icon} /></span>
  {#if renaming || creating}
    <input
      class="rename"
      class:invalid
      type="text"
      aria-label={creating ? t("newFolder") : t("rename")}
      aria-invalid={invalid}
      readonly={committing}
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      use:edit
      onkeydown={onInputKeydown}
      oninput={() => (invalid = false)}
      onblur={onInputBlur}
      onmousedown={stop}
      onclick={stop}
      ondblclick={stop}
      oncontextmenu={stop}
      ondragstart={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    />
  {:else}
    <span class="title">{node.title}</span>
  {/if}
</div>

<style>
  .row {
    position: absolute;
    left: 4px;
    right: 4px;
    display: flex;
    align-items: center;
    gap: var(--tree-icon-gap);
    height: var(--row-h);
    padding-left: calc(var(--tree-pad-x) + var(--depth) * var(--indent));
    padding-right: var(--tree-pad-x);
    border-radius: var(--radius-s);
    color: var(--c-text);
    font-size: var(--fs-ui);
    line-height: var(--lh-ui);
    white-space: nowrap;
    transition: background-color var(--dur-fast);
  }

  .row.folder {
    font-size: var(--fs-tree-folder);
  }

  .row:hover {
    background: var(--c-bg-hover);
  }

  .row.selected {
    background: var(--c-bg-active);
  }

  /* Images and unsupported files: secondary to the notes and the code, which open as text (DESIGN §4). */
  .row.muted {
    color: var(--c-text-muted);
  }

  .row.open {
    color: var(--c-text-strong);
    font-weight: 500;
  }

  .row.stuck {
    color: var(--c-text-muted);
  }

  .row.drop-target {
    background: var(--c-bg-active);
    box-shadow: inset 0 0 0 1px var(--c-border-strong);
  }

  /* The item dims, not the guide lines running through its row. */
  .row.dragging > :not(.guide) {
    opacity: 0.5;
  }

  /*
   * Guide lines (DESIGN §4): straight 1px lines with square corners. `--level` is the depth of
   * the open folder a line belongs to; the line runs down the middle of that folder's icon (the
   * half pixel falls on the device grid at 2x and is snapped at 1x). A plain guide crosses the
   * whole row; rows tile vertically, so the lines join up between rows.
   */
  .guide {
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(var(--tree-pad-x) + var(--level) * var(--indent) + var(--icon) / 2 - 0.5px);
    border-left: 1px solid var(--c-border-strong);
  }

  /* └ into the middle of this row's icon, stopping 1px short of it; with a plain guide, ├. */
  .elbow {
    bottom: auto;
    width: calc(var(--indent) - var(--icon) / 2 - 0.5px);
    height: calc(var(--row-h) / 2 + 0.5px);
    border-bottom: 1px solid var(--c-border-strong);
  }

  /* An open folder's line starts right under its own icon. */
  .stem {
    top: calc((var(--row-h) + var(--icon)) / 2);
  }

  .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: var(--icon);
    height: var(--icon);
    color: var(--c-icon-tree);
  }

  /* A folder takes its color, and whether it is solid, from the icon set (SET-08, tokens.css). */
  .folder .icon {
    color: var(--tree-folder);
    --icon-fill: var(--tree-folder-fill);
  }

  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Same position and size as the title: no layout shift (DESIGN §4). */
  .rename {
    flex: 1;
    min-width: 0;
    height: 20px;
    margin: 0 0 0 -3px;
    padding: 0 2px;
    border: none;
    border-radius: var(--radius-s);
    outline: 1px solid var(--c-border-strong);
    outline-offset: 0;
    background: var(--c-bg);
    color: var(--c-text-strong);
    font: inherit;
  }

  .rename.invalid {
    outline-style: dashed;
    outline-color: var(--c-text-muted);
  }
</style>
