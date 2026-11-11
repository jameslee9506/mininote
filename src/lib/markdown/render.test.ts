import { describe, expect, it } from "vitest";
import { splitImageSize } from "./plugins/images";
import { anchorKey, BROKEN_IMAGE_SRC, renderUnsafe, type RenderContext } from "./render";

/** Anything containing "Missing"/"missing" is unresolved; images become fake asset URLs. */
const ctx: RenderContext = {
  from: "notes/Today.md",
  resolveWiki: (target) => (target.includes("Missing") ? null : `${target}.md`),
  resolveImage: (src, kind) => (src.includes("missing") ? null : `asset://localhost/${kind}/${src}`),
  resolveHref: (href) => (href.includes("missing") ? null : href),
};

const render = (text: string): string => renderUnsafe(text, ctx);

describe("wikilinks", () => {
  it("renders target, alias and heading forms", () => {
    expect(render("[[Note]]")).toContain('<a class="internal-link" data-wiki="Note" role="link" tabindex="0">Note</a>');
    expect(render("[[Note|Shown]]")).toContain('data-wiki="Note" role="link" tabindex="0">Shown</a>');
    expect(render("[[Note#Part|Shown]]")).toContain('data-wiki="Note" data-subpath="Part" role="link" tabindex="0">Shown</a>');
    // Without an alias the target shows as typed, heading included (LIVE-14).
    expect(render("[[Note#Part]]")).toContain('data-subpath="Part" role="link" tabindex="0">Note#Part</a>');
  });

  it("treats [[#heading]] as the current note, never unresolved", () => {
    expect(render("[[#Part]]")).toContain('<a class="internal-link" data-wiki="" data-subpath="Part"');
  });

  it("marks unresolved targets", () => {
    expect(render("[[Missing note]]")).toContain('class="internal-link is-unresolved" data-wiki="Missing note"');
  });

  it("follows the editor grammar: one line, no empty target, inline code wins", () => {
    expect(render("[[]] and [[open")).not.toContain("<a");
    expect(render("[[a\nb]]")).not.toContain("<a");
    expect(render("`[[x]]`")).toContain("<code>[[x]]</code>");
    expect(render("\\[[x]]")).not.toContain("<a");
    expect(render("[[\uD68C\uC758\uB85D]]")).toContain('data-wiki="\uD68C\uC758\uB85D" role="link" tabindex="0">\uD68C\uC758\uB85D</a>');
  });

  it("reads an escaped alias bar, in table cells and elsewhere", () => {
    expect(render("| [[a\\|b]] |\n|---|")).toContain('data-wiki="a" role="link" tabindex="0">b</a>');
    expect(render("[[a\\|b]]")).toContain('data-wiki="a" role="link" tabindex="0">b</a>');
  });

  it("escapes targets and text", () => {
    const html = render('[[<b>"x"</b>]]');
    expect(html).toContain('data-wiki="&lt;b&gt;&quot;x&quot;&lt;/b&gt;"');
    expect(html).not.toContain("<b>");
  });

  it("never nests a wikilink inside a markdown link", () => {
    expect(render("[see [[x]]](url)").match(/<a /g)).toHaveLength(1);
  });
});

describe("embeds and images", () => {
  it("resolves image embeds and applies Obsidian sizes", () => {
    expect(render("![[pic.png|300]]")).toContain('<img src="asset://localhost/wiki/pic.png" alt="pic.png" width="300"');
    expect(render("![[pic.png|100x50]]")).toContain('width="100" height="50"');
    expect(render("![[pic.png|A cat]]")).toContain('alt="A cat"');
  });

  it("renders an unresolved embed as the broken box", () => {
    expect(render("x ![[missing.png]]")).toContain(`<img src="${BROKEN_IMAGE_SRC}" alt="missing.png" class="is-broken">`);
  });

  it("renders note embeds as links (transclusion is P2)", () => {
    expect(render("![[Some note]]")).toContain('<a class="internal-link" data-wiki="Some note"');
  });

  it("resolves markdown images, keeps URLs and unresolvable sources as written", () => {
    expect(render("x ![alt|200](a.png)")).toContain('<img src="asset://localhost/href/a.png" alt="alt" width="200">');
    expect(render("x ![](https://example.com/y.png)")).toContain('<img src="https://example.com/y.png" alt="">');
    expect(render("x ![](missing.png)")).toContain('<img src="missing.png" alt="">');
  });

  it("marks an image alone in its paragraph as standalone", () => {
    expect(render("![](a.png)")).toContain('class="standalone"');
    expect(render("text ![](a.png)")).not.toContain("standalone");
  });

  it("splits sizes off alt text", () => {
    expect(splitImageSize("300")).toEqual({ alt: "", width: "300", height: null });
    expect(splitImageSize("cat|300x200")).toEqual({ alt: "cat", width: "300", height: "200" });
    expect(splitImageSize("a | b")).toEqual({ alt: "a | b", width: null, height: null });
  });
});

