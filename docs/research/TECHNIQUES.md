# mininote — Implementation Techniques

This document describes how to build the hard parts of mininote in our stack: Tauri 2, Svelte 5, CodeMirror 6 and markdown-it. Each section gives the recommended approach and then the pitfalls the research found. Requirement IDs (for example `SAVE-06`) refer to [REQUIREMENTS.md](REQUIREMENTS.md).

**Citations.**
- `[SB §4.2]` means `silverbullet.md` §4.2.
- The other tags map the same way: ZT `zettlr.md`, MT `marktext.md`, MS `mdsilo.md`, CM `cm6-live-preview-libs.md`, OB `obsidian-baseline.md`, OT/WR `tauri-notes-discovery.md`.
- `[OB RN:vX]` is an Obsidian release note quoted in `obsidian-baseline.md`.
- **Verified** means the claim was checked against the package installed in `node_modules`. [critic] For Rust it means the crate source in the local cargo registry (`trash` 5.2, `notify` 8.2, `tauri-plugin-store` 2.5, `wry` 0.57, `tauri` 2.12).
- **[critic]** marks text that the adversarial completeness review (2026-11-08) added or changed. *Changed:* introduces a correction to earlier text.

The code sketches are written for mininote. Nothing is copied from the analyzed projects, some of which are GPL or AGPL.

---

## 0. Ground rules

- **Installed versions.** `@codemirror/view` 6.43.15. At least 6.43.12 is required, because the composition fixes near widgets and decorations landed in 6.39–6.43 [CM §10]. Also `@codemirror/lang-markdown` 6.5.2, `@lezer/markdown` 1.8.1, markdown-it 15.0.3, DOMPurify 3, and Tauri 2.12 with `notify` 8 and `notify-debouncer-full` 0.7.
- **Layering** [OB §1.3]:
  - Rust is the raw filesystem adapter: list, read, atomic write, rename, trash, watch and search.
  - TypeScript owns policy: autosave, conflict rules, link rules and naming.
  - Editor extensions reach app state only through `EditorHost`.
- **No new dependencies.** Nothing below needs one. Where a library would help (turndown, a diff library), the requirement is either deferred or solved with a small pure function we write ourselves.
- **Testable cores.** Every tricky rule ends in a pure function with a unit test (§13). Nothing here requires launching the app.
- [critic] **Never panic in Rust.** The release profile sets `panic = "abort"` (`Cargo.toml`), so any panic, even inside `spawn_blocking`, aborts the whole process and loses the text waiting to be saved. File, path and IPC-input code returns errors and never calls `unwrap` or `expect` on them. (Dropping `panic = "abort"` would let `spawn_blocking` report a `JoinError` instead; either way, input must not panic.)

---

## 1. Live preview in CodeMirror 6

### 1.1 Parser and keymap

```ts
markdown({
  base: commonmarkLanguage,
  extensions: [GFM, WikiLink, Highlight /* , CjkEmphasis (P1) */],
  addKeymap: false,         // our own Enter/Backspace bindings, below
  completeHTMLTags: false,  // no HTML-tag completion popups
})                          // pasteURLAsLink stays on (the default)

Prec.high(keymap.of([
  { key: "Enter", run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
  { key: "Backspace", run: deleteMarkupBackward },
]))
```

- **Use `commonmarkLanguage` + `GFM`, not `markdownLanguage`.** `markdownLanguage` also turns on Subscript, Superscript and Emoji [CM §3, §11].
  - Obsidian supports none of the three, and markdown-it would not render them, so the two views would disagree.
  - `~` and `^` are common in Korean text. Lezer's subscript rule needs only two tildes with no whitespace between them (verified), so a sequence of Korean weekday names separated by tildes would render the middle name as a subscript.
- **`nonTightLists: false`.** By default, Enter on an empty second item of a tight list inserts a blank line, which makes the list loose, instead of leaving the list [CM §12]. The option exists in the installed `d.ts` (verified). (EDIT-03)
- **Subtree indentation.** Tab in a list item indents the whole `ListItem` node, so child lines move with it. Indenting only the current line breaks the nesting of its children [OT §4.2 LIST-004, OB §4.5].
  - Tab on a first item does nothing, and returns `true` so focus stays in the editor.
  - Outside lists, use `insertTab` for an empty selection and `indentMore` for a selection.
- **Code languages.** Leave `codeLanguages` empty: the editor stays monotone with no highlighting (LIVE-08). If grayscale highlighting is ever added, load `@codemirror/language-data` lazily.
- **Frontmatter: detect it in the editor, not with a Lezer block parser.** This is ARCHITECTURE §10's approach, and it is the right one, for two reasons:
  - A block parser can look only one line ahead through the public API (`BlockContext.peekLine()`, verified). It cannot check for a closing fence without internals.
  - A decision at line 0 that depends on a fence far below breaks incremental parsing: when the user later types the closing `---`, the old line-0 node is reused and the block is never recognized.

  Write a pure `frontmatterRange(doc): { from, to } | null`:
  - Line 1 must match `/^---[ \t]*$/`.
  - Scan forward to the first line matching `/^(---|\.\.\.)[ \t]*$/`. If there is none, return `null`.
  - Recompute only when a change touches `[0, range.to]`, or touches line 1 when the result was `null`.

  Every decoration builder, the completion source and link extraction skip syntax nodes inside the range. Lezer parses YAML as `HorizontalRule` + `SetextHeading2` + inline nodes [CM §3].
- **CJK-friendly emphasis (READ-08, P1).** Add an inline parser `{ name: "CjkEmphasis", before: "Emphasis" }` for `*` and `_`. It recomputes the flanking test with one change: a CJK character next to the delimiter run (Hangul syllables and jamo, kana, CJK ideographs, CJK and fullwidth punctuation) also satisfies the "whitespace or punctuation" alternative. It then calls `cx.addDelimiter(InlineContext.emphasisAsterisk /* or emphasisUnderscore */, from, to, canOpen, canClose)`.
  - Lezer exposes the built-in delimiter types as static fields and resolves emphasis by comparing type identity (verified). Its own resolver therefore still builds `Emphasis` and `StrongEmphasis`.
  - The reading view gets the same rule by subclassing markdown-it's `StateInline` and overriding `scanDelims` for our instance only. In markdown-it 15, `md.inline.State` is an instance field (verified).
  - One shared fixture list tests both parsers [MT §3.2, §11].

### 1.2 Two decoration sources, and only two

1. **The `livePreview` ViewPlugin** handles everything inline or per line: hidden marks (`Decoration.replace({})`), style marks, line classes and attributes, and the checkbox widget.
   - It works on `view.visibleRanges` only, with one tree walk per range. A single `switch` in `enter(node)` dispatches to the per-construct builders [CM §9, §16].
