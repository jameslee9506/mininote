import { describe, expect, it } from "vitest";
import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { gdshader } from "./modes/clikes";
import { config } from "./modes/config";
import { gdscript } from "./modes/gdscript";
import { elixir, makefile } from "./modes/simple";

const languages = new Map<object, StreamLanguage<unknown>>();

/** The styled tokens of `text`, as "style:text". */
function tokens<State>(mode: StreamParser<State>, text: string): string[] {
  let language = languages.get(mode);
  if (!language) languages.set(mode, (language = StreamLanguage.define(mode) as StreamLanguage<unknown>));
  const out: string[] = [];
  language.parser.parse(text).iterate({
    enter: (n) => {
      if (n.name !== "Document") out.push(`${n.name}:${text.slice(n.from, n.to)}`);
    },
  });
  return out;
}

describe("gdscript mode", () => {
  it("marks declarations, types, annotations and built-in calls", () => {
    expect(tokens(gdscript, "@export var speed: float = 300.0 # px")).toEqual([
      "meta:@export",
      "keyword:var",
      "variableName.definition:speed",
      "typeName:float",
      "operator:=",
      "number:300.0",
      "comment:# px",
    ]);
    expect(tokens(gdscript, "class_name Player extends CharacterBody2D")).toEqual([
      "keyword:class_name",
      "variableName.definition:Player",
      "keyword:extends",
      "typeName:CharacterBody2D",
    ]);
    // A lambda has no name to declare, and only a call is a built-in.
    expect(tokens(gdscript, "var f = func(): print(len)")).toEqual([
      "keyword:var",
      "variableName.definition:f",
      "operator:=",
      "keyword:func",
      "variableName.standard:print",
      "variableName:len",
    ]);
  });

  it("tells node paths from the modulo operator", () => {
    expect(tokens(gdscript, 'x = $Sprite2D/Child if %Unique else 5 % n % "a"')).toEqual([
      "variableName:x",
      "operator:=",
      "variableName.special:$Sprite2D/Child",
      "keyword:if",
      "variableName.special:%Unique",
      "keyword:else",
      "number:5",
      "operator:%",
      "variableName:n",
      "operator:%",
      'string:"a"',
    ]);
    // A statement starts with a name, so `%` there is a node; an expression carried over a line keeps its operator.
    expect(tokens(gdscript, 'var x = 1\n%Label.text = "hi"\nvar y = (a\n\t% b)')).toEqual([
      "keyword:var",
      "variableName.definition:x",
      "operator:=",
      "number:1",
      "variableName.special:%Label",
      "variableName:text",
      "operator:=",
      'string:"hi"',
      "keyword:var",
      "variableName.definition:y",
      "operator:=",
      "variableName:a",
      "operator:%",
      "variableName:b",
    ]);
  });

  it("carries a triple-quoted string over lines, and no other", () => {
    expect(tokens(gdscript, 'var s = """a\nb""" + &"n"\nvar t = "open\nMAX = 0x1F')).toEqual([
      "keyword:var",
      "variableName.definition:s",
      "operator:=",
      'string:"""a',
      'string:b"""',
      "operator:+",
      'string:&"n"',
      "keyword:var",
      "variableName.definition:t",
      "operator:=",
      'string:"open',
      "variableName:MAX",
      "operator:=",
      "number:0x1F",
    ]);
  });

  it("keeps escaped quotes inside strings and closes after escaped backslashes", () => {
    for (const text of [String.raw`"a\" # still a string"`, String.raw`'it\'s a string'`, String.raw`"path\\"`]) {
      expect(tokens(gdscript, `${text} + 1`)).toEqual([`string:${text}`, "operator:+", "number:1"]);
    }
    // Two trailing backslashes do not continue an unclosed string onto the next line.
    const text = String.raw`"path\\`;
    expect(tokens(gdscript, `${text}\nvar n = 1`)).toEqual([
      `string:${text}`,
      "keyword:var",
      "variableName.definition:n",
      "operator:=",
      "number:1",
    ]);
  });
});

describe("config mode", () => {
  it("reads section headers with attributes", () => {
    expect(tokens(config, '; scene\n[node name="Player" type="Node2D" groups=["a"]]\n[core]')).toEqual([
      "comment:; scene",
      "squareBracket:[",
      "keyword:node",
      "attributeName:name",
      'string:"Player"',
      "attributeName:type",
      'string:"Node2D"',
      "attributeName:groups",
      'string:"a"',
      "squareBracket:[",
      "keyword:core",
    ]);
  });

  it("reads typed values, and keys only at the start of a logical line", () => {
    expect(tokens(config, 'position = Vector2(100, -20.5)\nmetadata/_lock = true\nname=&"x"\n  a = b')).toEqual([
      "propertyName.definition:position",
      "typeName:Vector2",
      "number:100",
      "number:-20.5",
      "propertyName.definition:metadata/_lock",
      "atom:true",
      "propertyName.definition:name",
      'string:&"x"',
    ]);
  });

  it("continues a value or a string over lines", () => {
    expect(tokens(config, 'data = {\n"points": PackedVector2Array(0, 1),\n"text": "a\nb = c"\n}\nnext = 1')).toEqual([
      "propertyName.definition:data",
      'string:"points"',
      "typeName:PackedVector2Array",
      "number:0",
      "number:1",
      'string:"text"',
      'string:"a',
      'string:b = c"',
      "propertyName.definition:next",
      "number:1",
    ]);
    // An unbalanced bracket stops mattering at a blank line.
    expect(tokens(config, "a = (1\n\nb = 2")).toEqual([
      "propertyName.definition:a",
      "number:1",
      "propertyName.definition:b",
      "number:2",
    ]);
  });

  it("takes a number only where it ends, in one pass over any line", () => {
    expect(tokens(config, "v = 1.2.3\nw = 12px 0x1F 1e-05 -.5\nn = 7")).toEqual([
      "propertyName.definition:v",
      "propertyName.definition:w",
      "number:0x1F",
      "number:1e-05",
      "number:-.5",
      "propertyName.definition:n",
      "number:7",
    ]);
    // Digits before a letter, and blanks without a "=": each is read once, however long the line.
    expect(tokens(config, `${"1".repeat(20000)}x`)).toEqual([]);
    expect(tokens(config, `a${" ".repeat(100000)}b`)).toEqual([]);
  });
});

describe("other custom modes", () => {
  it("highlights a shader's declarations and preprocessor lines", () => {
    expect(tokens(gdshader, '#include "a.gdshaderinc"\nuniform vec4 tint : source_color; // c')).toEqual([
      'meta:#include "a.gdshaderinc"',
      "keyword:uniform",
      "typeName:vec4",
      "variableName:tint",
      "variableName.standard:source_color",
      "comment:// c",
    ]);
  });

  it("keeps an Elixir heredoc one string, with or without a sigil", () => {
    expect(tokens(elixir, '@doc ~S"""\nsay "hi"\n"""\ndef run(x), do: x')).toEqual([
      "meta:@doc",
      'string:~S"""',
      'string:say "hi"',
      'string:"""',
      "keyword:def",
      "variableName.definition:run",
      "atom:do:",
    ]);
  });

  it("tells a makefile's targets from its variables", () => {
    expect(tokens(makefile, "CC := gcc\nZ ::= 1\nall:: main.o\n\t$(CC) -o $@ # link")).toEqual([
      "variableName.special:CC",
      "variableName.special:Z",
      "variableName.definition:all",
      "variableName.special:$(CC)",
      "variableName.special:$@",
      "comment:# link",
    ]);
  });
});
