/**
 * Link targets for clicks (ARCHITECTURE §10.2 "Clicks", LIVE-06): resolved
 * from the syntax tree at event time, never captured when decorations are built.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import type { EditorHost, LinkTarget } from "../host";
import { parseWikiInner } from "../../markdown/resolve";
import { autolinkHref, linkDestination } from "./model";
import { fmField, reportOnce } from "./state";

/** Pointer travel (px) that turns a click on a rendered link into a drag. */
export const DRAG_SLOP = 4;

/** Text inside `[[…]]` / `![[…]]`; a table-escaped pipe (`\|`) counts as the alias separator. */
export function wikiInner(doc: Text, from: number, to: number): string {
  return doc.sliceString(from, to).replace(/\\\|/g, "|");
}

/** Target of a WikiLink/WikiEmbed node. */
export function wikiTarget(doc: Text, node: SyntaxNode): LinkTarget | null {
  const open = node.firstChild;
  const close = node.lastChild;
  if (!open || !close || close.from <= open.from) return null;
  const { target, subpath } = parseWikiInner(wikiInner(doc, open.to, close.from));
  return { kind: "wiki", target, subpath };
}

export interface FoundLink {
  target: LinkTarget;
  /** Source range of the whole construct. */
  from: number;
  to: number;
}

/**
 * The destination URL node of a Link or Image: the first URL after the label's
 * closing `]`. Reference links (`[t][ref]`, `[t]`) have none. A bare URL inside
 * the label (`[www.x.com](https://x.com)`) is also a URL child, and it comes
 * first, so `getChild("URL")` would return it instead of the destination.
 */
export function linkUrl(node: SyntaxNode): SyntaxNode | null {
  const close = node.getChildren("LinkMark")[1];
  if (!close) return null;
  for (let c = close.nextSibling; c; c = c.nextSibling) if (c.name === "URL") return c;
  return null;
}

const URL_OWNERS = new Set(["Link", "Image", "Autolink"]);

/** The link-like construct around `pos` (wikilink, markdown link, autolink, bare URL), or null. */
export function linkAt(state: EditorState, pos: number, side: -1 | 1 = 1): FoundLink | null {
  const fm = state.field(fmField, false);
  if (fm && pos <= fm.to) return null;
  const doc = state.doc;
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
    switch (n.name) {
      case "WikiLink":
      case "WikiEmbed": {
        const target = wikiTarget(doc, n);
        return target ? { target, from: n.from, to: n.to } : null;
      }
      case "Link":
      case "Image": {
        const url = linkUrl(n);
        if (!url) return null;
        return { target: { kind: "href", href: linkDestination(doc.sliceString(url.from, url.to)) }, from: n.from, to: n.to };
      }
      case "Autolink": {
        const url = n.getChild("URL");
        if (!url) return null;
        return { target: { kind: "href", href: autolinkHref(doc.sliceString(url.from, url.to)) }, from: n.from, to: n.to };
      }
      case "URL": {
        // A link's URLs (its destination, or a bare URL in its label) belong to the link.
        // In a reference link's label nothing is the destination, so a URL there is a bare link.
        const owner = n.parent;
        if (owner && URL_OWNERS.has(owner.name) && (owner.name === "Autolink" || linkUrl(owner))) continue;
        return { target: { kind: "href", href: autolinkHref(doc.sliceString(n.from, n.to)) }, from: n.from, to: n.to };
      }
    }
  }
  return null;
}

/**
 * The link under the pointer of a mouse event (used for Mod-click, which works
 * on rendered and revealed links alike). A click past the end of a line, or in
 * front of its start, does not count as a hit on a link at that edge.
 */
export function linkUnderPointer(view: EditorView, e: MouseEvent): FoundLink | null {
  const hit = view.posAndSideAtCoords({ x: e.clientX, y: e.clientY });
  if (!hit) return null;
  const found = linkAt(view.state, hit.pos, hit.assoc);
  if (!found) return null;
  if (hit.pos === found.to || hit.pos === found.from) {
    const edge = view.coordsAtPos(hit.pos, hit.assoc);
    if (!edge) return null;
    const outside = hit.pos === found.to ? e.clientX > edge.left + 2 : e.clientX < edge.left - 2;
    if (outside) return null;
  }
  return found;
}

/**
 * Returns a test for "this wikilink target does not resolve" (LIVE-14). It is
 * false for every target until the host has a note listing, because an empty
 * candidate list means the vault is still loading; nothing flashes dashed.
 */
export function unresolvedTest(host: EditorHost): (target: string) => boolean {
  let loaded: boolean | null = null;
  return (target) => {
    if (target === "") return false; // [[#heading]] points into the current note
    if (loaded === null) {
      try {
        loaded = host.noteCandidates().length > 0;
      } catch {
        loaded = false;
      }
    }
    if (!loaded) return false;
    try {
      return host.resolveWiki(target) === null;
    } catch {
      return false;
    }
  };
}

/** Hands a target to the host, isolating its errors from the editor's event handling. */
export function followLink(host: EditorHost, target: LinkTarget): void {
  try {
    host.openLink(target);
  } catch (err) {
    reportOnce("openLink", err);
  }
}

/**
 * Follows `target` when the primary button is released within DRAG_SLOP px of
 * the press in `e`; a longer drag cancels it.
 */
export function followOnRelease(e: MouseEvent, host: EditorHost, target: LinkTarget): void {
  const x = e.clientX;
  const y = e.clientY;
  const up = (u: MouseEvent) => {
    if (u.button !== 0) return;
    window.removeEventListener("mouseup", up, true);
    if (Math.max(Math.abs(u.clientX - x), Math.abs(u.clientY - y)) <= DRAG_SLOP) followLink(host, target);
  };
  window.addEventListener("mouseup", up, true);
}

/** The element an event targets (text-node targets resolve to their parent element). */
export function eventElement(e: Event): Element | null {
  const t = e.target as Node | null;
  if (!t) return null;
  return t.nodeType === 1 ? (t as Element) : t.parentElement;
}
