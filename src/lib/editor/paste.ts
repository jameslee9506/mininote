/**
 * Paste and drop (EDIT-07, EDIT-08): clipboard images and images dropped from
 * the OS become attachments of the note they were pasted into, through
 * `host.saveAttachment`; a file-tree row dropped on the editor becomes a
 * wikilink; a single URL pasted over a one-line selection becomes a link
 * (replacing lang-markdown's pasteURLAsLink). Other text pastes stay with CodeMirror.
 */
import { StateEffect, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { commonmarkLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import type { VaultPath } from "../types";
import { extname } from "../utils/path";
import type { EditorHost } from "./host";

/** Drag type the file tree sets on its rows; the value is the row's VaultPath. */
export const TREE_DRAG_TYPE = "application/x-mininote-path";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};
/** The image types the vault listing shows (ARCHITECTURE §6.3). */
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);
/** Tree items that make sense as a wikilink: notes and images, not folders. */
const LINKABLE_EXTS = new Set(["md", "markdown", ...IMAGE_EXTS]);

/** Attachment extension for an image file, or null for anything else (ignored). */
function imageExt(file: File): string | null {
  const byType = MIME_EXT[file.type.toLowerCase()];
  if (byType) return byType;
  const ext = extname(file.name);
  return IMAGE_EXTS.has(ext) ? ext : null;
}

// ── Pending inserts ──────────────────────────────────────────────────────
// Saving is async. The files are saved for the note captured at paste time,
// and the target range lives in that note's own EditorState, so edits made
// meanwhile map it and a note switch (setState) cannot redirect the insert
// into another document. When another note is shown once the files are
// written, the links wait until the note's state is back in the view.

interface Pending {
  readonly id: number;
  readonly from: number;
  readonly to: number;
}

const addPending = StateEffect.define<Pending>();
const removePending = StateEffect.define<number>();

const pendingInserts = StateField.define<readonly Pending[]>({
  create: () => [],
  update(list, tr) {
    let next = list;
    if (tr.docChanged && next.length > 0) {
      next = next.map(({ id, from, to }) => {
        // A caret stays in front of text typed at it; a range shrinks rather than swallowing new text.
        if (from === to) {
          const at = tr.changes.mapPos(from, -1);
          return { id, from: at, to: at };
        }
        const start = tr.changes.mapPos(from, 1);
        return { id, from: start, to: Math.max(start, tr.changes.mapPos(to, -1)) };
      });
    }
    for (const e of tr.effects) {
      if (e.is(addPending)) next = [...next, e.value];
      else if (e.is(removePending)) next = next.filter((p) => p.id !== e.value);
    }
    return next;
  },
});

let lastPendingId = 0;

/** Finished links whose note was not in the view, by pending id. */
const waiting = new Map<number, string>();

/** Runs `fn` now, or after the IME composition ends (nothing dispatches into a composition). */
function whenIdle(view: EditorView, fn: () => void): void {
  if (!view.composing) {
    fn();
    return;
  }
  const retry = () => {
    view.contentDOM.removeEventListener("compositionend", retry);
    requestAnimationFrame(() => whenIdle(view, fn));
  };
  view.contentDOM.addEventListener("compositionend", retry);
}

/**
 * Saves the images one by one (unique names stay race-free) as attachments of
 * `note`, and returns the Markdown of each success.
 */
async function saveAll(host: EditorHost, files: readonly File[], note: VaultPath | null): Promise<string[]> {
  const parts: string[] = [];
  for (const file of files) {
    const ext = imageExt(file);
    if (!ext) continue;
    try {
      const markdown = await host.saveAttachment(new Uint8Array(await file.arrayBuffer()), ext, note);
      if (markdown) parts.push(markdown);
    } catch (e) {
      console.error("editor: saving an attachment failed", e);
    }
  }
  return parts;
}

/** Inserts the links of `id` when its note's state is the one in the view; false (nothing done) otherwise. */
function finishInsert(view: EditorView, id: number, text: string): boolean {
  const { state } = view;
  const pending = state.field(pendingInserts, false)?.find((p) => p.id === id);
  if (!pending) return false;
  const insert = text !== "" && !state.readOnly;
  const main = state.selection.main;
  const caretStayed = main.from === pending.from && main.to === pending.to;
  view.dispatch({
    changes: insert ? { from: pending.from, to: pending.to, insert: text } : undefined,
    selection: insert && caretStayed ? { anchor: pending.from + text.length } : undefined,
    effects: removePending.of(id),
    userEvent: insert ? "input.paste" : undefined,
    scrollIntoView: insert && caretStayed,
  });
  return true;
}

/** Inserts finished links now when their note is shown, else keeps them for when it is shown again. */
function deliver(view: EditorView, id: number, text: string): void {
  whenIdle(view, () => {
    if (finishInsert(view, id, text)) waiting.delete(id);
    else if (text !== "") waiting.set(id, text);
  });
}

/**
 * Created again on every setState: inserts the waiting links that belong to the
 * state just shown. A note that left the cache meanwhile takes its links with it.
 */
