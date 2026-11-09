# CodeMirror 6 live-preview libraries: ixora and ink-mde

Research note for **mininote** (Tauri 2 + Svelte 5 + CodeMirror 6 live preview). This is research only: behaviors and
approaches are described in our own words with file paths as evidence. No code was copied. ixora is Apache-2.0 and
ink-mde is MIT.

## 0. Sources and scope

| | ixora | ink-mde |
|---|---|---|
| Repo | github.com/retronav/ixora (mirrors codeberg.org/retronav/ixora) | github.com/davidmyersdev/ink-mde |
| Snapshot read | `1734bce` (2026-07-20), `@retronav/ixora` 0.3.3 | `597bbd0` (2026-07-30), `ink-mde` 0.34.0 |
| License | Apache-2.0 (logo CC BY 4.0) | MIT |
| Code size | ~1.4k LOC (`packages/ixora/src`) | ~2.3k LOC core (`src/`, `lib/codemirror-kit/`, `plugins/katex/`) |
| Nature | CM6 extension pack: Obsidian-style "hide the syntax unless the cursor is on it" | Embeddable editor component (Solid.js shell, Vue/Svelte wrappers): "hybrid plain-text" rendering. Syntax stays visible but is styled. Optional widgets for lists, images and math |
| Tests | DOM specs via web-test-runner + puppeteer (`packages/ixora/test/*.spec.ts`) | Playwright e2e (`test/e2e/**`), vitest units |

Upstream versions used to check the API claims (installed in a scratch folder): `@codemirror/view` 6.43.15,
`@codemirror/state` 6.7.6, `@codemirror/language` 6.13.1, `@codemirror/lang-markdown` 6.5.2, `@lezer/markdown` 1.8.1,
`@codemirror/lang-yaml` 6.1.3. References like "view `dist/index.js` ~L2802" point at those builds.

### TL;DR for mininote

1. **The core live-preview loop** is ixora's: a `ViewPlugin` walks `syntaxTree(state)` only inside `view.visibleRanges`.
   For every element that no selection range touches, it emits empty `Decoration.replace({})` ranges over the element's
   mark children (`plugins/hide-mark.ts`). Everything else is a variation on this.
2. **Reveal granularity is a design decision for each construct.** In ixora, inline styles reveal per element, headings
   per line, and blockquotes and fenced code per whole block. The boundaries are inclusive, so a caret touching the
   element counts as inside (`util.ts` `checkRangeOverlap`).
3. **Hard CM6 rule (checked in the view source).** Block widgets, and replacements that span a line break, must come from a
   *static* decoration source: a `StateField` exposed through `EditorView.decorations.from(field)`. A ViewPlugin, or any
   `decorations.of(view => …)` function, throws `RangeError` for them.
4. **Recompute when the parser makes progress, not only on doc, viewport or selection changes.** Neither library does
   this. On large notes, regions parsed later stay undecorated until the next keystroke.
