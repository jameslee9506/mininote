/**
 * Frontmatter detection (LIVE-10): line 1 is exactly `---` (trailing blanks
 * allowed) and the block ends at the next `---` or `...` line. Without a
 * closing fence there is no frontmatter. Lezer would read the block as an hr
 * plus a setext heading, so every live-preview builder skips this range.
 */
import type { Text } from "@codemirror/state";

export interface FrontmatterRange {
  /** Always 0. */
  from: number;
  /** End of the closing fence line. */
  to: number;
}

const OPEN = /^---[ \t]*$/;
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

/** The frontmatter block at the start of `doc`, or null. */
export function frontmatterRange(doc: Text): FrontmatterRange | null {
  if (doc.lines < 2) return null;
  const first = doc.line(1);
  if (!OPEN.test(first.text)) return null;
  let pos = first.to + 1;
  for (const text of doc.iterLines(2)) {
    if (CLOSE.test(text)) return { from: 0, to: pos + text.length };
    pos += text.length + 1;
  }
  return null;
}
