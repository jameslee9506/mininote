import { describe, expect, it } from "vitest";
import { history, undo } from "@codemirror/commands";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { GFM } from "@lezer/markdown";
import { fenceClosing } from "./fences";
import { markdownExtensions } from "./syntax";

const md = markdown({ base: commonmarkLanguage, extensions: [GFM, ...markdownExtensions] });

/** Each "§" is a caret. */
function stateOf(marked: string): EditorState {
  const parts = marked.split("§");
  let pos = 0;
  const carets = parts.slice(0, -1).map((part) => EditorSelection.cursor((pos += part.length)));
  return EditorState.create({
    doc: parts.join(""),
    selection: EditorSelection.create(carets),
    extensions: [md, history(), EditorState.allowMultipleSelections.of(true)],
  });
}

/** The state after `text` is typed over the selection, as the input handler applies it. */
function typeInto(state: EditorState, text: string): EditorState {
  const typed = state.update(state.replaceSelection(text), { userEvent: "input.type" });
  return (fenceClosing(typed) ?? typed).state;
}

function marked(state: EditorState): string {
  let doc = state.doc.toString();
  for (const head of state.selection.ranges.map((r) => r.head).reverse()) doc = doc.slice(0, head) + "§" + doc.slice(head);
  return doc;
}

/** Types a backtick at every caret; the result is in the same notation. */
const type = (doc: string): string => marked(typeInto(stateOf(doc), "`"));

/** The fenced block around the caret as its source text, when it has a closing fence of its own. */
function closedBlock(state: EditorState): string | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 1000)!;
  for (let n: SyntaxNode | null = tree.resolveInner(state.selection.main.head, -1); n; n = n.parent) {
    if (n.name !== "FencedCode") continue;
    const close = n.lastChild;
    return close && close.name === "CodeMark" && close.from > n.from ? state.sliceDoc(n.from, n.to) : null;
  }
  return null;
}

describe("typed code fences", () => {
  it("closes the block that the third backtick opens", () => {
    expect(type("``§")).toBe("```\n§\n```");
    expect(type("a\n``§\nb")).toBe("a\n```\n§\n```\nb");
    expect(type("가\n\n``§\n\n나")).toBe("가\n\n```\n§\n```\n\n나");
    // Up to three columns of indentation are still a fence, and the block keeps them.
    expect(type("  ``§")).toBe("  ```\n  §\n  ```");
    // Blanks behind the caret stay on the line they were on.
    expect(type("``§  ")).toBe("```  \n§\n```");
    // A block above another one: without its own fence, it would take the next one's.
    expect(type("``§\n\n```js\na\n```")).toBe("```\n§\n```\n\n```js\na\n```");
  });

  it("keeps the block inside its quote and its list item", () => {
    expect(type("> ``§")).toBe("> ```\n> §\n> ```");
    expect(type("> a\n> ``§\n> b")).toBe("> a\n> ```\n> §\n> ```\n> b");
    expect(type("- ``§")).toBe("- ```\n  §\n  ```");
    expect(type("- a\n  ``§\n- b")).toBe("- a\n  ```\n  §\n  ```\n- b");
    expect(type("10. ``§")).toBe("10. ```\n    §\n    ```");
    expect(type("- a\n\t- ``§")).toBe("- a\n\t- ```\n\t  §\n\t  ```");
    expect(type("- a\n\t``§")).toBe("- a\n\t```\n\t§\n\t```");
    expect(type("> - ``§")).toBe("> - ```\n>   §\n>   ```");
    for (const doc of ["> ``§\n\nb", "- ``§\n\nb", "10. ``§\nb", "- a\n\t- ``§\n- b", "- a\n\t``§\nb", "> - ``§\n> b"]) {
      const state = typeInto(stateOf(doc), "`");
      const block = closedBlock(state);
      expect(block, doc).not.toBeNull();
      expect(block!.split("\n"), doc).toHaveLength(3);
    }
  });

  it("leaves a fence that closes a block", () => {
    expect(type("```js\na\n``§")).toBe("```js\na\n```§");
    expect(type("```\na\n``§\nb")).toBe("```\na\n```§\nb");
    expect(type("- ```\n  a\n  ``§")).toBe("- ```\n  a\n  ```§");
  });

  it("leaves backticks that open no block", () => {
    expect(type("a ``§")).toBe("a ```§");
    expect(type("`§")).toBe("``§");
    // A longer fence, and a fence with something after it.
    expect(type("```§")).toBe("````§");
    expect(type("``§js")).toBe("```§js");
    expect(type("`§`")).toBe("``§`");
    // Text of another block: a longer fence, indented code, HTML, a task's text.
    expect(type("````\n``§")).toBe("````\n```§");
    expect(type("    ``§")).toBe("    ```§");
    expect(type("\t``§")).toBe("\t```§");
    expect(type("<div>\n``§")).toBe("<div>\n```§");
    expect(type("- [ ] ``§")).toBe("- [ ] ```§");
    expect(type("---\ntitle: a\n``§\n---\n")).toBe("---\ntitle: a\n```§\n---\n");
    expect(type("---\ntitle: a\n---\n``§")).toBe("---\ntitle: a\n---\n```\n§\n```");
  });

  it("acts where the backtick replaced a selection, and not at several carets", () => {
    const state = EditorState.create({ doc: "``xy", selection: EditorSelection.single(2, 4), extensions: [md] });
    expect(marked(typeInto(state, "`"))).toBe("```\n§\n```");
    expect(type("``§\n\n``§")).toBe("```§\n\n```§");
    expect(marked(typeInto(stateOf("``§"), "x"))).toBe("``x§");
  });

  it("undoes to the fence alone, which then stays", () => {
    let state = typeInto(stateOf("``§\nb"), "`");
    expect(marked(state)).toBe("```\n§\n```\nb");
    undo({ state, dispatch: (tr) => (state = tr.state) });
    expect(marked(state)).toBe("```§\nb");
    expect(marked(typeInto(state, "j"))).toBe("```j§\nb");
  });
});
