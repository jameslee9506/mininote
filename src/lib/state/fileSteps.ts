/**
 * Undo and redo of the file operations (TREE-21). An operation leaves the step that takes it
 * back. Performing a step gives the step that takes that one back, which goes on the other
 * stack. Steps hold exact VaultPaths and are performed newest first, so each finds the files
 * as the step after it left them.
 */
import type { VaultPath } from "../types";

/** One thing to do to the vault's files. */
export type FileStep =
  /** Give the entry at `from` the path `to`: a rename or a move, taken back. */
  | { do: "move"; from: VaultPath; to: VaultPath }
  /** Put the entry at `path` in the trash: a new folder or a pasted copy taken back, a delete done again. */
  | { do: "trash"; path: VaultPath }
  /**
   * Bring the entry of `ticket` back from the trash to `path`: a delete, taken back. `shown` is
   * the file the delete closed, and `expanded` the folders it collapsed, both put back with it.
   */
  | { do: "restore"; path: VaultPath; ticket: number; shown: VaultPath | null; expanded: readonly VaultPath[] };

export type StepKind = "undo" | "redo";

/** Operations that can be taken back at most. The backend remembers more trashed entries than both stacks hold. */
export const STEP_LIMIT = 50;

export class StepHistory<S> {
  #undo: S[] = [];
  #redo: S[] = [];

  constructor(readonly limit = STEP_LIMIT) {}

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /** An operation was done, and `inverse` takes it back. What was undone before it can no longer be redone. */
  record(inverse: S): void {
    this.#push(this.#undo, inverse);
    this.#redo = [];
  }

  /** Takes the next step of `kind` off its stack: the one that undoes the last operation, or redoes the last undone one. */
  take(kind: StepKind): S | null {
    return this.#stack(kind).pop() ?? null;
  }

  /** The step taken with `take(kind)` was performed, and `inverse` takes it back: it is the next step of the other kind. */
  performed(kind: StepKind, inverse: S): void {
    this.#push(this.#stack(kind === "undo" ? "redo" : "undo"), inverse);
  }

  /** The step taken with `take(kind)` was not performed after all: it is the next one again. */
  putBack(kind: StepKind, step: S): void {
    this.#stack(kind).push(step);
  }

  clear(): void {
    this.#undo = [];
    this.#redo = [];
  }

  #stack(kind: StepKind): S[] {
    return kind === "undo" ? this.#undo : this.#redo;
  }

  #push(stack: S[], step: S): void {
    stack.push(step);
    if (stack.length > this.limit) stack.splice(0, stack.length - this.limit);
  }
}
