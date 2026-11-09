/**
 * Markdown links `[text](target)` (LINK-01): a target that is neither a URL with
 * a scheme nor a `#anchor` points into the vault and gets `class="internal-link"`,
 * plus `is-unresolved` when `ctx.resolveHref` finds no file for it.
 * Navigation itself is decided at click time (Reader.svelte).
 */
import type { MarkdownIt } from "markdown-it";
import { isExternalHref } from "../resolve";
import { contextOf } from "./context";

export function linkPlugin(md: MarkdownIt): void {
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = String(token.attrGet("href") ?? "");
    if (href !== "" && !href.startsWith("#") && !isExternalHref(href)) {
      token.attrJoin("class", "internal-link");
      const ctx = contextOf(env);
      if (ctx?.resolveHref && ctx.resolveHref(href) === null) token.attrJoin("class", "is-unresolved");
    }
    return self.renderToken(tokens, idx, options);
  };
}
