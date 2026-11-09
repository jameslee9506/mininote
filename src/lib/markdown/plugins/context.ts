/**
 * Per-render context for the reading-view plugins. Parsing never depends on it;
 * renderer rules read it from markdown-it's `env`, so one configured instance
 * serves every note.
 */
import type { Env } from "markdown-it";
import type { RenderContext } from "../render";

const CTX = Symbol("mininote.renderContext");

/** A fresh markdown-it env carrying `ctx`. */
export function envFor(ctx: RenderContext): Env {
  return { [CTX]: ctx };
}

/** The render context stored in `env`, or null when rendering without one. */
export function contextOf(env: Env | undefined): RenderContext | null {
  return (env?.[CTX] as RenderContext | undefined) ?? null;
}