2. **The `blockPreview` StateField** handles everything that changes vertical structure: image widgets (P1) and table widgets (P1). It is exposed with `EditorView.decorations.from(field)`.
   - Block widgets, and replacements that cross a line break, throw `RangeError` when they come from a ViewPlugin [CM §8].
   - **Only static decoration sources feed CodeMirror's height map** for content that has not been drawn (verified: the height map filters out function-valued decoration sources). So a widget's `estimatedHeight` only stabilizes scrolling when the widget comes from the StateField. This is why images belong there, not in the ViewPlugin (REQUIREMENTS §14 #10).

```ts
build(view) {
  const sel = view.hasFocus ? view.state.selection.ranges : NONE   // LIVE-01: unfocused → render all
  const fm = frontmatterRange(view.state.doc)
  const out: Range<Decoration>[] = []
  for (const { from, to } of view.visibleRanges)
    syntaxTree(view.state).iterate({ from, to, enter: (n) => {
      if (fm && n.from < fm.to && n.to > fm.from) return false  // nothing inside YAML
      return builders[n.name]?.(n, sel, out)                    // false = skip children
    } })
  return Decoration.set(out, true)                              // sort = true [CM §8]
}
```

- [critic] **Focus.** `view.hasFocus` checks only `contentDOM`, so a focused find input would make everything render and hide a match that sits inside hidden syntax. Use `focused = view.hasFocus || findPanelFocused(view)` for the `sel` line above (EDIT-09, LIVE-01).
- **Touch test.** `touches(r, from, to) = r.from <= to && r.to >= from`, inclusive at both ends [CM §5, SB §4.2]. For line-unit constructs, compare line numbers instead.
- **Outermost element decides.** When the walk enters an inline element:
  - decide its reveal state;
  - hide every mark child in its subtree, iterating with the node's own cursor (never `toTree()`, which allocates a new tree per element [CM §4.1]);
  - return `false` so its children are not visited again.
- **Nesting means strict containment.** ixora tests "nested" with the inclusive overlap test, so in `**a**_b_` the second element is treated as nested and never hidden [CM §4.1, §15 #2].
- **Failure isolation.** Wrap each builder in `try/catch`. On an error, log once per construct type and skip that node; the note stays editable as plain text [OT §4.2].

### 1.3 Freeze rules: map instead of rebuild

```ts
update(u) {
  if (u.view.composing || hold.active(u.view)) {      // IME, pointer or keyboard hold
    this.deco = this.deco.map(u.changes); return
  }
  if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged
      || syntaxTree(u.startState) !== syntaxTree(u.state) || hasRefresh(u))
    this.deco = this.build(u.view)
}
```

- **Composition.** Only map while `view.composing`. On `compositionend`, schedule one refresh with `requestAnimationFrame(() => view.dispatch({ effects: refresh.of(null) }))` [OT §4.2, CM §10]. The StateField does the equivalent with `tr.isUserEvent("input.type.compose")` [SB §4.2].
- **Pointer hold.** A capture-phase `mousedown` on `contentDOM` starts the hold. `mouseup` (or `dragend`) on `window` releases it a task later, so CodeMirror's own mouseup handling goes first, and a document change or window blur releases it at once [SB §4.2, OB API `livePreviewState.mousedown`]. Without the hold, a drag-select lands on the wrong characters, because markup appears in the middle of the gesture [SB §4.2].
  - *Changed:* no 100 ms delay after the release. The delay existed for double-clicks (the first click's release reveals marks and shifts the text under the pointer), but it protected only fast ones and made every click's reveal a beat late. Instead an `EditorView.mouseSelectionStyle` handles `event.detail ≥ 2`: the word (`charCategorizer` groups) or line is taken at the caret the first click placed, and a drag farther than 10 px extends from there over the current layout, as `basicMouseSelection` would.
- **No keyboard hold.** A caret moved by the keyboard reveals its construct in the same update. The earlier 100 ms hold after a line change made ↑/↓ reveal late; the build over the visible ranges is cheap enough to run per keystroke. Same-line moves never held anyway: `moveByChar` steps through hidden characters (replaced ranges are not atomic unless `atomicRanges` says so, verified in `@codemirror/view`), and a character typed under a hold could land inside hidden markup.
- **Leaving a hold** always triggers one rebuild, because the selection may have moved during the hold.
- **Scrolling during a hold.** If the viewport changes while held, rebuild using the selection snapshot taken when the hold started. Newly visible lines get decorations, but no reveal state changes.

### 1.4 Recompute triggers and first paint

- **Parser progress.** Background parse results arrive as transactions that carry only `Language.setState`, with no doc, viewport or selection change. Compare `syntaxTree(u.startState) !== syntaxTree(u.state)` (included above). Without it, everything after the first ~3,000 characters of a large note stays undecorated until the next keystroke [CM §9, §15 #11].
- **On open** (LIVE-16), right after `view.setState(state)` and in the same task, call `forceParsing(view, Math.min(doc.length, viewportEnd + 2500), 100)`. WebKit has no `requestIdleCallback`, and CodeMirror's idle fallback waits about 500 ms, which flashes raw Markdown in WKWebView and WebKitGTK [SB §8].
- **Restoring scroll.** Set `scrollTop` after CodeMirror's first measure (one `requestAnimationFrame` after `setState`), and keep the scroller at `visibility: hidden` for that frame [SB §8].
- **Lists continued by Enter** need the tree parsed up to the caret. Our Enter runs lang-markdown's command, which uses the current tree. On a freshly opened large note, call `ensureSyntaxTree(state, pos, 100)` first [SB §4.3].

### 1.5 Construct recipes

"Hidden" is the state while the selection does not touch the construct.

| Construct (Lezer nodes) | Hidden state | Notes and pitfalls |
|---|---|---|
| `ATXHeading1–6` (`HeaderMark`) | Replace the opening mark plus the spaces after it, clamped to the line end; replace a closing mark together with the spaces before it. Line class `cm-hN`. A content mark over the heading text (§1.7) | Never extend a range by a fixed `+1`: on `# Title #` or a bare `#` it crosses the newline and throws [CM §4.2]. An empty heading keeps its `#` [OB RN:v0.13.9]. The reveal unit is the line |
| `SetextHeading1/2` | Line class on the text line; the underline line is muted | Never hidden |
| `Emphasis`, `StrongEmphasis`, `Strikethrough`, `InlineCode`, `Highlight` | Replace the mark children; a style mark over the element | Outermost element decides. A caret right after the closing mark reveals the element, so Backspace reaches the mark |
| `Link` (`LinkMark`, `URL`, `LinkTitle`) | Replace `[` and everything from `](` to the end; mark the label `cm-link` | Skip links with no `URL` child (reference links) and links with an empty label [ZT §4.2]. For `Autolink`, replace only the two `LinkMark`s; ixora hid the URL as well [CM §4.4]. A bare `URL` is only styled |
| `WikiLink`, `WikiEmbed` | Replace `[[`, `target\|` (when there is an alias) and `]]`; mark the visible text `cm-wikilink`, plus `cm-unresolved` when `host.resolveWiki` fails | Apply `cm-unresolved` only after the listing has loaded [SB §6]. Dispatch `refresh` when the set of notes changes |
| `ListMark` (bullets) | A mark that makes the glyph transparent, with `::after` drawing `•` at the same width | A mark, not a widget, so caret metrics and width never change and there is no `eq()` to get wrong [CM §6.1, OB RN:v0.13.1] |
| `Task` / `TaskMarker` | Replace the bullet and its space; replace `TaskMarker` with `CheckboxWidget(checked)`; mark checked text `cm-task-done` | Reveal when the selection touches `[ListMark.from, TaskMarker.to]`. See §1.8 for the widget |
| `Blockquote` / `QuoteMark` | Line class `cm-quote` (with the depth as a data attribute) on every line of the node, lazy lines included; replace `QuoteMark` plus one space on each line the selection is not on | Draw the bar on the line box, not in an inline span, or wrapped rows lose it [CM §7]. Use repeating gradients for nested depth [SB §7]. Reveal per line [CM §5] |
| `FencedCode` (`CodeMark`, `CodeInfo`) | Line classes `cm-code`, `cm-code-first` and `cm-code-last`, taken from `doc.lineAt(node.from / node.to)`; fence lines get `cm-fence` with transparent text; a content mark on each code line | Taking first and last from viewport lines styles the wrong line once the block starts above the viewport [CM §7, §15 #8]. Add `spellcheck="false"` [CM §7]. An unclosed fence runs to the end of the document |
| `CodeBlock` (indented) | Line background only | |
| `HorizontalRule` | Line class `cm-hr` (a 1 px rule drawn on the line box); a mark with transparent text keeps the line height | Lezer already tells setext underlines apart. Skip it inside frontmatter |
| `Table` (P1) | StateField: a block replace with a `TableWidget` | §1.8 |
| `Image` on a line of its own (P1) | StateField: a block replace of the line with an `ImageWidget`; when revealed, a block widget after the line (`side: 1`) | §1.8 [CM §4.5, §6.4] |
| `Escape` (P2) | Replace the backslash | Reveal per line [OB RN:v0.14.11] |

### 1.6 Editor spacing (LIVE-15)

- **Flow walk.** In the same pass, for the `Document` and every container node that meets the viewport (`BulletList`, `OrderedList`, `ListItem`, `Blockquote`), walk its block children (`livePreview/flow.ts` skips `QuoteMark` and `ListMark`). For every child with a block before it, add `Decoration.line({ attributes: { "data-blk", "data-prev", "data-ctx", style: "--mn-blank: n" } })` to its first line (DESIGN.md §3.2), and `cm-blank` to each of the `n` lines between the two blocks (blank, or quote markers only; a quote's content ends at its last block, so its trailing `>` lines count). A first child gets nothing; the document's leading blank lines still shrink.
  - Frontmatter counts as `fm` for the first block after it (Lezer reads the fences as an hr and a setext heading, so skip the nodes inside it).
  - Lists are classified once per build (`listContext`: tight, loose, holding blocks) with CommonMark's looseness rule, so `li + li` gets the renderer's gap.
  - Keep `blockKind`, `listContext`, `blankLinesBetween` and `contentEnd` pure and unit-tested.
- **CSS.** All gap rules sit at one specificity (`:where`) in markdown.css's order and set `--mn-gap`; one rule pads: `padding-top: calc(var(--fs-content) * max(0, var(--mn-gap) - var(--mn-blank, 0) * var(--gap-blank) - var(--mn-half, 0)))`. `--mn-half` is half a text line on an hr line and the line after it. `cm-blank` lines get `line-height: calc(var(--fs-content) * var(--gap-blank))`.
- **Blank lines shrink, but exist.** A blank line between blocks is `--gap-blank` tall (its caret is that short), so the editor's rhythm is the reading view's; trailing blank lines keep their height so typing at the end feels normal. Whitespace in a blank line is text: guard it (§1.7). Empty lines have no children and are never sampled.
- **Never from the selection.** These attributes must never depend on the selection, so moving the caret never reflows the text. A block's first text does reflow once, when the user types it after blank lines (the lines shrink then).
- **Never margins.** CodeMirror's height map ignores margins, which misplaces clicks and makes scrolling jump [CM §14, OB RN:v0.13.9]. Boxes drawn on lines (code `::before`, quote bars) start at `--mn-pad-t`, below the padding.
- **Widgets** read their pair from the current tree when decorations are composed (`blocks.ts › blockPair`), not from the cached regions, so a changed block above never leaves a stale gap.
- **Every padded line also needs the content-mark rule** (§1.7): paragraphs, quotes and HTML blocks get it from the flow walk; list lines carry marks already.
- **Gutters (LIVE-13).** Each list line gets `--mn-depth` (list levels) and `--mn-hang` (the measured width of its prefix, from the line start to its text, hidden quote marks included); CSS pads `max(0, 1.5em × depth − hang)` and hangs wrapped rows by `hang`. The measure is keyed by the prefix text plus a font tag (`c` for code and table lines, `hN` for headings), because the same spaces measure differently in each font. Lines of nested verbatim blocks give up at most the item's content indent in characters.
- **Not chosen:** `EditorView.blockWrappers` (CM ≥ 6.39), which wraps each top-level block and pads the wrappers [CM §14]. It adds DOM and uses a newer API; reconsider only if per-line attributes become unwieldy.

### 1.7 The line-height sampling hazard (verified)

CodeMirror estimates the height of lines it has not drawn from **one sampled line**. `measureTextSize` takes the first visible line that:
- has at most 20 characters;
- has only plain text nodes as children (no marks);
- contains only printable ASCII.

That line's `getBoundingClientRect().height` becomes the default line height (`@codemirror/view` 6.43.15).

If the sampled line is a revealed heading (`## Notes`), an unhighlighted code line, a frontmatter line or a padded block start, every off-screen estimate is wrong:
- the scrollbar misreports the document length;
- jumps to search results land off target;
- measure loops can follow. Otterly's spec calls this SPACE-009: a line box must never carry vertical space [OT §4.6].

**Rule.** Any line whose height differs from body text carries a mark decoration over its content: heading text, code lines, frontmatter lines, table source lines, padded block-start lines, and the whitespace of a shrunk blank line. A mark makes the line's children non-text, so it is never sampled.
- Empty lines have no children and are never sampled (verified in `measureTextSize`, 6.43.15). A blank line holding spaces or tabs does have a text child, so it is guarded.
- Lines containing Hangul are never sampled either (not ASCII). Testing only with Korean notes therefore hides this bug.

### 1.8 Widgets

- **`eq()`** compares rendering inputs only (`checked`; `src` + alt; a hash of the table source), never positions [CM §6.7].
  - With no `eq`, the DOM is rebuilt on every caret move (ixora, ink-mde).
  - With positions in `eq`, images reload after any edit above them (ixora's `JSON.stringify` eq).
- **Widgets are immutable.** ixora's checkbox mutated its own `checked` field [CM §15 #6].
- **Positions are resolved at event time** with `view.posAtDOM(dom)`. Never capture them when the widget is built [CM §6.2].
- **The checkbox** is a `<span class="cm-task" role="checkbox" aria-checked>` drawn with CSS. Safari pins native checkboxes at about 13 px [SB §7].
  - Handle `mousedown` in the plugin's `eventHandlers`: find `closest(".cm-task")`, call `posAtDOM`, check that the source text is `[ ]`, `[x]` or `[X]`, dispatch a one-character change, and `return true` so CodeMirror does not move the selection [CM §6.2].
  - If the selection moved into the marker, the marker would reveal and un-render the checkbox [ZT §4.2].
- **Block widgets (images and tables, P1).**
  - `estimatedHeight` comes from a cache: images keyed by URL, tables by content hash. The fallback is rows × line height.
  - Reserve `aspect-ratio` or `min-height` before content loads. Call `view.requestMeasure()` when async content changes size.
  - The root element uses `display: flow-root` and has no margin [SB §7, §8; CM §6.4]. It carries the block's pair attributes and inset as a line would (§1.6), so the gap above it and its gutter are padding on the root.
- **Images (P1)** come from the StateField:
  - A line holding only an image, not revealed: `Decoration.replace({ widget, block: true })` over `[line.from, line.to]`.
  - Revealed: `Decoration.widget({ widget, block: true, side: 1 })` at `line.to`, so the image stays below the source and nothing jumps [CM §4.5, OT §4.2].
- [critic] **DOM from text.** Widgets build their DOM with properties and `textContent` (`img.src`, `img.alt`), never `innerHTML` from note text. Table cells (P1) render through the reading view's sanitized pipeline (§9), or as plain text.
- [critic] **Reveal of block widgets.** A table or image reveals only when a selection end (anchor or head) lies inside it. A selection that merely spans it keeps it rendered, so Select All never turns tables into raw source (LIVE-01).
- **Tables (P1).** A block replace over the whole table, with the same caching.
  - A multi-line replace is atomic, so ArrowUp from below lands on the table start, which then reveals the table [SB §4.2]. Accept this for P1.
  - SB's alternative hides each line separately and puts the widget on the first line.
  - Cells carry `data-pos`, so a click puts the caret at that cell's source position [SB §4.2].

### 1.9 Clicks

- **Link clicks.** `EditorView.domEventHandlers({ mousedown })` runs before CodeMirror's own mouse handling. Decide with `event.target.closest(".cm-link, .cm-wikilink")`.
  - Because links are marks, the hit target is exact. Widget-based links need distance heuristics [SB §4.2].
  - **Plain primary click on a rendered link:** call `preventDefault()` (no selection change, so no reveal). On `mouseup` within 4 px of the press, navigate [SB §4.2].
  - **Mod+click:** navigate, whether the link is rendered or revealed.
  - **Alt+click on a rendered link:** set a single caret at `posAtCoords`, which reveals the link, and call `preventDefault()`.
- [critic] **Where a click goes** is decided by the shared `classifyHref()` (§9, LINK-01); the editor never hands an unclassified target to the opener.
- **`EditorView.clickAddsSelectionRange.of(e => e.altKey)`.** CodeMirror's default adds a cursor on Cmd+click (macOS) or Ctrl+click (elsewhere) (verified), which collides with Mod+click on links [OB RN:v0.13.2].

### 1.10 Performance checklist

- One ViewPlugin pass. ixora runs 8 separate tree walks and SB about 20 StateFields per update [CM §9, SB §8].
- No `doc.toString()` per transaction (ink-mde does this); call it only in the save [CM §9].
- No `toTree()` and no `JSON.stringify` in hot paths [CM §9].
- Check the node type before computing line blocks or overlaps [CM §4.2].
- In the StateField, a selection-only transaction just maps the set, unless a block's reveal state flips [CM §16].
- Notes over 2 MB: reconfigure the live-preview compartment to `[]`, which is source mode (SAVE-11).

### Pitfalls (live preview)
- Revealing shifts text under the pointer. Use width-preserving replacements (the bullet mark) and the holds [CM §5].
- Reveal per block makes long quotes jump. Reveal per line [CM §5].
- ixora's image plugin ignores `viewportChanged`, so images scrolled into view keep their raw syntax [CM §15 #4].
- Theme margins on lines broke selection in Obsidian [OB RN:v0.13.9]. Pads only, never margins.
- Identical widgets confused Obsidian's widget reuse [OB RN:v0.13.20]. `eq()` compares content, and positions are resolved at event time.
- Stale decorations after a structural edit far from the cursor (typing ```` ``` ```` reparses everything below). Never build decorations incrementally from "changed ranges" only [CM §8].
- [critic] Changing `--fs-content`, the readable width or the theme changes line heights without any DOM change that CodeMirror watches. Call `view.requestMeasure()` afterwards, or clicks and scroll positions use stale heights.
- [critic] CodeMirror's default search panel has text labels and buttons. Build the single-input panel of EDIT-09 with `search({ createPanel })`.

---

## 2. Wikilinks: parsing, completion, resolution, rewriting

### 2.1 Parsing
- `syntax.ts` already follows the right pattern:
  - The inline parser is registered `before: "Link"`. Otherwise `[[x]]` parses as a `Link` `[x]` inside literal brackets [CM §3, ZT §4.1].
  - The construct must fit on one line.
  - It reads with `cx.char` / `cx.slice` and absolute positions. ink-mde indexed `cx.text` with absolute positions, which reads the wrong characters away from offset 0 [CM §11].
  - Child nodes (`WikiLinkMark`, `WikiLinkTarget`, `WikiLinkAlias`) let live preview hide parts selectively.
  - Inline code takes precedence automatically [SB §4.1].
- **Reading view.** A markdown-it inline rule registered before `link` mirrors the parser. It scans `[[…]]` on one line and renders `<a class="internal-link" data-wiki="…">`. Both parsers run against one shared list of fixtures.

### 2.2 Resolution
- **Index the listing, not the content.**
  - `byPath`: `key(path without extension) → entry`.
  - `byName`: `key(stem) → entry[]`, where `key = NFC + lowercase`.
  - Rebuild on every listing change; 10,000 entries take a few milliseconds (`markdown/resolve.ts`).
- **Order follows LINK-03.** "First match in traversal order" is ambiguous with duplicate names [ZT §7].
- **Extensions.** Treat only known extensions (`md`, `markdown` and the image list) as extensions. SB parses `Meeting 2024.01` as having the extension `01` [SB §6].
- **Unresolved styling** waits for the listing [SB §6] and refreshes when the set of notes changes.

### 2.3 Completion (LINK-04)
- **Setup.** `autocompletion({ override: [wikiSource], icons: false })`.
- **Source.**
  - Match the text before the cursor against `/\[\[([^\[\]|#\n]*)$/`.
  - Return `{ from: queryStart, options, filter: false, validFor: /^[^\[\]|#\n]*$/ }`.
  - The options are pre-ranked with the switcher scorer (§6), top 50.
- **Context.** Bail out inside `InlineCode`, `FencedCode` or `CodeBlock` (check `syntaxTree(state).resolveInner(pos, -1)` and its parents) and inside the frontmatter range.
- **Apply.**
  - Insert the shortest unique link text: the title when `byName` holds a single entry for it, otherwise the path without its extension [OB §7.2].
  - If the next two characters are `]]`, as when auto-closing inserted them, move the caret past them; otherwise insert `]]`.
  - Tab inside `]]` must not add a second `]]` [OB RN:v0.8.5].
  - `|` and `#` must not accept a suggestion [OB §7.3].
  - [critic] Insert the NFC display form of the name, even when the stored name is NFD (LINK-04).
- **IME.** Accepting is a keymap action, and CodeMirror skips keymaps while composing [CM §10].

### 2.4 Rewriting links after a rename (LINK-07, P1), without a persistent index
1. Flush, then rename through IPC.
2. **Candidates.** Ask Rust for the notes whose text contains the old stem, compared in NFC ignoring case, or its percent-encoded form (`My%20Note`). This reuses the search scanner (§7) in files-only mode.
3. **Exact parse.** Parse each candidate in JS with the editor's own grammar: `@lezer/markdown`'s `parser.configure([GFM, WikiLink, …]).parse(text)`, with no `EditorView` needed. Keep the `WikiLink` and `Link` nodes whose target, resolved with the **old** listing, is the renamed path.
4. **Edits.**
   - Replace only the target sub-range. Keep the alias, `#heading`, a leading `!`, `<…>`, the presence of `.md` and `%20` encoding [OB §7.5, SB §6].
   - Escape `|` as `\|` inside table rows [OB RN:v1.6.4].
   - If the new stem is ambiguous, write the path form [OB RN:v0.8.3].
5. **Apply.**
   - The open note changes through an editor transaction, so it is one undo step.
   - Other notes go through `note_write` with an expected baseline (§3.2).
   - Unchanged files are skipped.
   - [critic] Closed notes are decoded and re-encoded with their own line ending and BOM (§3.1 `encode`), so only the link bytes change. New names are inserted in NFC.
   - [critic] The candidate scan skips cloud placeholders (§7) and reports how many it skipped in the error toast; reading them would download them.
- **Why no persistent link index.** An index must be kept in sync with every watcher event: ZT rebuilds its link database on every filesystem event [ZT §7], and MS commits Tantivy on every event [MS §8]. A substring prefilter in Rust plus an exact parse in JS costs one scan per rename, and renames are rare. Backlinks (P2) can use the same approach lazily, when the panel opens.

### 2.5 Unresolved targets: create on first edit (LINK-05)
- Clicking an unresolved link calls `editor.open(targetPath, { virtual: true })`. This opens an empty `EditorState`, and its save controller starts with `baseline = null` and `pendingCreate = true`.
- The inline title shows the target name, and the tree shows nothing yet.
- The first save calls `note_create`, an exclusive create that makes missing parent folders, instead of `note_write`.
  - If that returns `exists`, someone created the file in the meantime. Read it and continue as a dirty-buffer conflict (§3.4).
- Navigating away before any edit writes nothing. The history entry stays, and following it again shows the same empty virtual note [SB §5].
- Never create the file when a complete `[[X]]` is typed; mdSilo does, and it litters the vault [MS §11].
- [critic] Validate the target before opening the virtual note: each segment against TREE-07, no `.` or `..` segments, inside the vault. An invalid target shows the error toast and opens nothing; otherwise the first keystroke starts a save that can never succeed.
- [critic] Folder segments resolve to existing folders by `key()`, and their stored names go into the path to create (no case twins on Linux).
- [critic] Renaming a virtual note through the inline title only changes its `path`; nothing is written.

### Pitfalls (links)
- `$` in file names corrupted rewritten links through string-replacement patterns [OB RN:v0.13.23]. Splice by offsets, from the end of the text backwards.
- Verify that the slice still equals the expected text before replacing it, because ranges can be stale [SB §6].
- Links inside code must not change [MS §6].
- Open notes must update in their buffers, not on disk behind the editor's back [OB RN:v0.6.6, ZT §7].
- Folder renames update links to every descendant [OB RN:v0.8.3]. Compare path prefixes with a trailing `/` [ZT §3.3].
- Without NFC, an NFD file name never matches a wikilink whose target was typed in NFC [SB §11, MS §9, OT §4.8].

---

## 3. Autosave, atomic writes, the watcher and conflicts

### 3.1 The save controller (frontend, one per open note)

State: `{ path, lastSaved, baseline: { mtime, size }, version, savedVersion, timer, firstDirtyAt, inFlight, again, eol, bom, failures }`. [critic] The baseline also carries `hash` (§3.2), and the controller a `pinned` flag (EDIT-10).

```ts
onTransaction(tr) {                    // user edits only; External-annotated ones are skipped
  version++
  firstDirtyAt ??= now
  arm(Math.min(400, firstDirtyAt + 2000 - now))       // SAVE-01
}
onTimer() { save() }                                   // [critic] also mid-composition: a save only reads (EDIT-11)
async save() {
  if (inFlight) { again = true; return inFlight }      // one write per file
  const snap = { path, text: state().doc.toString(), version }   // [critic] this note's own state, never `view`
  inFlight = noteWrite(snap.path, encode(snap.text, eol, bom), baseline)
    .then(ok   => { lastSaved = snap.text; baseline = ok; savedVersion = snap.version
                    if (version === savedVersion) firstDirtyAt = null }, // clean only if unchanged
          err  => err.kind === "conflict" ? reconcile(snap) : retryLater(err))
    .finally(() => { inFlight = null; if (again) { again = false; save() } })
  return inFlight
}
async flush() { clearTimer(); if (version !== savedVersion) await save(); await inFlight }
```

- `encode` restores CRLF or CR and prepends U+FEFF when the file had a BOM (EDIT-02). `FileContent` must therefore report `bom`.
- Reloads and merges are dispatched with an `External` annotation, so they never schedule a save [MS §12 (controlled value)].
- On failure (`retryLater`): keep the note dirty, back off 1 s, 2 s, 5 s, then 10 s; show one toast per run of failures; write a recovery copy ([critic] P0 now) [SB §5, OB §5].
- [critic] **`state()`** returns the view's state while this note is open and its cached `EditorState` otherwise. The earlier sketch read `view.state`: a retry firing after the user switched notes would have written the other note's text into this file, which is Obsidian's "saved into the wrong file" bug [OB §0].
- [critic] **No composition check.** Saving mid-composition is safe because nothing in this controller dispatches into the editor. SB defers saves only because its save path dispatches a refresh [SB §4.5]. Deferring would starve saves: the Korean IME keeps the last syllable composing until the next non-Hangul key, so the old `view.composing ? arm(200) : save()` could re-arm through a whole pause.
- [critic] **Pinned dirty notes.** If the flush on a note switch fails or times out (2 s), the note's `EditorState` stays in the cache, pinned against eviction, and this controller keeps retrying against it (EDIT-10).
- [critic] **Payload.** Send the encoded bytes as a raw request body, `invoke("note_write", bytes, { headers })`, with the URI-encoded path, the baseline and the vault epoch in headers, as `binary_write` already does. A JSON string argument escapes the whole text on the main thread, and serde_json rejects lone surrogates (`"\ud800"`), so one stray surrogate in a note would make every save fail. `TextEncoder` writes them as U+FFFD.
- [critic] **Large notes.** Over 2 MB, use a 2,000 ms debounce and a 10,000 ms maximum wait (SAVE-11).
- [critic] **Open sequencing.** `editor.open()` takes a sequence number, and a read that resolves after a newer open has started is discarded, so a slow cloud or network read never replaces the note the user picked later (SAVE-03).

### 3.2 The write path (Rust)

```text
note_write(rel, bytes, expected: Option<Baseline>, epoch) -> Result<Baseline, IpcError>
  [critic] epoch != active epoch → Err(stale_vault)          // PLAT-08
  [critic] root missing → Err(root_unavailable)              // never recreate the root (VAULT-06)
  abs = vault::resolve(rel)?       // [critic] per-platform components, no symlink component (PLAT-08)
  if let Some(b) = expected:
      meta = stat(abs)             // NotFound → Err(not_found): handled as an external delete
      if (meta.len, meta.mtime) != (b.size, b.mtime): return Err(conflict)
      [critic] if b.mtime has no sub-second part: hash(read(abs)) != b.hash → Err(conflict)   // FAT/exFAT, SMB
  [critic] if exists(abs) && !writable(abs): return Err(read_only)   // never replace a protected file
  write_atomic(abs, bytes)?
  meta = stat(abs); registry.record(abs, meta, hash(bytes))   // for watcher suppression (§3.3)
  Ok(Baseline { mtime: meta.mtime, size: meta.len, hash: hash(bytes) })   // [critic] + hash

write_atomic(abs, bytes):
  tmp = abs.parent / format!(".mn~{pid}-{counter}.tmp")   // [critic] never embeds the note's name
  create_new(tmp); write_all; sync_all
  #[cfg(unix)] copy permissions from abs if it exists
  [critic] copy the creation time from abs if it exists (FileTimes::set_created; macOS and Windows)
  rename(tmp, abs), retrying on raw OS errors 5/32/33 after 10, 20, 40, 80, 160 ms
  [critic] #[cfg(target_os = "linux")] fsync the parent directory, so the rename survives power loss
  on any error: remove tmp, return io
```

- Every command is `async` and runs in `spawn_blocking`. A synchronous Tauri command runs on the main thread (Otterly has 73 of them) [OT §2.1, §5].
- On macOS, `sync_all` issues a full flush (`F_FULLFSYNC`), which can take tens of milliseconds. That is fine off the main thread, because a slow write only gathers more edits into the next one.
- The save-time check (`expected`) closes the race in which the watcher has not yet reported an external write when autosave fires [MT §4.3, OT §4.3].
- Never open a dialog from this path. MarkText's Replace modal could pop up during autosave [MT §4.3].
- [critic] **Temp name length.** The old `.{name}.mn~{pid}-{counter}` adds about a dozen bytes to a name that TREE-07 allows up to 255 bytes, so every save of a long Hangul note would fail with `ENAMETOOLONG`. The dot prefix already hides the temp file; it needs no name.
- [critic] **Read-only targets.** On Unix, `rename` over a 0444 file succeeds because it needs only folder permission, so the atomic write would silently defeat the protection. Check the target first (mode bits, the Windows read-only attribute; the macOS locked flag makes the rename fail anyway).
- [critic] **In-place fallback.** If `create_new(tmp)` fails with a permission error but the target is writable, write the target in place (truncate, write, `sync_all`). It is not atomic, but it beats failing forever (SAVE-04).
- [critic] **`note_create`** creates missing parents only below an existing root. A missing root returns `root_unavailable`; `create_dir_all` on a path under an unmounted `/Volumes/<drive>` would otherwise rebuild it on the system disk.
- [critic] **Stale temps.** The listing walk already visits our temp files; delete those older than one hour (a crash or power loss left them).
- [critic] **Hash.** std's `DefaultHasher` over the bytes is enough (no new dependency); it only has to tell versions apart. It closes the gap that coarse mtimes leave (SAVE-05). Send it to JS as a string, since a `u64` does not fit a JS number exactly.

### 3.3 The watcher (Rust)

- **Setup.** `notify-debouncer-full` with a 200 ms window, recursive on the canonical root, one per window.
  - Replace it when the vault changes, dropping the old one first.
  - Tag batches with the root, or an epoch, so that late events from the previous vault are discarded [WR in OT §2.4].
- **Filtering.** Drop components that start with `.`, our temp suffixes, and names that are not valid UTF-8. **Classify a rename by its destination:**

  | Event | Emit |
  |---|---|
  | rename, listed → listed | `rename(from, to)` |
  | rename, hidden or unlisted temp → listed (the atomic save of VS Code, JetBrains, sync clients, …) | `modify(to)`, or `create(to)` if `to` is new |
  | rename, listed → hidden or unlisted | `remove(from)` |
  | rename(from, to) where `from` exists again when the batch is emitted (vim's backup-then-write) | `modify(from)` plus whatever `to` maps to [MS §4] |

  Filtering a rename by its *source* path silently drops other editors' atomic saves.
- **Self-write suppression** [MS §4, SB §5].
  - Drop `create` and `modify` events whose current `(size, mtime)` equals the registry entry for that path.
  - The registry keeps only the last write per path. An LRU of about 1,000 entries bounds memory; no TTL is needed, because a later external write changes the metadata.
  - The frontend still ignores content equal to `lastSaved` (§3.4). This second check covers filesystems with coarse mtimes. [critic] *Changed:* it covers only one direction, our own echoes that slip past the registry. The reverse is the dangerous one: on a coarse-mtime volume (FAT32 and exFAT at 2 s, some SMB shares) an external same-size write inside one tick matches the registry entry and is dropped before the frontend ever sees it, and the metadata-only save-time check then overwrites it. When the recorded mtime has no sub-second part, compare the content hash too before dropping the event (§3.2, SAVE-05).
- **Floods.** More than 100 changes in one batch become a single `{ kind: "any", path: "" }`, which means "list everything again" (git checkout, bulk sync) [SB §5].
- **Platform notes.**
  - macOS: watch the canonical root (`/private/var`, not `/var`) [SB §9, MS §4]. Use native FSEvents and never poll; MarkText forces polling on macOS [MT §8].
  - Linux: hitting the inotify watch limit (ENOSPC) shows one error toast, then the app falls back to listing every 30 s [MT §4.5, SB §5]. inotify misses files created inside a new directory before its watch exists, so the frontend lists again on a directory `create` [SB §5].
  - All: close the watcher on exit [ZT §5.3].
- **Paths** pass through byte-identical. All comparisons happen in TS through `key()` (§10). [critic] An event path is mapped to an entry by exact path first, then by `key()` (§10.1).
- [critic] **Symlinks.** Build the watcher with `notify::Config::default().with_follow_symlinks(false)`. notify follows symlinks by default (verified in notify 8.2), so inotify and kqueue would add watches inside linked folders, outside the vault, or loop.
- [critic] **Overflow.** notify reports a queue overflow as `EventKind::Other` with `Flag::Rescan` (inotify and FSEvents; verified). ARCHITECTURE §6.3's mapping has no row for it and would drop it; map it to `any`.
- [critic] **Network volumes.** FSEvents, inotify and ReadDirectoryChangesW see only this machine's changes on SMB, NFS and AFP shares, and Windows can drop a burst silently. On window focus, stat the open note against its baseline; on network volumes, or after a fallback, also re-list (TREE-12).
- [critic] **Own renames.** Record in-app renames and moves, including the case-only temp step, in the registry, so their `remove(from)` echoes are dropped. The frontend still confirms a `remove` by reading (§3.4).

### 3.4 Reconciling external changes (frontend, SAVE-06 and SAVE-07)

```ts
async onExternalChange(path) {                 // [critic] matched exact-first, then key() (§10.1); never ===
  const seq = ++readSeq[path]
  const disk = await noteReadSettled(path).catch(e => e.kind === "not_found" ? null : rethrow(e))  // [critic]
  if (seq !== readSeq[path]) return            // a newer read won [MT §4.5]
  if (disk === null) return onRemoved(path)    // [critic] confirmed by this read, not by the event (SAVE-07)
  const buf = state().doc.toString()           // [critic] this note's own state: open, or cached and pinned
  if (disk.text === lastSaved || disk.text === buf) { baseline = disk.meta; adoptStyle(disk); return }  // [critic] eol/BOM
  await compositionIdle()                      // [critic] never dispatch mid-composition (EDIT-11)
  if (seq !== readSeq[path]) return            // [critic] a newer change arrived meanwhile
  if (version === savedVersion) { applyMinimal(disk.text); lastSaved = disk.text; baseline = disk.meta; return }
  await conflict(disk)                         // dirty
}
```

- **`applyMinimal`** takes the common prefix and suffix, dispatches one change, and annotates it `External.of(true)` plus `Transaction.addToHistory.of(false)`. CodeMirror's history maps the user's own undo steps through changes kept out of history, which is collab semantics, so Undo never reverts the reload [CM §13]. The cursor and scroll stay put, unlike a whole-document replace [CM §13, ZT §5.3].
- **`conflict`, P0.**
  1. Write `disk.text` as `<stem> (conflict YYYYMMDD-HHmmss).md` with `note_create` (exclusive; add a suffix on collision).
     - [critic] Encode it with the disk version's own `eol` and `bom`, so the copy is byte-identical to what was on disk. Keep the original extension, and truncate the stem (at a character boundary) so the whole name fits in 255 bytes.
     - [critic] If this write fails, stop here: keep the buffer dirty, write a recovery copy (SAVE-10) and show the toast. Never continue to step 2, which would overwrite the only copy of the external version.
     - [critic] If this note already produced a conflict copy in the last 60 s, overwrite that copy (our own file) instead of creating another one; a tool that rewrites the file after every save would otherwise flood the folder.
  2. Set `baseline = disk.meta`, then `save()`, so the local text wins in the original file.
  3. Show one toast.
- **`onRemoved`.** If the note is clean, close it. If it is dirty, keep the buffer, set `baseline = null`, and let the next save create the file (`note_create`). [critic] `note_create` recreates missing folders below the root, never the root itself (§3.2).
- **Inactive cached notes.** An external change only evicts their cached `EditorState` (EDIT-10). They are always clean, because switching notes flushes. [critic] *Changed:* they are normally clean, but a flush can fail or time out on a switch. A pinned dirty note is reconciled like the open note, against its cached state, and is never evicted.
- [critic] **`noteReadSettled`.** Stat, read, stat again. If the size or mtime moved, another program is still writing in place: wait 100 ms and retry, up to three times [MT §4.5]. An empty result for a clean, non-empty note is applied only if it is still empty 1 s later (cloud clients leave empty files briefly while syncing, and reloads are not undoable).
- [critic] **`adoptStyle`.** When only line endings or the BOM changed, copy `disk.eol` and `disk.bom` into the controller, so the next save keeps them (EDIT-02).
- [critic] **`compositionIdle`.** Resolves at once when `view.composing` is false, otherwise on the next `compositionend`. LINK-07 edits of the open note and refresh effects wait the same way.

### 3.5 Three-way merge (P1)

Use only prefix/suffix diffs, which need no library:

```ts
hunk(a, b) = { from: p, to: a.length - s, insert: b.slice(p, b.length - s) }  // p, s = common prefix/suffix
L = hunk(lastSaved, buffer);  R = hunk(lastSaved, disk.text)                   // both in base coordinates
if (R.to < L.from)      apply R unchanged                       // external edit lies before the local one
else if (R.from > L.to) apply R shifted by L.insert.length - (L.to - L.from)
else                    conflict copy                           // overlapping or touching edits
```

Then set `lastSaved = disk.text` and `baseline = disk.meta`, and save; the merged buffer is dirty. The classic case merges cleanly: another device appended at the end while the user typed at the top.
- An external edit with several separate hunks becomes one wide hunk and is more likely to fall back to a copy. That is safe.
- A line-level diff for finer merges is P2.
- SB maps external changes through local ones with `ChangeSet.map` and defers collisions that touch the same chunk [SB §5].

### Pitfalls (persistence)
- **Timing.**
  - A trailing debounce with no max-wait never saves while the user keeps typing [ZT §5.2, MT §4.1].
  - Marking a note clean before the write succeeds hides failures [ZT §5.2]; mdSilo ignored a `false` return from its write entirely [MS §4, §11].
- **Write races.**
  - Overlapping writes blanked a note [OB RN:v0.6.2].
  - Final characters were lost on large files [OB RN:v0.9.12]. A flush must await the write in flight, then write the latest text.
  - After a failed open, the previous buffer was saved into the new file [OB RN:v0.11.6]. Bind the path when the save starts.
  - Pending saves must be cancelled before a delete, or they bring the file back [MS §4].
- **Durability.**
  - Without fsync, a power loss left zero-filled files [MT §4.3].
  - On Windows, a rename fails while any handle is open on the target (our own watcher, Defender, OneDrive). Retry after short, staggered delays; MarkText measured longer backoff as worse [MT §4.3, OT §2.3].
  - Skip `mkdir` when the parent exists, because Windows returns EPERM on drive roots [MT §4.3].
  - The temp file must be in the same folder, so it is on the same volume [MS §4].
- **Event handling.**
  - "Ignore the next event" lists leak and then swallow a real change [ZT §5.3, OT §5].
  - Cloud clients touch the mtime without changing content (OneDrive, Box). Compare content [ZT §5.3, MT §4.6].
  - The "disk wins" rule (WR) drops typing, and closing dirty tabs on removal (OT) loses edits [OT §4.3].

---

## 4. Close and quit (SAVE-02)

- **Window close.**
  ```ts
  getCurrentWindow().onCloseRequested(async () => {
    try { await withTimeout(Promise.all([editor.flush(), settings.flush()]), 2000) }
    catch { await withTimeout(writeRecoveryCopies(), 1000).catch(() => {}) }   // SAVE-10 ([critic] P0, bounded)
  })
  ```
  The JS API awaits the handler and then calls `destroy()` unless `preventDefault()` was called (verified in `@tauri-apps/api` 2.12). **If the handler throws, `destroy()` never runs, and the window cannot be closed.** Always catch.
  - [critic] Bound the recovery write as well: `await withTimeout(writeRecoveryCopies(), 1000).catch(() => {})`. The flush usually fails because the disk is stuck, and app data may sit on the same disk; an unbounded recovery write would keep the window open. Recovery copies are P0 now (SAVE-10).
- **App exit.** On `RunEvent::ExitRequested`:
  - if not yet ready and a webview exists, call `api.prevent_exit()`, emit `app:flush-request`, and start a 1,500 ms fallback timer;
  - [critic] *Changed:* make the fallback 4,000 ms, longer than the frontend's own budget (a 2,000 ms flush timeout plus the 1,000 ms recovery write). With 1,500 ms (ARCHITECTURE §6.5) the process can be killed while the frontend is still flushing: the atomic write keeps the old file intact, but the newest text and its recovery copy are lost. A hung webview still exits after 4 s;
  - the frontend flushes, then calls `app_exit_ready`, which calls `app.exit(0)` (ARCHITECTURE §6.5).
- **macOS Cmd+Q.** The predefined Quit item never raises a preventable `ExitRequested`, because tao only implements `applicationWillTerminate:` (Tauri #9198). Replace it with a custom `CmdOrCtrl+Q` item that emits the flush request [OT §2.7].
- **Dock › Quit and logout** cannot be intercepted. Clicking the Dock blurs the window first, so the blur flush and the 400 ms / 2 s debounce cover nearly everything [OT §2.7, §5].
- **Windows and Linux.** There is no menu bar; Ctrl+Q is a frontend command that flushes, then calls `app_exit_ready`.
- **Never show an "unsaved changes" dialog.** MT, ZT and OT all do [MT §4.7, ZT §5.2, OT §2.7]. Otterly also saved only its session file, not the `.md` files, on close; avoid that [OT §5].

---

## 5. Keeping the file tree in sync (TREE-01, TREE-12, TREE-13)

- **Source of truth.** `vault_list` returns flat `Entry[]` records (path, kind, mtime, size) for folders, notes and images. It reads metadata only, never file contents [MT §8 (avoid), ZT §9].
- **Model, in Svelte 5:**
  1. `entries` is `$state.raw` and is replaced, never mutated.
  2. `$derived` builds the tree (a node map and sorted children).
  3. `$derived` flattens the visible rows (expanded folders only).
  4. A virtual list renders them (fixed 28 px rows, about 5 rows of overscan) [OT §4.1, MS §2].

  Never deep-proxy 10,000 nodes.
- **Updates.**
  - **P0:** a debounced (250 ms) full re-list on any structural change (`create`, `remove`, `rename`, `any`). A content `modify` never re-lists. Our own operations update optimistically, and the watcher echo then re-lists harmlessly.
  - **P1, large vaults:** a pure `applyChanges(entries, changes)` applies small batches as deltas. Re-list only on a flood (`any`) or on a directory `create`.
  - A re-list costs tens of milliseconds for 10,000 entries plus about 1 MB of JSON. If that grows, stream it through a `tauri::ipc::Channel` [OT §2.1].
  - [critic] When `ListResult.truncated` is set, show one error toast (VAULT-01) and raise the re-list debounce to `max(250 ms, 2 × the last listing's duration)` (PERF-05).
- [critic] **Windows hidden entries.** Skip entries whose `file_attributes()` (`std::os::windows::fs::MetadataExt`) has Hidden (`0x2`) or System (`0x4`) set (TREE-01).
- [critic] **Unreadable folders.** A walkdir error inside a sub-folder keeps that folder as an entry, skips its children and continues. Only an unreadable root fails the listing [ZT §10].
- **Sorting** (TREE-02) uses one shared `Intl.Collator`, created once and used only in JS. Otterly sorts ASCII-lowercase in Rust but uses `localeCompare` in JS, and the two disagree for Hangul [OT §4.1].
- **Expanded set.** A `Set` of keys, persisted as `VaultPath`s. Re-key it on rename using a trailing `/` on prefixes, and prune it on delete [MT §2, OB §3].
- **Reveal.** Expand the ancestors, then scroll the row into view, centered, only if it is not fully visible [MT §2]. Suppress reveal while renaming [OB RN:v1.13.0].
- **Inline rename and create.**
  - One store field holds the state: `{ mode: "rename" | "create-folder", target, draft }`.
  - Commit closes the input *before* the async call.
  - A capture-phase `mousedown` on `document` commits on click-away, and still works when other handlers call `stopPropagation`. A right-click cancels [MT §2].
- **Keyboard navigation** walks the same flattened row array, so navigation order always equals render order [ZT §3.4].
- **Drag and drop.**
  - `dragDropEnabled: false` in `tauri.conf.json`; otherwise Tauri's native drop handler swallows HTML5 drag events on Windows [OT §2.6].
  - Use a custom MIME type, `application/x-mininote-path`.
  - Keep a depth counter for `dragenter`/`dragleave` [CM §12].
  - A 700 ms hover-expand timer, cleared on leave. Auto-scroll within 32 px of the edges [MT appendix].

### Pitfalls (tree)
- **Stale data.**
  - Rust listing caches that the watcher does not invalidate: Otterly's tree stays stale for up to 30 s [OT §4.1]. Do not cache listings.
  - Reading every file's content during the scan [MT §8], or indexing before showing the UI [ZT §9].
- **Logic slips.**
  - A collator created per comparison [ZT §9].
  - Path prefix checks without a separator (`/a/foo` vs `/a/foobar`) [ZT §3.3].
  - Hidden items must not be selectable [OB §3].
- **UI behavior.**
  - Expand state lost on restart [ZT §2, OT §4.1].
  - `dragenter`/`dragleave` also fire for child elements [ZT §3.4, CM §12].
  - Lag with many expanded rows [OB §3]. Virtualize.

---

## 6. Quick switcher ranking (NAV-01, NAV-02)

- **Precompute** for each listed file, once per listing change: `titleKey = NFC(lowercase(stem))`, `pathKey`, and `cho = choseong(title)`.
- **Per token, per field.** Score the title (weight 1.0) and the folder path (weight about 0.8), and keep the best.
  - Tiers, best first: exact, prefix, prefix at a word boundary, substring, then in-order subsequence. A subsequence gets bonuses for consecutive characters and word starts, and penalties for gaps.
  - A token that matches nothing excludes the item.
  - Combine the token scores by sum or by geometric mean [OT §4.4 (tiers 1200 / 1040 / 820 / 720 / 420), SB §13].
- **Hangul.**
  - Compare NFC to NFC.
  - A query made only of compatibility consonants (U+3131–U+314E) is matched against `cho`.
  - The last query character may be a partial syllable or a bare consonant: it matches any target syllable that it is a prefix of (for example, U+D558 → U+D55C or U+AD6C → U+AD6D).
  - Do **not** NFD-normalize everything. SB does, and its length thresholds then count jamo, which makes two-syllable queries noisy [SB §11].
  - `utils/fuzzy.ts` already implements this.
- **Recency.** The session's `recent` list gives a small boost and is the whole list for an empty query [OB §6.1].
- **Ties** go to the shorter title, then the shorter path, then collator order.
- **Cost.** Scoring 10,000 items per keystroke takes a few milliseconds. Render at most 50 rows. When the new query only appends to the old one, re-scoring just the previous matches is an optional optimization [SB §8].
- **IME.** Input events during composition still update the results (partial-syllable matching makes this useful). Enter and the arrow keys do nothing while composing.

### Pitfalls (switcher)
- An unranked regex substring match plus a subprocess per query [MT §5]; no fuzzy matching at all [ZT §6].
- Enter during composition opened or created a note with a truncated name [OB RN:v0.12.14, MS §5].
- Folder matches penalized too heavily [OB RN:v0.12.6].
- Disable spellcheck in the input [OB RN:v1.7.0].

---

## 7. Full-text search (SRCH-01, SRCH-02)

- **In Rust, not JS.** JS would have to pull every note over IPC. Rust reads files locally from the OS cache [MT §11, OB §6.2].
- **No persistent index for now.**
  - Scanning 5,000 notes (about 25–50 MB) for substrings takes a few hundred milliseconds with a warm cache.
  - An index brings lifecycle work and Korean tokenization trouble: FTS5's `unicode61` misses Hangul words with attached particles [OT §4.4], and jieba splits Hangul into single syllables [MS §5]. A Hangul bigram tokenizer would be needed [SB §11].
- **`search_text`, step by step.**
  1. Increment the search generation.
  2. Walk the notes with the same filters as the listing, skipping files over 5 MB.
  3. For each file: read it and skip it if it is not UTF-8. NFC-normalize it only when `is_nfc_quick` says that is needed, which avoids copying almost every file.
  4. A file qualifies when every term appears somewhere in it (AND). A quoted phrase counts as one term.
  5. Collect up to 20 matching lines and trim long lines around the first hit (240 characters).
  6. Report ranges as UTF-16 offsets into the returned snippet.
  7. Check the generation after each file and abort if a newer search started (ARCHITECTURE §6.4).
- **Case folding with correct offsets.** Build the folded line one character at a time with `char::to_lowercase()`, alongside a vector that maps each folded character back to its original character index. Map hits back through it, then convert to UTF-16. Lowercasing a whole line and reusing its offsets breaks wherever lowercasing changes length (`İ` → `i̇`) [ZT §6].
- [critic] **Cloud placeholders.** Skip files whose content is not local, because reading them downloads them: on macOS, `st_flags() & SF_DATALESS` (`0x40000000`, from `std::os::macos::fs::MetadataExt`; verified to compile); on Windows, `file_attributes()` with `RECALL_ON_DATA_ACCESS` (`0x400000`), `RECALL_ON_OPEN` (`0x40000`) or `OFFLINE` (`0x1000`). The LINK-07 candidate scan uses the same walk [WR in OT §2.1].
- **Frontend.** A 200 ms debounce, a request sequence number to drop stale responses, and lazy rendering of at most 200 files. [critic] Snippets are rendered as text, with the matches as spans cut from the offsets, never `{@html}`.
- **Jump to a match** (NAV-05). Open the note at the line, then select the first occurrence found by the same folding.
- **P2.** A parallel walk (`std::thread::scope` over chunks), results streamed through a `tauri::ipc::Channel` and flushed every 50 ms [OT §2.1], and query operators.

### Pitfalls (search)
- **Offsets.** UTF-8 byte offsets highlight the wrong characters in Korean [MT §5]. NFD content must be normalized before matching [SB §11].
- **Re-running.** Re-running on every keyup without a debounce [MT §5].
- **Result sets.**
  - Respecting `.gitignore` silently hides notes [MT §5].
  - A NOT-only query returns nearly everything [ZT §6].
  - Without a result cap, the UI floods [ZT §6].
- **Robustness.** One unreadable file must not hang the search [OB RN:v0.11.6].

---

## 8. Local images (READ-05, LIVE-11)

- **Protocol.** Tauri's asset protocol: Cargo feature `protocol-asset`, `assetProtocol: { enable: true, scope: [] }`. At vault open, call `app.asset_protocol_scope().allow_directory(&root, true)` (ARCHITECTURE §6.1).
  - `convertFileSrc(abs)` produces `asset://localhost/…` on macOS and Linux, and `http://asset.localhost/…` on Windows [MS §9].
- **Resolver, as a pure function.**
  1. Percent-decode the target, tolerating malformed sequences.
  2. Try candidates in order: relative to the note, relative to the vault root, then a basename lookup (for `![[x.png]]` and bare names).
  3. Match each candidate against the listing by `key()`.
  4. Return the **listed** `VaultPath`, then `toAbsolute(root, rel)`, then `convertFileSrc`.

  Returning the listed name fixes NFC/NFD mismatches on NTFS and ext4, where name lookups are sensitive to Unicode form [SB §11]. (APFS happens to be insensitive.)
- **CSP.** `img-src 'self' asset: http://asset.localhost https: http: data: blob:` (already in `tauri.conf.json`).
- **Cache busting.** Append `?v=<mtime>` so that an image that changed on disk reloads. This relies on the asset handler resolving the URI path only.
- **Height.** Cache each image's natural size by URL. Set `aspect-ratio` before it loads, and call `requestMeasure()` on load [CM §6.4].
- [critic] **SVG** is displayed only through `<img>`, in the editor, the reading view and the image viewer (TREE-15). An SVG loaded as a document runs its scripts, and in our origin they could reach IPC.
- [critic] **UNC roots.** On Windows a vault on a mapped drive canonicalizes to `\\server\share\…`. Make sure `toAbsolute` and `convertFileSrc` produce working asset URLs for such roots; Obsidian needed fixes for images on network drives [OB §10].

### Pitfalls (images)
- **Scope.**
  - An asset scope of `**` exposes every file on disk (WR, MS). Scope it to the vault [OT §2.2, MS §9].
  - An `allow` cannot be revoked, and `forbid_*` rules are sticky. A previously opened vault therefore stays readable for the rest of the session. That is acceptable; if it ever matters, switch to a custom vault-scoped scheme, as Otterly does [OT §2.5].
  - On Unix, Tauri's scope globs do not match dot-prefixed path components by default (`requireLiteralLeadingDot`). Images inside dot-folders, such as Otterly's `.assets/`, are denied unless the scope config sets it to false.
- **Windows.**
  - Custom schemes need the `http://<scheme>.localhost` form in WebView2 [OT §2.5]. The asset protocol already handles this.
  - Convert drive-letter paths to asset URLs *before* sanitizing, because `C:` looks like a URL scheme [MT §7].
- **Async rendering.** Without `requestMeasure()` after load, CodeMirror's height map stays stale [CM §6.4].

---

## 9. Reading view and sanitizing (READ-01 … READ-07)

- **Pipeline.**
  1. Strip the frontmatter with the same `frontmatterRange` function and render it as `<pre class="frontmatter">`. Offset token line numbers by its line count.
  2. `md.render(body, env)`.
  3. `DOMPurify.sanitize(html, cfg)`.
  4. `{@html}` into `.markdown`.
- **markdown-it options:** `{ html: true, linkify: true, breaks: true, typographer: false }`.
- **Our own small plugins:**
  - **Wikilinks:** an inline rule before `link`.
  - **Highlight:** `==text==`.
  - **Task items:** a core rule. A list item whose first inline text starts with `[ ] ` or `[x] ` gets a checkbox element.
  - **Loose lists:** a core rule. A list whose items contain a paragraph that is not hidden gets `class="loose"`.
  - **Table wrapper:** wrap each `<table>` in `<div class="table-wrap">`.
  - **Table alignment to classes:** turn `style="text-align:x"` attributes on `th` and `td` into `class="ta-x"`. markdown-it emits alignment as inline styles (verified), and the sanitizer removes `style` [OB RN:v0.6.7: a sanitizer broke table alignment].
  - **Images:** rewrite `src` through the resolver (§8).
  - **Heading ids:** Unicode slugs that keep Hangul.
  - **Line numbers:** `data-line` from `token.map` on block tokens, used for checkbox toggling and scroll sync.
- **DOMPurify config.**
  - `USE_PROFILES: { html: true }`.
  - `FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form", "base", "link", "meta"]`. [critic] Add `"dialog"`.
  - `FORBID_ATTR: ["style"]`, which keeps the palette monotone. [critic] Add `"popover"`, `"popovertarget"`, `"popovertargetaction"` and `"autofocus"`: top-layer overlays could cover the app's UI, and autofocus steals focus.
  - `ALLOW_DATA_ATTR: false` plus `ADD_ATTR` for the data attributes we emit.
  - An `ALLOWED_URI_REGEXP` that allows `http(s)`, `mailto`, `tel`, relative paths, `#`, `asset:` and `http://asset.localhost`.
- **Checkboxes.** Render `<span class="task-box" role="checkbox" aria-checked="…" data-line="N">`, not `<input disabled>`. A disabled form control may not deliver click events to our listener. The same custom drawing serves both views [SB §7].
- **Click delegation.** One listener on the container:
  - every `<a>`: `preventDefault()`, then route it (LINK-01 … LINK-05);
  - a task box: `editor.toggleTaskAtLine(line)`.
- **Navigation lock, as defense in depth.** A Rust `on_navigation` hook (a tiny internal plugin) allows only the app's own origin, so a click handler we missed still cannot navigate the webview [ZT §10, MT §9].
- [critic] **One link classifier.** The click delegation here and the editor's link handler (§1.9) both call the same pure `classifyHref(href, notePath)` (LINK-01): `http(s)`, `mailto` and `tel` go to the opener; vault paths, normalized against the note's folder and kept inside the root, open in mininote; everything else does nothing. That covers `file:`, `javascript:`, `data:`, drive paths, UNC paths and custom schemes.
- [critic] **Task toggles** re-check that the source line at `data-line` is a task item before editing it; raw HTML in the note can forge the attribute.
- [critic] **Heading anchors.** DOMPurify's `SANITIZE_DOM` (on by default) strips `id` and `name` values that clash with DOM properties, so a heading named `title` or `body` loses its id. Jump to anchors through our own slug-to-line map built from the tokens, not through `getElementById`.
- [critic] **CSP additions:** `object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'`. `base-uri` and `form-action` do not fall back to `default-src`.
- [critic] **`{@html}` only here.** File names and snippets elsewhere are text nodes; on macOS and Linux a file created by another app may have `<` and `>` in its name (READ-04).
- **Spacing CSS** is DESIGN.md §3.1 as written:
  - Zero margins first, then the `CONTAINER > :where(A + B)` rules. Their specificity is equal, so source order sets priority.
  - Nothing ever sets `margin-bottom`. The `loose` class replaces `:has()`.
- **Rendering cost.** Render only while visible. Re-render on `editor.revision`, debounced about 150 ms, while visible. Per-section caching is P2 [OB §8.1].

### Pitfalls (reading view)
- **Spacing.** Per-element margins plus first/last-child patches show up in every analyzed project: MT relies on margin collapsing, mixes rem and em, and leaks the UA `pre` margin [MT §7]; also [MS §7, SB §7, ZT §8].
- **Sanitizing.**
  - Allow-lists that are too strict broke task checkboxes [OB RN:v0.6.7].
  - Resolve local image paths before sanitizing [MT §7].
- **HTML blocks.** No Markdown is processed inside an HTML block, and a blank line ends it. markdown-it follows CommonMark here [OB §8.2].
- **Comments (P2).** An unclosed `%%` hides the rest of the note in Obsidian [OB §4.1]. If comments are added, never let one cross a blank line.

---

## 10. Unicode (NFC/NFD) and IME

### 10.1 Names
- **Three forms of a path.**
  - The **`VaultPath`**: byte-identical to the listing and used for I/O.
  - The **`key`**: `NFC` + lowercase, used for equality and lookup.
  - The **display** form: NFC (ARCHITECTURE §4).
- **Rules.**
  - Compare only with `key()`. [critic] *Changed:* look an entry up with `key()` when the spelling comes from outside (a typed link, a watcher path, switcher input, a collision check), but once found, identify it by its exact stored `VaultPath`, and let an exact match win over a key match (PLAT-06). Editor states, save controllers, history and recovery copies are keyed by that exact path. "Compare only with `key()`" would merge `A.md` and `a.md` on ext4, or NFC and NFD twins on NTFS, into one buffer.
  - [critic] `key()` maps U+00A0 and U+202F to a plain space before NFC and lowercasing, as Obsidian's `normalizePath` does [OB §0].
  - Create new names in NFC.
  - After create and rename, adopt the stored name that the backend reports. Read it back from the parent folder by `key`, because HFS+ volumes store NFD whatever we pass. APFS keeps the form given; NTFS and ext4 compare forms exactly.
  - Watcher events report the stored form, so match them by `key` [MT §9, OT §4.8].
- **Links, search and the switcher** normalize both sides to NFC [SB §11, MS §9, ZT §10].
- **Same `key`, different stored names.** On ext4 or NTFS, two stored names can share a `key`. List both; resolution prefers the exact stored name; collision checks treat the `key` as taken.
- **Content is never normalized** (EDIT-01). Search normalizes a copy.
- [critic] **CJK compatibility ideographs.** NFC maps U+F900–U+FAFF, which Korean uses for distinct readings of the same hanja, to the unified ideographs. A new name typed with them is stored with the unified form (accepted). Because content is never normalized, hanja text inside notes is safe.
- **Length.** A name may take at most 255 bytes of UTF-8, and Hangul uses 3 bytes per syllable [OB §10].

### 10.2 IME
- **CodeMirror handles composition itself.** Keymaps do not run while composing, and on Safari (WKWebView is the same engine) key events within 100 ms after `compositionend` are ignored [CM §10]. Pin `@codemirror/view` at 6.43.12 or later.
- **Live preview.** Map only while composing, and refresh after `compositionend` (§1.3) [OT §4.2, SB §4.5]. Prefer replacements that keep width near the caret, so reveal or hide does not move the composition target [CM §10].
- **Autosave** waits until composition ends (§3.1) [SB §4.5]. [critic] *Changed:* autosave does **not** wait, because it only reads the document (§3.1). What waits for `compositionend` is whatever dispatches into the editor: reloads, merges, LINK-07 edits of the open note and refresh effects (`compositionIdle`, §3.4).
- [critic] **Shortcuts in Hangul mode.** The global listener matches `e.key` and falls back to the physical key (`e.code`) when `e.key` is not ASCII: a jamo in Hangul mode, or `₩` on the backslash key of the Korean macOS layout. CodeMirror's keymap does the same for chords (verified), so only our own listener needs it (PLAT-10).
- [critic] **Mod-chords while composing** stay ignored by the guard, and the user presses them again. Running a note switch mid-composition can drop the syllable (EDIT-11 item 6).
- **Our own inputs and the shortcut listener** (switcher, rename, inline title, find, search, settings, and the window-level capture listener) return early on `e.isComposing || e.keyCode === 229`. WebKit can deliver the Enter that commits a syllable with `isComposing === false` but `keyCode === 229` [SB §4.5, MT §3.9].
  - Do not add a time window after `compositionend` for our own inputs. Korean users expect an Enter right after a syllable to act. Chromium (WebView2) sends a composing Enter (229) and then a real Enter (13), and acting on the second one is correct.
  - If double actions show up on macOS, add a window of 50 ms or less, for Enter only.
- **Alternative for simple inputs.** Commit on `keypress` Enter, which does not fire for the IME's own Enter [MT §3.9].
- **Linux AppImage.** Set `GTK_IM_MODULE_FILE` before GTK initializes and before any thread starts, since it is an environment variable [MS §9]. (PLAT-11)
  - [critic] `WEBKIT_DISABLE_DMABUF_RENDERER=1` goes in at the same point, and only when an NVIDIA proprietary driver is present (`/proc/driver/nvidia/version` exists), to avoid WebKitGTK's blank window there (PLAT-01).

### Pitfalls (Unicode and IME)
- Obsidian shipped more than 15 IME fixes: caret jumps, duplicated characters, characters placed behind the caret, a newline before tables. All of them targeted Chromium. Re-check on WKWebView and WebKitGTK [OB §4.8].
- **Guards.**
  - mdSilo has no composition guards anywhere [MS §3.3].
  - ink-mde's find input jumped on the committing Enter [CM §10].
  - Zettlr rebuilds decorations right next to the composition [ZT §4.6].
- **WebKit quirks.**
  - WebKit can keep drawing a stale caret after a paste. Nudge the selection in a microtask [SB §4.4].
  - A Chromium bug lost the first composed keystroke at a trailing newline [MT §3.9]; CodeMirror handles it.
- **Missing normalization.**
  - Path comparisons without NFC fail for NFD Hangul names (every project except Obsidian) [ZT §10, MT §9, MS §9, SB §11, OT §4.8].
  - mdSilo's SQLite prefix delete compared character counts with byte lengths, so children of Hangul folders survived deletion [MS §11]. Compare path components, not lengths.

---

## 11. Rename, move and delete

- **Rename.**
  - Flush first, then call `path_rename(from, to)`.
  - If `to` exists and is not the same entry (compare canonical paths), return `exists`. [critic] *Changed:* decide "same entry" by file identity: `(dev, ino)` from `std::os::unix::fs::MetadataExt` on Unix, and on Windows `fs::canonicalize`, which reads the stored name back through the file handle. Canonical path strings alone fail on Linux case-insensitive mounts (exFAT, ext4 casefold), where `realpath` keeps the case it was given [MT §9].
  - A rename that changes only case or Unicode form of the same entry goes through a temporary name in two steps, and rolls back if the second step fails [OT §2.3, SB §9]. [critic] Try the direct rename first (APFS, HFS+ and NTFS accept it), then read the stored name back from the parent folder. Fall back to the two steps only when the name did not change: Linux treats a rename onto the same inode as a no-op, which is what FAT and exFAT mounts produce. The temporary name keeps the extension (`<stem>.mn-tmp-<n>.md`, stem truncated to fit 255 bytes), so a crash between the steps leaves a listed note; ARCHITECTURE's `from.mn-tmp-<n>` would drop out of the tree.
  - The command returns the stored name (§10.1). Then re-point everything that holds the path.
- **Move.**
  - Moving a folder into its own subtree is refused; compare path components.
  - A cross-device rename (`EXDEV`) is refused, not emulated [MT §2].
- **Delete.**
  - Cancel the pending save first [MS §4]. Then use the `trash` crate. [critic] *Changed:* flush the open note first (SAVE-02), freeze its controller so no save can start, trash, and dispose the controller only after the trash succeeds. MS §4's lesson is that no save may run *after* the delete; cancelling *before* it loses the pending text whenever trashing fails or the permanent-delete confirmation is cancelled. Folders apply this to every open, cached or pinned note under them.
  - On a trash failure (some Linux setups), confirm a permanent delete.
  - Folders always confirm (TREE-08).
  - [critic] On macOS, set `DeleteMethod::NsFileManager` through `trash::macos::TrashContextExtMacos`. The default `Finder` method drives Finder with AppleScript and "might ask the user to give additional permissions" (verified in `trash` 5.2); a denial would turn every delete into the permanent-delete confirmation.
  - [critic] `path_trash`, `path_delete` and `path_rename` refuse the root (the empty path) themselves (PLAT-08).
- **Never delete then re-create for a rename;** mdSilo lost the creation time that way [MS §11]. **Never overwrite on a collision;** Zettlr deleted the target after a prompt [ZT §3.3].
- **Re-point** the editor-state cache, history, recent list and expanded set, then rewrite links (LINK-07). [critic] Pinned dirty notes, their save controllers and recovery copies are re-pointed too.

---

## 12. Window chrome and shortcuts

- **macOS window.**
  - `titleBarStyle: "Overlay"`, `hiddenTitle: true`, and a `trafficLightPosition` aligned to the 40 px header.
  - Drag regions use `data-tauri-drag-region`. Dragging needs the `core:window:allow-start-dragging` permission, and double-click zoom needs the toggle-maximize permission [OT §2.6].
  - [critic] With the sidebar hidden, pad the main strip's left edge by the traffic lights' width; drop the padding in full screen, detected on resize (NAV-04).
- [critic] **Window title.** The open note's name in NFC without its extension, or the vault name (PLAT-02). `core:window:allow-set-title` is already granted.
- **Startup.** Create the window with `visible: false` and the theme's background color, and call `show()` after the first paint [MT §8].
- **Plugins.**
  - `tauri-plugin-window-state` restores the window. Make sure a window restored onto a disconnected monitor moves to a visible display [OB RN:v0.11.10, MT §9].
  - Register `tauri-plugin-single-instance` first [OT §2.8]. [critic] It is P0 now (PLAT-05); `lib.rs` does not register it yet.
  - [critic] `tauri-plugin-store` 2.5 saves with a plain `fs::write` and ignores a file it cannot parse, so its next save replaces it with defaults (verified). Either write `settings.json` through our own `write_atomic` (§3.2), or keep the plugin and set an unparsable file aside before its first save (SET-01).
- **Menus.**
  - macOS: App (About, Hide, Hide Others, Show All, our custom Quit), Edit (the predefined Undo, Redo, Cut, Copy, Paste and Select All, which WKWebView needs for clipboard shortcuts) and Window.
  - Windows and Linux: no menu bar, because `Builder::menu` would add one to every window [OT §2.8].
- **Shortcuts.**
  - One capture-phase `keydown` listener reads the command registry and applies the IME guard.
  - `Mod` maps to Cmd or Ctrl.
  - Avoid Option-only chords on macOS and Ctrl+Alt+letter (AltGr) on Windows [MT §3.10]. Leave Cmd+\` to macOS [MT §3.10].
  - Ctrl+Alt+arrows rotate the screen with some Windows graphics drivers, so history also gets Alt+arrows (NAV-03).
  - [critic] Match `e.key`, then fall back to the physical key (`e.code`) when `e.key` is not ASCII (§10.2).
  - [critic] **CodeMirror's default keymaps collide with ours** (verified). `defaultKeymap` binds `Mod-i` (`selectParentSyntax`), `Mod-[` and `Mod-]` (indent), `Alt-ArrowLeft/Right` on Windows and Linux (syntax moves), `Mod-Enter` (`insertBlankLine`), `Ctrl-m` (`Shift-Alt-m` on macOS, `toggleTabFocusMode`), `Mod-/` and `Alt-A` (comments); `searchKeymap` binds `Mod-f`, `Mod-g`, `Mod-d`, `Mod-Shift-l` and `Mod-Alt-g` (`gotoLine`, a panel with a text label). Filter out `toggleTabFocusMode`, `gotoLine`, `toggleComment` and `toggleBlockComment`, and put our editor bindings in `Prec.high`. The global listener calls `preventDefault()` on keys it handles, and CodeMirror runs no handlers for an event that is already default-prevented (verified), so Cmd+[ or Alt+← never also indents or moves the caret.
  - [critic] Keep Esc unprevented when nothing is open: CodeMirror arms its 2-second "Tab leaves the editor" escape on Esc, but only if the event is not default-prevented (EDIT-04).
- [critic] **Engine defaults (PLAT-13).** wry leaves WebView2's browser accelerator keys and default context menus on, and adds nothing to WKWebView's or WebKitGTK's menus (verified in wry 0.57); zoom and swipe navigation are off by default. Cancel F5, Mod+R, Mod+Shift+R, Mod+P and Alt+←/→ in the capture listener, and call `preventDefault()` on `contextmenu` except over editable or selected text. wry denies new-window requests when no `on_new_window` handler is set; keep it unset.
- **OS file drops.** With `dragDropEnabled: false`, dropped files arrive as DOM `File` objects without paths. Read them with `File.arrayBuffer()` and write them through `binary_write` [OT §2.6].

---

## 13. Unit-test targets (pure functions only)

| Module | What to test |
|---|---|
| `utils/path` | `key()`; join and relative paths; prefix checks with a separator; `toAbsolute` on Windows-style roots. [critic] No-break spaces in `key()`; exact-before-key lookup; `toAbsolute` on UNC roots |
| [critic] `classifyHref` | `http(s)`, `mailto`, `tel`; vault paths with `./` and `../`; a target above the root; `file:`, `javascript:`, `data:`, drive and UNC paths, custom schemes; the LINK-01 extension allowlist |
| `utils/names` | Validation, including the 255-byte limit, reserved names and trailing dot or space; `uniqueName`. [critic] Reserved names before the first dot, `COM0`/`LPT0`, superscript digits and `CONIN$`; bidi and zero-width characters; a typed `.md` dropped; conflict-copy names truncated to 255 bytes at a character boundary |
| `utils/fuzzy` | Tier order, initial-consonant queries, partial syllables, tie-breaks |
| `markdown/resolve` | LINK-03 order, NFC and case, dotted names, images |
| `editor/syntax` | WikiLink, Highlight and (P1) CJK emphasis, on fixtures shared with the markdown-it plugins |
| `frontmatterRange` | `---` and `...` closers, trailing spaces, unterminated blocks, no frontmatter |
| `blockKind` / pair mapping | Node name to kind, previous kind, first block `none` |
| markdown-it plugins | Wikilinks, tasks, the `loose` class, alignment to class, the frontmatter line offset |
| Text utilities | Line-ending and BOM detect and restore round trip; `hunk` / minimal diff; merge (P1) disjoint vs overlapping |
| Save scheduler | `delay = min(400, firstDirtyAt + 2000 - now)` with fake timers; [critic] *changed:* a save fires while composing (no rescheduling); the 2 s / 10 s timing above 2 MB; a retry after a note switch reads the right note's state |
| Link rewrite (P1) | Keeping alias, heading, embed and encoding; escaping pipes in tables. [critic] Re-encoding with the note's own line ending and BOM |
| Rust | `vault::resolve` rejects `..`, absolute paths and prefixes; `write_atomic` in a temp dir; case-only rename; search folding offsets in UTF-16, including `İ`; mapping watcher events to changes, including the rename-by-destination rules. [critic] Per-platform component rules (`\` and `:` legal on Unix); symlink components rejected; the root refused by delete, trash and rename; `stale_vault`; a temp name independent of the note's name (a 255-byte name saves); `read_only` targets refused; `root_unavailable` instead of recreating the root; `Flag::Rescan` mapped to `any` |

There are no integration or E2E tests, and nobody launches the app to verify (the owner's rule).
