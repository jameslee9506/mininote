Mininote's UI should feel like a sheet of paper with a quiet gray margin. Every rule below exists to keep it that way.

## 1. Principles

1. **Monotone.** Every color is a gray from `src/styles/tokens.css`. There is no accent color. Emphasis comes from weight, size, and contrast, never from hue. That includes links, selection, focus, and "danger" actions. There are three exceptions. The text of a code file (§6) has syntax colors, which are content, not chrome. The "Color" icon set (§4) tints the tree's folders: a hue the user chooses, where the default set is gray. And the reason a name was refused, under the inline title (§4), is red: it stands where the date does, in the same small type, and must not read as one. A PDF's pages (§7) show whatever colors the document has; the app's own marks on them stay gray.
2. **No unnecessary text.** No visible labels on toolbars, no "Saved" indicator, no status bar, no placeholder copy unless the input would otherwise be unusable. The one placeholder that is content is a new note's name in its title (§4). Icons carry `aria-label`, not visible captions or `title` tooltips. Text appears only where it *is* the content: note names, document text, settings labels, confirmations, and errors.
3. **Content first.** The document column is centered with a readable measure (`--content-max`, 720px by default). Chrome recedes: icons sit at `--c-text-faint` and only darken on hover or focus.
4. **Quiet motion.** Only short fades or background transitions (`--dur-fast`, `--dur`). No sliding panels, no bouncing, no skeleton shimmer.
5. **Native feel.** System fonts with Korean fallbacks (Apple SD Gothic Neo, Malgun Gothic, Noto Sans KR); the document's text and headings can take other families (SET-09). On macOS the window uses an overlay title bar with hidden title, so the sidebar header doubles as the drag region and the traffic lights sit inside it.

## 2. Tokens

`src/styles/tokens.css` defines every variable. Components must not hard-code colors, font sizes, or radii.

| Group | Variables |
|---|---|
| Surfaces | `--c-bg` (editor), `--c-bg-alt` (sidebar), `--c-bg-elev` (menus/modals), `--c-bg-hover`, `--c-bg-active`, `--c-bg-code`, `--c-bg-mark` |
| Lines | `--c-border`, `--c-border-strong` |
| Text | `--c-text-strong` > `--c-text` > `--c-text-muted` > `--c-text-faint`; `--c-error`, the red of a refused name under the inline title and of nothing else (§4) |
| Tree icons | `--c-icon-tree` (row icons, between muted and faint text), `--c-icon-folder` (a solid folder, a step stronger), `--c-icon-folder-tint` (a solid folder of the "Color" set, the one hue in the chrome). The icon set in use resolves them to `--tree-folder` and `--tree-folder-fill` (§4) |
| Interaction | `--c-selection`, `--c-caret`, `--c-focus`, `--shadow-elev` |
| Syntax | `--c-syn-*`: the colors of code files, and of nothing else (§6) |
| PDF pages | `--c-pdf-*`: the grays drawn on a PDF's pages (the page itself, selection, find matches, a link under the pointer, a note's text box). One value for both themes, because a page is paper in either (§7) |
| Type | `--font-text` (the system's font: the chrome, and the document by default), `--font-serif` (the system's classic serif, with Myeongjo for Hangul), `--font-content` (the text font, a user setting), `--font-heading` (the heading font, a user setting; the text font by default), `--font-h1…h4` (the font of each of h1 to h4: the heading font for the levels the settings give it, else the text font), `--font-mono` (the code font, a user setting, in front of `--font-mono-default`), `--fs-content` (15px, user setting), `--lh-content` 1.7, `--fs-h1…h6`, `--fs-code`, `--fs-ui` 13px, `--fs-tree-folder` 14px, `--fs-ui-small` 12px |
| Markdown components | `--md-list-indent`, `--md-quote-bar`, `--md-quote-step`, `--md-code-lh`, `--md-code-pad-x`, `--md-code-pad-y`, `--md-task-size`, `--md-task-gap`, `--md-cell-pad`: every measure both views draw (§5) |
| Code view | `--code-max`, `--code-gutter-gap`, `--code-gutter-edge` (§6) |
| PDF view | `--pdf-panel-width` 168px, `--pdf-thumb-width` 108px (§7) |
| Layout | `--sidebar-width`, `--header-h` 40px, `--pane-width`, `--content-max`, `--content-pad-x`, `--inline-title-gap` 24px, `--row-h` 28px, `--tree-pad-x` 10px, `--tree-icon-gap` 6px, `--indent` 16px, `--icon` 16px, radii |

