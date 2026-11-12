/**
 * Small languages the legacy modes lack, as rule lists: comments, strings, numbers and
 * keywords are enough for a viewer. Each state's rules are tried in order at the current
 * position; the last rule of a list swallows a whole word, so that no keyword matches
 * inside one. A delimited token's closing delimiter is optional: an unclosed one takes
 * the rest of its line once, instead of being tried again at every opener of a long line.
 */
import { simpleMode } from "@codemirror/legacy-modes/mode/simple-mode";

const DOUBLE_QUOTED = /"(?:[^"\\]|\\.)*"?/;
const SINGLE_QUOTED = /'(?:[^'\\]|\\.)*'?/;

export const makefile = simpleMode({
  start: [
    { regex: /#.*/, token: "comment" },
    {
      regex: /(?:ifn?eq|ifn?def|else|endif|-?include|sinclude|define|endef|export|unexport|override|vpath)\b/,
      sol: true,
      token: "keyword",
    },
    // "target:" and "target::", but not "NAME := value" or "NAME ::= value".
    { regex: /[^\s:=#$]+(?=\s*(?:::(?!=)|:(?![:=])))/, sol: true, token: "def" },
    { regex: /[\w.-]+(?=\s*(?:[:+?!]|::)?=)/, sol: true, token: "variable-2" },
    { regex: /\$[({][^)}]*[)}]?|\$[@<^+?*%|$]/, token: "variable-2" },
    { regex: DOUBLE_QUOTED, token: "string" },
    { regex: SINGLE_QUOTED, token: "string" },
  ],
});

export const elixir = simpleMode({
  start: [
    { regex: /#.*/, token: "comment" },
    // A heredoc, plain or behind a sigil (`~S"""`), before the one-line strings its quotes start like.
    { regex: /(?:~[a-zA-Z])?"""/, token: "string", next: "heredoc" },
    { regex: /(?:~[a-zA-Z])?'''/, token: "string", next: "heredocSingle" },
    { regex: DOUBLE_QUOTED, token: "string" },
    { regex: SINGLE_QUOTED, token: "string" },
    {
      regex: /~[a-zA-Z](?:\/(?:[^/\\]|\\.)*\/?|"(?:[^"\\]|\\.)*"?|\((?:[^)\\]|\\.)*\)?|\[(?:[^\]\\]|\\.)*\]?)[a-zA-Z]*/,
      token: "string-2",
    },
    { regex: /:(?:[a-zA-Z_][\w@]*[?!]?|"(?:[^"\\]|\\.)*"?)/, token: "atom" },
    { regex: /[a-zA-Z_]\w*[?!]?:(?!:)/, token: "atom" },
    { regex: /@[a-zA-Z_]\w*/, token: "meta" },
    { regex: /0x[\da-fA-F_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/, token: "number" },
    {
      regex:
        /(def|defp|defmodule|defmacro|defmacrop|defprotocol|defimpl|defdelegate|defguard|defguardp|defexception)(\s+)([a-zA-Z_][\w.]*[?!]?)/,
      token: ["keyword", "", "def"],
    },
    {
      regex:
        /(?:def|defp|defmodule|defmacro|defmacrop|defstruct|defprotocol|defimpl|defdelegate|defguard|defguardp|defexception|defoverridable|do|end|fn|if|else|unless|case|cond|with|for|when|and|or|not|in|try|catch|rescue|after|raise|throw|receive|import|alias|require|use|quote|unquote|super)\b/,
      token: "keyword",
    },
    { regex: /(?:true|false|nil)\b/, token: "atom" },
    { regex: /[A-Z]\w*(?:\.[A-Z]\w*)*/, token: "type" },
    { regex: /[a-z_]\w*[?!]?/, token: null },
  ],
  heredoc: [
    { regex: /"""/, token: "string", next: "start" },
    { regex: /(?:[^"\\]|\\.|"(?!""))+/, token: "string" },
  ],
  heredocSingle: [
    { regex: /'''/, token: "string", next: "start" },
    { regex: /(?:[^'\\]|\\.|'(?!''))+/, token: "string" },
  ],
});

export const zig = simpleMode({
  start: [
    { regex: /\/\/.*/, token: "comment" },
    // A multiline string is a run of lines that each start with two backslashes.
    { regex: /\\\\.*/, token: "string" },
    { regex: DOUBLE_QUOTED, token: "string" },
    { regex: SINGLE_QUOTED, token: "string" },
    { regex: /@[a-zA-Z_]\w*/, token: "builtin" },
    {
      regex: /0x[\da-fA-F_]+(?:\.[\da-fA-F_]+)?(?:[pP][+-]?\d+)?|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/,
      token: "number",
    },
    { regex: /(fn)(\s+)([a-zA-Z_]\w*)/, token: ["keyword", "", "def"] },
    {
      regex:
        /(?:addrspace|align|allowzero|and|anyframe|anytype|asm|async|await|break|callconv|catch|comptime|const|continue|defer|else|enum|errdefer|error|export|extern|fn|for|if|inline|linksection|noalias|noinline|nosuspend|opaque|or|orelse|packed|pub|resume|return|struct|suspend|switch|test|threadlocal|try|union|unreachable|usingnamespace|var|volatile|while)\b/,
      token: "keyword",
    },
    { regex: /(?:true|false|null|undefined)\b/, token: "atom" },
    {
      regex:
        /(?:[iu]\d+|f16|f32|f64|f80|f128|isize|usize|bool|void|noreturn|type|anyerror|anyopaque|comptime_int|comptime_float|c_char|c_short|c_ushort|c_int|c_uint|c_long|c_ulong|c_longlong|c_ulonglong|c_longdouble)\b/,
      token: "type",
    },
    { regex: /[A-Z]\w*/, token: "type" },
    { regex: /[a-z_]\w*/, token: null },
  ],
});

export const graphql = simpleMode({
  start: [
    { regex: /#.*/, token: "comment" },
    { regex: /"""/, token: "string", next: "block" },
    { regex: DOUBLE_QUOTED, token: "string" },
    {
      regex:
        /(?:query|mutation|subscription|fragment|on|type|interface|union|enum|input|scalar|schema|extend|directive|implements|repeatable)\b/,
      token: "keyword",
    },
    { regex: /(?:true|false|null)\b/, token: "atom" },
    { regex: /\$[a-zA-Z_]\w*/, token: "variable-2" },
    { regex: /@[a-zA-Z_]\w*/, token: "meta" },
    { regex: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, token: "number" },
    { regex: /[A-Z]\w*/, token: "type" },
    { regex: /[a-z_]\w*/, token: null },
  ],
  block: [
    { regex: /"""/, token: "string", next: "start" },
    { regex: /(?:[^"]|"(?!""))+/, token: "string" },
  ],
});

/** HCL (Terraform). A heredoc's body is read as HCL, not as one string. */
export const hcl = simpleMode({
  start: [
    { regex: /(?:#|\/\/).*/, token: "comment" },
    { regex: /\/\*/, token: "comment", next: "comment" },
    { regex: DOUBLE_QUOTED, token: "string" },
    { regex: /<<-?\s*[A-Za-z_]\w*/, token: "string-2" },
    {
      regex:
        /(?:resource|data|variable|output|locals|module|provider|terraform|backend|provisioner|connection|dynamic|lifecycle|moved|import|check|for|in|if|else|endif|endfor)\b/,
      token: "keyword",
    },
    { regex: /(?:true|false|null)\b/, token: "atom" },
    { regex: /\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, token: "number" },
    { regex: /[a-zA-Z_][\w-]*(?=\s*=(?![=>]))/, token: "def" },
    { regex: /[a-zA-Z_][\w-]*/, token: null },
  ],
  comment: [
    { regex: /[^]*?\*\//, token: "comment", next: "start" },
    { regex: /[^]+/, token: "comment" },
  ],
});

/** Windows batch files. */
export const batch = simpleMode({
  start: [
    { regex: /\s*(?:@?rem\b|::).*/i, sol: true, token: "comment" },
    { regex: /\s*:[\w.-]+/, sol: true, token: "def" },
    { regex: /"[^"]*"?/, token: "string" },
    { regex: /%%~?[a-zA-Z]|%(?:~[a-zA-Z]*)?\d|%\*|%[^%\s]+%|![^!\s]+!/, token: "variable-2" },
    {
      regex:
        /@?(?:echo|set|setlocal|endlocal|if|else|for|in|do|goto|call|exit|pause|shift|start|cd|chdir|md|mkdir|rd|rmdir|del|erase|copy|xcopy|move|ren|rename|type|cls|title|color|pushd|popd|not|exist|defined|errorlevel|equ|neq|lss|leq|gtr|geq)\b/i,
      token: "keyword",
    },
    { regex: /\d+\b/, token: "number" },
    { regex: /[\w.-]+/, token: null },
  ],
});

/** gettext catalogs (`.po`, `.pot`). */
export const gettext = simpleMode({
  start: [
    { regex: /#.*/, sol: true, token: "comment" },
    { regex: /(?:msgctxt|msgid_plural|msgid|msgstr)\b/, token: "keyword" },
    { regex: /\[\d+\]/, token: "number" },
    { regex: DOUBLE_QUOTED, token: "string" },
  ],
});
