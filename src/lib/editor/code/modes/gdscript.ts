/** GDScript, tokenized for highlighting only: no scopes, no indentation. */
import type { StreamParser, StringStream } from "@codemirror/language";

interface State {
  /** The quote that closes a string still open at the end of the line, or null. */
  string: string | null;
  /** The keyword before declares the next name (`func`, `var`, `class_name`…). */
  declares: boolean;
  /** The last token on this line was a value, so a following `%` is the modulo operator, not a unique node. */
  value: boolean;
}

const words = (list: string): Set<string> => new Set(list.split(" "));

const KEYWORDS = words(
  "if elif else for while match when break continue pass return class class_name extends is in as self super " +
    "signal func static const enum var breakpoint preload await yield assert and or not namespace trait " +
    "tool export onready setget",
);
/** Keywords followed by the name they declare. */
const DECLARING = words("func var const signal class class_name enum");
const ATOMS = words("true false null PI TAU INF NAN");
/** Built-in types that do not read as PascalCase; class names are told by their shape. */
const TYPES = words("bool int float void String StringName NodePath RID AABB Variant");
const BUILTINS = words(
  "print prints printt printerr printraw print_rich print_debug push_error push_warning range len str abs absf absi " +
    "sign min max clamp clampf clampi lerp lerpf lerp_angle inverse_lerp remap floor ceil round sqrt pow fmod fposmod " +
    "posmod sin cos tan asin acos atan atan2 deg_to_rad rad_to_deg randi randf randi_range randf_range randomize seed " +
    "is_instance_valid is_instance_of is_equal_approx is_zero_approx is_nan is_inf typeof type_string weakref load " +
    "instance_from_id var_to_str str_to_var var_to_bytes bytes_to_var move_toward snapped wrap wrapf wrapi smoothstep " +
    "ease hash char ord convert",
);

const STRING_START = /^[r&^]?("""|'''|"|')/;
const NODE_PATH = /^[$%](?:"[^"]*"|'[^']*'|[A-Za-z_][\w/%]*)/;
const NUMBER = /^(?:0x[\da-f_]+|0b[01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:e[+-]?\d+)?)/i;
const ANNOTATION = /^@[A-Za-z_]\w*/;
const WORD = /^[A-Za-z_\u00a1-\uffff][\w\u00a1-\uffff]*/;
const OPERATOR = /^(?:->|:=|\*\*=?|<<=?|>>=?|&&|\|\||[-+*/%&|^!=<>]=?|~)/;
/**
 * A class name: letters and digits from an upper-case start, with a lower-case letter
 * somewhere, so `MAX_SPEED` stays a plain name. Two tests, each one pass over the word.
 */
const isClassName = (word: string): boolean => /^[A-Z][A-Za-z0-9]*$/.test(word) && /[a-z]/.test(word);

/** Reads to the closing quote. A triple-quoted string runs over lines; another one only after a trailing backslash. */
function readString(stream: StringStream, state: State, quote: string): string {
  let escaped = false;
  while (!stream.eol()) {
    if (!escaped && stream.match(quote)) {
      state.string = null;
      return "string";
    }
    const ch = stream.next();
    escaped = !escaped && ch === "\\";
  }
  state.string = quote.length === 3 || escaped ? quote : null;
  return "string";
}

export const gdscript: StreamParser<State> = {
  name: "gdscript",
  startState: () => ({ string: null, declares: false, value: false }),
  token(stream, state) {
    if (state.string !== null) return readString(stream, state, state.string);
    // A statement starts with a name, never with an operator: `%Label.text = ...` is a node.
    if (stream.sol()) state.value = false;
    if (stream.eatSpace()) return null;
    const declares = state.declares;
    state.declares = false;

    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    const quote = stream.match(STRING_START) as RegExpMatchArray | null;
    if (quote) {
      state.value = true;
      return readString(stream, state, quote[1]);
    }
    // `$Path/To/Node` and `%UniqueNode`; after a value, `%` is the modulo operator.
    if ((stream.peek() === "$" || !state.value) && stream.match(NODE_PATH)) {
      state.value = true;
      return "variableName.special";
    }
    if (stream.match(NUMBER)) {
      state.value = true;
      return "number";
    }
    if (stream.match(ANNOTATION)) {
      state.value = false;
      return "meta";
    }
    if (stream.match(WORD)) {
      const word = stream.current();
      state.value = true;
      if (declares) return "variableName.definition";
      if (KEYWORDS.has(word)) {
        state.declares = DECLARING.has(word);
        state.value = false;
        return "keyword";
      }
      if (ATOMS.has(word)) return "atom";
      if (TYPES.has(word) || isClassName(word)) return "typeName";
      if (BUILTINS.has(word) && stream.match(/^\s*\(/, false)) return "variableName.standard";
      return "variableName";
    }
    if (stream.match(OPERATOR)) {
      state.value = false;
      return "operator";
    }
    const ch = stream.next();
    state.value = ch === ")" || ch === "]" || ch === "}";
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
};