Dark mode swaps the same variable names, either through `:root[data-theme="dark"]` or through `prefers-color-scheme` when the theme is "system". Nothing else needs to know about themes; CodeMirror's theme also reads the variables.

### Type scale (base 15px)

| Element | Size | Line height | Weight |
|---|---|---|---|
| body / p / li | 15px (`--fs-content`) | 1.7 | 400 |
| h1 | ×1.8667 ≈ 28px | 1.3 | 600 |
| h2 | ×1.6 ≈ 24px | 1.3 | 600 |
| h3 | ×1.2 ≈ 18px | 1.3 | 600 |
| h4 | 15px | 1.3 | 600 |
| h5 | ×0.94 ≈ 14.1px | 1.3 | 600 |
| h6 | ×0.88 ≈ 13.2px, `--c-text-muted` | 1.3 | 600 |
| code (inline and block) | ×0.88 ≈ 13.2px mono | block 1.55 | 400 |
| UI (tree, menus, inputs) | 13px | 1.4 | 400 (active file 500) |
| Tree folders (including rename inputs) | 14px (`--fs-tree-folder`) | 1.4 | 400 |

The document's text is set in `--font-content`, and each of h1 to h4 in its `--font-h1…h4`: `--font-heading` for the levels the settings give the heading font, h1 and h2 until changed, and the text font for the others (SET-09). The inline title takes h1's font; h5 and h6 always stay in the text font. The text and heading fonts are the system's font until the settings choose others. The chrome stays in `--font-text`.

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
| Sidebar | `--c-bg-alt` background, 1px `--c-border` right edge, resizable 180–480px. Header (40px) is the drag region with faint icon buttons (new note, new folder, collapse all folders). Below it the search field (a `.field`, always shown, with a faint magnifier at the left where the tree's icons sit and a faint × while it holds text), then the file tree; while the field holds a query, the search results take the tree's place, and Escape or the × clears it. Footer holds the vault name after a bound notebook icon (`--fs-ui-small`, muted; opens the vault menu) and a settings gear. |
| Tree row | `--row-h` 28px, `padding-left: --tree-pad-x + depth × --indent`, `padding-right: --tree-pad-x`. Every row starts with a 16px icon, `--tree-icon-gap` before the name: a folder that switches between closed and open, drawn as the icon set says (next row), and in `--c-icon-tree` a page for notes, a picture for images, a page with a label across it for PDFs, a page with angle brackets for code files, a blank page for any other file. Folders use `--fs-tree-folder` 14px, files `--fs-ui` 13px. Hover `--c-bg-hover`, selected `--c-bg-active`, open note at weight 500 in `--c-text-strong`. Notes show without ".md". Code files and PDFs show their full name in `--c-text`, like notes: they open as documents. Images and unsupported files show theirs in `--c-text-muted`. |
| Icon sets | A setting (SET-08) decides how a tree row draws its folder, so that folders and files differ at a glance. **Outline**: the folder in outline, in `--c-icon-tree` like the files. **Filled**, the default: a solid folder in `--c-icon-folder`. **Color**: a solid folder in `--c-icon-folder-tint`. Files are the same outline icons in every set. A solid closed folder is filled whole; an open one keeps its back as a line and fills only the front flap. The set is the `data-icons` attribute on `<html>`, which `tokens.css` turns into `--tree-folder` (the color) and `--tree-folder-fill`. Folders on buttons (new folder, open folder) stay in outline. |
| Tree guide lines | An open folder is joined to its children by straight 1px `--c-border-strong` lines with square corners, no curves or dashes. A vertical line starts right under the folder's icon and runs down its icon's middle; each child gets a horizontal arm at the row's middle that stops 1px before its icon (├, or └ for the last child). Top-level rows have no line to the root. A dragged row dims its item, not the lines. |
| Inline rename | The row text becomes an input at the same position and size, with a 1px `--c-border-strong` outline and no layout shift. |
| Main top strip | 40px drag region. Faint icons: sidebar toggle (always shown, so the mouse can hide and show the sidebar), back/forward, reading-view toggle; a faint lock when the note is read-only, and for every code file (§6). For a note or a code file, a copy icon (two sheets) stands left of the view toggle, or last in the strip for a code file: it copies the file's whole text, becomes a check for 1.5s once it has, and is disabled while the file is empty. Only while a newer release is known, the update button sits left of those two: a muted download-tray icon (`--c-text-muted`, one step past the faint chrome) that becomes the whole download percentage (`--fs-ui-small`, tabular numerals) while it downloads, turns faint while it installs or restarts, and becomes a clockwise arrow when only the restart is left. No badge, no text. For a PDF the strip carries the PDF's controls between the navigation icons and the update button (§7). |
| Welcome screen | A centered open-folder icon button over the names of the recent vaults. The update button, when there is one, sits in the top-right corner of the 40px strip, where the main strip keeps it once a vault opens. |
| Inline title | `--font-h1` at `--fs-h1`, weight 600, `--c-text-strong`, aligned with the content column. Under it, on macOS and Windows, the day the note or code file was created: one `--c-text-muted` line at `--fs-ui`, the system's long date ("November 22, 2026") with no label; a virtual note shows today. Fixed `--inline-title-gap` 24px from the last of them to the body, independent of the content font size. A new note's name is a placeholder in `--c-text-faint` until something is typed in the note (TREE-04). A refused name gets its reason on the date's line, in `--c-error` at the same size, one line cut with an ellipsis; where no date shows, the reason hangs in the gap, so the text below never moves. |
| Editor column | `max-width: var(--content-max)`, centered, horizontal padding `--content-pad-x`, bottom padding `--content-pad-bottom`. A code file gets a wider column (§6). The horizontal padding follows `--pane-width`, the window's width less a sidebar standing beside the document: 48px from an 840px pane up, 16px from 680px down, and a straight line between (a fifth of the pane, less 120px), so a narrowing pane takes from the padding as well as from the text. |
| Unsupported file | Below the inline title, 12vh down and centered: the blank-page icon in `--c-text-faint` over one `--c-text-muted` line at `--fs-ui` that names the extension ("“.zip” files aren’t supported."; a name without one gets "This file type isn’t supported."). Nothing else. |
| Modal (switcher, palette) | 560px wide, 14vh from top, `--c-bg-elev`, `--radius-l`, `--shadow-elev`, no backdrop tint (clicking outside closes it). Input is 44px tall at 15px with no border, separated from results by a 1px `--c-border`. Result rows are 32px. The selected row is `--c-bg-active`. Matched characters are `--c-text-strong` weight 600. Folder path is muted on the right. |
| Settings modal | 520px wide. A 44px strip of three tabs named in text (General, Appearance, Shortcuts) over a 1px `--c-border`: 28px tabs at `--fs-ui`, `--c-text-muted` and `--c-text` under the pointer, the open one `--c-bg-active` in `--c-text-strong`, the first tab's name on the line of the labels below. The page under the strip scrolls on its own and takes the height of its rows. General and Appearance: label left and control right, rows 40px. Controls are segmented controls (the theme by name; the icon set by a sample, each segment showing that set's folder and note in the tree's colors, with the set's name as its `aria-label`), a stepper (font size), switches (toggles), and selects (locations, the three fonts). A font select lists "Default", the generic choices ("Serif", and "Sans-serif" for the heading font), the installed families and "Custom", which adds a sub-row with a field for a family name, like the attachment folder's; a refused name gets a dashed border. A sub-row belongs to the row above it and hangs from it as a folder's children do in the tree: a straight 1px `--c-border-strong` line drops from the foot of that row's label, 5px in, and each sub-row gets an arm at its middle (├, or └ for the last) that stops 4px before its content, 22px in; its label is `--c-text-muted`. While the heading font is not "Default", four 32px sub-rows under it, H1 to H4, each hold a checkbox before the level's name: a 14px square with a 1px `--c-border-strong` border like a task's box, filled `--c-text-strong` with a `--c-bg` check when checked. The whole row toggles it. On macOS a switch installs and removes the terminal command: it shows what is installed, so it moves only once that is done, and stays where it was when the system's password prompt is declined. A quiet last row of General shows the app version: label and value both muted at `--fs-ui-small`. The Shortcuts tab is the shortcut list, its rows on the same line as the other tabs' first row. |
| Shortcut row | Command name left; on the right, one 24px key chip per key (1px `--c-border-strong`, `--radius-s`, `--fs-ui-small`, a faint × to remove), a faint "+" and a faint ↺ that keeps its place but shows only when the keys differ from the defaults. While "+" listens it becomes a dashed slot that shows the held modifiers. The general and editor groups are split by a 1px `--c-border`. No descriptions, no hints. |
| Context menu | Min width 180px, `--c-bg-elev`, `--radius-m`, `--shadow-elev`, 4px padding, 28px items, 1px separators. Commands use plain text labels. Each recent vault in the sidebar menu has a 16px bound notebook icon in `--c-text-muted`, with `--tree-icon-gap` before its name, and at its far edge a 20px button, 4px in, with a 12px ×: `--c-text-faint`, and `--c-text` on `--c-bg-hover` under the pointer. The × shows only in the highlighted row and keeps its room in the others, so no name moves. An item with a submenu ends in a `--c-text-faint` chevron. The submenu is a second panel of the same make, 3px over the menu's edge, its first item level with its own. It appears and goes without motion, and its item stays `--c-bg-active` while it is open. |
| Toast | Errors only. Bottom-center, `--c-bg-elev`, `--fs-ui`, auto-dismisses after 4s. A name refused in the inline title is not a toast: its reason shows under the title. |
| Scrollbars | 10px, transparent track, `--c-scrollbar` thumb with 3px inset, `--c-scrollbar-hover` on hover. |
| Focus | `outline: 1px solid var(--c-focus); outline-offset: -1px`, only for `:focus-visible`. |