5. **Every widget needs an `eq()` that ignores document positions.** Without one, the DOM is rebuilt on every cursor move
   (ixora bullets and checkboxes, ink-mde dot/number/spacer widgets). If `eq()` compares positions, images reload whenever
   text above them changes (ixora's `JSON.stringify` eq).
6. **Interactive widgets must resolve their position at event time with `view.posAtDOM`** (ink-mde `lists.ts`), not
   capture it when the widget is built (ixora `CheckboxWidget`).
7. **Text that is replaced permanently must be atomic** (`EditorView.atomicRanges`, ink-mde lists). For wrapped list
   items, ink-mde's hanging-indent trick (a padding-left plus negative text-indent driven by a CSS variable) is the one to
   copy.
8. **Vertical spacing in the editor must use padding, never margins.** CM measures line and block heights with
   `getBoundingClientRect().height`, and its own docs say block decorations must not have vertical margins. CM 6.39 added
   **block wrappers** (DOM nodes around groups of lines), which is the natural way to get "spacing between blocks".
9. **IME: CM already ignores key events during composition**, including Safari's reversed compositionend/Enter order
   (within 100 ms). Our own `<input>`s (find bar, rename, quick switcher) do not get this protection. Neither library
   touches composition. Pin `@codemirror/view` ≥ 6.43.12, because many fixes for compositions next to widgets and
   decorations landed in 6.39–6.43.
10. **lang-markdown already provides** Enter list/quote continuation, Backspace markup deletion, paste-URL-over-selection
    → link, and heading-section folding. Neither library reimplements them.
11. **Neither library implements** tables, horizontal-rule rendering, `[[wikilinks]]`, `==highlight==`, callouts,
    footnotes, escape hiding, or Unicode heading slugs. ixora's slugger drops Hangul entirely.

## 1. Areas these projects do not cover (one line each)

1. **Vault/workspace**: not covered. Both are single-document editor libraries.
2. **File tree**: not covered.
4. **Persistence**: not covered. ink-mde only fires `beforeUpdate`/`afterUpdate` hooks with the full document string on
   every doc-changing transaction (`src/editor/view.ts` L10-24). There is no debounce and no I/O.
5. **Navigation & search**: in-document find only (ink-mde custom search panel). ixora keeps heading slugs and positions in
   a StateField, which could feed an outline. There is no switcher, tabs, history, or full-text search.
6. **Links**: no wikilinks or backlinks. ixora jumps to `[x](#slug)` targets inside the note. ink-mde's kit has a generic
   inline-parser builder that its doc comment says is meant for `[[...]]`.
9. **Platform/desktop**: not covered. ink-mde supports Shadow DOM roots (`view.ts` L6-7) and SSR, neither of which
   matters for Tauri.
10. **Settings**: ink-mde has an options object and CSS custom properties (§13, §14). ixora has none beyond exported class
    names and base themes.

The rest of this note covers areas 3 (Editor), 7 (Rendering & typography) and 8 (Performance).

## 2. Module maps

### 2.1 ixora (`packages/ixora/src`)

| Extension | File | Mechanism | Nodes used | Decorations | Revealed when a selection touches… | Recompute trigger |
|---|---|---|---|---|---|---|
| `hideMarks` | `plugins/hide-mark.ts` | ViewPlugin | Emphasis, StrongEmphasis, InlineCode, Strikethrough → EmphasisMark, CodeMark, StrikethroughMark | empty replace on each mark | the outermost element | doc / viewport / selection |
| `headings` | `plugins/heading.ts` | 2 ViewPlugins + baseTheme | ATXHeading1-6, SetextHeading1-2, HeaderMark | line class `cm-heading cm-heading-N cm-heading-slug-*`; replace `#`+1 char | the heading's line | doc / viewport / selection |
| `headingSlugField` | `state/heading-slug.ts` | StateField (data) | all headings, whole doc | none (slug + pos list) | — | docChanged |
| `lists` | `plugins/list.ts` | 2 ViewPlugins | ListMark (`-+*` only), Task, TaskMarker | replace mark with bullet widget; replace `[ ]` with checkbox; mark `cm-task-checked` over the task | the mark itself | doc / viewport / selection |
| `blockquote` | `plugins/blockquote.ts` | ViewPlugin | Blockquote (+ regex on raw text) | line class; replace first `>` char with a border span; point widget on lazy lines | any line of the quote | doc / viewport / selection |
| `codeblock` | `plugins/code-block.ts` | ViewPlugin | FencedCode, CodeBlock, CodeMark, CodeInfo | line classes (begin/end); replace fences + info string | the whole block | doc / viewport / selection |
| `links` | `plugins/link.ts` | ViewPlugin | URL (parent not Image), LinkMark, LinkTitle | replace marks, URL, title; `🔗` anchor widget after URL | the parent node (Link/Autolink/…) | doc / viewport / selection |
| `image` | `plugins/image.ts` + `state/image.ts` | ViewPlugin (hide) + StateField (preview) | Image + URL child | replace whole syntax; preview widget after it | the Image node (hiding only) | hide: doc/selection (no viewport!); preview: doc or load effect |
| `htmlBlock` | `plugins/html.ts` | StateField | HTMLBlock | sanitized block widget **after** the source | preview is removed while the caret is inside | doc or any selection |
| `frontmatter` | `plugins/frontmatter.ts` | `@lezer/markdown` block-parser extension | Frontmatter, FrontmatterMark | YAML overlay parse + styleTags + fold | — | parser |

The default export bundles everything except `frontmatter`, which must go into `markdown({extensions})` (`index.ts`
L31-42). The demo and test setups use `base: markdownLanguage` (GFM) and `EditorView.lineWrapping` (`demo/index.ts`,
`test/util.ts`).

### 2.2 ink-mde

- **Always on** (`src/editor/state.ts` L24-40): the `blockquote()` and `code()` ViewPlugins, which add line classes
  `cm-blockquote(-open|-close)` and `cm-codeblock(-open|-close)`, inline `cm-code(-open|-close)` marks, and
  spellcheck/Grammarly-off attributes. Also history, the default keymaps, `lineWrapping`, and a HighlightStyle whose values
  are all CSS variables (`extensions/theme.ts`).
- **Lazy features**: each is dynamically imported into its own `Compartment` (`src/extensions.ts` L76-183). These are
  autocomplete+closeBrackets, images (StateField block widgets), indentWithTab, lists (3 StateFields + atomicRanges),
  placeholder, readonly, search (custom panel), spellcheck and vim.
- **Grammar plugins** reconfigure a compartment around `markdown()` (`src/markdown.ts`). The KaTeX plugin adds `$…$`
  and `$$…$$` (`plugins/katex/`).
- **Kit** (`lib/codemirror-kit/`): `nodeDecorator` (a StateField decorator keyed by node names, with an optional
  incremental mode), `buildWidget` (an object-literal WidgetType), and `buildInlineParser`.
- **It never hides syntax.** Marks stay visible, coloured with `--ink-syntax-processing-instruction-color`. Only list
  markers and indentation are replaced, and those replacements are always on.

## 3. The syntax tree is the single source of truth

Both libraries derive everything from the Lezer markdown tree. Node layouts confirmed by parsing samples with
`markdownLanguage` (lezer-markdown 1.8.1):

- `# Title #` is ATXHeading1 with **two** HeaderMarks: `[0,1]` and the closing `[8,9]` at end of line. A bare `#` is a
  heading whose only child is a HeaderMark.
- `- [X] done` gives ListItem → ListMark, Task → TaskMarker. Uppercase `X` is recognised, and `1. [ ] x` also produces a
  Task.
- `**a**_b_` gives StrongEmphasis `[0,5]` **immediately followed** by Emphasis `[5,8]`, so the two siblings share an
  endpoint.
- `> q\nlazy` gives one Blockquote spanning the lazy line, with a QuoteMark only on the first line. `> > x` nests two
  Blockquotes.
- `![alt](a b.png)` has **no URL child**, because spaces are not allowed in a destination. Generated attachment links must
  percent-encode spaces or use `<…>`.
- `[[wiki]]` parses as a `Link` `[wiki]` inside literal brackets. A wikilink parser has to claim `[[` before the Link
  parser runs.
- `==hi==` produces no node. `~sub~` and `^sup^` become Subscript and Superscript, because `markdownLanguage` = CommonMark
  + GFM + Subscript + Superscript + Emoji (lang-markdown `dist/index.js` L63-74). Obsidian supports neither.
- Without a frontmatter extension, `---\ntitle: x\n---` parses as **HorizontalRule + SetextHeading2**, so the YAML line
  renders as a large H2.
- `<https://x>` gives Autolink → LinkMark, URL, LinkMark. A bare `https://x` gives a URL directly under Paragraph. A
  reference definition gives LinkReference → LinkLabel, LinkMark `:`, URL.
- Tables give Table → TableHeader/TableRow → TableCell + TableDelimiter (the `|---|` row is one TableDelimiter). Escapes
  and entities have their own `Escape`/`Entity` nodes, so a backslash could be hidden like a mark.

Note also that the default `base` of `markdown()` is **commonmarkLanguage**. GFM requires passing
`base: markdownLanguage`, or building `commonmark + GFM`. All markdown languages share one language-data facet, so
`markdownLanguage.isActiveAt` (used by the Enter/Backspace commands) still works with a custom base (lang-markdown
L9-24, L55-57).

## 4. Hiding syntax with `Decoration.replace`

### 4.1 Inline marks (ixora `plugins/hide-mark.ts` L32-76)

- It walks the tree in the visible ranges. For node types in the element set it remembers the outermost element
  (`parentRange`) and skips any node overlapping it, so nested emphasis is decided by its outermost ancestor.
- If any selection range overlaps the element (inclusive at both ends), the element is left alone. Otherwise the element
  is turned into a standalone tree (`node.toTree()`) and walked again, emitting an empty replace for every mark child,
  offset by the element start. Nested marks inside the hidden element are hidden too: `` **_`foo`_** is bar `` displays as
  `foo is bar` (`test/hide-mark.spec.ts`).
- Edge cases:
  - **Bug:** the nesting check also uses the inclusive overlap test, so an adjacent sibling (`**a**_b_`) is treated as
    nested and its marks are never hidden.
  - Reveal is all-or-nothing for a nested group.
  - Escapes, entities, links and headings are handled elsewhere or not at all.
  - `toTree()` allocates a fresh tree for every element on every recompute. Iterating the node's own cursor
    (`node.node.cursor()`, or `iterate` with from/to) avoids this.

### 4.2 Headings (ixora `plugins/heading.ts` L39-62)

- The `#` sequence plus one following character is replaced when no selection touches the heading's **line**. Setext
  underlines are kept visible: the hide is only applied if the mark text contains `#`.
- **Crash bug:** the range `[from, to+1]` crosses the line break for a closing sequence (`# Title #`, mark `[8,9]`) or an
  empty heading (`#`). A ViewPlugin then throws *"Decorations that replace line breaks may not be specified via plugins"*,
  or the range runs past the end of the document. Safe version: hide only the opening mark plus the run of spaces after
  it, clamp to `line.to`, and treat closing sequences separately (hide them together with the spaces before them).
- `view.lineBlockAt(from)` and the cursor test run for **every** node before the type check. Test the node type first.

### 4.3 Fenced code (ixora `plugins/code-block.ts` L44-82)

CodeMark and CodeInfo are hidden while no selection is inside the block. The fence lines remain as **empty, backgrounded
lines**, because a ViewPlugin cannot remove whole lines. Collapsing them would need a block-level replace from a
StateField. Indented code has no marks, so only its background changes.

### 4.4 Links (ixora `plugins/link.ts` L59-126)

- For every URL node whose parent is not an Image, while no selection touches the parent, ixora hides the parent's
  LinkMarks, the URL and the LinkTitle. It then appends a `🔗` `<a>` widget after the URL, so `[text](url)` reads as
  `text🔗`.
- `#slug` targets jump to the heading using `headingSlugField`. Other links use `href` + `target=_blank`. In Tauri this
  must go through the opener plugin.
- Bugs and edge cases:
  - For an **autolink** `<https://x>`, the parent has LinkMarks, so the URL text is hidden as well. Only the icon remains.
  - A bare GFM URL gets an icon but nothing hidden.
  - Reference definitions lose their URL text.
  - The title tooltip keeps its quotes.
  - A global regex is used with `.test()` (L18, L95), which carries `lastIndex` state between calls.
- For a minimal UI, the icon widget is noise. Obsidian-style behaviour is "text only, open on Mod+click".

### 4.5 Images (ixora `plugins/image.ts`, `state/image.ts`)

The whole `![alt](src)` is hidden while no selection is inside it (ViewPlugin). The preview is a separate StateField
widget that stays visible, so with the caret inside, the source appears and the image stays below it. **Bug:** the
hiding plugin does not recompute on `viewportChanged` (L40-43), so images scrolled into view keep their raw syntax until
the next edit or selection change.

### 4.6 ink-mde: no hiding

Only list markers, task markers and indentation units are replaced, permanently, and they are added to
`EditorView.atomicRanges`. Without that, the caret could sit invisibly "inside" replaced text and arrow keys would look
stuck (`src/editor/extensions/lists.ts` L196-211).

## 5. Reveal rules

| Construct | ixora reveal unit (`util.ts` L13-43: inclusive overlap with *any* selection range) | Notes |
|---|---|---|
| Emphasis / strong / code / strike | outermost element | a caret right after the closing mark reveals it |
| Heading `#` | the heading's line block | whole line, so the text shifts once when the line is entered |
| Link / autolink | parent node | |
| Image syntax | Image node | the preview widget stays |
| Bullet | the ListMark only | arrowing onto `-` reveals it |
| Task checkbox | the TaskMarker `[ ]` only | clicking the widget does not move the selection (default `ignoreEvent` = true) |
| Blockquote `>` | **any line of the whole quote** (`blockquote.ts` L64-69) | big jumps for long quotes |
| Code fences | whole block | |
| HTML preview | whole HTML block | the source is always visible; the preview is removed while editing |

Consequences:

- Clicking into hidden text first sets the selection, then decorations change, and the text shifts under the pointer.
  Obsidian behaves the same way.
- Two mitigations reduce the shift: replacements that keep the original width (ixora's bullet, §6.1) and line-level
  reveal for headings.
- Multi-cursor works naturally because every range is checked.

## 6. Widgets

### 6.1 Bullets

- **ixora** (`list.ts` L28-73, L162-177): the widget renders the **original marker character but invisible**, and an
  absolutely positioned `::after` draws U+2022. Width and caret metrics stay exactly those of `-`, so revealing it causes
  no reflow. Only `-+*` bullets are replaced; ordered markers stay as typed. **Missing `eq()`**, so every selection change
  rebuilds every bullet's DOM.
- **ink-mde** (`lists.ts` L68-79, L146-217): replaces marker + trailing space with a `<label>` showing `&bull;`
  (min-width 2rem, `inert`, `aria-hidden`). It is always on and atomic. Only `-` and `*` count as bullets, so `+` items
  fall through to the "number" decorator and show a literal `+`.

### 6.2 Task checkboxes

- **ixora** (`list.ts` L78-153):
  - TaskMarker is replaced by an `<input type=checkbox>` widget **when the caret is not on the marker**. A checked task
    also gets a mark decoration with `line-through`.
  - The click handler dispatches a one-character change (`' '` ↔ `x`) at a position **captured when the widget was
    built**, and it mutates the widget's own `checked` field.
  - This only works because the missing `eq()` forces a rebuild after every update. Adding an `eq` would make the stored
    position stale.
- **ink-mde** (`lists.ts` L292-418):
  - The widget has `eq` by checked state and `ignoreEvent: () => false`.
  - A ViewPlugin `mousedown` handler finds the checkbox via `closest()`, gets the marker start with **`view.posAtDOM()`
    at event time**, checks the text at +2..+5 is `[ ]`/`[x]`, swaps it, and returns `true` so the caret does not move.
    `test/e2e/core/lists.spec.ts` covers "toggle after preceding content changes".
  - Limits: only lowercase `[x]`, only `-`/`*`, and it requires a space after `]`, so `- [ ]` with no text is
    undecorated.

### 6.3 Indentation and hanging indent (ink-mde `lists.ts` L101-144, L420-465)

- Each 2-character indentation unit (`tabSize = 2`, L9) becomes a fixed-width (2rem) spacer widget that draws a 1px
  vertical guide. Spacers are atomic.
- The list line gets `--indent-level: N`. CSS sets `padding-left: calc(N*2rem + 2rem)` and
  `text-indent: calc(-(N*2rem + 2rem))`, resetting `text-indent: 0` on children. Wrapped rows therefore align with the item
  text instead of the line start. **This is the technique to copy for wrapped list items.**
- Pitfalls:
  - A tab is a single character but is counted as if indentation were in 2-space units.
  - A 3-space continuation under `1. ` leaves a stray space.
  - Lists inside blockquotes are skipped entirely (`getVals` returns false for Blockquote).

### 6.4 Images

- **ixora** (`state/image.ts` L47-170):
  - A StateField places a widget after the Image node (`side: 1`).
  - At creation it renders an **inline placeholder** while a detached `Image` loads the source. On `load` it dispatches
    an `imageLoadedEffect`. The field rebuilds, carrying a `loaded` flag through the decoration spec matched by `src`, and
    now emits a **block** widget with the real image. Its height is known on first insertion, which fixed "messed up
    editor when an image preview is loaded" (CHANGELOG 0.3.1).
  - Pitfalls:
    - `eq` uses `JSON.stringify(info)` including `from/to`, so any edit above an image recreates it (flicker, re-decode).
    - Alt text comes from a regex, which breaks on `]` in the alt.
    - Reference-style images are ignored.
    - `src` is used verbatim, with no relative-path resolution.
    - The recompute is whole-document on every doc change.
- **ink-mde** (`extensions/images.ts`):
  - A StateField block widget with `side: -1` at the **start of the line** containing the image, so the preview sits
    above the source and the source stays visible.
  - `eq` compares only the URL, so moving it does not rebuild it. The container uses padding (0.5rem top/bottom), never
    margins. The image is `width:100%`, `max-height: var(--ink-block-max-height)` (20rem), inside a rounded backdrop.
  - There is no load handling, so the height map is stale until the next measure.
- **CM guidance**: block widgets "should not have vertical margins", and if their height changes dynamically you must
  call `view.requestMeasure()` (view `dist/index.d.ts` WidgetDecorationSpec.block). For mininote:
  - resolve paths relative to the note;
  - map them through Tauri's asset protocol (`convertFileSrc`);
  - cache natural sizes so you can set `aspect-ratio` up front;
  - call `requestMeasure` on load;
  - compare `src`/alt/size only in `eq`.

### 6.5 Sanitized HTML preview (ixora `plugins/html.ts`)

A StateField collects every HTMLBlock in the whole document while the caret is outside it. The content is sanitized with
DOMPurify with `style` attributes forbidden, and a block widget is added **after** the source. The widget sets
`overflow: auto` to contain child margins. It recomputes on any selection presence, re-sanitizing every block in the
document on every caret move. Its `eq` again includes positions.

### 6.6 Math (ink-mde `plugins/katex/`)

- The block widget (`side: -1`, above the `$$` source) is keyed by `id = math source`, so it is not rebuilt when it moves.
- It renders asynchronously after `import('katex')`, then calls `view.requestMeasure()`. `updateDOM` re-renders into the
  existing element instead of replacing it (`index.ts` L38-84).
- Inline `$…$` is only highlighted, not rendered.
- The block parser consumes lines until a closing `$$`. **If none exists it still returns true without adding a node**,
  so the rest of the document silently drops out of the tree (`grammar.ts` L75-135).

### 6.7 Widget identity rules (both libraries, CM `WidgetType` defaults: `eq` → false, `ignoreEvent` → true, `estimatedHeight` → -1)

- **No `eq`**: the DOM is redrawn whenever the decoration set is rebuilt. With selection-driven plugins that means every
  caret move (ixora bullets and checkboxes, ink-mde dot/number/spacer widgets).
- **`eq` including positions**: the DOM is redrawn on unrelated edits above the widget (ixora image and html).
- **Correct**: compare only rendering inputs (ink-mde image `url`, katex `id`, task `isChecked`). Use `updateDOM` to patch
  instead of replacing, and `estimatedHeight` for block widgets.
- ink-mde's `buildWidget` returns a plain object that mimics the WidgetType interface and overrides `compare` to call
  `eq` (`lib/codemirror-kit/decorations.ts` L78-104). This works, but subclassing `WidgetType` is clearer.

## 7. Line decorations and block-shaped constructs

- **Headings**:
  - ixora sets font size on the **line** (`.cm-heading-N`: 2.2/1.8/1.4/1.2/1.0/0.8 rem in the base theme; the docs site
    overrides with 15px base and 1.8/1.6/1.4/1.2/1/0.8 rem). With the size on the line, the caret height and line box
    match the heading even where the `#` is hidden. Using `rem` ties heading size to the root font, not the editor's
    15px. Prefer `em`.
  - ink-mde sizes only the **text spans** through HighlightStyle on `tags.heading1..6` (1.6/1.5/1.4/1.3/1.2/1.1 em,
    weight 600). An empty or just-started heading line keeps the body line box.
- **Blockquote**:
  - ixora puts a class on every *visible* line and replaces the first `>` with a span that has `border-left: 4px`.
    Because the border is an inline span, **wrapped continuation rows lose the bar**.
  - ink-mde puts `border-left` and background on the `.cm-line` itself, plus `-open`/`-close` classes that add padding
    and radius on the first and last line (`ui/components/root/styles.css` L187-219). This is correct for wrapped rows.
- **Code blocks**:
  - ixora derives "begin/end" from **viewport** lines (`editorLines`), so when a block starts above the viewport its
    first *visible* line gets the begin styling.
  - ink-mde uses `doc.lineAt(node.from/to)`, which is viewport-independent. It also tags code lines and inline code with
    `spellcheck=false` and Grammarly opt-outs (`extensions/code.ts` L14-27), which is worth copying for Korean users whose
    OS spellcheck underlines code.
- **Folding**: ixora's `editorLines` drops lines inside folded ranges so no decorations leak into folds (CHANGELOG 0.2.0).
- **Inline code "pill"**: ink-mde splits inline code into open-mark / body / close-mark decorations, so it can round only
  the outer corners and pad the ends (`styles.css` L221-235).

## 8. StateField vs ViewPlugin (rules checked in `@codemirror/view` source)

- view `dist/index.js` ~L2800-2805: for decoration sources flagged *dynamic*, block widgets throw "Block decorations may
  not be specified via plugins", and replace ranges that cross a line end throw "Decorations that replace line breaks may
  not be specified via plugins".
- ~L3455-3459: a source is *dynamic* when its facet value is a **function of the view**. That covers every ViewPlugin
  `decorations` option and any `EditorView.decorations.of(view => …)`. `EditorView.decorations.from(field)` is static.
  ink-mde's lists use `decorations.of(view => view.state.field(f)[0])`, which is fine for inline replaces but would throw
  if a block widget were added.
- The reason: vertical structure has to be computable from the state alone, before the viewport is known, so that the
  height map covers off-screen text.

| Need | Use | Seen in |
|---|---|---|
| Hide/reveal inline marks, line classes, inline widgets, all selection-dependent | ViewPlugin over `visibleRanges` | ixora (all plugins) |
| Block widgets (image preview, rendered table, math, HTML) | StateField + `decorations.from` | ixora image/html, ink-mde images/katex |
| Replace that spans lines (collapse a fence line, render a whole table instead of its source) | StateField | none (both avoid it) |
| Permanently replaced text | either, plus `EditorView.atomicRanges` | ink-mde lists |
| Data derived from the whole doc (slugs, outline) | StateField, or compute lazily | ixora `headingSlugField` |

A StateField sees `tr.selection`, so selection-dependent block widgets are possible: ixora's `htmlBlock` hides the preview
while the caret is inside. The cost is that the field reruns on every transaction, unless it limits work to the changed
ranges. ink-mde's `nodeDecorator({optimize: true})` maps the old set and re-decorates only nodes overlapping
`iterChangedRanges`. Its example notes that without `eq`, a full rebuild redraws every widget (`examples/plugins.tsx`).
Two caveats:

- Structural edits change meaning far from the edited range (typing ` ``` ` re-parses everything below), so incremental
  mode can keep stale decorations.
- `RangeSet.of(ranges)` needs `from` + `startSide` order, and the kit sorts only by `from`. Use `Decoration.set(r, true)`.

## 9. Update triggers and performance

| Plugin | Recomputes on | Scope | Issue |
|---|---|---|---|
| ixora ViewPlugins (×8) | doc / viewport / selection | visible ranges | 8 separate tree walks per update (TODO.md: "Move all line decorations into a single plugin"). **No parse-progress trigger** |
| ixora `headingSlugField`, `imagePreview` | docChanged | **whole document** each keystroke | also miss parse progress, so slugs and images can be incomplete on open |
| ixora `htmlBlock` | doc or any selection | whole doc + DOMPurify per block | heavy on caret moves |
| ink-mde `lists` (3 fields) | **every transaction** | whole document ×3 | combined with widgets lacking `eq`: DOM churn on every caret move |
| ink-mde `blockquote`/`code` | every update (the decorations getter recomputes) | visible lines, one tree walk **per line** | O(lines × depth) |
| ink-mde dispatch hook | every transaction | `transaction.newDoc.toString()` even for selection-only transactions (`view.ts` L12) | O(doc) per caret move |

**CM background parsing**, checked in `@codemirror/language` `dist/index.js` L520-640:

- Only the first 3000 chars (`Work.InitViewport`) are parsed synchronously when a state is created, with a 20 ms budget
  per applied transaction (`Work.Apply`).
- The rest is parsed in idle slices: at most 100 ms (minimum 25), 100–500 ms pauses, 3000 ms of budget per 30 s, and up to
  100,000 chars ahead of the viewport.
- Progress arrives as a transaction carrying only `Language.setState`, with **no doc, viewport or selection change**. A
  ViewPlugin must also compare `syntaxTree(update.startState) !== syntaxTree(update.state)`. A StateField should do the
  same check on `tr.startState`.
- For the outline or export, use `ensureSyntaxTree(state, upto, timeoutMs)` (default 50 ms), or a cheap line scan for
  `^#{1,6}\s` that ignores fenced code.

**Recommendations**:

- Use **one** live-preview ViewPlugin that does a single pass over the visible tree and emits inline hides, line classes
  and inline widgets together.
- Keep block widgets in one StateField that maps cheaply on selection-only transactions.
- Never stringify the doc per transaction. Mark the note dirty and call `doc.toString()` only in the debounced save.
- Avoid `toTree()`/`JSON.stringify` in hot paths.

## 10. IME / composition (Korean)

- **CM internals** (view `dist/index.js` ~L4685-4720, ~L5310-5330):
  - Key events are ignored while composing.
  - On desktop Safari, a key event within 100 ms after `compositionend` is also ignored, because Safari can fire Enter's
    keydown *after* compositionend. Tauri on macOS runs WKWebView, which is the Safari engine.
  - CM keeps the composition's DOM text node intact while it redraws around it.
  - EditContext is used only on Android Chrome (~L7214), so Windows WebView2 takes the classic contenteditable path.
  - Result: keymap commands such as Enter list continuation are safe during Hangul composition.
- **Composition fixes in `@codemirror/view` CHANGELOG**, all in exactly the areas a live-preview editor stresses:

  | Version | Fix |
  |---|---|
  | 6.25.0 | temporary widget after non-inclusive marks |
  | 6.39.6 | composing on a decoration boundary garbled the following text |
  | 6.39.9 | composition next to widgets interrupted |
  | 6.39.16 | changing decorations right before a composition corrupted the DOM |
  | 6.43.1 | widget reuse near composition, for Safari |
  | 6.43.12 | mark DOM around an active composition |

  **Pin ≥ 6.43.12.**
- **Library gaps**: neither library checks `view.composing`. ink-mde's search input handles Enter on keydown with no
  composition guard (`extensions/search.tsx` L30-42). Confirming a Hangul syllable with Enter would therefore jump to the
  next match.
- **mininote rules**:
  - Every custom input (find, rename, quick switcher, settings) ignores Enter/Escape when `e.isComposing`,
    `keyCode === 229`, or within ~100 ms after `compositionend` on WebKit.
  - In the live-preview plugin, while `update.view.composing`, map the existing decorations through `update.changes`
    instead of rebuilding toggles near the caret.
  - Run one fresh recompute after `compositionend`: use a DOM event handler that dispatches an empty effect.
  - Prefer replacements that keep width, so reveal/hide right before typing does not move the composition target.

## 11. Markdown flavor and custom syntax

- **Base choice**: `markdownLanguage` adds Subscript (`~x~`), Superscript (`^x^`) and Emoji (`:smile:`), which Obsidian
  users will not expect. A `commonmark + GFM + custom` parser avoids surprises. Commands still work (§3).
- **Inline parser builder** (ink-mde `lib/codemirror-kit/markdown.ts` L37-110):
  - It checks the first char code quickly, then the remaining prefix chars, then runs a regex on the rest of the line.
    It emits `Name` with `NameMark` children (start/end marks) and gives every node a fresh `Tag` (plus
    `processingInstruction` for marks) for styling.
  - **Bug:** it reads `inlineContext.text.charCodeAt(position + i + 1)` using an *absolute* document position. Lezer
    `InlineContext.text` is section-relative (`char(pos)` subtracts `offset`; lezer `dist/index.js` L1670-1679). Any
    multi-character prefix such as `[[` is therefore compared against the wrong characters unless the paragraph starts at
    document offset 0.
  - Use `cx.char(pos)` / `cx.slice(from, to)`.
- **Delimiter-style syntax** (`==highlight==`): copy the approach of lezer's built-in Strikethrough (lezer `dist/index.js`
  L2063-2089). It registers a delimiter with `cx.addDelimiter(type, from, to, canOpen, canClose)`, using left/right
  flanking rules for whitespace and punctuation. Emphasis-style nesting and unmatched delimiters then just work. Regex
  scanning, as in ink-mde's `$…$` (`grammar.ts` L14-66), produces false positives such as `$5 and $10`.
- **Wikilinks**: register before `Link` so `[[` is consumed before the shortcut-link rule (§3). Emit
  target/alias/heading sub-nodes so hiding can reveal only the alias.
- **Block constructs**:
  - ixora's frontmatter parser triggers only at `lineStart === 0` with `^---\s*$`. It **assumes 4-char fences**
    (`---\n`), breaks on trailing spaces, and crashes when unclosed, because `end` stays undefined (`frontmatter.ts`
    L39-62). It also creates a new YAML `StreamLanguage` inside every `wrap` callback (L29).
  - `@codemirror/lang-yaml` ≥ 6.1 ships `yamlFrontmatter({content})`, which wraps the markdown language in a
    frontmatter-aware top-level language (nodes `FrontmatterContent`/`Body`). It is cleaner, but the top node is no longer
    `Document`.
  - Either way, handle unclosed blocks by ending at document end and still emitting a node.

## 12. Editing behaviors around the decorations

- **List/quote continuation** comes free with lang-markdown (`addKeymap` defaults to true, `Prec.high`; lang-markdown
  L196-296, L350-400):
  - **Enter on an item** continues the marker. It increments and renumbers following ordered items, continues `- [ ]`
    with the box unchecked, and continues `>`.
  - **Enter on an empty item** removes one level, or re-adds the parent level's marker. A tight two-item list becomes
    loose. Two empty quote lines exit the quote. Nothing happens inside fenced code or with a non-empty selection.
  - **Backspace right after markup** first turns a list marker into spaces, then removes the indentation.
- **Paste a URL over a plain-text selection → `[sel](url)`** (`pasteURLAsLink`, default on; `www.` gets `https://`).
  It refuses when the selection crosses nodes or sits in code, links, etc.
- **Heading folds**: `headerIndent` is a fold service that folds from a heading to the next heading of the same or higher
  level.
- **Tab** (ink-mde `extensions/indentWithTab.ts`, on by default, with a TODO citing CM's accessibility guidance):
  `indentMore`/`indentLess`. The indent unit must match CommonMark nesting. Under `1. ` a child needs 3+ columns, so a
  2-space unit mis-nests. lang-markdown normalises to tabs when `indentUnit` is `"\t"`.
- **Format toggles** (ink-mde `src/api/format.ts`):
  - Inline formats expand an empty selection to `state.wordAt()` and un-wrap when the selection is inside a node of that
    type.
  - The heading command cycles `# ` → … → `###### ` → none.
  - Line formats (quote, list, task) apply to every selected line.
  - Single-cursor only.
- **Find** (ink-mde `extensions/search.tsx`):
  - The CM search panel is replaced by a single unlabeled input pinned top-right (`top: true`). Enter goes to the next
    match, Shift+Enter to the previous, and `runScopeHandlers(view, e, 'search-panel')` handles Escape etc.
    `test/e2e/core/search.spec.ts` asserts focus on Mod-F and match navigation.
  - The input carries `attr:main-field` instead of `main-field`, so CM's re-focus on a second Mod-F cannot find it.
  - There is no `update()` hook to reflect external query changes.
  - There is no IME guard (§10).
- **Paste/drop files** (ink-mde `ui/components/drop_zone/index.tsx`):
  - Document-level drag listeners use a **depth counter** so nested dragenter/dragleave pairs do not flicker the overlay.
  - Pasted or dropped `FileList`s go to a user handler that returns a URL, and `![](url)` is inserted at the selection.
  - Pitfalls:
    - `URL.createObjectURL` previews are never revoked.
    - The overlay shows text ("drop files here", "uploading files...").
    - Inserted markup has empty alt text and does not escape spaces.
  - For mininote, use `EditorView.domEventHandlers({paste, drop})`, write bytes via Rust, and insert an encoded relative
    path.

## 13. Document lifecycle and configuration

- **`load(doc)`** builds a fresh `EditorState` and calls `view.setState()`, which resets undo history and selection.
  **`update(doc)`** dispatches one change replacing `0..length` (`src/api/load.ts`, `src/api/update.ts`). Switching notes
  should use a fresh state, or a cached state per open note so undo survives tab switches. An external-change reload
  should apply a minimal diff instead of replacing the whole doc, which would destroy cursor and scroll.
- **Async work queue** (`src/utils/queue.ts`): lazy extension loading, `load` and `reconfigure` are serialized, so a doc
  load cannot interleave with a half-applied reconfiguration.
- **Compartments** (`src/extensions.ts` L25-51): one per feature, with a resolver that reads the current options.
  Settings changes become `compartment.reconfigure()` effects without recreating the view, and the markdown grammar
  itself can be reconfigured live (`test/e2e/plugins/grammar.spec.ts`).
- **Svelte wrapper** (`svelte/src/lib/InkMde.svelte`): two-way `value` binding that compares against `getDoc()` before
  pushing, to avoid loops. Two flaws: it stringifies the doc on every reactive run, and it skips empty strings (a falsy
  guard). With Svelte 5 runes, keep the `EditorView` out of deep reactivity and treat the CM state as the source of truth.
- **Defaults worth noting** (`src/store.ts` L11-77): spellcheck on, search on, Tab trapping on, lists/images/toolbar off,
  attribution footer on. Our UI should have no footer or placeholder text.

## 14. Typography, theming and block spacing

- **Theme through CSS variables**: every colour and size in ink-mde's HighlightStyle and `cm-line` CSS is a
  `var(--ink-internal-*)`. These fall back to `var(--ink-*, default)`, with separate light values (`src/ui/utils.ts`
  L33-122), and a `prefers-color-scheme` listener reconfigures the editor. A grey/white palette plus dark variant is then
  only a matter of variables.
- **ink-mde defaults**:
  - `--ink-editor-line-height: 2em`, editor and block padding 0.5rem, radius 0.25rem, block max-height 20rem.
  - Code font `'Monaco', Courier, monospace`. Headings 1.6–1.1 em at weight 600.
  - Wrapped lines use `white-space: pre-wrap; word-break: break-word`. Code and quotes use `break-all` (`styles.css`
    L141-176).
  - For Hangul prose, `word-break: keep-all` with `overflow-wrap: anywhere` keeps eojeol intact.
- **How block spacing is defined**: neither library defines inter-block spacing. Spacing comes from the raw blank source
  lines, each a full `.cm-line`. ink-mde only pads the first and last line of quotes and code via the `-open`/`-close`
  classes, and pads image containers.
- **Margins are invisible to CM's height map**:
  - CM measures each line and block element with `getBoundingClientRect().height` (view `dist/index.js` ~L3346-3390).
    Margins between top-level lines are not measured, which gives wrong click mapping and scroll jumps.
  - Inside a **block wrapper**, the gap between the wrapper box and its first and last child *is* added to the lines
    (`spaceAbove` logic). Spacing should therefore be padding on lines or wrappers, never margin.
- **Two editor-side options for sibling-pair spacing** (matching `* + *` / `h2 + p` in the reading view):
  1. In the single live-preview pass, add a class to each block's **first line** describing its own type and its previous
     sibling's type (e.g. `mn-h2 mn-after-p`, via `node.prevSibling`). CSS then sets `padding-top` per pair.
  2. Use `EditorView.blockWrappers` (CM ≥ 6.39; `rank` since 6.43). Wrap each top-level block in an element and define
     pair spacing with padding on adjacent wrappers.
  - In both cases, decide what blank separator lines do: keep them at full height (Obsidian), or give them a
    reduced-height class while keeping them clickable.

## 15. Consolidated bugs and edge cases (avoid these)

| # | Where | Problem |
|---|---|---|
| 1 | ixora `heading.ts` L57 | `to+1` hide range crosses the newline for `# Title #` / `#` → RangeError in a ViewPlugin |
| 2 | ixora `hide-mark.ts` L50-55 | inclusive nesting test treats adjacent siblings as nested; second element's marks never hidden |
| 3 | ixora `link.ts` L78-91 | autolink URL text hidden (only 🔗 left); reference definitions lose their URL; global-regex `.test()` |
| 4 | ixora `image.ts` L40-43 | hiding plugin ignores `viewportChanged` |
| 5 | ixora `state/image.ts` L164-168, `html.ts` L79-81 | `eq` via JSON including positions → rebuild/reload on unrelated edits |
| 6 | ixora `list.ts` L63-73, L130-153 | widgets without `eq`; checkbox stores a build-time position and mutates itself |
| 7 | ixora `blockquote.ts` L18, L70-78 | regex on raw text instead of QuoteMark nodes; border span not drawn on wrapped rows |
| 8 | ixora `code-block.ts` L49-60 | begin/end decided from viewport lines |
| 9 | ixora `util.ts` L110-113 | slug regex `[^\w-]` without `u` deletes Hangul → empty slugs for Korean headings |
| 10 | ixora `frontmatter.ts` L44-57 | fixed 4-char fence math; unclosed fence → undefined `end` |
| 11 | ixora all ViewPlugins | no `syntaxTree` change check → stale decorations while background parsing |
| 12 | ink-mde `view.ts` L12 | `newDoc.toString()` on every transaction |
| 13 | ink-mde `lists.ts` L189-195 | full-doc rebuild on every transaction, ×3 fields; spacer/dot/number widgets lack `eq` |
| 14 | ink-mde `lists.ts` L9, L123-131 | indentation assumed in 2-char units (tabs, 3-space ordered nesting); `+` bullets and `[X]` unsupported |
| 15 | ink-mde `markdown.ts` (kit) L58 | absolute position used as a string index into `InlineContext.text` |
| 16 | ink-mde `katex/grammar.ts` L87-133 | unclosed `$$` swallows the rest of the document without a node |
| 17 | ink-mde `decorations.ts` L159-161, L203-205 | ranges sorted by `from` only before `RangeSet.of` |
| 18 | ink-mde `search.tsx` L23, L30-42 | `attr:main-field` attribute typo; Enter handled during IME composition |
| 19 | ink-mde `utils/readability.ts` L54-62 | word count strips non-ASCII → Korean text counts as 0 words |
| 20 | ink-mde `drop_zone/index.tsx` L128 | object URLs never revoked |

## 16. Recommended live-preview architecture for mininote

1. **Parser**: `markdown({ base: commonmark+GFM, extensions: [highlight (delimiter), wikilink (before Link),
   frontmatter] })`. Keep lang-markdown's keymap, `pasteURLAsLink` and heading fold service. Set `codeLanguages` from
   `@codemirror/language-data` so code languages load lazily.
2. **One `livePreview` ViewPlugin**:
   - It does a single pass over `visibleRanges` and produces:
     - inline mark hides for emphasis, strong, strike, code, highlight, link brackets/URL, wikilink brackets and escapes;
     - line classes for headings with level, quote lines, code lines with first/last flags from document lines, HR, and
       block-pair spacing classes;
     - inline widgets: a same-width bullet and an `eq`-stable checkbox toggled via `posAtDOM`.
   - Recompute on doc, viewport, selection or syntax-tree change.
   - While `view.composing`, map the existing decorations instead of rebuilding.
3. **One `blockPreview` StateField** for images, and later tables and math:
   - Block widgets come from `decorations.from(field)`, with positions-free `eq` and `estimatedHeight`.
   - Call `requestMeasure()` after async loads.
   - On selection-only transactions it should just map, unless the reveal state of a block actually flips.
4. **Atomic ranges** for anything replaced while the caret might stand next to it (bullets, spacer indents), exposed from
   the plugin's decoration set.
5. **Reveal policy** (Obsidian-like):
   - Inline elements reveal when touched, inclusive at both ends.
   - Headings reveal their `#` per line.
   - Quotes reveal per line rather than per block, which avoids ixora's big jumps.
   - Fences reveal per block.
   - Images show the source only while the caret is inside the syntax.
6. **CSS**:
   - Use `em`-based heading sizes on line classes, and padding-only vertical rhythm.
   - The hanging indent for list lines goes through a CSS variable.
   - Use `word-break: keep-all` for Hangul.
   - Use CSS variables for the gray/white light and dark palettes.
7. **IME and lifecycle**:
   - Add composition guards on every non-CM input.
   - Keep an `EditorState` per open note.
   - Read `doc.toString()` only in the debounced save.
   - Reload external changes through a minimal diff transaction tagged with an annotation, so autosave can ignore it.
