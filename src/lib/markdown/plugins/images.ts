/**
 * Images (READ-05), for `![alt](src)` and `![[image.png]]` embeds alike:
 * - `src` goes through `ctx.resolveImage` (the listed vault file, as an asset URL).
 *   `http(s):` and `data:image/` sources are kept as written; so is any Markdown
 *   source that does not resolve, leaving the decision to DOMPurify and the CSP.
 *   An embed that does not resolve renders as the broken-image box directly.
 * - Obsidian sizes: `|300` or `|300x200` at the end of the alt text or embed alias,
 *   and an alt text that is only `300` / `300x200`.
 * - An image alone in its paragraph gets `class="standalone"` (displayed as a block).
 */
import type { MarkdownIt, StateCore, Token } from "markdown-it";
import type { RenderContext } from "../render";
import { contextOf } from "./context";

/**
 * A 1×1 transparent GIF. Broken images show it, sized and tinted by CSS, so the
 * box is muted and text-free on every engine (no alt text, no broken-image glyph).
 */
export const BROKEN_IMAGE_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const KEEP_SRC = /^(?:https?:|data:image\/)/i;
const SIZE_ONLY = /^(\d+)(?:x(\d+))?$/;
const SIZE_SUFFIX = /^([\s\S]*)\|(\d+)(?:x(\d+))?$/;

/** Splits an Obsidian size off an alt text: "cat|300" → { alt: "cat", width: "300", height: null }. */
export function splitImageSize(text: string): { alt: string; width: string | null; height: string | null } {
  const only = SIZE_ONLY.exec(text.trim());
  if (only) return { alt: "", width: only[1], height: only[2] ?? null };
  const suffix = SIZE_SUFFIX.exec(text);
  if (suffix) return { alt: suffix[1].trim(), width: suffix[2], height: suffix[3] ?? null };
  return { alt: text, width: null, height: null };
}

function imageSrc(src: string, wiki: boolean, ctx: RenderContext | null): string {
  if (!wiki && KEEP_SRC.test(src)) return src;
  const resolved = ctx ? ctx.resolveImage(src, wiki ? "wiki" : "href") : null;
  if (resolved !== null) return resolved;
  return wiki ? BROKEN_IMAGE_SRC : src;
}

function markStandalone(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 1; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || !inline.children) continue;
    let image: Token | null = null;
    let alone = true;
    for (const child of inline.children) {
      if (child.type === "image" && image === null) image = child;
      else if (!(child.type === "text" && child.content.trim() === "")) {
        alone = false;
        break;
      }
    }
    if (alone && image) image.meta = { ...image.meta, standalone: true };
  }
}

export function imagePlugin(md: MarkdownIt): void {
  md.core.ruler.push("standalone_images", markStandalone);

  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const wiki = token.meta?.wiki === true;
    const rawSrc = String(token.attrGet("src") ?? "");
    const src = imageSrc(rawSrc, wiki, contextOf(env));
    const size = splitImageSize(self.renderInlineAsText(token.children ?? [], options, env));
    const alt = size.alt === "" && wiki ? rawSrc : size.alt;
    const esc = md.utils.escapeHtml;

    let attrs = ` src="${esc(src)}" alt="${esc(alt)}"`;
    const title = token.attrGet("title");
    if (title) attrs += ` title="${esc(String(title))}"`;
    if (size.width !== null) attrs += ` width="${size.width}"`;
    if (size.height !== null) attrs += ` height="${size.height}"`;
    const classes: string[] = [];
    if (token.meta?.standalone === true) classes.push("standalone");
    if (src === BROKEN_IMAGE_SRC) classes.push("is-broken");
    if (classes.length > 0) attrs += ` class="${classes.join(" ")}"`;
    return `<img${attrs}>`;
  };
}