## 5. Markdown visuals (shared by reading view and live preview)

A construct is one component with one design, drawn twice: by `markdown.css` on rendered HTML and by `editor.css` on CodeMirror lines. Both take every shared measure from the `--md-*` tokens in `tokens.css` (list indent, quote bar and step, code line height and padding, checkbox size and gap, table cell padding), so the two views cannot drift apart. A change to a component's look goes into its token, never into one stylesheet. Each component also sets the size of the caret inside it: a heading's line carries the heading's font, a code line the code font, a blank line the body font.

Both views also read the same Markdown (ARCHITECTURE §10.1, §11): the same block dialect, so a line is a heading, a quote line or a list item in one view exactly when it is in the other. What stays different is what editing needs: blank lines are visible lines (§3.2), raw HTML is shown as written, and the syntax of the construct under the caret is revealed.

| Element | Treatment |
|---|---|
| Headings | Weight 600, `--c-text-strong`, `letter-spacing: -0.01em` for h1/h2. h1 to h4 each in its `--font-h1…h4`: the heading font for the levels checked in the settings, h1 and h2 by default, else the text font. h5 and h6 in the text font. No underline rules under h1/h2. |
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

## 6. Code view

A code file opens as a viewer in the document column (ARCHITECTURE §10.4): read, selected, copied and searched, never edited. It is the reading view's code block grown to a whole page, with the two things a page of code needs: line numbers and syntax colors.

