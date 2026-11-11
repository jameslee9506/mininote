# mininote — Design System

The UI should feel like a sheet of paper with a quiet gray margin. Every rule below exists to keep it that way.

## 1. Principles

1. **Monotone.** Every color is a gray from `src/styles/tokens.css`. There is no accent color. Emphasis comes from weight, size, and contrast, never from hue. That includes links, selection, focus, and "danger" actions.
2. **No unnecessary text.** No visible labels on toolbars, no "Saved" indicator, no status bar, no placeholder copy unless the input would otherwise be unusable. Icons carry `aria-label`, not visible captions or `title` tooltips. Text appears only where it *is* the content: note names, document text, settings labels, confirmations, and errors.
3. **Content first.** The document column is centered with a readable measure (`--content-max`, 720px by default). Chrome recedes: icons sit at `--c-text-faint` and only darken on hover or focus.
4. **Quiet motion.** Only short fades or background transitions (`--dur-fast`, `--dur`). No sliding panels, no bouncing, no skeleton shimmer.
5. **Native feel.** System fonts with Korean fallbacks (Apple SD Gothic Neo, Malgun Gothic, Noto Sans KR). On macOS the window uses an overlay title bar with hidden title, so the sidebar header doubles as the drag region and the traffic lights sit inside it.

## 2. Tokens

`src/styles/tokens.css` defines every variable. Components must not hard-code colors, font sizes, or radii.

| Group | Variables |
|---|---|
| Surfaces | `--c-bg` (editor), `--c-bg-alt` (sidebar), `--c-bg-elev` (menus/modals), `--c-bg-hover`, `--c-bg-active`, `--c-bg-code`, `--c-bg-mark` |
| Lines | `--c-border`, `--c-border-strong` |
| Text | `--c-text-strong` > `--c-text` > `--c-text-muted` > `--c-text-faint`; `--c-icon-tree` sits between the last two, for the tree's row icons |
| Interaction | `--c-selection`, `--c-caret`, `--c-focus`, `--shadow-elev` |
| Type | `--font-text`, `--font-mono`, `--fs-content` (15px, user setting), `--lh-content` 1.7, `--fs-h1…h6`, `--fs-code`, `--fs-ui` 13px, `--fs-tree-folder` 14px, `--fs-ui-small` 12px |
| Markdown components | `--md-list-indent`, `--md-quote-bar`, `--md-quote-step`, `--md-code-lh`, `--md-code-pad-x`, `--md-code-pad-y`, `--md-task-size`, `--md-task-gap`, `--md-cell-pad`: every measure both views draw (§5) |
| Layout | `--sidebar-width`, `--header-h` 40px, `--content-max`, `--content-pad-x`, `--inline-title-gap` 24px, `--row-h` 28px, `--tree-pad-x` 10px, `--tree-icon-gap` 6px, `--indent` 16px, `--icon` 16px, radii |

Dark mode swaps the same variable names, either through `:root[data-theme="dark"]` or through `prefers-color-scheme` when the theme is "system". Nothing else needs to know about themes; CodeMirror's theme also reads the variables.

### Type scale (base 15px)

| Element | Size | Line height | Weight |
|---|---|---|---|
| body / p / li | 15px (`--fs-content`) | 1.7 | 400 |
| h1 | ×1.6 ≈ 24px | 1.3 | 600 |
| h2 | ×1.36 ≈ 20.4px | 1.3 | 600 |
| h3 | ×1.16 ≈ 17.4px | 1.3 | 600 |
| h4 | 15px | 1.3 | 600 |
| h5 | ×0.94 ≈ 14.1px | 1.3 | 600 |
| h6 | ×0.88 ≈ 13.2px, `--c-text-muted` | 1.3 | 600 |
| code (inline and block) | ×0.88 ≈ 13.2px mono | block 1.55 | 400 |
| UI (tree, menus, inputs) | 13px | 1.4 | 400 (active file 500) |
| Tree folders (including rename inputs) | 14px (`--fs-tree-folder`) | 1.4 | 400 |

## 3. The spacing system: gaps between blocks

> **Rule:** a block never owns vertical margin. Space exists only *between* two adjacent blocks. The **pair** (previous, next) decides how much.

Per-element margins (`p { margin: 1em 0 }`, `h2 { margin-top: … }`) break at the edges in predictable ways:

- The first and last child leak margin into their container.
- Adjacent margins collapse.
- Margins escape through parents that have no padding.
- Nested blockquotes and lists stack spacing twice.
- Every `:first-child` / `:last-child` override adds another special case.

The sibling-pair model removes all of these problems at once.

### 3.1 Mechanics (reading view: `src/styles/markdown.css`)

1. **Reset.** Every block inside `.markdown` gets `margin: 0`.
2. **Flow containers.** These are `.markdown` itself plus every nested container that holds blocks: `blockquote`, `li`, `.callout-body`, `details`, `.footnotes`, `.footnotes li`. Only their **direct children** take part in flow.
3. **Pair rules.** Space is set *only* through `margin-top` on the second element of an adjacent pair: `CONTAINER > :where(A + B)`.
   - Every rule has the same specificity, so the cascade is plain source order: general rules first, specific pairs later.
   - The first child never matches `A + B`, so no leading space is possible.
   - Nothing ever sets `margin-bottom`, so margins never collapse or leak.
4. **Units.** Gaps are unitless multipliers of `--fs-content` and resolve to `calc(var(--fs-content) * var(--gap-…))`. This keeps an `h2`'s own font size from scaling the space above it the way `em` would.

| Pair (A + B) | Token | ≈ px @15 |
|---|---|---|
| any + any (default) | `--gap-block` 1 | 15 |
| any + h1 | `--gap-before-h1` 2.2 | 33 |
| any + h2 | `--gap-before-h2` 1.9 | 28.5 |
| any + h3 | `--gap-before-h3` 1.6 | 24 |
| any + h4/h5/h6 | `--gap-before-h4` 1.4 | 21 |
| any + hr, hr + any | `--gap-hr` 1.6 | 24 |
| heading + any | `--gap-after-heading` 0.5 | 7.5 |
| heading + heading | `--gap-heading-heading` 0.8 | 12 |
| li + li (tight list) | `--gap-item` 0.2 | 3 |
| li + li (list whose items hold blocks, `.has-blocks`) | `--gap-block` 1 | 15 |
| li + li (loose list, `.loose`) | `--gap-item-loose` 0.6 | 9 |
| li text + nested list | `--gap-nested` 0.2 | 3 |

Order inside the stylesheet: default, then before-headings, then hr, then after-heading, then heading + heading. The more specific pair always comes last.

**Lists.** markdown-it marks list tightness by hiding the paragraph tokens inside items. Our renderer adds a `loose` class to `<ul>`/`<ol>` when any item contains a visible paragraph, and a `has-blocks` class when an item holds a block such as a code fence, table, or quote (nested lists aside), so `:has()` is never needed. In a `has-blocks` list the next item gets the block gap, which keeps the space above and below such a block equal. Inside an `li`, the item's text and its nested list are a pair (`--gap-nested`).

**Wrappers.** Tables are wrapped in `<div class="table-wrap">` for horizontal scrolling. Pair rules use `*` for "any", so wrappers take part in flow like any other block.

### 3.2 Editor (live preview: `src/styles/editor.css`)

The editor is line-based, and its blank source lines are real, editable text. It still follows the pair model of §3.1, so two blocks with no blank line between them sit exactly as far apart as in the reading view:

