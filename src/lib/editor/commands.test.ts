import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState, type StateCommand } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { indentUnit } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import { markdownExtensions } from "./syntax";
import {
  continueMarkup,
  cycleTaskText,
  cycleTasks,
  headingEdit,
  indentListOrInsertTab,
  insertLink,
  insertSoftBreak,
  isTaskText,
  linkAt,
  listLinePrefix,
  outdentListOrLines,
  outdentWhitespace,
  setHeading,
  toggleBold,
  toggleItalic,
} from "./commands";

const md = markdown({ base: commonmarkLanguage, extensions: [GFM, ...markdownExtensions] });

/** "a |b| c": the first "|" is the anchor, a second one the head (one "|" is a caret). */
function stateOf(marked: string): EditorState {
  const anchor = marked.indexOf("|");
  const head = marked.indexOf("|", anchor + 1);
  const doc = marked.replace(/\|/g, "");
  const selection = head < 0 ? EditorSelection.single(anchor) : EditorSelection.single(anchor, head - 1);
  return EditorState.create({ doc, selection, extensions: [md, indentUnit.of("\t"), EditorState.tabSize.of(4)] });
}

/** Runs a command and returns the result in the same "|" notation (null when the command declined). */
function run(cmd: StateCommand, marked: string): string | null {
  let state = stateOf(marked);
  const handled = cmd({ state, dispatch: (tr) => (state = tr.state) });
  if (!handled) return null;
  const { anchor, head } = state.selection.main;
  const doc = state.doc.toString();
  if (anchor === head) return doc.slice(0, head) + "|" + doc.slice(head);
  const [a, b] = anchor < head ? [anchor, head] : [head, anchor];
  return doc.slice(0, a) + "|" + doc.slice(a, b) + "|" + doc.slice(b);
}

describe("line transforms", () => {
  it("cycles task markup", () => {
    expect(cycleTaskText("foo")).toEqual({ from: 0, to: 0, insert: "- [ ] " });
    expect(cycleTaskText("  foo")).toEqual({ from: 2, to: 2, insert: "- [ ] " });
    expect(cycleTaskText("- foo")).toEqual({ from: 2, to: 2, insert: "[ ] " });
    expect(cycleTaskText("-")).toEqual({ from: 1, to: 1, insert: " [ ] " });
    expect(cycleTaskText("- [ ] foo")).toEqual({ from: 3, to: 4, insert: "x" });
    expect(cycleTaskText("- [X] foo")).toEqual({ from: 3, to: 4, insert: " " });
    expect(cycleTaskText("> 1. [ ] y")).toEqual({ from: 6, to: 7, insert: "x" });
    expect(isTaskText("\t* [x] z")).toBe(true);
    expect(isTaskText("- [ ]")).toBe(true);
    expect(isTaskText("- foo")).toBe(false);
    expect(isTaskText("[ ] foo")).toBe(false);
  });

  it("sets and clears heading levels", () => {
    expect(headingEdit("Title", 2)).toEqual({ from: 0, to: 0, insert: "## " });
    expect(headingEdit("# Title", 2)).toEqual({ from: 0, to: 2, insert: "## " });
    expect(headingEdit("##   Title", 2)).toBeNull();
    expect(headingEdit("### Title", 0)).toEqual({ from: 0, to: 4, insert: "" });
    expect(headingEdit("Title", 0)).toBeNull();
    expect(headingEdit("- item", 1)).toEqual({ from: 2, to: 2, insert: "# " });
    expect(headingEdit("> quote", 3)).toEqual({ from: 2, to: 2, insert: "### " });
    expect(headingEdit("#tag", 1)).toEqual({ from: 0, to: 0, insert: "# " });
    // No heading task in GFM: the box is never pushed behind a "#", only a typed one goes.
    expect(headingEdit("- [ ] task", 2)).toBeNull();
    expect(headingEdit("- [x] ## task", 0)).toEqual({ from: 6, to: 9, insert: "" });
  });

  it("splits list and quote prefixes", () => {
    expect(listLinePrefix("- foo")).toEqual({ continuation: "  ", beforeMarker: "", contentStart: 2 });
    expect(listLinePrefix("10. foo")).toEqual({ continuation: "    ", beforeMarker: "", contentStart: 4 });
    expect(listLinePrefix("- [ ] task")).toEqual({ continuation: "      ", beforeMarker: "", contentStart: 6 });
    expect(listLinePrefix("> - foo")).toEqual({ continuation: ">   ", beforeMarker: "> ", contentStart: 4 });
    expect(listLinePrefix("\t- foo")).toEqual({ continuation: "\t  ", beforeMarker: "\t", contentStart: 3 });
    expect(listLinePrefix("  more")).toEqual({ continuation: "  ", beforeMarker: null, contentStart: 2 });
    expect(listLinePrefix("-")).toEqual({ continuation: "  ", beforeMarker: "", contentStart: 1 });
    expect(listLinePrefix("- - nested")).toEqual({ continuation: "    ", beforeMarker: "  ", contentStart: 4 });
    expect(listLinePrefix("---")).toEqual({ continuation: "", beforeMarker: null, contentStart: 0 });
  });

  it("removes indentation by columns", () => {
    expect(outdentWhitespace("\t\t- c", 0, 4)).toEqual({ from: 1, to: 2, insert: "" });
    expect(outdentWhitespace("    - c", 0, 2)).toEqual({ from: 2, to: 4, insert: "" });
    expect(outdentWhitespace("\t  - c", 0, 4)).toEqual({ from: 0, to: 3, insert: "  " });
    expect(outdentWhitespace("> \t- c", 2, 2)).toEqual({ from: 2, to: 3, insert: "" });
    expect(outdentWhitespace("- c", 0, 2)).toBeNull();
  });
});

