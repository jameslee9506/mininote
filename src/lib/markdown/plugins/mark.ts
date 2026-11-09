/**
 * `==highlight==` → `<mark>`. Mirrors the Lezer `Highlight` parser in
 * editor/syntax.ts: a delimiter is exactly two "=" (a longer run is not one at
 * its first character) with the flanking rules of GFM strikethrough, which is
 * what `scanDelims(pos, true)` computes. Pairing is done by markdown-it's
 * balance_pairs, like strikethrough.
 */
import type { Delimiter, MarkdownIt, StateInline } from "markdown-it";

const EQUALS = 0x3d;

function tokenize(state: StateInline, silent: boolean): boolean {
  if (silent) return false;
  const start = state.pos;
  if (state.src.charCodeAt(start) !== EQUALS) return false;
  const scanned = state.scanDelims(start, true);
  if (scanned.length !== 2) return false;
  const token = state.push("text", "", 0);
  token.content = "==";
  state.delimiters.push({
    marker: EQUALS,
    // 0 disables the emphasis "rule of 3" in balance_pairs.
    length: 0,
    token: state.tokens.length - 1,
    end: -1,
    open: scanned.can_open,
    close: scanned.can_close,
  });
  state.pos += 2;
  return true;
}

function applyPairs(state: StateInline, delimiters: Delimiter[]): void {
  for (const opener of delimiters) {
    if (opener.marker !== EQUALS || opener.end === -1) continue;
    const closer = delimiters[opener.end];
    const open = state.tokens[opener.token];
    open.type = "mark_open";
    open.tag = "mark";
    open.nesting = 1;
    open.markup = "==";
    open.content = "";
    const close = state.tokens[closer.token];
    close.type = "mark_close";
    close.tag = "mark";
    close.nesting = -1;
    close.markup = "==";
    close.content = "";
  }
}

function postProcess(state: StateInline): void {
  applyPairs(state, state.delimiters);
  for (const meta of state.tokens_meta) {
    if (meta?.delimiters) applyPairs(state, meta.delimiters);
  }
}

export function markPlugin(md: MarkdownIt): void {
  md.inline.ruler.before("emphasis", "mark", tokenize);
  md.inline.ruler2.before("emphasis", "mark", postProcess);
}