- The live-preview plugin tags the first line of every block that has a block before it in its flow container (the document, a list item, a quote, or a list for its items) with `data-blk` (its type: `h1`…`h6`, `p`, `ul`, `ol`, `li`, `quote`, `code`, `table`, `hr`, `html`), `data-prev` (the previous block's type, or `fm` after frontmatter), `data-ctx` inside a container (`li`, `quote`, or `list`, `list-loose`, `list-blocks`: the renderer's list classes) and, as `--mn-blank`, the number of blank lines above it. Block widgets (images, tables) carry the same attributes.
- **A blank line is a body line.** It is as tall as a line of body text, its caret is a body caret, and it is never styled or shrunk. This is the one deliberate difference from the reading view, which drops blank lines: in the editor each one is a line the user can see and put the caret on.
- **A blank line stands where a paragraph would.** In the document and in a quote, the blank line right below a block carries that block's pair with a paragraph (the plugin tags it `data-blk="p"`): `--gap-after-heading` below a heading, `--gap-block` below a list, a quote or a code block. Text typed on it is that paragraph, so typing never moves the line; the layout changes only on structural keys such as Enter. There is no such gap below a paragraph, a table or an HTML block, where typed text joins the block, nor between list items or inside one, where a blank line belongs to whatever its own indentation says once it has text.
- `editor.css` resolves the pair gap with the rules of §3.1, in the same order, and gives the block's first line `padding-top: gap − blank lines × --lh-content − the first blank line's gap` (`data-lead`), never below 0 and never as a margin (CodeMirror measures padding, not margins). A gap is therefore never smaller than in the reading view, and every further blank line adds exactly one body line.
- An hr line is a text line with the rule drawn across its middle, so half a text line (`--lh-content / 2`) counts toward the gap on each side of it.
- Code boxes and widgets start below the pair padding, and so does the bar of a quote that starts on the line. The bars of quotes that began earlier run through it, as the reading view's border runs through the gaps inside a quote. Padding inside a box is internal and does not count as a gap.

**Gutters.** List lines get the reading view's 1.5em gutter per level: the measured width of the line's prefix (indentation, marker, task box, hidden quote marks) hangs for wrapped rows, and padding fills the rest, so the text sits at 1.5em × depth whatever the source indentation, and `10.` lands its text where `9.` does. The later lines of an item sit in the same gutter; verbatim blocks (code, HTML) give up only the item's content indent. Quote bars and code boxes nested in an item start at that gutter.

## 4. Components

| Component | Spec |
|---|---|
| Window | macOS: overlay title bar, hidden title, traffic lights inside the 40px sidebar header (`trafficLightPosition` aligned to its vertical center). Windows/Linux: native frame. |
| Sidebar | `--c-bg-alt` background, 1px `--c-border` right edge, resizable 180–480px. Header (40px) is the drag region with faint icon buttons (new note, new folder, collapse all folders). Below it the search field (a `.field`, always shown, with a faint magnifier at the left where the tree's icons sit and a faint × while it holds text), then the file tree; while the field holds a query, the search results take the tree's place, and Escape or the × clears it. Footer holds the vault name (`--fs-ui-small`, muted; opens the vault menu) and a settings gear. |
| Tree row | `--row-h` 28px, `padding-left: --tree-pad-x + depth × --indent`, `padding-right: --tree-pad-x`. Every row starts with a 16px `--c-icon-tree` icon, `--tree-icon-gap` before the name: a folder that switches between closed and open, a page for notes, a picture for images. Folders use `--fs-tree-folder` 14px, files `--fs-ui` 13px. Hover `--c-bg-hover`, selected `--c-bg-active`, open note at weight 500 in `--c-text-strong`. Notes show without ".md". Images show their full name in `--c-text-muted`. |
| Tree guide lines | An open folder is joined to its children by straight 1px `--c-border-strong` lines with square corners, no curves or dashes. A vertical line starts right under the folder's icon and runs down its icon's middle; each child gets a horizontal arm at the row's middle that stops 1px before its icon (├, or └ for the last child). Top-level rows have no line to the root. A dragged row dims its item, not the lines. |
| Inline rename | The row text becomes an input at the same position and size, with a 1px `--c-border-strong` outline and no layout shift. |
| Main top strip | 40px drag region. Faint icons: sidebar toggle (always shown, so the mouse can hide and show the sidebar), back/forward, reading-view toggle; a faint lock when the note is read-only. Only while a newer release is known, the update button sits left of the view toggle: a muted download-tray icon (`--c-text-muted`, one step past the faint chrome) that becomes the whole download percentage (`--fs-ui-small`, tabular numerals) while it downloads, turns faint while it installs or restarts, and becomes a clockwise arrow when only the restart is left. No badge, no text. |
| Welcome screen | A centered open-folder icon button over the names of the recent vaults. The update button, when there is one, sits in the top-right corner of the 40px strip, where the main strip keeps it once a vault opens. |
| Inline title | `--fs-h1`, weight 600, `--c-text-strong`, aligned with the content column. Fixed `--inline-title-gap` 24px to the body, independent of the content font size. |
| Editor column | `max-width: var(--content-max)`, centered, horizontal padding `--content-pad-x`, bottom padding `--content-pad-bottom`. |
| Modal (switcher, palette) | 560px wide, 14vh from top, `--c-bg-elev`, `--radius-l`, `--shadow-elev`, no backdrop tint (clicking outside closes it). Input is 44px tall at 15px with no border, separated from results by a 1px `--c-border`. Result rows are 32px. The selected row is `--c-bg-active`. Matched characters are `--c-text-strong` weight 600. Folder path is muted on the right. |
| Settings modal | 520px wide, label left and control right, rows 40px. Controls are a segmented control (theme), a stepper (font size), switches (toggles), and a select (locations). The "Shortcuts" row, with a faint chevron, swaps the panel to the shortcuts page: a 44px header (back chevron, the page name at weight 600) over a scrolling list. A quiet last row shows the app version: label and value both muted at `--fs-ui-small`. |
| Shortcut row | Command name left; on the right, one 24px key chip per key (1px `--c-border-strong`, `--radius-s`, `--fs-ui-small`, a faint × to remove), a faint "+" and a faint ↺ that keeps its place but shows only when the keys differ from the defaults. While "+" listens it becomes a dashed slot that shows the held modifiers. The general and editor groups are split by a 1px `--c-border`. No descriptions, no hints. |
| Context menu | Min width 180px, `--c-bg-elev`, `--radius-m`, `--shadow-elev`, 4px padding, 28px items, 1px separators. Text only: no icons, no shortcut hints. |
| Toast | Errors only. Bottom-center, `--c-bg-elev`, `--fs-ui`, auto-dismisses after 4s. |
| Scrollbars | 10px, transparent track, `--c-scrollbar` thumb with 3px inset, `--c-scrollbar-hover` on hover. |
| Focus | `outline: 1px solid var(--c-focus); outline-offset: -1px`, only for `:focus-visible`. |

## 5. Markdown visuals (shared by reading view and live preview)

A construct is one component with one design, drawn twice: by `markdown.css` on rendered HTML and by `editor.css` on CodeMirror lines. Both take every shared measure from the `--md-*` tokens in `tokens.css` (list indent, quote bar and step, code line height and padding, checkbox size and gap, table cell padding), so the two views cannot drift apart. A change to a component's look goes into its token, never into one stylesheet. Each component also sets the size of the caret inside it: a heading's line carries the heading's font, a code line the code font, a blank line the body font.

Both views also read the same Markdown (ARCHITECTURE §10.1, §11): the same block dialect, so a line is a heading, a quote line or a list item in one view exactly when it is in the other. What stays different is what editing needs: blank lines are visible lines (§3.2), raw HTML is shown as written, and the syntax of the construct under the caret is revealed.

| Element | Treatment |
|---|---|
| Headings | Weight 600, `--c-text-strong`, `letter-spacing: -0.01em` for h1/h2. No underline rules under h1/h2. |
| Links | `--c-text`, underline 1px `--c-border-strong` at 2px offset, darken on hover. Unresolved wikilinks use a dashed underline in `--c-text-muted`. |
| Inline code | `--c-bg-code` background, `--radius-s`, 0.1em 0.35em padding, `--fs-code` mono. |
| Code block | `--c-bg-code`, `--radius-m`, one code line (`--md-code-pad-y`: `--fs-code` × 1.55, the editor's fence lines) of padding above and below and 16px at the sides, for fenced and indented code alike, `--fs-code`, line height 1.55, long lines wrap, no syntax colors. The language shows as a faint label at the top right. |
| Blockquote | 2px `--c-border-strong` left bar, text 16px in per level, `--c-text-muted`. The bar is unbroken from the quote's first line to its last. |
| Lists | 1.5em indent per level. Bullets are the `•` glyph in `--c-text-faint`, one space before the text. Ordered numbers in `--c-text-muted`, ending one space before the text. Tasks show a 14px square checkbox (1px `--c-border-strong`, radius 3px) in place of the bullet or number, centered on the item's first line, 0.5em before the text. When checked, the box is filled `--c-text-muted` and the text becomes `--c-text-muted` with strike-through. |
| hr | 1px `--c-border`, no margin of its own (it gets `--gap-hr` from flow). |
| Table | Collapsed 1px `--c-border` borders, cells padded 6px 12px and top-aligned, header `--c-bg-code` at weight 600 in `--c-text-strong`, scrolls horizontally inside `.table-wrap`. |
| Image | `max-width: 100%`, `--radius-s`, block-level when alone in a paragraph. |
| `==mark==` | `--c-bg-mark` background, text color inherited. |
| Frontmatter | Shown as a muted monospace block, fences included (reading view: `<pre class="frontmatter">`; live preview: `cm-fm` lines in `--c-text-muted` mono). |
| Syntax marks (live preview, revealed) | `--c-text-faint`. |