describe("highlight", () => {
  it("renders ==mark== with strikethrough-style flanking", () => {
    expect(render("a ==b== c")).toBe('<p data-line="0">a <mark>b</mark> c</p>\n');
    expect(render("==a **b**==")).toContain("<mark>a <strong>b</strong></mark>");
    expect(render("a == b == c")).not.toContain("<mark>");
  });
});

describe("tasks", () => {
  it("renders clickable checkboxes carrying the item's source line", () => {
    const html = render("intro\n\n- [ ] one\n- [x] two\n  - [X] three\n- plain");
    expect(html).toContain(
      '<li class="task-list-item" data-line="2">\n<p data-line="2"><span class="task-box" role="checkbox" tabindex="0" aria-checked="false"',
    );
    expect(html).toMatch(/aria-checked="false"[^>]*data-line="2"><\/span>one<\/p>/);
    expect(html).toMatch(
      /<li class="task-list-item is-checked" data-line="3">\n<p data-line="3"><span [^>]*aria-checked="true"[^>]*data-line="3"><\/span>two/,
    );
    expect(html).toMatch(/data-line="4"><\/span>three/);
    expect(html).toContain('<li data-line="5">\n<p data-line="5">plain</p>');
    expect(html).not.toContain("[ ]");
  });

  it("accepts ordered and empty tasks but needs a blank after the marker", () => {
    expect(render("1. [ ] a")).toContain('<ol>\n<li class="task-list-item" data-line="0">');
    expect(render("- [ ]")).toContain('data-line="0"></span></p>');
    expect(render("- [ ]task")).not.toContain("task-box");
  });

  it("draws a box only where a click can toggle the line (the editor's rule)", () => {
    // Escapes and entities are literal brackets; markdown-it has already turned them into text.
    expect(render("- \\[x] a")).not.toContain("task-box");
    expect(render("- &#91; ] a")).not.toContain("task-box");
    // The box sits on the marker line, after exactly one list marker.
    expect(render("-\n  [ ] a")).not.toContain("task-box");
    expect(render("- - [ ] a")).not.toContain("task-box");
    expect(render("1. - [ ] a")).not.toContain("task-box");
    // Quote markers in front are fine, and so is a box alone on its line.
    expect(render("> - [ ] a")).toMatch(/data-line="0"><\/span>a<\/p>/);
    expect(render("- [ ]\n  b")).toContain("task-box");
  });

  it("counts lines from the top of the file, frontmatter included", () => {
    expect(render("---\ntags: x\n---\n\n- [ ] t")).toMatch(/data-line="4"><\/span>t/);
  });
});

describe("lists", () => {
  it("adds `loose` only to loose lists and keeps every item paragraph", () => {
    expect(render("- a\n\n- b")).toBe(
      '<ul class="loose">\n<li data-line="0">\n<p data-line="0">a</p>\n</li>\n<li data-line="2">\n<p data-line="2">b</p>\n</li>\n</ul>\n',
    );
    expect(render("- a\n- b")).toBe(
      '<ul>\n<li data-line="0">\n<p data-line="0">a</p>\n</li>\n<li data-line="1">\n<p data-line="1">b</p>\n</li>\n</ul>\n',
    );
  });

  it("decides tightness per list", () => {
    const html = render("- a\n\n- b\n  - c\n  - d");
    expect(html).toContain('<ul class="loose">');
    expect(html).toContain('<p data-line="2">b</p>\n<ul>\n<li data-line="3">\n<p data-line="3">c</p>');
  });

  it("adds `has-blocks` to lists whose items hold blocks, nested lists aside", () => {
    expect(render("1. Install:\n   ```\n   npm i\n   ```\n2. Run:")).toContain('<ol class="has-blocks">');
    expect(render("- a\n  > q\n- b")).toContain('<ul class="has-blocks">');
    expect(render("- a\n\n  ```\n  x\n  ```\n\n- b")).toContain('<ul class="loose has-blocks">');
    expect(render("- a\n  - b\n- c")).not.toContain("class=");
  });
});

