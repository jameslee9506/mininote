/**
 * [[wikilinks]] and ![[embeds]] (LINK-02). The scanner mirrors the Lezer `WikiLink`
 * parser in editor/syntax.ts so both views agree: one line, no nested "[[", a "]"
 * only as part of "]]", the first "|" starts the alias, and an empty target needs
 * a "#". Table cells reach us with "\|" already unescaped by markdown-it; elsewhere
 * a backslash right before the alias bar is dropped as well.
 *
 * - `[[target#subpath|alias]]` → a `wikilink` token, rendered as
 *   `<a class="internal-link" data-wiki data-subpath>` (+ `is-unresolved`).
 * - `![[image.png|300]]` → an `image` token (`meta.wiki`) for the image renderer.
 * - Any other embed (note transclusion is P2) renders as a plain wikilink.
 */
import type { MarkdownIt, StateInline } from "markdown-it";
import { IMAGE_EXTS } from "../../utils/names";
import { extname } from "../../utils/path";
import { parseWikiInner } from "../resolve";
import { contextOf } from "./context";

const BANG = 0x21;
const BRACKET_OPEN = 0x5b;
const BRACKET_CLOSE = 0x5d;
const PIPE = 0x7c;
const BACKSLASH = 0x5c;
const NEWLINE = 0x0a;

function isImageTarget(target: string): boolean {
  return (IMAGE_EXTS as readonly string[]).includes(extname(target));
}

function wikilink(state: StateInline, silent: boolean): boolean {
  // Never inside link text: that would nest anchors.
  if (state.linkLevel > 0) return false;
  const src = state.src;
  const max = state.posMax;
  const start = state.pos;
  const at = (i: number): number => (i < max ? src.charCodeAt(i) : -1);

  let open: number;
  if (at(start) === BANG && at(start + 1) === BRACKET_OPEN && at(start + 2) === BRACKET_OPEN) open = start + 3;
  else if (at(start) === BRACKET_OPEN && at(start + 1) === BRACKET_OPEN) open = start + 2;
  else return false;

  let close = -1;
  let bar = -1;
  for (let i = open; i < max; i++) {
    const c = src.charCodeAt(i);
    if (c === NEWLINE) return false;
    if (c === BRACKET_OPEN && at(i + 1) === BRACKET_OPEN) return false;
    if (c === BRACKET_CLOSE) {
      if (at(i + 1) !== BRACKET_CLOSE) return false;
      close = i;
      break;
    }
    if (c === PIPE && bar < 0) bar = i;
  }
  if (close < 0) return false;
  const targetEnd = bar < 0 ? close : bar;
  if (src.slice(open, targetEnd).trim() === "" && src.slice(open, close).indexOf("#") < 0) return false;

  // In silent mode (link-label scanning) the whole construct is skipped as one
  // unit, so "[text [[x]]](url)" never becomes an anchor nested in an anchor.
  if (!silent) {
    const escapedBar = bar > open && src.charCodeAt(bar - 1) === BACKSLASH;
    const typedTarget = src.slice(open, escapedBar ? bar - 1 : targetEnd);
    const parts = parseWikiInner(bar < 0 ? typedTarget : `${typedTarget}|${src.slice(bar + 1, close)}`);
    const embed = open - start === 3;
    if (embed && isImageTarget(parts.target)) {
      const token = state.push("image", "img", 0);
      token.attrs = [
        ["src", parts.target],
        ["alt", ""],
      ];
      const alt = new state.Token("text", "", 0);
      alt.content = parts.alias ?? "";
      token.children = [alt];
      token.content = alt.content;
      token.markup = "![[";
      token.meta = { wiki: true };
    } else {
      const token = state.push("wikilink", "a", 0);
      // LIVE-14: the alias, or else the target as typed (so "[[Note#Part]]" reads "Note#Part").
      token.content = parts.alias ?? typedTarget.trim();
      token.markup = embed ? "![[" : "[[";
      token.meta = { target: parts.target, subpath: parts.subpath };
    }
  }
  state.pos = close + 2;
  return true;
}

export function wikilinkPlugin(md: MarkdownIt): void {
  // Before the standard link rule, as in syntax.ts, so "[[x]]" is never "[" + link "[x]" + "]".
  md.inline.ruler.before("link", "wikilink", wikilink);

  md.renderer.rules.wikilink = (tokens, idx, _options, env) => {
    const token = tokens[idx];
    const meta = token.meta ?? {};
    const target = typeof meta.target === "string" ? meta.target : "";
    const subpath = typeof meta.subpath === "string" ? meta.subpath : null;
    const ctx = contextOf(env);
    // An empty target ("[[#Heading]]") is the note itself, which always exists.
    const unresolved = target !== "" && ctx !== null && ctx.resolveWiki(target) === null;
    const esc = md.utils.escapeHtml;
    let attrs = ` class="internal-link${unresolved ? " is-unresolved" : ""}" data-wiki="${esc(target)}"`;
    if (subpath !== null) attrs += ` data-subpath="${esc(subpath)}"`;
    // No href: nothing to navigate to. role + tabindex keep it a keyboard-reachable link.
    return `<a${attrs} role="link" tabindex="0">${esc(token.content)}</a>`;
  };
}
