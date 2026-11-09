/**
 * `[[` completion (LINK-04): notes and images from the host, ranked as in NAV-02
 * with utils/fuzzy: the query splits on spaces and every token must match the
 * title or, weighted lower, the folder (a token with "/" matches the folder
 * path); exact titles come first. After "![[" images come first. There is no
 * recency boost: the host does not expose the recent list. The folder shows
 * muted on the right. Accepting inserts the shortest unique link text (images
 * keep their extension) and "]]", reusing a "]]" that already follows
 * (closeBrackets inserts one after "[["). Typing "|" or "#" ends the query, so
 * it never accepts a suggestion.
 */
import { acceptCompletion, autocompletion, completionKeymap, pickedCompletion } from "@codemirror/autocomplete";
import type { Completion, CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { fuzzyMatch, type FuzzyResult } from "../utils/fuzzy";
import { key } from "../utils/path";
import type { EditorHost, NoteCandidate } from "./host";

const MAX_OPTIONS = 50;
/** "[[" plus the query typed so far; "[", "]", "|", "#" and line breaks end it. */
const QUERY = /\[\[([^[\]|#\n]*)$/;
/** How far back on the line to look for "[[". */
const LOOKBEHIND = 300;
/** A folder match counts a little less than a title match (NAV-02, as in the quick switcher). */
const FOLDER_WEIGHT = 0.8;
/** No suggestions inside code, HTML or comments. */
const NO_COMPLETION = new Set(["InlineCode", "CodeText", "FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock", "Comment"]);
const FM_OPEN = /^---[ \t]*$/;
const FM_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

interface WikiOption extends Completion {
  /** [from, to, from, to, …] of matched characters in the label. */
  ranges: readonly number[];
}

function inCode(state: EditorState, pos: number): boolean {
  const tree = ensureSyntaxTree(state, pos, 20) ?? syntaxTree(state);
  for (let n: SyntaxNode | null = tree.resolveInner(pos, -1); n; n = n.parent) if (NO_COMPLETION.has(n.name)) return true;
  return false;
}

/** Frontmatter (LIVE-10): line 1 is "---" and a later "---" or "..." line closes it. */
function inFrontmatter(state: EditorState, lineNo: number): boolean {
  const { doc } = state;
  if (lineNo === 1 || !FM_OPEN.test(doc.line(1).text)) return false;
  for (let n = 2; n <= doc.lines; n++) if (FM_CLOSE.test(doc.line(n).text)) return lineNo < n;
  return false;
}

/** Positions (in any order, repeats allowed) merged into sorted [from, to) pairs, clamped to the label. */
function toRanges(positions: readonly number[], length: number): number[] {
  const out: number[] = [];
  for (const p of [...new Set(positions)].sort((a, b) => a - b)) {
    if (p < 0 || p >= length) continue;
    if (out.length > 0 && out[out.length - 1] === p) out[out.length - 1] = p + 1;
    else out.push(p, p + 1);
  }
  return out;
}

/**
 * Inserts `linkText`. Inside an existing link (a "]]" ahead on the line) only
 * the rest of its target is replaced, keeping "#heading" and "|alias"; the caret
 * always ends after the closing "]]".
 */
function applyLink(linkText: string) {
  const text = linkText.normalize("NFC");
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    const { state } = view;
    const rest = state.sliceDoc(to, state.doc.lineAt(to).to);
    const close = /^[^[\]\n]*?\]\]/.exec(rest);
    let end = to;
    let insert = text + "]]";
    let caret = from + insert.length;
    if (close) {
      // The target ends at "|", "#" or "]]"; a table's escaped pipe ("\|", LINK-02) ends it before the backslash.
      const stop = /\\\||[|#\]]/.exec(rest);
      const targetEnd = stop ? stop.index : 0;
      end = to + targetEnd;
      insert = text;
      caret = from + text.length + (close[0].length - targetEnd);
    }
    view.dispatch({
      changes: { from, to: end, insert },
      selection: { anchor: caret },
      annotations: pickedCompletion.of(completion),
      userEvent: "input.complete",
      scrollIntoView: true,
    });
  };
}

function option(candidate: NoteCandidate, title: string, positions: readonly number[]): WikiOption {
  return {
    label: title,
    detail: candidate.folder || undefined,
    ranges: toRanges(positions, title.length),
    apply: applyLink(candidate.linkText),
  };
}

interface Hit {
  c: NoteCandidate;
  /** NFC title (images: full file name). */
  title: string;
  /** NFC "folder/title". */
  path: string;
  score: number;
  /** The title (or, for a query containing "/", the path) equals the query. */
  exact: boolean;
  /** Matched characters of the title. */
  positions: number[];
}

/**
 * Every token must match (NAV-02): a token containing "/" against the folder
 * path, any other against the title or, weighted lower, the folder. Null when
 * a token matches nothing. Mirrors the quick switcher's matcher.
 */
function matchTokens(
  tokens: readonly string[],
  title: string,
  folder: string,
  path: string,
  folderCache: readonly Map<string, FuzzyResult | null>[],
): { score: number; positions: number[] } | null {
  let score = 0;
  const positions: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.includes("/")) {
      const r = fuzzyMatch(token, path);
      if (!r) return null;
      score += r.score;
      const titleStart = path.length - title.length;
      for (const p of r.positions) if (p >= titleStart) positions.push(p - titleStart);
      continue;
    }
    const inTitle = fuzzyMatch(token, title);
    let inFolder: FuzzyResult | null = null;
    if (folder !== "") {
      // Many candidates share a folder: match each folder once per token.
      const cached = folderCache[i].get(folder);
      inFolder = cached !== undefined ? cached : fuzzyMatch(token, folder);
      if (cached === undefined) folderCache[i].set(folder, inFolder);
    }
    if (inTitle && (!inFolder || inTitle.score >= inFolder.score * FOLDER_WEIGHT)) {
      score += inTitle.score;
      positions.push(...inTitle.positions);
    } else if (inFolder) {
      score += inFolder.score * FOLDER_WEIGHT;
    } else {
      return null;
    }
  }
  return { score, positions };
}

/**
 * NAV-02 order: after "![[" images first, then exact matches, the best score,
 * the shorter title, the shorter path, and collator order. An empty query keeps
 * the host's order.
 */
function rank(query: string, candidates: readonly NoteCandidate[], embed: boolean): WikiOption[] {
  const q = query.trim();
  if (q === "") {
    const list = embed
      ? candidates.filter((c) => c.kind === "image").concat(candidates.filter((c) => c.kind !== "image"))
      : candidates;
    return list.slice(0, MAX_OPTIONS).map((c) => option(c, c.title.normalize("NFC"), []));
  }
  const tokens = q.split(/\s+/);
  const folderCache = tokens.map(() => new Map<string, FuzzyResult | null>());
  const queryKey = key(q);
  const byPath = q.includes("/");
  const hits: Hit[] = [];
  for (const c of candidates) {
    const title = c.title.normalize("NFC");
    const folder = c.folder.normalize("NFC");
    const path = folder === "" ? title : `${folder}/${title}`;
    const m = matchTokens(tokens, title, folder, path, folderCache);
    if (m) hits.push({ c, title, path, score: m.score, exact: key(byPath ? path : title) === queryKey, positions: m.positions });
  }
  const imageRank = (h: Hit): number => (embed && h.c.kind === "image" ? 1 : 0);
  hits.sort(
    (a, b) =>
      imageRank(b) - imageRank(a) ||
      Number(b.exact) - Number(a.exact) ||
      b.score - a.score ||
      a.title.length - b.title.length ||
      a.path.length - b.path.length ||
      collator.compare(a.title, b.title),
  );
  return hits.slice(0, MAX_OPTIONS).map((h) => option(h.c, h.title, h.positions));
}

/** The `[[` completion source over `host.noteCandidates()`. */
export function wikiLinkSource(host: EditorHost): CompletionSource {
  return (ctx: CompletionContext): CompletionResult | null => {
    const { state, pos } = ctx;
    if (state.readOnly) return null;
    const line = state.doc.lineAt(pos);
    const match = QUERY.exec(state.sliceDoc(Math.max(line.from, pos - LOOKBEHIND), pos));
    if (!match) return null;
    if (inCode(state, pos) || inFrontmatter(state, line.number)) return null;
    // "![[": an embed, where images are what the user is after (LINK-04).
    const open = pos - match[0].length;
    const embed = open > line.from && state.sliceDoc(open - 1, open) === "!";
    return {
      from: pos - match[1].length,
      to: pos,
      options: rank(match[1], host.noteCandidates(), embed),
      // Pre-ranked; re-queried on every keystroke (validFor cannot be combined with filter: false).
      filter: false,
      getMatch: (completion) => (completion as WikiOption).ranges,
    };
  };
}

/** Autocompletion configured for wikilinks only; its keys come from `completionBindings`. */
export function wikiCompletion(host: EditorHost): Extension {
  return autocompletion({
    override: [wikiLinkSource(host)],
    defaultKeymap: false,
    icons: false,
    maxRenderedOptions: MAX_OPTIONS,
  });
}

/**
 * The completion keymap (precedence slot 2 of ARCHITECTURE §10.1) plus Tab to
 * accept (EDIT-04: an open completion takes Tab first). The macOS-only Option
 * chords are dropped because they type characters (PLAT-10). CodeMirror runs
 * no keymap while an IME composes, so the accept keys never act mid-syllable.
 */
export const completionBindings: readonly KeyBinding[] = [
  ...completionKeymap.filter((binding) => binding.key !== undefined),
  { key: "Tab", run: acceptCompletion },
];
