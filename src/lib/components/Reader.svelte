<script module lang="ts">
  import { editor } from "../state/editor.svelte";

  /*
   * NAV-05: the newest line request (`seq`) already shown, kept across reading views,
   * which unmount while editing and while an image or nothing is shown. A request
   * made while editing was the editor's to show. One made in reading mode while no
   * reading view existed is still this view's to show: a search hit opened from an
   * image or the blank state mounts the view in the same flush as the request.
   */
  let shownSeq = 0;

  $effect.root(() => {
    $effect(() => {
      const seq = editor.lineRequest?.seq ?? 0;
      if (editor.viewMode === "edit" && seq > shownSeq) shownSeq = seq;
    });
  });
</script>

<script lang="ts">
  /**
   * Reading view (READ-01…07): the note rendered to sanitized HTML. It re-renders
   * only when the text, the note path or the vault's link index change. Clicks are
   * delegated (ARCHITECTURE §9.2, LINK-01…05): the webview never navigates, links
   * open through the editor or the OS opener, and checkboxes toggle their source
   * line through the editor, so the change is undoable and autosaved. A line the
   * editor reveals (search hit, heading link) scrolls into view here too (NAV-05).
   */
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { t } from "../i18n";
  import { anchorKey, BROKEN_IMAGE_SRC, renderMarkdown } from "../markdown/render";
  import { isExternalHref, resolveMarkdownHref, resolveWikiTarget } from "../markdown/resolve";
  import { ui } from "../state/ui.svelte";
  import { vault } from "../state/vault.svelte";
  import type { VaultPath } from "../types";
  import { decodeLinkPath } from "../utils/path";
  import { isComposing } from "../utils/platform";

  interface Props {
    /** Markdown source to render. */
    text: string;
    /** The note's path: links and images resolve against its folder. */
    from: VaultPath | null;
  }

  let { text, from }: Props = $props();

  let article: HTMLElement | undefined = $state();

  /** Schemes handed to the OS (LINK-01); every other scheme does nothing. */
  const OPENABLE = /^(?:https?|mailto|tel):/i;

  /** Asset URL of a listed vault image; `?v=<mtime>` reloads it after it changes on disk. */
  function imageUrl(path: VaultPath | null): string | null {
    if (path === null) return null;
    const node = vault.node(path);
    if (node?.fileKind !== "image") return null;
    try {
      return `${vault.assetUrl(path)}?v=${Math.trunc(node.mtime)}`;
    } catch {
      // No asset protocol (not running in Tauri): this image shows as broken, the note still renders.
      return null;
    }
  }

  const html = $derived.by(() => {
    const index = vault.linkIndex;
    const note = from;
    return renderMarkdown(text, {
      from: note,
      resolveWiki: (target) => resolveWikiTarget(target, note, index),
      resolveHref: (href) => resolveMarkdownHref(href, note, index),
      resolveImage: (src, kind) =>
        imageUrl(kind === "wiki" ? resolveWikiTarget(src, note, index) : resolveMarkdownHref(src, note, index)),
    });
  });

  // A re-render replaces every node. Keep keyboard focus on the checkbox the user
  // just toggled (same source line) instead of dropping it to <body>.
  let focusedTaskLine: string | null = null;

  $effect.pre(() => {
    void html;
    const active = document.activeElement;
    const line =
      article && active instanceof Element && article.contains(active) && active.matches(".task-box")
        ? active.getAttribute("data-line")
        : null;
    // Digits only: raw HTML can forge data-line, and the value goes into a selector.
    focusedTaskLine = line !== null && /^\d+$/.test(line) ? line : null;
  });

  $effect(() => {
    void html;
    if (focusedTaskLine === null || !article) return;
    const box = article.querySelector(`.task-box[data-line="${focusedTaskLine}"]`);
    focusedTaskLine = null;
    if (box instanceof HTMLElement && document.activeElement !== box) box.focus({ preventScroll: true });
  });

  // NAV-05: a search hit or a heading link that opens a note while reading scrolls
  // to the source line the editor reveals, once the new HTML is in place. A request
  // already shown never replays (`shownSeq`), and one for another note is dropped.
  $effect(() => {
    void html;
    const req = editor.lineRequest;
    const root = article;
    if (!req || req.seq <= shownSeq || !root) return;
    if (req.path !== from) {
      shownSeq = req.seq;
      return;
    }
    // Layout is read in the next frame, never inside the effect (ARCHITECTURE §12).
    const frame = requestAnimationFrame(() => {
      shownSeq = Math.max(shownSeq, req.seq);
      scrollToLine(root, req.line);
    });
    return () => cancelAnimationFrame(frame);
  });

  function nearestScroller(el: HTMLElement): HTMLElement | null {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const overflow = getComputedStyle(p).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  }

  /** Scrolls `target` to the top of the document scroller, less its scroll-margin. */
  function scrollToTop(root: HTMLElement, target: Element): void {
    const scroller = nearestScroller(root);
    if (!scroller) {
      target.scrollIntoView({ block: "start" });
      return;
    }
    const margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
    scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - margin;
  }

  /** The block holding a 0-based source line: the last block that starts at or before it. */
  function blockAtLine(root: HTMLElement, line: number): Element | null {
    let found: Element | null = null;
    for (const el of root.querySelectorAll("[data-line]:not(.task-box)")) {
      const value = el.getAttribute("data-line") ?? "";
      // Digits only: raw HTML can forge data-line.
      if (!/^\d+$/.test(value)) continue;
      // Blocks come in source order, so the first later one ends the search.
      if (Number(value) > line) break;
      found = el;
    }
    // A fence carries its line on the <code> inside its <pre>.
    if (found?.tagName === "CODE" && found.parentElement?.tagName === "PRE") return found.parentElement;
    return found;
  }

  /** Scrolls a source line's block to the top. A line above every block shows the start of the note. */
  function scrollToLine(root: HTMLElement, line: number): void {
    const target = blockAtLine(root, line);
    if (target) {
      scrollToTop(root, target);
      return;
    }
    const scroller = nearestScroller(root);
    if (scroller) scroller.scrollTop = 0;
  }

  /** The heading (or raw-HTML id/name, prefixed by the sanitizer) an in-note anchor points at. */
  function findAnchor(root: HTMLElement, anchor: string): Element | null {
    const want = anchorKey(anchor);
    if (want !== "") {
      const seen = new Map<string, number>();
      let firstMatch: Element | null = null;
      for (const heading of root.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
        const key = anchorKey(heading.textContent ?? "");
        const n = seen.get(key) ?? 0;
        seen.set(key, n + 1);
        // Repeated headings are addressed as "name", "name-1", "name-2", … (GitHub style).
        if ((n === 0 ? key : `${key}-${n}`) === want) return heading;
        if (key === want && firstMatch === null) firstMatch = heading;
      }
      if (firstMatch) return firstMatch;
    }
    const named = `user-content-${anchor}`;
    for (const el of root.querySelectorAll("[id], [name]")) {
      if (el.id === named || el.getAttribute("name") === named) return el;
    }
    return null;
  }

  /** Scrolls an in-note anchor into view without touching `location` or history (PLAT-13). */
  function scrollToAnchor(raw: string): void {
    if (!article || raw.trim() === "") return;
    // As in the editor: the whole anchor first ("C# notes"), then the last part of a
    // nested one ("[[#Part#Sub]]" names "Sub" under "Part").
    const parts = raw.split("#").filter((s) => s.trim() !== "");
    const target =
      findAnchor(article, raw) ?? (parts.length > 1 ? findAnchor(article, parts[parts.length - 1]) : null);
    if (target) scrollToTop(article, target);
  }

  function follow(link: Element): void {
    if (link.matches("a.internal-link[data-wiki]")) {
      const target = link.getAttribute("data-wiki") ?? "";
      const subpath = link.getAttribute("data-subpath") || null;
      // A heading in this very note: only the reading view can scroll to it.
      if (target === "" || (from !== null && vault.resolveWiki(target, from) === from)) {
        if (subpath !== null) scrollToAnchor(subpath);
        return;
      }
      void editor.openLink({ kind: "wiki", target, subpath });
      return;
    }
    const href = link.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#")) {
      scrollToAnchor(decodeLinkPath(href.slice(1)));
      return;
    }
    if (isExternalHref(href)) {
      if (OPENABLE.test(href)) openUrl(href).catch(() => ui.notify(t("errOpen", { name: href })));
      return;
    }
    // "ThisNote.md#part" scrolls here, unless a file literally named "…#….md" exists (LINK-01).
    const hash = href.indexOf("#");
    if (
      hash > 0 &&
      from !== null &&
      vault.resolveHref(href.replace(/#/g, "%23"), from) === null &&
      vault.resolveHref(href, from) === from
    ) {
      scrollToAnchor(decodeLinkPath(href.slice(hash + 1)));
      return;
    }
    void editor.openLink({ kind: "href", href });
  }

  function toggleTask(box: Element): void {
    const line = box.getAttribute("data-line");
    if (line === null || !/^\d+$/.test(line) || editor.readOnly) return;
    editor.toggleTaskAtLine(Number(line));
  }

  function handleClick(e: MouseEvent): void {
    if (!article || !(e.target instanceof Element)) return;
    const box = e.target.closest(".task-box");
    if (box && article.contains(box)) {
      e.preventDefault();
      toggleTask(box);
      return;
    }
    const link = e.target.closest("a, area");
    if (!link || !article.contains(link)) return;
    e.preventDefault();
    // Releasing a drag that selected text across a link is a selection, not a click.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.containsNode(link, true)) return;
    follow(link);
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (isComposing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    if ((e.key !== "Enter" && e.key !== " ") || !(e.target instanceof Element)) return;
    if (e.target.matches(".task-box")) {
      e.preventDefault();
      toggleTask(e.target);
    } else if (e.key === "Enter" && e.target.matches("a.internal-link[data-wiki]")) {
      // Wikilinks have no href, so Enter does not activate them natively.
      e.preventDefault();
      follow(e.target);
    }
  }

  /** Middle-click must never open a window (READ-04). */
  function handleAuxClick(e: MouseEvent): void {
    if (e.target instanceof Element && e.target.closest("a, area")) e.preventDefault();
  }

  /** A link or image dropped back onto the page would navigate the webview. */
  function handleDragStart(e: DragEvent): void {
    const node = e.target;
    const el = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
    if (el?.closest("a, img")) e.preventDefault();
  }

  /** Images that fail to load become the muted, text-free box (READ-05). */
  function handleImageError(e: Event): void {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || img.classList.contains("is-broken")) return;
    img.classList.add("is-broken");
    img.src = BROKEN_IMAGE_SRC;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<article
  class="markdown"
  bind:this={article}
  onclick={handleClick}
  onkeydown={handleKeydown}
  onauxclick={handleAuxClick}
  ondragstart={handleDragStart}
  onerrorcapture={handleImageError}
>
  {@html html}
</article>