| Part | Spec |
|---|---|
| Measure | The column takes the wider of the text measure (`--content-max`) and `--code-max`, 60 × `--fs-code`: about 100 columns. With the "Full" line width it is full too. |
| Text | `--font-mono` (the code font, SET-07) at `--fs-code`, line height `--md-code-lh`, on the page's own background: no box. Tab stops every 4 columns. |
| Long lines | They wrap. Later rows start under the line's own first character, up to 32 columns in, so the indentation still reads down the page. |
| Line numbers | `--c-text-faint`, tabular, right-aligned, `--code-gutter-gap` 12px before the code, no background or rule. They hang in the page margin, so the code's first column stands under the inline title. Where the margin is narrower than the numbers (a narrow window, a very long file), they keep `--code-gutter-edge` 4px from the edge and the code moves right. |
| Selection, find | As in the editor: `--c-selection`, the same find panel without its replace row. No caret, and the pointer is a text cursor. |
| Title, chrome | The inline title shows the full file name. In the top strip, a faint lock says that the view does not edit, as for a read-only note, and the copy icon copies the whole file (§4). |

**Syntax colors.** This is the one place with hue (§1): the colors are the content here. They are tokens like every other color, `--c-syn-*`, used by nothing but the code view's highlight style (`editor/code/highlight.ts`). The light values are the default highlight style of the editor component, unchanged; each dark value keeps its hue at a lightness that reads on `--c-bg`.