describe("inline toggles", () => {
  it("wraps and unwraps, keeping the inner text selected", () => {
    expect(run(toggleBold, "a |bold| c")).toBe("a **|bold|** c");
    expect(run(toggleBold, "a **|bold|** c")).toBe("a |bold| c");
    expect(run(toggleBold, "a |**bold**| c")).toBe("a |bold| c");
    expect(run(toggleBold, "|word |next")).toBe("**|word|** next");
    expect(run(toggleBold, "a |**bold** |c")).toBe("a |bold |c");
  });

  it("toggles one layer of bold italic at a time", () => {
    expect(run(toggleItalic, "***|x|***")).toBe("**|x|**");
    expect(run(toggleBold, "|***x***|")).toBe("|*x*|");
    expect(run(toggleItalic, "**|bold|**")).toBe("***|bold|***");
  });

  it("inserts, removes and steps over pairs at a caret", () => {
    expect(run(toggleBold, "a |")).toBe("a **|**");
    expect(run(toggleBold, "a **|**")).toBe("a |");
    expect(run(toggleBold, "**bold|**")).toBe("**bold**|");
  });

  it("inserts links", () => {
    expect(run(insertLink, "|text|")).toBe("[text](|)");
    expect(run(insertLink, "x |")).toBe("x [|]()");
    expect(run(insertLink, "|https://x.com|")).toBe("[|](https://x.com)");
  });
});

describe("line commands", () => {
  it("sets headings and tasks with the caret after the new markup", () => {
    expect(run(setHeading(2), "|Title")).toBe("## |Title");
    expect(run(setHeading(0), "## Ti|tle")).toBe("Ti|tle");
    expect(run(cycleTasks, "|")).toBe("- [ ] |");
    expect(run(cycleTasks, "- [ ] do|")).toBe("- [x] do|");
  });
});

describe("list indentation", () => {
  it("indents an item with its subtree under a previous sibling", () => {
    expect(run(indentListOrInsertTab, "- a\n- b|\n  - c\n- d")).toBe("- a\n\t- b|\n\t  - c\n- d");
    expect(run(indentListOrInsertTab, "- a|\n- b")).toBe("- a|\n- b");
    expect(run(indentListOrInsertTab, "> - a\n> - b|")).toBe("> - a\n> \t- b|");
    expect(run(indentListOrInsertTab, "foo|")).toBe("foo\t|");
    // "100. " puts the text at column 5, one past a tab.
    expect(run(indentListOrInsertTab, "100. a\n101. b|\n     c")).toBe("100. a\n\t 101. b|\n\t      c");
  });

  it("outdents an item with its subtree to the parent's column", () => {
    expect(run(outdentListOrLines, "- a\n\t- b|\n\t\t- c")).toBe("- a\n- b|\n\t- c");
    expect(run(outdentListOrLines, "- a\n  - b|\n    - c")).toBe("- a\n- b|\n  - c");
    expect(run(outdentListOrLines, "- a|")).toBe("- a|");
    expect(run(outdentListOrLines, "\tfoo|")).toBe("foo|");
  });
});