describe("tables", () => {
  it("wraps tables and turns alignment into classes", () => {
    const html = render("| a | b | c | d |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |");
    expect(html.startsWith('<div class="table-wrap">\n<table data-line="0">')).toBe(true);
    expect(html.trimEnd().endsWith("</table>\n</div>")).toBe(true);
    expect(html).toContain('<th class="align-left">a</th>\n<th class="align-center">b</th>\n<th class="align-right">c</th>\n<th>d</th>');
    expect(html).toContain('<td class="align-right">3</td>');
    expect(html).not.toContain("style=");
  });
});

describe("frontmatter", () => {
  it("renders a closed block as muted pre, fences included, and parses the rest", () => {
    expect(render("---\ntitle: <x>\n...\n# H")).toBe(
      '<pre class="frontmatter"><code>---\ntitle: &lt;x&gt;\n...</code></pre>\n<h1 data-line="3">H</h1>\n',
    );
  });

  it("requires a closing fence and line 1", () => {
    expect(render("---\ntitle")).toBe('<hr data-line="0">\n<p data-line="1">title</p>\n');
    expect(render("x\n\n---\na: 1\n---")).not.toContain("frontmatter");
    expect(render(" ---\na\n---")).not.toContain("frontmatter");
  });

  it("shows an empty block as its two fences, as the editor does", () => {
    expect(render("---\n---\ntext")).toBe('<pre class="frontmatter"><code>---\n---</code></pre>\n<p data-line="2">text</p>\n');
  });
});

describe("fences", () => {
  it("labels a fence with the first word of its info string, shortened like the editor", () => {
    expect(render("```ts title=x\ncode\n```")).toContain('<pre><code data-lang="ts" data-line="0" class="language-ts">');
    expect(render("```\ncode\n```")).toBe('<pre><code data-line="0">code\n</code></pre>\n');
    expect(render("```abcdefghijklmnopqrstuvwxyz\nx\n```")).toContain('data-lang="abcdefghijklmnopqrstuvwx"');
  });
});

describe("source lines", () => {
  it("puts each block's 0-based start line in data-line", () => {
    const html = render("# H\n\ntext\n\n> q\n\n---\n\n```js\ncode\n```\n\n    indented\n\n| a |\n|---|\n| 1 |");
    expect(html).toContain('<h1 data-line="0">H</h1>');
    expect(html).toContain('<p data-line="2">text</p>');
    expect(html).toContain('<blockquote data-line="4">\n<p data-line="4">q</p>');
    expect(html).toContain('<hr data-line="6">');
    // markdown-it puts a fence's attributes on its <code>, an indented block's on its <pre>.
    expect(html).toContain('<pre><code data-lang="js" data-line="8" class="language-js">');
    expect(html).toContain('<pre data-line="12"><code>');
    expect(html).toContain('<table data-line="14">\n<thead>\n<tr data-line="14">');
    expect(html).toContain('<tr data-line="16">\n<td>1</td>');
  });
});

describe("links and text", () => {
  it("renders single newlines as breaks", () => {
    expect(render("a\nb")).toBe('<p data-line="0">a<br>\nb</p>\n');
  });

  it("marks internal markdown links and their resolution", () => {
    expect(render("[a](other.md)")).toContain('<a href="other.md" class="internal-link">a</a>');
    expect(render("[a](missing.md)")).toContain('class="internal-link is-unresolved"');
    expect(render("[a](https://example.com)")).toContain('<a href="https://example.com">a</a>');
    expect(render("[a](#part)")).toContain('<a href="#part">a</a>');
  });

  it("autolinks only openable URLs", () => {
    expect(render("https://a.com/x")).toContain('<a href="https://a.com/x">');
    expect(render("me@example.com")).toContain('href="mailto:me@example.com"');
    expect(render("README.md ftp://x.y //host/x")).not.toContain("<a");
  });

  it("autolinks www. addresses the way the editor does (GFM)", () => {
    expect(render("see www.example.com today")).toContain(
      'see <a href="https://www.example.com">www.example.com</a> today',
    );
    expect(render("www.example.com/a_(b).")).toContain(
      '<a href="https://www.example.com/a_(b)">www.example.com/a_(b)</a>.',
    );
    expect(render("www.x WWW.example.com awww.x.com www.ex_ample.com")).not.toContain("<a");
  });

  it("autolinks right after a strikethrough, highlight or code mark, as the editor does", () => {
    const link = '<a href="https://www.example.com">www.example.com</a>';
    expect(render("~~www.example.com~~")).toContain(`<s>${link}</s>`);
    expect(render("==www.example.com==")).toContain(`<mark>${link}</mark>`);
    expect(render("`x`www.example.com")).toContain(`</code>${link}`);
    expect(render("~~me@example.com~~")).toContain('<s><a href="mailto:me@example.com">');
    // Never inside another link, and never an invalid or unsafe target.
    expect(render("[~~www.example.com~~](https://x.com)")).toBe('<p data-line="0"><a href="https://x.com"><s>www.example.com</s></a></p>\n');
    expect(render("~~www.x~~ ~~javascript:alert(1)~~")).not.toContain("<a");
  });
});

