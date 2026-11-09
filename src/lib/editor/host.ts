/**
 * The only bridge between CodeMirror extensions and app state. Editor modules
 * import this interface, never the stores, so they stay pure and testable.
 * Implemented by the editor store (src/lib/state/editor.svelte.ts).
 */
import type { EditorState } from "@codemirror/state";
import type { VaultPath } from "../types";

export type LinkTarget =
  /** [[target#subpath|alias]] — target "" means the current note. */
  | { kind: "wiki"; target: string; subpath: string | null }
  /** [text](href) — external URL or a relative/vault-absolute path. */
  | { kind: "href"; href: string };

export interface NoteCandidate {
  path: VaultPath;
  /** Notes are linked by title; images keep their extension in titles and link text. */
  kind: "note" | "image";
  /** Notes: file name without ".md"; images: full file name (NFC). */
  title: string;
  /** Parent folder path for display ("" at the root). */
  folder: string;
  /** Text to put inside [[ ]] — shortest unambiguous form. */
  linkText: string;
}

export interface EditorHost {
  /** Called for every user-originated doc change (never for External-annotated reloads). */
  onDocChanged(state: EditorState): void;
  /** Follow a link (open note, create note for an unresolved wikilink, or open a URL externally). */
  openLink(link: LinkTarget): void;
  /** Notes and images offered by [[ completion (LINK-04). */
  noteCandidates(): readonly NoteCandidate[];
  /** Resolved VaultPath of a wikilink target in the current note, or null (unresolved). */
  resolveWiki(target: string): VaultPath | null;
  /** URL for an <img src> (asset:// for vault files, http(s) passthrough), or null if unresolvable. */
  resolveImage(src: string, kind: "wiki" | "href"): string | null;
  /**
   * Saves pasted/dropped image bytes as an attachment of note `forNote` (captured
   * when the paste/drop happened, not read later) and returns the markdown to insert,
   * with a link relative to that note.
   */
  saveAttachment(data: Uint8Array, ext: string, forNote: VaultPath | null): Promise<string | null>;
  /** Wikilink text for a dragged tree item. */
  linkTextFor(path: VaultPath): string;
  currentPath(): VaultPath | null;
  /**
   * ↑ on the body's first line (EDIT-15): moves focus to the inline title, caret at
   * its end. Returns false when no title is shown, so the key keeps its default.
   */
  focusTitle(): boolean;
  /** The user's keys for editor command `id` (SET-06), or undefined to keep its default keys. Read at every key press. */
  shortcutKeys(id: string): readonly string[] | undefined;
}
