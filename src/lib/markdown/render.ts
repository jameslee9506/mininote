/**
 * Reading view: markdown-it + own plugins + DOMPurify (ARCHITECTURE §11).
 *
 * One markdown-it instance is configured once (`html`, `linkify`, `breaks`, no
 * typographer). Per-render data (the note, link and image resolution) travels
 * in markdown-it's `env` (plugins/context.ts), so parsing never depends on it.
 */
import MarkdownIt, { type StateCore, type Token } from "markdown-it";
import DOMPurify, { type Config, type DOMPurify as Purifier } from "dompurify";
import type { VaultPath } from "../types";
import { envFor } from "./plugins/context";
import { fencePlugin } from "./plugins/fences";
import { frontmatterPlugin } from "./plugins/frontmatter";
import { BROKEN_IMAGE_SRC, imagePlugin } from "./plugins/images";
import { sourceLinePlugin } from "./plugins/lines";
import { linkPlugin } from "./plugins/links";
import { listPlugin } from "./plugins/lists";
import { markPlugin } from "./plugins/mark";
import { tablePlugin } from "./plugins/tables";
import { taskPlugin } from "./plugins/tasks";
import { wikilinkPlugin } from "./plugins/wikilinks";

export { BROKEN_IMAGE_SRC };

export interface RenderContext {
  /** Note being rendered (relative links resolve against its folder). */
  from: VaultPath | null;
  /** VaultPath for a wikilink target, or null when unresolved. */
  resolveWiki(target: string): VaultPath | null;
  /** Loadable URL for an image reference, or null. */
  resolveImage(src: string, kind: "wiki" | "href"): string | null;
  /**
   * VaultPath for a relative Markdown link target (as written, percent-encoded),
   * or null when it points at nothing. Optional: without it, Markdown links are
   * never marked unresolved.
   */
  resolveHref?(href: string): VaultPath | null;
}

/**
 * GFM "www." autolinks, read the way the editor's Lezer `Autolink` reads them, so
 * both views link the same text. After a lowercase "www." come word labels with
 * at least one more dot, then an optional port and path. Trailing punctuation, an
 * unbalanced ")" and a trailing entity are left out. The href gets https://, as
 * live preview's `autolinkHref` does. Bare domains stay text: ".md" is a TLD, so
 * fuzzy linking would turn "README.md" into a link.
 */
const WWW_HOST = /[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:\/[^\s<]*)?/y;
const LAST_TWO_LABELS = /[\w-]+\.[\w-]+(?:$|[/:])/;
const TRAILING_ENTITY = /&(?:#\d+|#x[a-f\d]+|\w+);$/;

/** linkify-it validator: the length of a "www." link's tail at `pos` (just past "www."), or 0. */
function wwwTail(text: string, pos: number): number {
  // linkify-it matches the prefix case-insensitively; GFM and the editor take only "www.".
  if (text.slice(pos - 4, pos) !== "www.") return 0;
  WWW_HOST.lastIndex = pos;
  const m = WWW_HOST.exec(text);
  if (!m || LAST_TWO_LABELS.exec(m[0])?.[0].includes("_")) return 0;
  let end = pos + m[0].length;
  const count = (ch: string): number => text.slice(pos, end).split(ch).length - 1;
  while (end > pos) {
    const last = text[end - 1];
    let entity: RegExpExecArray | null;
    if (/[?!.,:*_~]/.test(last) || (last === ")" && count(")") > count("("))) end--;
    else if (last === ";" && (entity = TRAILING_ENTITY.exec(text.slice(pos, end))) !== null) end = pos + entity.index;
    else break;
  }
  return end - pos;
}

/** Tokens that end in a character linkify-it does not take as a link boundary ("~", "=", "`"). */
const AFTER_MARK = new Set(["s_open", "s_close", "mark_open", "mark_close", "code_inline"]);

/** `token` split into text and autolinks the way markdown-it's linkify rule does it, or null without a valid link. */
function linkifyText(state: StateCore, token: Token): Token[] | null {
  const { md } = state;
  const text = token.content;
  const matches = md.linkify.match(text);
  if (!matches) return null;
  const nodes: Token[] = [];
  let level = token.level;
  let last = 0;
  const textToken = (content: string): Token => {
    const node = new state.Token("text", "", 0);
    node.content = content;
    node.level = level;
    return node;
  };
  for (const m of matches) {
    const href = md.normalizeLink(m.url);
    if (!md.validateLink(href)) continue;
    let label: string;
    if (!m.schema) label = md.normalizeLinkText(`http://${m.text}`).replace(/^http:\/\//, "");
    else if (m.schema === "mailto:" && !/^mailto:/i.test(m.text))
      label = md.normalizeLinkText(`mailto:${m.text}`).replace(/^mailto:/, "");
    else label = md.normalizeLinkText(m.text);
    if (m.index > last) nodes.push(textToken(text.slice(last, m.index)));
    const open = new state.Token("link_open", "a", 1);
    open.attrs = [["href", href]];
    open.level = level++;
    open.markup = "linkify";
    open.info = "auto";
    nodes.push(open, textToken(label));
    const close = new state.Token("link_close", "a", -1);
    close.level = --level;
    close.markup = "linkify";
    close.info = "auto";
    nodes.push(close);
    last = m.lastIndex;
  }
  if (nodes.length === 0) return null;
  if (last < text.length) nodes.push(textToken(text.slice(last)));
  return nodes;
}

/**
 * markdown-it's linkify rule skips a block unless linkify-it finds a link in its
 * whole text, and linkify-it takes a link only after whitespace or punctuation.
 * "~", "=" and "`" are neither, so "~~www.example.com~~", "==www.example.com=="
 * and a link right after inline code stayed text, while the editor's Lezer
 * Autolink links what no word character precedes. Text right after such a token
 * starts at a boundary of its own, so it is linkified here, outside links. A block
 * markdown-it already linkified has no such text left with a valid link in it.
 */
function linkifyAfterMarks(state: StateCore): void {
  for (const block of state.tokens) {
    const tokens = block.children;
    if (block.type !== "inline" || !tokens) continue;
    let out: Token[] | null = null;
    let inLink = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token.type === "link_open" || (token.type === "html_inline" && /^<a[>\s]/i.test(token.content))) inLink++;
      else if (token.type === "link_close" || (token.type === "html_inline" && /^<\/a\s*>/i.test(token.content)))
        inLink = Math.max(0, inLink - 1);
      const linked =
        token.type === "text" && i > 0 && inLink === 0 && AFTER_MARK.has(tokens[i - 1].type)
          ? linkifyText(state, token)
          : null;
      if (linked) {
        out ??= tokens.slice(0, i);
        out.push(...linked);
      } else out?.push(token);
    }
    if (out) block.children = out;
  }
}