const deliverWaiting = ViewPlugin.define((view) => {
  if (waiting.size > 0) {
    const ids = (view.state.field(pendingInserts, false) ?? []).filter((p) => waiting.has(p.id)).map((p) => p.id);
    // Not while the view is still installing the state.
    if (ids.length > 0)
      queueMicrotask(() => {
        for (const id of ids) {
          const text = waiting.get(id);
          if (text !== undefined) deliver(view, id, text);
        }
      });
  }
  return {};
});

/**
 * Writes the images, then inserts all their links together at the (mapped)
 * range. A drop also puts the caret there, so it ends up after the links.
 */
function insertImages(view: EditorView, host: EditorHost, files: readonly File[], from: number, to: number, drop = false): void {
  const id = ++lastPendingId;
  // Read now: the files belong to this note even if another one is open once they are written.
  const note = host.currentPath();
  view.dispatch({ effects: addPending.of({ id, from, to }), selection: drop ? { anchor: from } : undefined });
  if (drop) view.focus();
  void saveAll(host, files, note).then((parts) => deliver(view, id, parts.join("\n")));
}

/** A clipboard that holds exactly one URL (EDIT-07). */
const SINGLE_URL = /^(?:https?:\/\/|mailto:|www\.)\S+$/i;
/** Nodes a pasted link must not land in or cut through (lang-markdown's pasteURLAsLink check). */
const NON_PLAIN = /code|horizontalrule|html|link|comment|processing|escape|entity|image|mark|url/i;

/**
 * A single URL pasted over a non-empty, single-line selection of plain text, outside
 * code and links, becomes "[selection](url)" in one undo step (EDIT-07). Unlike
 * lang-markdown's pasteURLAsLink, text that merely starts with a URL pastes as is.
 */
function pasteUrlAsLink(view: EditorView, text: string): boolean {
  const { state } = view;
  const { main } = state.selection;
  if (state.selection.ranges.length !== 1 || main.empty || state.doc.lineAt(main.from).to < main.to) return false;
  let url = text.trim();
  if (!SINGLE_URL.test(url)) return false;
  if (/^www\./i.test(url)) url = "https://" + url;
  if (!commonmarkLanguage.isActiveAt(state, main.from, 1)) return false;
  let crosses = false;
  syntaxTree(state).iterate({
    from: main.from,
    to: main.to,
    enter: (node) => {
      if (node.from > main.from || NON_PLAIN.test(node.name)) crosses = true;
    },
    leave: (node) => {
      if (node.to < main.to) crosses = true;
    },
  });
  if (crosses) return false;
  view.dispatch({
    changes: [
      { from: main.from, insert: "[" },
      { from: main.to, insert: `](${url})` },
    ],
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  return true;
}

/** Clipboard image files. `items` and `files` usually list the same files, so only one is used. */
function clipboardImages(data: DataTransfer): File[] {
  const fromItems: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file && imageExt(file)) fromItems.push(file);
  }
  return fromItems.length > 0 ? fromItems : Array.from(data.files).filter((f) => imageExt(f) !== null);
}

/** Paste and drop handlers for one host. */
export function pasteAndDrop(host: EditorHost): Extension {
  return [
    pendingInserts,
    deliverWaiting,
    EditorView.domEventHandlers({
      paste(event, view) {
        const data = event.clipboardData;
        if (!data || view.state.readOnly) return false;
        // When the clipboard holds text and an image (Office copies), the text wins.
        const text = data.getData("text/plain");
        if (text !== "") return pasteUrlAsLink(view, text);
        const files = clipboardImages(data);
        if (files.length === 0) return false;
        event.preventDefault();
        const { from, to } = view.state.selection.main;
        insertImages(view, host, files, from, to);
        return true;
      },

      dragover(event, view) {
        const dt = event.dataTransfer;
        if (!dt || view.state.readOnly) return false;
        const tree = dt.types.includes(TREE_DRAG_TYPE);
        if (tree || dt.types.includes("Files")) {
          event.preventDefault();
          dt.dropEffect = tree ? "link" : "copy";
        }
        // Not handled: the drop cursor keeps tracking the pointer.
        return false;
      },

      drop(event, view) {
        const dt = event.dataTransfer;
        if (!dt) return false;
        const tree = dt.types.includes(TREE_DRAG_TYPE);
        // Plain text drags (including moves inside the editor) stay with CodeMirror.
        if (!tree && !dt.types.includes("Files")) return false;
        event.preventDefault();
        if (view.state.readOnly) return true;
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
        if (tree) {
          const links = dt
            .getData(TREE_DRAG_TYPE)
            .split("\n")
            .filter((path) => path !== "" && LINKABLE_EXTS.has(extname(path)))
            .map((path) => `[[${host.linkTextFor(path).normalize("NFC")}]]`)
            .join(" ");
          if (links !== "") {
            view.dispatch({
              changes: { from: pos, insert: links },
              selection: { anchor: pos + links.length },
              userEvent: "input.drop",
              scrollIntoView: true,
            });
            view.focus();
          }
          return true;
        }
        // Dropped files that are not images are ignored (never inserted as text).
        const files = Array.from(dt.files).filter((f) => imageExt(f) !== null);
        if (files.length > 0) insertImages(view, host, files, pos, pos, true);
        return true;
      },
    }),
  ];
}
