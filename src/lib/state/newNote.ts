/** Eligibility for cancelling the new note that is still open and untouched. */
import type { VaultPath } from "../types";
import { titleOf } from "../utils/names";
import { basename, key } from "../utils/path";

export interface NewNoteSnapshot {
  epoch: number | null;
  path: VaultPath | null;
  revision: number;
}

/**
 * Keep the actual generated path, including its localized name and collision suffix.
 * A matching name alone must never make an older note eligible for deletion.
 * `title` is the uncommitted inline title, when Escape came from that field.
 */
export function canDiscardNewNote(
  created: NewNoteSnapshot | null,
  current: NewNoteSnapshot,
  text: string,
  title?: string,
): boolean {
  if (!created || created.epoch === null || created.path === null) return false;
  if (current.epoch !== created.epoch || current.path !== created.path || current.revision !== created.revision) return false;
  if (text !== "") return false;
  return title === undefined || key(title) === key(titleOf(basename(created.path), "note"));
}