const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: false });
// Autolink only what can be opened (LINK-01): "ftp://…" and protocol-relative "//host" stay text.
md.linkify
  .add("ftp:", null)
  .add("//", null)
  .add("www.", {
    validate: wwwTail,
    normalize: (match) => {
      match.url = `https://${match.url}`;
    },
  });
md.core.ruler.after("linkify", "linkify_after_marks", linkifyAfterMarks);
md.use(frontmatterPlugin)
  .use(wikilinkPlugin)
  .use(markPlugin)
  .use(taskPlugin)
  .use(listPlugin)
  .use(tablePlugin)
  .use(imagePlugin)
  .use(linkPlugin)
  .use(fencePlugin)
  // Last, so the classes other rules add come first in each tag.
  .use(sourceLinePlugin);

/**
 * URL attributes may hold only http(s) (which covers Windows' http://asset.localhost),
 * mailto, tel, the asset protocol, data:image/, or a URL without a scheme (relative
 * paths, #anchors). Same shape as DOMPurify's default pattern: the last two
 * branches accept anything that does not start with "scheme:".
 */
const SAFE_URI = /^(?:(?:https?|mailto|tel|asset):|data:image\/|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

const PURIFY_CONFIG: Config = {
  USE_PROFILES: { html: true },
  // `dialog` and popovers open top-layer overlays that could cover the app's UI (READ-04).
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "base", "link", "meta", "dialog"],
  // `srcset` is a URL list that DOMPurify checks only up to its first URL.
  FORBID_ATTR: ["style", "popover", "popovertarget", "popovertargetaction", "command", "commandfor", "autofocus", "srcset"],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ["data-wiki", "data-subpath", "data-line", "data-lang"],
  // Their values are link targets, headings and language names, not URLs ("Meeting: notes" must survive).
  ADD_URI_SAFE_ATTR: ["data-wiki", "data-subpath", "data-line", "data-lang"],
  ALLOWED_URI_REGEXP: SAFE_URI,
  // Raw-HTML ids and names become "user-content-…", so a note can never clobber app ids or globals.
  SANITIZE_NAMED_PROPS: true,
};

let purifier: Purifier | null = null;

/** A private DOMPurify instance (hooks and config never leak to other users), created on first use. */
function getPurifier(): Purifier | null {
  if (purifier === null) {
    const instance = DOMPurify();
    if (!instance.isSupported) return null;
    instance.setConfig(PURIFY_CONFIG);
    instance.addHook("afterSanitizeAttributes", (node) => {
      // An <img> whose src was missing or removed (e.g. "file:") shows the muted broken box.
      if (node.nodeName === "IMG" && !node.getAttribute("src")) {
        node.setAttribute("src", BROKEN_IMAGE_SRC);
        node.classList.add("is-broken");
      }
      // Components' scoped classes ("svelte-…") are the same in every copy of a release, and
      // some draw fixed overlays. The renderer never emits them; raw HTML may not borrow them
      // (READ-04). markdown.css also contains positioned elements inside the article.
      for (const name of Array.from(node.classList)) {
        if (/^svelte-/i.test(name)) node.classList.remove(name);
      }
    });
    purifier = instance;
  }
  return purifier;
}

/** Renders markdown to unsanitized HTML. For tests; anything shown must go through `renderMarkdown`. */
export function renderUnsafe(text: string, ctx: RenderContext): string {
  return md.render(text, envFor(ctx));
}

/** Renders markdown to sanitized HTML for a `.markdown` container. Never throws. */
export function renderMarkdown(text: string, ctx: RenderContext): string {
  try {
    const p = getPurifier();
    if (p !== null) return p.sanitize(renderUnsafe(text, ctx));
  } catch (err) {
    console.error("mininote: rendering failed", err);
  }
  // No working sanitizer, or an unexpected failure: show the source as plain text.
  return `<pre>${md.utils.escapeHtml(text)}</pre>`;
}

/**
 * Comparison key for heading anchors (LINK-01): NFC, lower-case, every run of
 * punctuation, symbols and blanks folded to one "-". It is the loose rule of the
 * editor's heading lookup (state/headings.ts), so both views find the same
 * heading: "#meeting-notes" and "[[#Meeting Notes!]]" match the same title,
 * and NFC and NFD spellings of a Hangul heading produce the same key.
 */
export function anchorKey(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .replace(/\s+/g, "-");
}
