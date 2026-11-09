import { describe, expect, it } from "vitest";
import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { GFM } from "@lezer/markdown";
import type { EditorHost } from "../host";
import { refreshEffect } from "../shared";
import { markdownExtensions } from "../syntax";
import { highlightRetags } from "../theme";
import { blockPreview } from "./blocks";
import { fmField, focusField, freezeField, rebuild, setFocus } from "./state";
import { TableWidget } from "./widgets";

const host = {
  resolveImage: (src: string) => `asset://localhost/${src}`,
  resolveWiki: (target: string) => (target.includes("Missing") ? null : `${target}.md`),
  noteCandidates: () => [{ path: "a.md", kind: "note", title: "a", folder: "", linkText: "a" }],
  currentPath: () => "a.md",
} as unknown as EditorHost;

const language: Extension = [
  markdown({ base: commonmarkLanguage, extensions: [GFM, ...markdownExtensions, highlightRetags], codeLanguages: [] }),
  focusField,
  freezeField,
  fmField,
];
const extensions: Extension = [language, blockPreview(host)];

/** Each block-widget field's widgets: range plus everything their eq() compares. */
function fields(state: EditorState): string[][] {
  const sets = state.facet(EditorView.decorations).filter((s): s is DecorationSet => typeof s !== "function");
  return sets.map((set) => {
    const rows: string[] = [];
    for (let it = set.iter(); it.value; it.next()) {
      const w = it.value.spec.widget;
      const shown =
        w instanceof TableWidget ? [w.source, w.unresolved, w.inset, w.pair] : [w.url, w.alt, w.inset, w.pair];
      rows.push(`${it.from}-${it.to} ${JSON.stringify(shown)}`);
    }
    return rows;
  });
}

/**
 * The field's widgets must be what a full scan of the same tree finds: a second field,
 * added to this state, scans it from scratch. (A fresh parse is no oracle: Lezer's
 * incremental tree can differ from it, e.g. a table read as paragraph text.)
 */
function expectFullScan(state: EditorState, message: string): void {
  expect(syntaxTree(state).length).toBe(state.doc.length);
  const [incremental, full] = fields(state.update({ effects: StateEffect.appendConfig.of(blockPreview(host)) }).state);
  expect(incremental, message).toEqual(full);
}

const DOC = [
  "---",
  "title: x",
  "---",
  "Intro ![](inline.png)",
  "",
  "![](a.png)",
  "",
  "1. Step one:",
  "",
  "   | a | [[Missing]] |",
  "   |---|---|",
  "   | 1 | [[Note]] |",
  "",
  "   ![](step.png)",
  "2. Step two",
  "",
  "> Quote",
  "> ![[pic.png]]",
  "",
  "| h | [[Missing two]] |",
  "|---|---|",
  "| x | y |",
  "",
  "```js",
  "![](code.png)",
  "```",
  "",
  "- item",
  "  > ![](iq.png)",
  "",
  "end",
].join("\n");

const SNIPPETS = ["\n", "\n\n", "```", "```\n", "> ", "- ", "1. ", "   ", "|", "| x |\n|---|\n", "![](n.png)", "[[Missing]]", "x", "<!--", "-->", "---\n"];

/** Applies `edits` (find `at`, "$" for the end; replace `remove` characters there with `insert`) and checks against a full scan. */
function replay(doc: string, edits: { at: string; remove?: number; insert?: string }[]): void {
  let state = EditorState.create({ doc, extensions });
  for (const { at, remove = 0, insert = "" } of edits) {
    const from = at === "$" ? state.doc.length : state.doc.toString().indexOf(at);
    expect(from, at).toBeGreaterThanOrEqual(0);
    state = state.update({ changes: { from, to: from + remove, insert } }).state;
    expectFullScan(state, state.doc.toString());
  }
}

