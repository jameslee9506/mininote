import { describe, expect, it, vi } from "vitest";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { hardened } from "./stream";

/** The styled tokens `mode` gives `text`, as "style:text". */
function tokens<State>(mode: StreamParser<State>, text: string): string[] {
  const out: string[] = [];
  StreamLanguage.define(mode)
    .parser.parse(text)
    .iterate({
      enter: (n) => {
        if (n.name !== "Document") out.push(`${n.name}:${text.slice(n.from, n.to)}`);
      },
    });
  return out;
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

describe("hardened stream modes", () => {
  it("reads U+2028 and U+2029 as spaces, which a mode's patterns can pass", () => {
    // Like many modes: a comment runs to the end of the line, as "." sees it.
    const comments: StreamParser<unknown> = {
      token(stream) {
        return stream.match(/^#.*/) ? "comment" : (stream.next(), null);
      },
    };
    const text = `# a${LINE_SEPARATOR}b${PARAGRAPH_SEPARATOR}c`;
    expect(tokens(comments, text)).toEqual([`comment:# a`]);
    expect(tokens(hardened(comments), text)).toEqual([`comment:${text}`]);
  });

  it("moves on by one character when a tokenizer does not advance", () => {
    const stuck: StreamParser<unknown> = {
      token(stream) {
        return stream.match("ok") ? "keyword" : null;
      },
    };
    expect(() => tokens(stuck, "ok?ok")).toThrow();
    expect(tokens(hardened(stuck), "ok?ok")).toEqual(["keyword:ok", "keyword:ok"]);
  });

  it("leaves the rest of the line unstyled when a tokenizer throws", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: StreamParser<unknown> = {
      name: "failing",
      token(stream) {
        if (stream.match("ok")) return "keyword";
        throw new Error("no rule");
      },
    };
    expect(tokens(hardened(failing), "ok bad ok\nok")).toEqual(["keyword:ok", "keyword:ok"]);
    // One report for the mode, not one per token.
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
