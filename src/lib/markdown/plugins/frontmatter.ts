/**
 * YAML frontmatter, with the editor's rules (LIVE-10): line 1 is exactly `---`
 * (trailing blanks allowed) and the block ends at the next `---` or `...` line.
 * Without a closing fence it is not frontmatter. Its lines are never parsed as
 * Markdown; the block renders as a muted `<pre class="frontmatter">`, fences
 * included, so both views show the same lines.
 *
 * It is a block rule on the full text (not a pre-split), so every later token
 * keeps its true source line in `token.map`.
 */
import type { MarkdownIt, StateBlock } from "markdown-it";

const OPEN = /^---[ \t]*$/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

function lineText(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line], state.eMarks[line]);
}

function frontmatter(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (startLine !== 0 || state.parentType !== "root" || state.level !== 0) return false;
  if (!OPEN.test(lineText(state, 0))) return false;
  for (let line = 1; line < endLine; line++) {
    if (!CLOSE.test(lineText(state, line))) continue;
    if (silent) return true;
    const token = state.push("frontmatter", "pre", 0);
    token.content = state.src.slice(state.bMarks[0], state.eMarks[line]);
    token.markup = "---";
    token.map = [0, line + 1];
    state.line = line + 1;
    return true;
  }
  return false;
}

export function frontmatterPlugin(md: MarkdownIt): void {
  // First block rule, so `---` is never read as a thematic break.
  md.block.ruler.before("table", "frontmatter", frontmatter);
  md.renderer.rules.frontmatter = (tokens, idx) =>
    `<pre class="frontmatter"><code>${md.utils.escapeHtml(tokens[idx].content)}</code></pre>\n`;
}