describe("block widget regions", () => {
  it("draw nested tables and images at their container's inset, with their pair gap", () => {
    const doc = "- a\n\n  | x | [[Missing]] |\n  |---|---|\n  | 1 | 2 |\n\n> ![](q.png)\n\n- b\n  > ![](r.png)";
    expect(fields(EditorState.create({ doc, extensions }))[0]).toEqual([
      `5-50 ${JSON.stringify([
        "  | x | [[Missing]] |\n  |---|---|\n  | 1 | 2 |",
        "Missing",
        { quote: 0, quoteList: 0, depth: 1 },
        { blk: "table", prev: "p", blank: 1 },
      ])}`,
      // The quote's first block: no pair of its own.
      `52-64 ${JSON.stringify(["asset://localhost/q.png", "", { quote: 1, quoteList: 0, depth: 0 }, null])}`,
      `70-84 ${JSON.stringify(["asset://localhost/r.png", "", { quote: 1, quoteList: 1, depth: 1 }, null])}`,
    ]);
  });

  it("read a widget's pair from the current tree: the block above, the blank lines between, the frontmatter", () => {
    const doc = "---\nt: 1\n---\n\n![](a.png)\n# H\n\n\n| a |\n|---|\n\n![](b.png)\ntext\n![](c.png)";
    const [image, table, below, later] = fields(EditorState.create({ doc, extensions }))[0];
    expect(image).toContain(JSON.stringify({ blk: "p", prev: "fm", blank: 1 }));
    expect(table).toContain(JSON.stringify({ blk: "table", prev: "h1", blank: 2 }));
    expect(below).toContain(JSON.stringify({ blk: "p", prev: "table", blank: 1 }));
    // An image on a later line of its paragraph has no gap of its own.
    expect(later).toContain(",null]");
    // Turning the heading into a paragraph changes the table's pair without touching the table.
    let state = EditorState.create({ doc, extensions });
    state = state.update({ changes: { from: doc.indexOf("# H"), to: doc.indexOf("# H") + 2, insert: "" } }).state;
    expect(fields(state)[0][1]).toContain(JSON.stringify({ blk: "table", prev: "p", blank: 2 }));
    // A revealed image (a caret on its line, editor focused) carries none: the source line above it does.
    state = state.update({ effects: setFocus.of(true), selection: { anchor: state.doc.toString().indexOf("![](a.png)") } }).state;
    expect(fields(state)[0][0]).toContain(",null]");
  });

  it("re-resolve images once the host shows another note (a state is built before its note shows)", () => {
    let current = "old/a.md";
    const moving = { ...host, currentPath: () => current, resolveImage: (src: string) => `asset://localhost/${current}/${src}` };
    let state = EditorState.create({ doc: "![](i.png)\n\ntext", extensions: [language, blockPreview(moving as unknown as EditorHost)] });
    expect(fields(state)[0][0]).toContain("old/a.md/i.png");
    current = "new/b.md";
    state = state.update({ selection: { anchor: state.doc.length } }).state;
    expect(fields(state)[0][0]).toContain("new/b.md/i.png");
  });

  it("follow blocks that an edit merges, splits, opens or closes", () => {
    // An edit on a later line of a paragraph that holds an image line.
    replay("text\n![](a.png)\nmore", [{ at: "more", insert: "x" }]);
    // A fence or comment opened above images swallows them; closing it brings them back.
    const tail = "\n\n![](b.png)\n\n| a |\n|---|\n| 1 |\n\n- i\n  ![](c.png)\n";
    replay(`start${tail}`, [
      { at: "start", insert: "```\n" },
      { at: "\n\n![](b.png)", insert: "\n```" },
      { at: "```\nstart", remove: 4 },
      { at: "start", insert: "<!--\n" },
      { at: "\n\n![](b.png)", insert: "\n-->" },
    ]);
    // A deleted blank line merges a paragraph and a table; an inserted one splits them.
    replay("para\n\n| a |\n|---|\n| 1 |\n\n![](d.png)", [
      { at: "\n| a |", remove: 1 },
      { at: "| a |", insert: "\n" },
    ]);
    // Inside lists and quotes: item text, a marker or indent that reshapes the list, a fence in an item.
    replay("- a\n  ![](a.png)\n- b\n\n  ![](b.png)\n- c\n  > ![](c.png)\n\n![](d.png)", [
      { at: "b\n", insert: "x" },
      { at: "> ![](c.png)", insert: "z" },
      { at: "z>", remove: 1 },
      { at: "$", insert: "\n- e\n  ![](e.png)" },
      { at: "$", insert: "x" },
      { at: "- c", remove: 1, insert: "1." },
      { at: "- xb", insert: "  " },
      { at: "\n  ![](b.png)", remove: 1 },
      { at: "![](a.png)", insert: "```\n  " },
      { at: "```", remove: 3 },
    ]);
    // Edits inside a quote (in a list item) keep the container's inset; a quote that
    // stops taking a lazy line gives its image back to the top level.
    replay("- a\n  > b\n  > ![](q.png)\n\n> c\n> ![](r.png)\n\nend", [
      { at: "b\n", insert: "x" },
      { at: "c\n", insert: "x" },
    ]);
    replay("> a\n![](d.png)", [{ at: "a\n", remove: 1, insert: "```" }]);
    // An edit in the indentation before a quote that starts later on the line.
    replay("- b\n  - c\n    > ![](c.png)\n    > d\n\nend", [{ at: "   > ![](c.png)", insert: "\t" }]);
    // A frontmatter that grows to a later fence takes in blocks far from the edit.
    replay("---\na: 1\n---\n\npara\n\n![](x.png)\n\n---\nend", [
      { at: "---\n\npara", remove: 4 },
      { at: "\npara", insert: "---" },
    ]);
  });

  it("stay what a full scan finds through edits, compositions and refreshes", () => {
    let seed = 7;
    const random = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    let state = EditorState.create({ doc: DOC, extensions });
    let composing = false;
    for (let step = 0; step < 400; step++) {
      const len = state.doc.length;
      const pos = random(len + 1);
      const changes =
        len > 2000 || random(3) === 0
          ? { from: pos, to: Math.min(len, pos + 1 + random(12)) }
          : { from: pos, insert: SNIPPETS[random(SNIPPETS.length)] };
      // Now and then a composition: only mapped until the next update that is not part
      // of it (the compositionend rebuild, or an edit).
      if (!composing && random(10) === 0) composing = true;
      state = state.update({ changes, userEvent: composing ? "input.type.compose" : "input.type" }).state;
      if (composing && random(3) === 0) {
        composing = false;
        if (random(2) === 0) continue;
        state = state.update({ effects: rebuild.of(null) }).state;
      }
      if (!composing && random(8) === 0) state = state.update({ effects: refreshEffect.of(null) }).state;
      if (composing) continue;
      expectFullScan(state, `after step ${step}:\n${state.doc}`);
    }
  });
});
