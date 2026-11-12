<script lang="ts">
  /**
   * The single CodeMirror view (ARCHITECTURE §9). It is created once and lives
   * as long as a vault is open; the editor store swaps EditorStates into it.
   * The editor is auto-height: the ancestor .doc-scroll scrolls title and text together.
   */
  import { untrack } from "svelte";
  import { EditorView } from "@codemirror/view";
  import { createEditorState, reconfigureEditor, refreshDecorations } from "../editor/setup";
  import { editor } from "../state/editor.svelte";
  import { settings } from "../state/settings.svelte";
  import { vault } from "../state/vault.svelte";

  interface Props {
    /** The element that scrolls the document column (.doc-scroll), for per-note scroll restore. */
    scroller: HTMLElement | null;
  }

  let { scroller }: Props = $props();

  let host: HTMLDivElement | undefined = $state();
  // CodeMirror objects never live in $state (CLAUDE.md); effects below run after the one that sets these.
  let view: EditorView | null = null;
  let attachedScroller: HTMLElement | null = null;

  /** The prop, or the nearest .doc-scroll when a parent passes none. */
  function resolveScroller(el: HTMLElement): HTMLElement | null {
    return scroller ?? el.closest<HTMLElement>(".doc-scroll");
  }

  $effect(() => {
    const el = host;
    if (!el) return;
    const created = untrack(() => new EditorView({ state: createEditorState("", editor.host, editor.options()), parent: el }));
    view = created;
    untrack(() => {
      attachedScroller = resolveScroller(el);
      editor.attach(created, attachedScroller);
    });
    return () => {
      view = null;
      attachedScroller = null;
      editor.detach();
      created.destroy();
    };
  });

  // A parent that hands over its scroller later re-attaches with it.
  $effect(() => {
    const el = host;
    void scroller;
    if (!view || !el) return;
    const next = resolveScroller(el);
    if (next === attachedScroller) return;
    const current = view;
    untrack(() => {
      attachedScroller = next;
      editor.attach(current, next);
    });
  });

  // Primitives: settings.update replaces the whole settings object, and a setting none of these
  // depend on (the sidebar width, on every pointermove of a drag) must not re-run the effects below.
  const livePreview = $derived(editor.options().livePreview);
  const spellcheck = $derived(editor.options().spellcheck);
  const readOnly = $derived(editor.options().readOnly);
  const fontSize = $derived(settings.values.fontSize);
  const codeFont = $derived(settings.values.codeFont);
  const lineWidth = $derived(settings.values.lineWidth);
  const theme = $derived(settings.values.theme);

  // Settings changes, and swapped-in cached states built with older options. A no-op when nothing
  // differs. Never mid-composition (EDIT-11): the store re-applies options once a composition ends.
  $effect(() => {
    const opts = { livePreview, spellcheck, readOnly };
    void editor.path;
    if (view && !view.composing) reconfigureEditor(view, opts);
  });

  // The note set changed: unresolved-link styling depends on it (LIVE-14).
  $effect(() => {
    void vault.linkIndex;
    if (view) refreshDecorations(view);
  });

  // Font size, code font, line width and theme change line heights without any DOM change CodeMirror watches.
  $effect(() => {
    void fontSize;
    void codeFont;
    void lineWidth;
    void theme;
    view?.requestMeasure();
  });
</script>

<div class="editor" bind:this={host}></div>

<style>
  .editor {
    min-width: 0;
  }
</style>
