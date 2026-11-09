/** Annotations/effects shared across editor modules (kept separate to avoid import cycles). */
import { Annotation, StateEffect } from "@codemirror/state";

/** Marks programmatic transactions (external reloads, state swaps). Autosave ignores them. */
export const External = Annotation.define<boolean>();

/** Forces live-preview decorations to recompute (e.g. the vault's note set changed). */
export const refreshEffect = StateEffect.define<null>();

let resolutions = 0;

/**
 * Link and image resolutions a live-preview state cached before the last
 * `refreshDecorations` are stale in every state: the shown one also gets
 * refreshEffect, a cached one (another note) sees the new epoch on its next update.
 */
export function resolutionEpoch(): number {
  return resolutions;
}

export function invalidateResolutions(): void {
  resolutions++;
}
