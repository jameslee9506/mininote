/**
 * GFM tables (READ-06): each `<table>` is wrapped in `<div class="table-wrap">`
 * for horizontal scrolling (the wrapper takes part in block flow), and the
 * column alignment markdown-it emits as `style="text-align:x"` becomes the class
 * `align-x`, because the sanitizer removes every `style` attribute.
 */
import type { MarkdownIt, StateCore } from "markdown-it";

const ALIGN = /^text-align:(left|center|right)$/;

function alignmentClasses(state: StateCore): void {
  for (const token of state.tokens) {
    if ((token.type !== "th_open" && token.type !== "td_open") || !token.attrs) continue;
    const i = token.attrIndex("style");
    if (i < 0) continue;
    const m = ALIGN.exec(String(token.attrs[i][1]));
    token.attrs.splice(i, 1);
    if (m) token.attrJoin("class", `align-${m[1]}`);
  }
}

export function tablePlugin(md: MarkdownIt): void {
  md.core.ruler.push("table_align", alignmentClasses);
  md.renderer.rules.table_open = (tokens, idx, options, _env, self) =>
    `<div class="table-wrap">\n${self.renderToken(tokens, idx, options)}`;
  md.renderer.rules.table_close = (tokens, idx, options, _env, self) =>
    `${self.renderToken(tokens, idx, options)}</div>\n`;
}
