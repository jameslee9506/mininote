/**
 * The note that "New note" made a moment ago, for as long as nothing is typed in it (TREE-04).
 * Its inline title shows its name as a placeholder, and Esc or a click in the sidebar deletes
 * it. appCommands sets and clears it; the inline title says whether a title is typed.
 */
import type { VaultPath } from "../types";
import { editor } from "./editor.svelte";
import { canDiscardNewNote, type NewNoteSnapshot } from "./newNote";
import { vault } from "./vault.svelte";

class NewNoteStore {
  /** The new note as the editor first showed it. Compared, never cleared when the note is left or edited. */
  note = $state.raw<NewNoteSnapshot | null>(null);
  /** The inline title holds typed text: a name is on its way, so the note is no longer blank. */
  titled = $state(false);

  /** The open note is that note, with its text untouched: its title is a placeholder. */
  get open(): boolean {
    const note = this.note;
    if (note === null || editor.readOnly) return false;
    const now = { epoch: vault.info?.epoch ?? null, path: editor.path, revision: editor.revision };
    return canDiscardNewNote(note, now, editor.getText());
  }

  /** …and no title is typed for it either: leaving it deletes it. */
  get blank(): boolean {
    return this.open && !this.titled;
  }

  /** `path` is that blank note: what stands for it in the sidebar changes nothing when pressed. */
  holds = (path: VaultPath | null | undefined): boolean => path != null && path === editor.path && this.blank;
}

export const fresh = new NewNoteStore();
