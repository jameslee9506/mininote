import { describe, expect, it } from "vitest";
import { history, undo } from "@codemirror/commands";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { arrowReplacement } from "./arrows";
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
  return (arrowReplacement(typed) ?? typed).state;
}

function marked(state: EditorState): string {
  let doc = state.doc.toString();
  for (const head of state.selection.ranges.map((r) => r.head).reverse()) doc = doc.slice(0, head) + "§" + doc.slice(head);
  return doc;
}

/** Types `text` at every caret; the result is in the same notation. */
const type = (doc: string, text: string): string => marked(typeInto(stateOf(doc), text));

describe("typed arrows", () => {
  it("replaces a sequence when its last character is typed", () => {
    expect(type("a -§", ">")).toBe("a →§");
    expect(type("a <§", "-")).toBe("a ←§");
    expect(type("a =§", ">")).toBe("a ⇒§");
    expect(type("a <=§", ">")).toBe("a ⇔§");
    // "<->" in one go: its "<-" is an arrow by the time ">" comes. A "<-" that stayed counts too.
    expect(type("a ←§", ">")).toBe("a ↔§");
    expect(type("a <-§", ">")).toBe("a ↔§");
    expect(type("-§ b", ">")).toBe("→§ b");
    expect(type("# a -§\n\n- b <§", ">")).toBe("# a →§\n\n- b <>§");
    expect(type("\uAC00-§\uB098", ">")).toBe("\uAC00→§\uB098");
  });

  it("leaves what is not an arrow", () => {
    expect(type("a --§", ">")).toBe("a -->§");
    expect(type("<!-- a --§", ">")).toBe("<!-- a -->§");
    expect(type("a ==§", ">")).toBe("a ==>§");
    expect(type("a <==§", ">")).toBe("a <==>§");
    expect(type("a <§", "=")).toBe("a <=§");
    expect(type("a >§", "-")).toBe("a >-§");
    expect(type("a -§", "-")).toBe("a --§");
    expect(type("a\n§", ">")).toBe("a\n>§");
  });

  it("keeps the characters in code, HTML and frontmatter", () => {
    expect(type("`a -§`", ">")).toBe("`a ->§`");
    // A code span that is still being typed: the closing backtick comes later.
    expect(type("`a -§", ">")).toBe("`a ->§");
    expect(type("``a ` b -§", ">")).toBe("``a ` b ->§");
    expect(type("`a` -§", ">")).toBe("`a` →§");
    expect(type("\\`a -§", ">")).toBe("\\`a →§");
    expect(type("```js\na =§", ">")).toBe("```js\na =>§");
    expect(type("\ta <§", "-")).toBe("\ta <-§");
    expect(type("<div>\na -§", ">")).toBe("<div>\na ->§");
    // The typed ">" closes the tag: the text is read as it is after the character.
    expect(type("b <a data-x-§", ">")).toBe("b <a data-x->§");
    expect(type("---\ntitle: a -§\n---\n", ">")).toBe("---\ntitle: a ->§\n---\n");
    expect(type("---\ntitle: a\n---\nb -§", ">")).toBe("---\ntitle: a\n---\nb →§");
  });

  it("keeps the characters in links and after a backslash", () => {
    expect(type("https://example.com/a-§", ">")).toBe("https://example.com/a->§");
    expect(type("[a](b-§)", ">")).toBe("[a](b->§)");
    expect(type("[a -§](b)", ">")).toBe("[a →§](b)");
    expect(type("[[a-§]]", ">")).toBe("[[a->§]]");
    expect(type("[[a-§", ">")).toBe("[[a->§");
    expect(type("[[a]] -§", ">")).toBe("[[a]] →§");
    // Only the target is a file name: a heading and an alias are prose.
    expect(type("[[a#b -§]]", ">")).toBe("[[a#b →§]]");
    expect(type("[[a|b -§", ">")).toBe("[[a|b →§");
    expect(type("\\-§", ">")).toBe("\\->§");
    expect(type("\\<§", "-")).toBe("\\<-§");
    expect(type("\\\\-§", ">")).toBe("\\\\→§");
  });

  it("works at every caret, and where the character replaced a selection", () => {
    expect(type("-§\n`-§`\n=§", ">")).toBe("→§\n`->§`\n⇒§");
    const state = EditorState.create({ doc: "a -xy", selection: EditorSelection.single(3, 5), extensions: [md] });
    expect(marked(typeInto(state, ">"))).toBe("a →§");
  });

  it("undoes to the typed characters, which then stay", () => {
    let state = typeInto(stateOf("a -§"), ">");
    expect(marked(state)).toBe("a →§");
    undo({ state, dispatch: (tr) => (state = tr.state) });
    expect(marked(state)).toBe("a ->§");
    expect(marked(typeInto(state, " "))).toBe("a -> §");
  });
});