describe("Enter in lists", () => {
  // continueMarkup only reads `state` and calls `dispatch` on these small, fully parsed docs.
  const enter: StateCommand = (target) => continueMarkup(target as unknown as EditorView);

  it("starts a new item after a soft-broken or lazy line", () => {
    expect(run(enter, "- a\n  b|")).toBe("- a\n  b\n- |");
    expect(run(enter, "- [x] a\n      b|")).toBe("- [x] a\n      b\n- [ ] |");
    expect(run(enter, "> 1. a\n>    b|\n> 2. c")).toBe("> 1. a\n>    b\n> 2. |\n> 3. c");
    expect(run(enter, "- a\nb|")).toBe("- a\nb\n- |");
  });

  it("keeps a tab after the marker or the task box", () => {
    expect(run(enter, "1.\ta|\n2.\tb")).toBe("1.\ta\n2.\t|\n3.\tb");
    expect(run(enter, "- [ ]\ta|")).toBe("- [ ]\ta\n- [ ]\t|");
    expect(run(enter, "-\ta\n-\t|")).toBe("-\ta\n|");
    expect(run(enter, "- a\n\t-\tb\n\t-\t|")).toBe("- a\n\t-\tb\n- |");
  });

  it("removes an empty item between two others, keeping the list tight", () => {
    expect(run(enter, "- a\n- |\n- c")).toBe("- a|\n- c");
    expect(run(enter, "1. a\n2. |\n3. c")).toBe("1. a|\n2. c");
    expect(run(enter, "- a\n- |")).toBe("- a\n|");
  });
});

describe("soft breaks", () => {
  it("continues list items and quotes without a marker", () => {
    expect(run(insertSoftBreak, "- foo|")).toBe("- foo\n  |");
    expect(run(insertSoftBreak, "- [ ] task|")).toBe("- [ ] task\n      |");
    expect(run(insertSoftBreak, "> q|")).toBe("> q\n> |");
    expect(run(insertSoftBreak, "plain|")).toBeNull();
  });
});

describe("linkAt", () => {
  const at = (doc: string, pos: number) => linkAt(EditorState.create({ doc, extensions: [md] }), pos);
  it("finds wikilinks, links and bare URLs", () => {
    expect(at("see [[Note#H|alias]] x", 8)).toEqual({ kind: "wiki", target: "Note", subpath: "H" });
    expect(at("| [[Note\\|alias]] |", 5)).toEqual({ kind: "wiki", target: "Note", subpath: null });
    expect(at("[[#Top]]", 0)).toEqual({ kind: "wiki", target: "", subpath: "Top" });
    expect(at("a [t](<a b.md>) b", 4)).toEqual({ kind: "href", href: "a b.md" });
    expect(at("go https://x.com/a now", 6)).toEqual({ kind: "href", href: "https://x.com/a" });
    expect(at("plain text", 3)).toBeNull();
  });

  it("opens a link's destination, never a URL in its label (LP-1), and bare URLs like a click", () => {
    expect(at("[www.example.com](https://example.com)", 3)).toEqual({ kind: "href", href: "https://example.com" });
    expect(at("![shot of www.x.com](a.png)", 12)).toEqual({ kind: "href", href: "a.png" });
    expect(at("go www.x.com now", 5)).toEqual({ kind: "href", href: "https://www.x.com" });
    expect(at("mail <a@b.com> now", 8)).toEqual({ kind: "href", href: "mailto:a@b.com" });
    expect(at("[see https://x.com][ref]", 8)).toEqual({ kind: "href", href: "https://x.com" });
    expect(at("[see https://x.com][ref]", 1)).toBeNull();
  });
});
