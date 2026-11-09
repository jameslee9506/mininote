/**
 * Task list items (READ-07): a list item whose first paragraph starts with
 * `[ ]`, `[x]` or `[X]` followed by a blank or the end of the line becomes
 * `li.task-list-item` (+ `is-checked`), and the marker becomes a clickable
 * `<span class="task-box" role="checkbox" data-line>`. A disabled `<input>`
 * would swallow clicks, and DOMPurify keeps a plain span.
 *
 * `data-line` is the 0-based source line of the item; the editor re-checks
 * that line before toggling, because raw HTML in a note can forge the attribute.
 * So a box is drawn only where that check passes, and a click always toggles:
 * - the paragraph starts on the marker line, as in live preview;
 * - the marker line reads `[quotes] <one list marker> [ ]`, the editor's rule
 *   (`isTaskText` in editor/commands.ts). This keeps out an escaped `\[x]` and an
 *   entity `&#91; ]`, which markdown-it has already turned into plain text, and a
 *   second marker on the same line (`- - [ ] x`).
 */
import type { MarkdownIt, StateCore } from "markdown-it";
import { t } from "../../i18n";

const MARKER = /^\[([ xX])\](?:[ \t]+|$)/;
/** A task item's marker line as the editor's toggle accepts it (mirrors `isTaskText`). */
const TASK_LINE = /^(?:[ \t]*>[ \t]?)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+\[[ xX]\](?:[ \t]|$)/;

function taskItems(state: StateCore): void {
  const tokens = state.tokens;
  let lines: string[] | null = null;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const item = tokens[i];
    if (item.type !== "list_item_open") continue;
    const paragraph = tokens[i + 1];
    const inline = tokens[i + 2];
    if (paragraph.type !== "paragraph_open" || inline.type !== "inline" || !inline.children) continue;
    const line = item.map?.[0];
    if (line === undefined || paragraph.map?.[0] !== line) continue;
    const first = inline.children[0];
    if (!first || first.type !== "text") continue;
    const m = MARKER.exec(first.content);
    if (!m) continue;
    // state.src is the normalized source (LF only), so its lines are the editor's lines.
    lines ??= state.src.split("\n");
    if (!TASK_LINE.test(lines[line] ?? "")) continue;
    const checked = m[1] !== " ";
    first.content = first.content.slice(m[0].length);
    const box = new state.Token("task_box", "span", 0);
    box.meta = { checked, line };
    inline.children.unshift(box);
    item.attrJoin("class", checked ? "task-list-item is-checked" : "task-list-item");
  }
}

export function taskPlugin(md: MarkdownIt): void {
  // After text_join, so the item's leading text is a single token.
  md.core.ruler.push("task_items", taskItems);

  md.renderer.rules.task_box = (tokens, idx) => {
    const meta = tokens[idx].meta ?? {};
    const checked = meta.checked === true;
    const line = typeof meta.line === "number" ? ` data-line="${meta.line}"` : "";
    const label = md.utils.escapeHtml(t("ariaCheckbox"));
    return `<span class="task-box" role="checkbox" tabindex="0" aria-checked="${checked}" aria-label="${label}"${line}></span>`;
  };
}
