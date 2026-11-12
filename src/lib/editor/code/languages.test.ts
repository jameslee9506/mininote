import { describe, expect, it } from "vitest";
import type { Language } from "@codemirror/language";
import { CODE_EXTS, CODE_NAMES, codeLanguageOf } from "../../utils/codeFiles";
import { loadCodeLanguage } from "./languages";

/** One file name for every language id of the table. */
function samples(): Map<string, string> {
  const byLanguage = new Map<string, string>();
  for (const name of [...CODE_NAMES, ...CODE_EXTS.map((ext) => `x.${ext}`)]) {
    const id = codeLanguageOf(name);
    if (id !== null && !byLanguage.has(id)) byLanguage.set(id, name);
  }
  return byLanguage;
}

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/**
 * Text a viewer must survive: the two separators that CodeMirror keeps inside a line, in
 * the places where tokenizers written for an editor's own text loop or stop (after a
 * quote, after an escape, in comments of every style, alone on a line of an open string).
 */
const HOSTILE = [
  'a = b(1, "c") # d // e',
  "\tf: [g] <h> {i}",
  `name = "${LS}pasted"`,
  `name = "a\\n${PS}b"`,
  `text = """`,
  "first",
  `${LS}second`,
  `"""`,
  `/* a${LS}b */`,
  `// a${PS}b`,
  `(; a${LS}b ;)`,
  `(* a${PS}b *)`,
  `<!-- a${LS}b -->`,
  `# a${LS}b`,
  `'${PS}'`,
  `${LS}${PS}`,
  "",
].join("\n");

describe("code languages", () => {
  it("loads a grammar for every language but plain text, and each one parses", async () => {
    for (const [id, name] of samples()) {
      const language = await loadCodeLanguage(name);
      if (id === "text") {
        expect(language, id).toBeNull();
        continue;
      }
      expect(language, id).not.toBeNull();
      const { parser } = language as unknown as Language;
      expect(() => parser.parse(HOSTILE), id).not.toThrow();
    }
  });

  it("has none for a file that is not code", async () => {
    expect(await loadCodeLanguage("photo.png")).toBeNull();
  });
});