describe("block dialect (shared with the editor, editor/syntax.test.ts)", () => {
  it("has no setext headings: a line under text never changes it", () => {
    expect(render("\uAC00\n-")).toBe("<p data-line=\"0\">\uAC00<br>\n-</p>\n");
    expect(render("\uAC00\n=")).toBe("<p data-line=\"0\">\uAC00<br>\n=</p>\n");
    expect(render("\uAC00\n===")).not.toContain("<h1");
    expect(render("\uAC00\n---")).toBe("<p data-line=\"0\">\uAC00</p>\n<hr data-line=\"1\">\n");
    expect(render("\uAC00\n- \uB098")).toContain("<ul>");
  });

  it("ends a quote at the first line without its mark", () => {
    expect(render("> a\nb")).toBe('<blockquote data-line="0">\n<p data-line="0">a</p>\n</blockquote>\n<p data-line="1">b</p>\n');
    expect(render("> a\n> b\nc")).toContain("<p data-line=\"0\">a<br>\nb</p>\n</blockquote>\n<p data-line=\"2\">c</p>");
    // An indented line is no lazy line either: it starts a code block.
    expect(render("> a\n    b")).toContain("</blockquote>\n<pre");
    expect(render("> - a\n> b")).toContain("</ul>\n<p data-line=\"1\">b</p>\n</blockquote>");
  });

  it("ends a list item at the first line indented less than its text", () => {
    expect(render("- a\nb")).toContain("</ul>\n<p data-line=\"1\">b</p>");
    expect(render("1. a\n  b")).toContain("</ol>\n<p data-line=\"1\">b</p>");
    expect(render("- a\n  b")).toContain("<p data-line=\"0\">a<br>\nb</p>");
    // Out of the nested item, still in the outer one; then out of both.
    expect(render("- a\n  - b\n  c")).toContain("</ul>\n<p data-line=\"2\">c</p>\n</li>");
    expect(render("- a\n  - b\n c")).toContain("</li>\n</ul>\n<p data-line=\"2\">c</p>");
    expect(render("- > q\n  b")).toContain("</blockquote>\n<p data-line=\"1\">b</p>\n</li>");
  });

  it("keeps tasks and tables whole when the next line is outside them", () => {
    expect(render("- [ ] a\nb")).toContain('class="task-list-item"');
    expect(render("- [ ] a\nb")).toContain("</ul>\n<p data-line=\"1\">b</p>");
    expect(render("| a | b |\n| - | - |\n| 1 | 2 |")).toContain("<td>1</td>");
    // A row without the item's indentation is no row of the item's table.
    expect(render("- | a | b |\n  | - | - |\n| c | d |")).toContain("</ul>\n<p data-line=\"2\">| c | d |</p>");
  });
});

describe("anchorKey", () => {
  it("matches headings, slugs and wikilink subpaths alike (the editor's loose rule)", () => {
    expect(anchorKey("Meeting Notes!")).toBe("meeting-notes");
    expect(anchorKey("meeting-notes")).toBe("meeting-notes");
    expect(anchorKey("  Step 1: Set up  ")).toBe("step-1-set-up");
    expect(anchorKey("C# notes")).toBe(anchorKey("c-notes"));
    expect(anchorKey("\uD68C\uC758 \uC694\uC57D".normalize("NFD"))).toBe("\uD68C\uC758-\uC694\uC57D");
  });
});
