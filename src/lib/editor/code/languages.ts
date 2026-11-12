/**
 * The languages of the code view (ARCHITECTURE §10.4), one per id of
 * `utils/codeFiles.ts`. The grammars lang-markdown already brings (JavaScript, HTML,
 * CSS, Markdown) are imported as they are. Everything else is a stream mode in a
 * chunk of its own, fetched when a file of that language is first opened, and
 * wrapped so that no input can stall or fail it (`stream.ts`).
 */
import type { Extension } from "@codemirror/state";
import { cssLanguage } from "@codemirror/lang-css";
import { htmlLanguage } from "@codemirror/lang-html";
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { codeLanguageOf, type CodeLanguage } from "../../utils/codeFiles";
import { streamLanguage as stream } from "./stream";

const clikes = () => import("@codemirror/legacy-modes/mode/clike");
const custom = () => import("./modes/clikes");
const simple = () => import("./modes/simple");
const mllike = () => import("@codemirror/legacy-modes/mode/mllike");
const css = () => import("@codemirror/legacy-modes/mode/css");

/** Every highlighted language; `text` has none. */
const LOADERS: Record<Exclude<CodeLanguage, "text">, () => Extension | Promise<Extension>> = {
  javascript: () => javascriptLanguage,
  jsx: () => jsxLanguage,
  typescript: () => typescriptLanguage,
  tsx: () => tsxLanguage,
  html: () => htmlLanguage,
  css: () => cssLanguage,
  markdown: () => markdownLanguage,

  json: () => import("@codemirror/legacy-modes/mode/javascript").then((m) => stream(m.json)),
  scss: () => css().then((m) => stream(m.sCSS)),
  less: () => css().then((m) => stream(m.less)),
  sass: () => import("@codemirror/legacy-modes/mode/sass").then((m) => stream(m.sass)),
  stylus: () => import("@codemirror/legacy-modes/mode/stylus").then((m) => stream(m.stylus)),
  xml: () => import("@codemirror/legacy-modes/mode/xml").then((m) => stream(m.xml)),
  python: () => import("@codemirror/legacy-modes/mode/python").then((m) => stream(m.python)),
  rust: () => import("@codemirror/legacy-modes/mode/rust").then((m) => stream(m.rust)),
  go: () => import("@codemirror/legacy-modes/mode/go").then((m) => stream(m.go)),
  c: () => clikes().then((m) => stream(m.c)),
  cpp: () => clikes().then((m) => stream(m.cpp)),
  csharp: () => clikes().then((m) => stream(m.csharp)),
  java: () => clikes().then((m) => stream(m.java)),
  kotlin: () => clikes().then((m) => stream(m.kotlin)),
  scala: () => clikes().then((m) => stream(m.scala)),
  dart: () => clikes().then((m) => stream(m.dart)),
  objectivec: () => clikes().then((m) => stream(m.objectiveC)),
  objectivecpp: () => clikes().then((m) => stream(m.objectiveCpp)),
  glsl: () => clikes().then((m) => stream(m.shader)),
  swift: () => import("@codemirror/legacy-modes/mode/swift").then((m) => stream(m.swift)),
  gdshader: () => custom().then((m) => stream(m.gdshader)),
  gdscript: () => import("./modes/gdscript").then((m) => stream(m.gdscript)),
  config: () => import("./modes/config").then((m) => stream(m.config)),
  php: () => custom().then((m) => stream(m.php)),
  solidity: () => custom().then((m) => stream(m.solidity)),
  ruby: () => import("@codemirror/legacy-modes/mode/ruby").then((m) => stream(m.ruby)),
  lua: () => import("@codemirror/legacy-modes/mode/lua").then((m) => stream(m.lua)),
  perl: () => import("@codemirror/legacy-modes/mode/perl").then((m) => stream(m.perl)),
  r: () => import("@codemirror/legacy-modes/mode/r").then((m) => stream(m.r)),
  julia: () => import("@codemirror/legacy-modes/mode/julia").then((m) => stream(m.julia)),
  haskell: () => import("@codemirror/legacy-modes/mode/haskell").then((m) => stream(m.haskell)),
  erlang: () => import("@codemirror/legacy-modes/mode/erlang").then((m) => stream(m.erlang)),
  elixir: () => simple().then((m) => stream(m.elixir)),
  clojure: () => import("@codemirror/legacy-modes/mode/clojure").then((m) => stream(m.clojure)),
  lisp: () => import("@codemirror/legacy-modes/mode/commonlisp").then((m) => stream(m.commonLisp)),
  scheme: () => import("@codemirror/legacy-modes/mode/scheme").then((m) => stream(m.scheme)),
  ocaml: () => mllike().then((m) => stream(m.oCaml)),
  fsharp: () => mllike().then((m) => stream(m.fSharp)),
  groovy: () => import("@codemirror/legacy-modes/mode/groovy").then((m) => stream(m.groovy)),
  pascal: () => import("@codemirror/legacy-modes/mode/pascal").then((m) => stream(m.pascal)),
  fortran: () => import("@codemirror/legacy-modes/mode/fortran").then((m) => stream(m.fortran)),
  cobol: () => import("@codemirror/legacy-modes/mode/cobol").then((m) => stream(m.cobol)),
  vb: () => import("@codemirror/legacy-modes/mode/vb").then((m) => stream(m.vb)),
  vbscript: () => import("@codemirror/legacy-modes/mode/vbscript").then((m) => stream(m.vbScript)),
  zig: () => simple().then((m) => stream(m.zig)),
  shell: () => import("@codemirror/legacy-modes/mode/shell").then((m) => stream(m.shell)),
  powershell: () => import("@codemirror/legacy-modes/mode/powershell").then((m) => stream(m.powerShell)),
  batch: () => simple().then((m) => stream(m.batch)),
  sql: () => import("@codemirror/legacy-modes/mode/sql").then((m) => stream(m.standardSQL)),
  yaml: () => import("@codemirror/legacy-modes/mode/yaml").then((m) => stream(m.yaml)),
  toml: () => import("@codemirror/legacy-modes/mode/toml").then((m) => stream(m.toml)),
  dockerfile: () => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => stream(m.dockerFile)),
  cmake: () => import("@codemirror/legacy-modes/mode/cmake").then((m) => stream(m.cmake)),
  makefile: () => simple().then((m) => stream(m.makefile)),
  nginx: () => import("@codemirror/legacy-modes/mode/nginx").then((m) => stream(m.nginx)),
  hcl: () => simple().then((m) => stream(m.hcl)),
  graphql: () => simple().then((m) => stream(m.graphql)),
  protobuf: () => import("@codemirror/legacy-modes/mode/protobuf").then((m) => stream(m.protobuf)),
  properties: () => import("@codemirror/legacy-modes/mode/properties").then((m) => stream(m.properties)),
  diff: () => import("@codemirror/legacy-modes/mode/diff").then((m) => stream(m.diff)),
  gettext: () => simple().then((m) => stream(m.gettext)),
  tex: () => import("@codemirror/legacy-modes/mode/stex").then((m) => stream(m.stex)),
  tcl: () => import("@codemirror/legacy-modes/mode/tcl").then((m) => stream(m.tcl)),
  verilog: () => import("@codemirror/legacy-modes/mode/verilog").then((m) => stream(m.verilog)),
  vhdl: () => import("@codemirror/legacy-modes/mode/vhdl").then((m) => stream(m.vhdl)),
  asm: () => import("@codemirror/legacy-modes/mode/gas").then((m) => stream(m.gas)),
  coffeescript: () => import("@codemirror/legacy-modes/mode/coffeescript").then((m) => stream(m.coffeeScript)),
  elm: () => import("@codemirror/legacy-modes/mode/elm").then((m) => stream(m.elm)),
  haxe: () => import("@codemirror/legacy-modes/mode/haxe").then((m) => stream(m.haxe)),
  jinja: () => import("@codemirror/legacy-modes/mode/jinja2").then((m) => stream(m.jinja2)),
  pug: () => import("@codemirror/legacy-modes/mode/pug").then((m) => stream(m.pug)),
  wast: () => import("@codemirror/legacy-modes/mode/wast").then((m) => stream(m.wast)),
};

/** One language instance per id: defining a stream language twice would register its token types twice. */
const loaded = new Map<CodeLanguage, Promise<Extension | null>>();

/**
 * The language extension for a code file's name (or path), or null for plain text and
 * for a language that failed to load. Never rejects: a file opens without highlighting
 * rather than not at all.
 */
export function loadCodeLanguage(name: string): Promise<Extension | null> {
  const id = codeLanguageOf(name);
  if (id === null || id === "text") return Promise.resolve(null);
  let language = loaded.get(id);
  if (!language) {
    language = Promise.resolve()
      .then(LOADERS[id])
      .catch((e: unknown) => {
        console.error(`code view: loading "${id}" failed`, e);
        loaded.delete(id);
        return null;
      });
    loaded.set(id, language);
  }
  return language;
}
