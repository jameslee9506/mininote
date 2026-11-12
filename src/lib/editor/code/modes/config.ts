/**
 * Sectioned `key = value` text whose values are typed: strings, numbers, calls such as
 * `Vector2(1, 2)`, arrays and dictionaries. It reads `.cfg` files and the text scene and
 * resource formats built on the same syntax, where a section header carries attributes
 * (`[node name="Player" type="Node2D"]`) and a value or a string may span lines.
 */
import type { StreamParser, StringStream } from "@codemirror/language";

interface State {
  /** A double-quoted string is still open at the end of the line. */
  string: boolean;
  /** Inside a `[section …]` header: its name comes next, or its attributes. */
  header: "name" | "attributes" | null;
  /** Brackets open in a header or a value. Above zero, the next line continues the value. */
  depth: number;
}

/** What a key cannot start with: a quote, a bracket, a comment mark. */
const NOT_A_KEY = /^["'[\]{}()#;]/;
/** `[core]` and `[my section]` whole; with attributes, the first word only. */
const SECTION = /^[^\]="]+(?=\])|^[^\s\]="]+/;
const WORD = /^[A-Za-z_][\w.-]*/;
/** A number that ends where it ends: `1.2.3` and `12px` are not numbers. */
const NUMBER = /^-?(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)(?![\w.])/i;
/** A run that starts with a digit and is no number: read whole, so that no part of it is tried again. */
const DIGIT_RUN = /^\d[\w.-]*/;
const ATOM = /^(?:true|false|null|nil|inf|nan|yes|no|on|off)$/i;

/**
 * At the start of a line: the key before the first `=`, without the blanks in front of
 * the `=`. One pass over the line, however long it is.
 */
function readKey(stream: StringStream): boolean {
  const equals = stream.string.indexOf("=");
  if (equals <= 0) return false;
  const key = stream.string.slice(0, equals).trimEnd();
  if (key === "" || NOT_A_KEY.test(key)) return false;
  stream.pos = key.length;
  return true;
}

/** Reads to the closing quote; without one, the string continues on the next line. */
function readString(stream: StringStream, state: State): string {
  let escaped = false;
  for (let ch = stream.next(); ch; ch = stream.next()) {
    if (ch === '"' && !escaped) {
      state.string = false;
      return "string";
    }
    escaped = !escaped && ch === "\\";
  }
  state.string = true;
  return "string";
}

export const config: StreamParser<State> = {
  name: "config",
  startState: () => ({ string: false, header: null, depth: 0 }),
  token(stream, state) {
    if (state.string) return readString(stream, state);
    let lineStart = false;
    if (stream.sol()) {
      // A header ends with its line, closed or not.
      if (state.header !== null) {
        state.header = null;
        state.depth = 0;
      }
      // A new logical line, unless a value is still open.
      lineStart = state.depth === 0;
      const indented = stream.eatSpace();
      if (stream.eol()) return null;
      if (lineStart) {
        const ch = stream.peek();
        if (ch === ";" || ch === "#") {
          stream.skipToEnd();
          return "comment";
        }
        if (ch === "[") {
          stream.next();
          state.header = "name";
          state.depth = 1;
          return "squareBracket";
        }
        // An indented line continues the value above it, so only column 0 starts a key.
        if (!indented && readKey(stream)) return "propertyName.definition";
      }
    } else if (stream.eatSpace()) return null;

    if (state.header === "name") {
      state.header = "attributes";
      if (stream.match(SECTION)) return "keyword";
    }

    // `&"name"` and `^"path"` are strings with a type prefix.
    if (stream.match(/^[&^]?"/)) return readString(stream, state);
    if (stream.match(/^'[^']*'/)) return "string";
    if (stream.match(NUMBER)) return "number";
    if (stream.match(WORD)) {
      if (state.header !== null && stream.match(/^\s*=/, false)) return "attributeName";
      if (stream.match(/^\s*\(/, false)) return "typeName";
      return ATOM.test(stream.current()) ? "atom" : null;
    }
    if (stream.match(DIGIT_RUN)) return null;
    const ch = stream.next();
    if (ch === "(" || ch === "[" || ch === "{") state.depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      state.depth = Math.max(0, state.depth - 1);
      if (state.depth === 0) state.header = null;
    }
    return null;
  },
  // No value runs over a blank line (a string may): an unbalanced bracket stops mattering there.
  blankLine(state) {
    if (state.string) return;
    state.header = null;
    state.depth = 0;
  },
  languageData: { commentTokens: { line: ";" } },
};
