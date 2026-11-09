/**
 * Obsidian-style live preview (ARCHITECTURE §10.2, LIVE-01…16): one ViewPlugin
 * for everything inline or per line over the visible ranges (plugin.ts,
 * decorations.ts), one StateField for the image and table block widgets
 * (blocks.ts), shared state for focus, the pointer hold and the frontmatter
 * range (state.ts), arrow keys into block widgets (navigation.ts) and
 * multi-click selection at the caret (clicks.ts). Styling lives in
 * src/styles/editor.css.
 *
 * Put the whole extension in a compartment: reconfiguring it to [] is source mode.
 */
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorHost } from "../host";
import { blockPreview } from "./blocks";
import { multiClickSelection } from "./clicks";
import { widgetKeymap } from "./navigation";
import { panelFocused, previewPlugin, type ViewRef } from "./plugin";
import { fmField, focusField, freezeField, setFocus } from "./state";

export { frontmatterRange, type FrontmatterRange } from "./frontmatter";

export function livePreview(host: EditorHost): Extension {
  const ref: ViewRef = { view: null };
  return [
    focusField,
    freezeField,
    fmField,
    // The find panel counts as editor focus: a match inside hidden syntax must stay revealed.
    EditorView.focusChangeEffect.of((state, focusing) => {
      const focused = focusing || (ref.view !== null && panelFocused(ref.view));
      return state.field(focusField, false) === focused ? null : setFocus.of(focused);
    }),
    blockPreview(host),
    previewPlugin(host, ref),
    widgetKeymap,
    multiClickSelection,
  ];
}