| Token | Marks | Light | Dark |
|---|---|---|---|
| `--c-syn-keyword` | keywords | `#770088` | `#c88be0` |
| `--c-syn-atom` | `true`, `null`, labels, URLs | `#221199` | `#8ea6f6` |
| `--c-syn-number` | numbers | `#116644` | `#7fc99a` |
| `--c-syn-string` | strings | `#aa1111` | `#e98c86` |
| `--c-syn-escape` | escapes, regular expressions | `#ee4400` | `#f0975c` |
| `--c-syn-def` | names where they are defined | `#0000ff` | `#62a9f1` |
| `--c-syn-local` | local and built-in names | `#3300aa` | `#b3a4f5` |
| `--c-syn-type` | types, tags | `#008855` | `#4fc9a4` |
| `--c-syn-class` | class names | `#116677` | `#5cb9c8` |
| `--c-syn-macro` | macros, special variables | `#225566` | `#86b9cc` |
| `--c-syn-property` | keys where they are defined | `#0000cc` | `#6ea7ee` |
| `--c-syn-comment` | comments | `#994400` | `#b48a62` |
| `--c-syn-meta` | annotations, preprocessor lines | `#404740` | `#9aa39a` |
| `--c-syn-invalid` | invalid text | `#ff0000` | `#ff6b6b` |

Everything else stays `--c-text`: plain names, operators and punctuation. Headings and emphasis in a Markdown source file take weight and slant, not color. Code blocks inside notes keep no syntax colors (§5).

## 7. PDF view

A PDF opens as a viewer that fills the pane below the top strip (ARCHITECTURE §10.5): read, searched and copied from, never edited. Its layout and its keys are those of Chrome's PDF viewer, which most people know; its chrome is this app's, in gray, with icons and no labels.

| Part | Spec |
|---|---|
| Ground | `--c-bg-alt`, the sidebar's gray, behind the pages. It scrolls in both directions; the pages are centered while they fit. |
| Pages | One under the other, about 10px apart, each on `--c-pdf-page` with a 1px `--c-border` hairline around it. No shadow. A page is paper: it stays white in dark mode, with whatever colors the document has. |
| Marks on a page | Selection `--c-pdf-selection`; every find match `--c-pdf-match` and the current one `--c-pdf-match-current`, with a 2px radius; a link under the pointer `--c-pdf-link-hover`; a note annotation's text box `--c-pdf-note` with a `--c-pdf-note-border` outline. All gray, and the same in both themes, since they lie on the page. |
| Toolbar | In the main strip (§4), three columns, the middle one centered. Left: the panel button (three bars; `--c-text` while the panel is open) and the file's full name in `--c-text-muted`, cut with an ellipsis. Middle: the page field and "/ N", a 1px `--c-border` divider, zoom out (−), the zoom field, zoom in (+), a divider, the fit button and the turn button. Nothing else: no download, no print, no menu. |
| Fields | Page and zoom: 24px high, 1px `--c-border`, `--radius-s`, `--fs-ui-small`, tabular numerals, centered, `--c-text-muted`; `--c-border-strong` and `--c-text` while focused, with the text selected. The page field is as wide as the page count's digits. Enter takes the value, Escape drops it. |
| Fit button | One button, as in Chrome: it shows the fit it will apply. A sheet with a vertical arrow fits the whole page; once that is applied it shows a sheet with a horizontal arrow, which fits the width. |
| Narrow pane | Under 400px of toolbar the name goes, under 300px the fit and turn buttons too. The page and zoom controls stay. |
| Side panel | `--pdf-panel-width` 168px at the left of the pages, `--c-bg-alt`, 1px `--c-border` at its right. Thumbnails: sheets `--pdf-thumb-width` 108px wide, 1px `--c-border` hairline, the page number under each in `--fs-ui-small` muted; the current page has a 2px `--c-text-muted` ring and its number at weight 500 in `--c-text-strong`. Outline: rows of `--row-h` at least, `--indent` per level, a faint chevron that turns a quarter when open, `--c-bg-hover` under the pointer. Two icon tabs above (four sheets, stepped lines) only when the document has an outline; the chosen one is `--c-bg-active`. |
| Find bar | The editor's find panel (ARCHITECTURE §10.3), for the pages: 8px from the top, at the right, clear of the scrollbar, `--c-bg-elev`, 1px `--c-border`, `--radius-m`, `--shadow-elev`. One borderless field, the count "3/12" in `--fs-ui-small` muted, then previous, next and close as icon buttons. The field's text turns `--c-text-faint` when nothing matches. |
| Password | For a protected document, 12vh down and centered: a faint lock over one field with the placeholder "Password". A refused password leaves the field with a dashed `--c-border-strong` border. |
| Nothing to show | A document that did not open leaves the ground with the faint PDF icon, 12vh down. The reason was the toast's. Nothing is shown while a document loads. |
