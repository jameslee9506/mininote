/**
 * Which files are code: the source, configuration and plain-text files that open in
 * the read-only code view (TREE-17), and the language each one is highlighted as.
 * Pure data, keyed by file name; `editor/code/languages.ts` loads the languages.
 *
 * `CODE_EXTS`, `CODE_NAMES` and `CODE_NAME_PREFIXES` are mirrored in
 * src-tauri/src/fs_ops.rs, where the watcher uses them to report content changes
 * of these files. codeFiles.test.ts keeps the two sides equal.
 */
import { basename } from "./path";

/** Language id → the extensions of its files (lower-case, without the dot). */
const EXTENSIONS = {
  // No highlighting: prose, tables, logs and formats without a grammar here.
  text:
    "txt text log csv tsv lock rst adoc asciidoc org bib srt vtt uid dialogue dtl ink yarn strings pbxproj xcconfig pro nix prisma sln",
  javascript: "js mjs cjs",
  jsx: "jsx",
  typescript: "ts mts cts",
  tsx: "tsx",
  json: "json jsonc json5 jsonl ndjson geojson gltf ipynb map webmanifest code-workspace tfstate",
  html: "html htm xhtml svelte vue astro ejs erb hbs handlebars mustache",
  css: "css pcss postcss",
  scss: "scss",
  less: "less",
  sass: "sass",
  stylus: "styl",
  xml:
    "xml xsd xsl xslt plist csproj vbproj fsproj vcxproj vcproj props targets resx xaml axaml nuspec wsdl rss atom " +
    "storyboard xib entitlements xcscheme xcworkspacedata iml dae ui qrc kml gpx opml xlf xliff tmx filters slnx",
  markdown: "mdx rmd qmd",
  python: "py pyw pyi pyx pxd bzl bazel gyp gypi",
  rust: "rs",
  go: "go",
  c: "c",
  cpp: "h cpp cc cxx c++ hpp hh hxx h++ inl ipp tpp ino cu cuh",
  csharp: "cs csx",
  java: "java",
  kotlin: "kt kts",
  scala: "scala sc sbt",
  dart: "dart",
  swift: "swift",
  objectivec: "m",
  objectivecpp: "mm",
  glsl: "glsl vert frag geom comp tesc tese vsh fsh hlsl fx cg cginc compute wgsl metal",
  gdshader: "gdshader gdshaderinc shader",
  gdscript: "gd",
  config: "cfg tscn tres escn godot import gdextension gdnlib gdns",
  php: "php phtml",
  ruby: "rb rake gemspec ru podspec jbuilder",
  lua: "lua luau rockspec",
  perl: "pl pm",
  r: "r",
  julia: "jl",
  haskell: "hs",
  erlang: "erl hrl",
  elixir: "ex exs",
  clojure: "clj cljs cljc edn",
  lisp: "lisp lsp el",
  scheme: "scm ss rkt",
  ocaml: "ml mli",
  fsharp: "fs fsi fsx",
  groovy: "groovy gradle gvy",
  pascal: "pas dpr lpr",
  fortran: "f f90 f95 f03 f08 for",
  cobol: "cob cbl cpy",
  vb: "vb bas",
  vbscript: "vbs",
  zig: "zig zon",
  solidity: "sol",
  shell: "sh bash zsh fish ksh command bats",
  powershell: "ps1 psm1 psd1",
  batch: "bat cmd",
  sql: "sql",
  yaml: "yaml yml",
  toml: "toml",
  dockerfile: "dockerfile containerfile",
  cmake: "cmake",
  makefile: "mk mak make",
  nginx: "",
  hcl: "hcl tf tfvars",
  graphql: "graphql gql graphqls",
  protobuf: "proto",
  properties: "properties env ini conf cnf desktop service",
  diff: "diff patch",
  gettext: "po pot",
  tex: "tex sty cls ltx",
  tcl: "tcl",
  verilog: "v sv svh vh",
  vhdl: "vhd vhdl",
  asm: "s asm",
  coffeescript: "coffee",
  elm: "elm",
  haxe: "hx",
  jinja: "j2 jinja jinja2 njk twig liquid",
  pug: "pug jade",
  wast: "wat wast",
} as const satisfies Record<string, string>;

/** A language of the code view. `text` is shown without highlighting. */
export type CodeLanguage = keyof typeof EXTENSIONS;

/** Language id → whole file names (lower-case): files told by name, with or without an extension. */
const NAMES: Partial<Record<CodeLanguage, string>> = {
  text:
    "license licence copying copyright patents notice authors contributors maintainers owners codeowners " +
    "changelog changes history news readme todo thanks install version procfile caddyfile cartfile cname " +
    "go.mod go.sum go.work",
  python: "sconstruct sconscript scsub snakefile tiltfile wscript meson.build",
  ruby: "gemfile rakefile podfile fastfile appfile matchfile brewfile vagrantfile guardfile dangerfile",
  groovy: "jenkinsfile",
  shell: "gradlew mvnw",
  toml: "cargo.lock poetry.lock uv.lock pipfile",
  json: "composer.lock flake.lock pipfile.lock",
  yaml: "pubspec.lock",
  dockerfile: "dockerfile containerfile",
  cmake: "cmakelists.txt",
  makefile: "makefile gnumakefile justfile",
  nginx: "nginx.conf",
};

/** Lower-case name prefixes: "Dockerfile.dev", "Makefile.am". */
const NAME_PREFIXES: Partial<Record<CodeLanguage, string>> = {
  dockerfile: "dockerfile.",
  makefile: "makefile.",
};

function index(table: Partial<Record<CodeLanguage, string>>): Map<string, CodeLanguage> {
  const map = new Map<string, CodeLanguage>();
  for (const [language, words] of Object.entries(table) as [CodeLanguage, string][]) {
    for (const word of words.split(" ")) {
      if (word === "") continue;
      if (map.has(word)) throw new Error(`codeFiles: "${word}" is listed twice`);
      map.set(word, language);
    }
  }
  return map;
}

// Maps, not objects: a file may be named "constructor" or end in ".__proto__".
const byExt = index(EXTENSIONS);
const byName = index(NAMES);
const byPrefix = [...index(NAME_PREFIXES)];

/** Every code extension, name and name prefix: the lists the backend mirrors. */
export const CODE_EXTS: readonly string[] = [...byExt.keys()];
export const CODE_NAMES: readonly string[] = [...byName.keys()];
export const CODE_NAME_PREFIXES: readonly string[] = byPrefix.map(([prefix]) => prefix);

/**
 * The language of a code file, from its name (or a path: its last segment): a whole
 * name first ("CMakeLists.txt" is CMake, not text), then a name prefix, then the
 * extension. Null for a file that is not code.
 */
export function codeLanguageOf(name: string): CodeLanguage | null {
  const file = basename(name).toLowerCase();
  const exact = byName.get(file);
  if (exact !== undefined) return exact;
  for (const [prefix, language] of byPrefix) if (file.startsWith(prefix)) return language;
  const dot = file.lastIndexOf(".");
  return dot > 0 ? (byExt.get(file.slice(dot + 1)) ?? null) : null;
}
