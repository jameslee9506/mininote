/**
 * Fence labels (LIVE-08 in reading view): a fenced code block's `<code>` carries
 * `data-lang`, the first word of its info string, which markdown.css draws as the
 * faint label the editor puts on the fence line. Shortened the way `fenceLabel`
 * in editor/livePreview/model.ts does it; keep them in sync.
 */
import type { MarkdownIt, StateCore } from "markdown-it";

function fenceLabels(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== "fence") continue;
    const word = token.info.trim().split(/\s+/)[0] ?? "";
    if (word) token.attrSet("data-lang", word.slice(0, 24));
  }
}

export function fencePlugin(md: MarkdownIt): void {
  md.core.ruler.push("fence_labels", fenceLabels);
}
