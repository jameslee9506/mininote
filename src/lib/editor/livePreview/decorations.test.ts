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
  it("tags a block's first line with its pair and the blank lines above it; those lines shrink", () => {
    const doc = ["---", "t: 1", "---", "", "# H", "", "text", "more", "", "", "## H2", "- a"].join("\n");
    const got = lines(doc);
    expect(got[1]).toBe("cm-fm spellcheck=false");
    expect(got[4]).toBe("cm-blank");
    expect(got[5]).toBe("cm-h1 | data-blk=h1 data-prev=fm style=--mn-blank: 1");
    expect(got[6]).toBe("cm-blank");
    expect(got[7]).toBe("data-blk=p data-prev=h1 style=--mn-blank: 1");
    expect(got[8]).toBeUndefined();
    expect(got[9]).toBe("cm-blank");
    expect(got[11]).toBe("cm-h2 | data-blk=h2 data-prev=p style=--mn-blank: 2");
    expect(got[12]).toBe("cm-hang style=--mn-hang: 10px; --mn-depth: 1 | data-blk=ul data-prev=h2");
  });

  it("pairs the children of lists, items and quotes in their own context", () => {
    const doc = ["- a", "", "- b", "  - c", "", "  text", "> q1", ">", "> q2"].join("\n");
    const got = lines(doc);
    // The first block, and the first item of its list: no pair.
    expect(got[1]).toBe("cm-hang style=--mn-hang: 10px; --mn-depth: 1");
    expect(got[2]).toBe("cm-blank");
    expect(got[3]).toBe("cm-hang style=--mn-hang: 10px; --mn-depth: 1 | data-blk=li data-ctx=list-loose data-prev=li style=--mn-blank: 1");
    expect(got[4]).toBe("cm-hang style=--mn-hang: 18px; --mn-depth: 2 | data-blk=ul data-ctx=li data-prev=p");
    expect(got[5]).toBe("cm-blank");
    expect(got[6]).toBe("cm-hang style=--mn-hang: 8px; --mn-depth: 1 | data-blk=p data-ctx=li data-prev=ul style=--mn-blank: 1");
    expect(got[7]).toBe("cm-quote style=--mn-quote: 1; --mn-quote-list: 0 | data-blk=quote data-prev=ul");
    expect(got[8]).toBe("cm-blank | cm-quote style=--mn-quote: 1; --mn-quote-list: 0");
    expect(got[9]).toBe("cm-quote style=--mn-quote: 1; --mn-quote-list: 0 | data-blk=p data-ctx=quote data-prev=p style=--mn-blank: 1");
  });

  it("shrinks leading blank lines but leaves trailing ones alone", () => {
    const got = lines("\n\n# H\n\n");
    expect(got[1]).toBe("cm-blank");
    expect(got[2]).toBe("cm-blank");
    expect(got[3]).toBe("cm-h1");
    expect(got[4]).toBeUndefined();
    expect(got[5]).toBeUndefined();
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
