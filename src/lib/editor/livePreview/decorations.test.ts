import { describe, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { commonmarkLanguage, markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import type { EditorHost } from "../host";
import { markdownExtensions } from "../syntax";
import { highlightRetags } from "../theme";
import { buildDecorations, type HangSource } from "./decorations";
import { fmField } from "./state";

const host = { resolveWiki: () => null, currentPath: () => "a.md" } as unknown as EditorHost;
const extensions: Extension = [
  markdown({ base: commonmarkLanguage, extensions: [GFM, ...markdownExtensions, highlightRetags], codeLanguages: [] }),
  fmField,
];
/** Prefix widths as the measure would have cached them, by key (font tag + prefix text). */
const widths = new Map<string, number>([
  ["s- ", 10],
  ["s  ", 8],
  ["s  - ", 18],
  ["sc   ", 20],
]);
const hang: HangSource = { get: (key) => widths.get(key), request: () => {} };

/** Line decorations by 1-based line: each one's classes and attributes, sorted and joined. */
function lines(doc: string): Record<number, string> {
  const state = EditorState.create({ doc, extensions });
  const set = buildDecorations({ state, ranges: [{ from: 0, to: doc.length }], sel: [], host, hang });
  const found = new Map<number, string[]>();
  for (let it = set.iter(); it.value; it.next()) {
    if (it.from !== it.to) continue;
    const spec = it.value.spec as { class?: string; attributes?: Record<string, string> };
    const parts = [spec.class ?? ""];
    for (const [k, v] of Object.entries(spec.attributes ?? {}).sort()) parts.push(`${k}=${v}`);
    const n = state.doc.lineAt(it.from).number;
    found.set(n, [...(found.get(n) ?? []), parts.join(" ").trim()]);
  }
  const out: Record<number, string> = {};
  for (const [n, decos] of found) out[n] = decos.sort().join(" | ");
  return out;
}

describe("block pairs", () => {
  it("tags a block's first line with its pair and the blank lines above it; blank lines stay body lines", () => {
    const doc = ["---", "t: 1", "---", "", "# H", "", "text", "more", "", "", "## H2", "- a"].join("\n");
    const got = lines(doc);
    expect(got[1]).toBe("cm-fm spellcheck=false");
    // The blank line below a block stands where a paragraph typed on it would: it carries that pair.
    expect(got[4]).toBe("data-blk=p data-prev=fm");
    expect(got[5]).toBe("cm-h1 | data-blk=h1 data-lead=block data-prev=fm style=--mn-blank: 1");
    expect(got[6]).toBe("data-blk=p data-prev=h1");
    expect(got[7]).toBe("data-blk=p data-lead=h data-prev=h1 style=--mn-blank: 1");
    expect(got[8]).toBeUndefined();
    // Below a paragraph a typed line is that paragraph's next line: no lead, no decoration.
    expect(got[9]).toBeUndefined();
    expect(got[10]).toBeUndefined();
    expect(got[11]).toBe("cm-h2 | data-blk=h2 data-prev=p style=--mn-blank: 2");
    expect(got[12]).toBe("cm-hang style=--mn-hang: 10px; --mn-depth: 1 | data-blk=ul data-prev=h2");
  });

  it("pairs the children of lists, items and quotes in their own context", () => {
    const doc = ["- a", "", "- b", "  - c", "", "  text", "> q1", ">", "> q2"].join("\n");
    const got = lines(doc);
    // The first block, and the first item of its list: no pair.
    expect(got[1]).toBe("cm-hang style=--mn-hang: 10px; --mn-depth: 1");
    // Blank lines between items or inside one carry no lead: text typed there may leave the list.
    expect(got[2]).toBeUndefined();
    expect(got[3]).toBe("cm-hang style=--mn-hang: 10px; --mn-depth: 1 | data-blk=li data-ctx=list-loose data-prev=li style=--mn-blank: 1");
    expect(got[4]).toBe("cm-hang style=--mn-hang: 18px; --mn-depth: 2 | data-blk=ul data-ctx=li data-prev=p");
    expect(got[5]).toBeUndefined();
    expect(got[6]).toBe("cm-hang style=--mn-hang: 8px; --mn-depth: 1 | data-blk=p data-ctx=li data-prev=ul style=--mn-blank: 1");
    // The quote starts on line 7: its bar begins below the gap above it, and runs through the gaps inside.
    expect(got[7]).toBe("cm-quote style=--mn-quote: 1; --mn-quote-list: 0; --mn-quote-new: 1 | data-blk=quote data-prev=ul");
    expect(got[8]).toBe("cm-quote style=--mn-quote: 1; --mn-quote-list: 0; --mn-quote-new: 0");
    expect(got[9]).toBe(
      "cm-quote style=--mn-quote: 1; --mn-quote-list: 0; --mn-quote-new: 0 | data-blk=p data-ctx=quote data-prev=p style=--mn-blank: 1",
    );
  });

  it("leaves leading blank lines alone and leads the blank line below the last block", () => {
    const got = lines("\n\n# H\n\n");
    expect(got[1]).toBeUndefined();
    expect(got[2]).toBeUndefined();
    expect(got[3]).toBe("cm-h1");
    expect(got[4]).toBe("data-blk=p data-prev=h1");
    expect(got[5]).toBeUndefined();
  });

  it("leads the blank line below a list or a quote, where a body paragraph would start", () => {
    // Left by Enter on an empty item or an empty quote line: the caret's line is a body line already.
    expect(lines("- a\n")[2]).toBe("data-blk=p data-prev=ul");
    expect(lines("> q\n")[2]).toBe("data-blk=p data-prev=quote");
    // Inside a quote, the blank ">" line below a heading; below the quote's last paragraph, none.
    const quoted = lines("> # h\n>\n> text\n>");
    expect(quoted[2]).toBe("cm-quote style=--mn-quote: 1; --mn-quote-list: 0; --mn-quote-new: 0 | data-blk=p data-ctx=quote data-prev=h1");
    expect(quoted[3]).toBe(
      "cm-quote style=--mn-quote: 1; --mn-quote-list: 0; --mn-quote-new: 0 | data-blk=p data-ctx=quote data-lead=h data-prev=h1 style=--mn-blank: 1",
    );
    expect(quoted[4]).toBe("cm-quote style=--mn-quote: 1; --mn-quote-list: 0; --mn-quote-new: 0");
    // Text below a paragraph, a table row or an HTML block joins it: no lead.
    expect(lines("text\n\nmore")[2]).toBeUndefined();
    expect(lines("| a |\n|---|\n")[3]).toBeUndefined();
  });

  it("never reads a line under text as a setext underline, nor a line without its markup as a lazy one", () => {
    // "-" typed under a paragraph while a list is being started: still that paragraph.
    expect(lines("text\n-")).toEqual({});
    expect(lines("text\n=")).toEqual({});
    // A line without ">" or the item's indentation is a paragraph of its own.
    expect(lines("> q\ntext")[2]).toBe("data-blk=p data-prev=quote");
    expect(lines("- a\ntext")[2]).toBe("data-blk=p data-prev=ul");
  });

  it("gives the lines of a nested code block the item's gutter, measured in the code font", () => {
    const doc = ["1. Install:", "   ```sh", "   npm i", "   ```", "2. Run"].join("\n");
    const got = lines(doc);
    expect(got[2]).toBe(
      "cm-code cm-code-first cm-fence data-lang=sh spellcheck=false | cm-hang style=--mn-hang: 20px; --mn-depth: 1 | data-blk=code data-ctx=li data-prev=p",
    );
    expect(got[3]).toBe("cm-code spellcheck=false | cm-hang style=--mn-hang: 20px; --mn-depth: 1");
    expect(got[5]).toBe("data-blk=li data-ctx=list-blocks data-prev=li");
  });
});
