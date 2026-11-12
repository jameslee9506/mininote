/**
 * EditorStates of the code view (ARCHITECTURE §10.4): a code file shown in the app's
 * single EditorView, read-only, with line numbers and syntax colors. Nothing of the
 * Markdown stack is in these states: no host, no keymaps that edit, no compartments,
 * so `reconfigureEditor` (setup.ts) has nothing to apply to them.
 */
import { EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, gutters, keymap, lineNumbers } from "@codemirror/view";
import { selectAll } from "@codemirror/commands";
import { syntaxHighlighting } from "@codemirror/language";
import { findKeymap, findPanel } from "../searchPanel";
import { parseAhead } from "../setup";
import { editorTheme } from "../theme";
import { codeHighlight } from "./highlight";
import { wrapIndent } from "./wrap";

/** Tab stops of the code view, in columns. */
export const CODE_TAB_SIZE = 4;

/**
 * `cm-mn-code` scopes code.css. `--mn-digits`, the width of the last line's number, lets
 * the stylesheet size the gutter before CodeMirror has measured it.
 */
const rootAttributes = EditorView.editorAttributes.compute(["doc"], (state) => ({
  class: "cm-mn-code",
  style: `--mn-digits:${String(state.doc.lines).length}`,
}));

/**
 * Nothing drops into a viewer. Both events are cancelled here, so the pointer shows it and
 * the webview never opens a dropped file itself (PLAT-13), whatever else listens.
 */
const noDrops = EditorView.domEventHandlers({
  dragover(event) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    return true;
  },
  drop(event) {
    event.preventDefault();
    return true;
  },
});

const viewer: Extension = [
  rootAttributes,
  lineNumbers(),
  // Not sticky: the document column never scrolls sideways (long lines wrap).
  gutters({ fixed: false }),
  wrapIndent,
  syntaxHighlighting(codeHighlight),
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  // A non-editable view cannot take focus by itself; tabindex keeps selection, copy, find and the scroll keys working.
  EditorView.contentAttributes.of({ tabindex: "0", spellcheck: "false", autocorrect: "off", autocapitalize: "off", translate: "no" }),
  drawSelection(),
  EditorView.lineWrapping,
  EditorState.tabSize.of(CODE_TAB_SIZE),
  findPanel(),
  // No motion keys: the arrows, Page Up/Down, Home and End scroll the document natively.
  keymap.of([{ key: "Mod-a", run: selectAll }, ...findKeymap]),
  noDrops,
  editorTheme,
];

/**
 * Past this many characters, colors come from CodeMirror's background parser alone:
 * parsing ahead of every scroll (`parseAhead`) would stall a file this big.
 */
const PARSE_AHEAD_MAX = 2 * 1024 * 1024;

/**
 * A state showing `doc` as code in `language` (null: plain text). A language that fails
 * on this very text gives way to plain text: the file opens either way.
 */
export function createCodeState(doc: string, language: Extension | null): EditorState {
  if (language !== null) {
    try {
      const ahead = doc.length > PARSE_AHEAD_MAX ? [] : parseAhead;
      return EditorState.create({ doc, extensions: [language, ahead, viewer] });
    } catch (e) {
      console.error("code view: the language failed on this file", e);
    }
  }
  return EditorState.create({ doc, extensions: viewer });
}
