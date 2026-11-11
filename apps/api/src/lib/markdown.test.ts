import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./markdown.js";
import { markdownToHtml } from "../services/native.js";

// What a Google Doc looks like once exported and sanitized: paragraphs wrapped in spans, a header
// picture, a table whose cells hold paragraphs, and a nested list.
const doc = `<p><span><img src="/api/files/native/1AbCdEfGhIjKlMnOp" alt="Wildflower logo"></span></p>
<h2><span>Tuition policy</span></h2>
<p><span>Families pay </span><strong>monthly</strong><span>, and may ask for </span><a href="https://example.org/aid?x=1&amp;y=2">flexible tuition</a><span>.</span></p>
<h3>Schedule</h3>
<table><tbody><tr><td><p><strong>Plan</strong></p></td><td><p><strong>Due</strong></p></td></tr><tr><td><p>Monthly</p></td><td><p>The 1st</p><p>of each month</p></td></tr><tr><td><p>A | B</p></td><td></td></tr></tbody></table>
<ul><li>First<ul><li>Nested</li></ul></li><li>Second</li></ul>
<ol start="3"><li>Third step</li></ol>
<hr><p></p><script>alert(1)</script>`;

describe("bringing a Google Doc into Wisdom", () => {
  const md = htmlToMarkdown(doc);
  it("keeps the picture, the headings, the emphasis and the link", () => {
    expect(md).toContain("![Wildflower logo](/api/files/native/1AbCdEfGhIjKlMnOp)");
    expect(md).toContain("# Tuition policy");
    expect(md).toContain("## Schedule");
    expect(md).toContain("Families pay **monthly**, and may ask for [flexible tuition](https://example.org/aid?x=1&y=2).");
    expect(md).not.toContain("alert");
  });
  it("writes the table as a table, with a cell's paragraphs joined and a bar inside a cell escaped", () => {
    expect(md).toContain("| **Plan** | **Due** |\n| --- | --- |\n| Monthly | The 1st of each month |\n| A \\| B |  |");
  });
  it("keeps list order and numbering", () => {
    expect(md).toContain("- First\n  - Nested\n- Second");
    expect(md).toContain("3. Third step");
  });
  // The point of the format: what comes in from Google must read back out as the same document.
  it("reads back as the same document", () => {
    const html = markdownToHtml(md);
    expect(html).toContain('<img src="/api/files/native/1AbCdEfGhIjKlMnOp" alt="Wildflower logo" />');
    expect(html).toContain("<h2>Tuition policy</h2>");
    expect(html).toContain('<a href="https://example.org/aid?x=1&amp;y=2"');
    expect(html).toContain("<table><thead><tr><th><strong>Plan</strong></th><th><strong>Due</strong></th></tr></thead><tbody><tr><td>Monthly</td><td>The 1st of each month</td></tr><tr><td>A | B</td><td></td></tr></tbody></table>");
    expect(html).toContain("<hr />");
    expect(htmlToMarkdown(html)).toBe(md.replace("  - Nested", "- Nested").replace("3. Third step", "1. Third step").replace("- Second\n\n1.", "- Second\n\n1."));
  });
});

describe("pages written in Wisdom", () => {
  it("still render what they did before tables and pictures were added", () => {
    expect(markdownToHtml("# Title\n\nSome *text* with a [link](https://example.org).\n\n- one\n- two\n\n> quoted")).toBe('<h2>Title</h2>\n<p>Some <em>text</em> with a <a href="https://example.org">link</a>.</p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<blockquote>quoted</blockquote>');
  });
  it("does not take a picture from anywhere but the web or Wisdom's own files", () => {
    expect(markdownToHtml("![x](javascript:alert(1))")).not.toContain("<img");
    expect(markdownToHtml("![x](/etc/passwd)")).not.toContain("<img");
  });
  it("renders a table with no rule line as rows without a header", () => {
    expect(markdownToHtml("| a | b |\n| c | d |")).toBe("<table><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>");
  });
});
