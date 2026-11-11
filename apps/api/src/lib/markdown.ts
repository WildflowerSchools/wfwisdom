import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";

/**
 * Turning a Google Doc's HTML into the Markdown a page held in Wisdom is written in.
 *
 * A resource is edited in exactly one place. When a linked Google Doc is detached, Wisdom becomes that
 * place, so the document has to arrive in the format Wisdom's own editor works in. That is Markdown, and
 * the alternative considered was keeping the HTML and editing it: it would have kept every nuance of the
 * layout, and left staff editing markup by hand. Markdown keeps what matters in these documents
 * (headings, lists, emphasis, links, tables and pictures) and drops what does not survive in a library
 * anyway: fonts, colors, merged cells, page layout.
 *
 * `markdownToHtml` in services/native.ts is the other half. The two have to agree: whatever this writes,
 * that must read back.
 */
const BLOCK = new Set(["p", "div", "section", "article", "figure", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "blockquote", "pre", "hr"]);
const isEl = (n: ChildNode): n is Element => n.type === "tag";
const tidy = (s: string) => s.replace(/[ \t ]+/g, " ");
// Storing a picture or link address inside ( ) means a ) or a space in it would end it early.
const addr = (u: string) => u.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
const okLink = (u: string) => /^https?:\/\//i.test(u) || u.startsWith("/item/") || u.startsWith("/c/");
const okImage = (u: string) => /^https?:\/\//i.test(u) || u.startsWith("/api/files/native/");

/** Text and inline marks only: what can sit inside a paragraph, a list item or a table cell. */
function inline(nodes: ChildNode[]): string {
  let out = "";
  for (const n of nodes) {
    if (n.type === "text") { out += tidy(n.data.replace(/\s+/g, " ")); continue; }
    if (!isEl(n)) continue;
    const t = n.name;
    if (t === "br") { out += " "; continue; }
    if (t === "img") { const src = n.attribs.src ?? ""; if (okImage(src)) out += `![${(n.attribs.alt ?? "").replace(/[\[\]]/g, "")}](${addr(src)})`; continue; }
    if (t === "script" || t === "style" || t === "iframe") continue;
    const inner = inline(n.children);
    if (!inner.trim()) { out += inner; continue; }
    // Marks go inside the surrounding spaces: "** bold **" is not bold.
    const wrap = (mark: string) => `${/^\s/.test(inner) ? " " : ""}${mark}${inner.trim()}${mark}${/\s$/.test(inner) ? " " : ""}`;
    if (t === "strong" || t === "b") out += wrap("**");
    else if (t === "em" || t === "i") out += wrap("*");
    else if (t === "code") out += wrap("`");
    else if (t === "a") { const href = n.attribs.href ?? ""; out += okLink(href) ? `[${inner.trim().replace(/[\[\]]/g, "")}](${addr(href)})` : inner; }
    else out += inner;
  }
  return out;
}
const hasBlock = (n: Element): boolean => n.children.some((c) => isEl(c) && (BLOCK.has(c.name) || hasBlock(c)));

function table(el: Element): string {
  const rows: Element[] = []; const collect = (n: Element) => { for (const c of n.children) if (isEl(c)) { if (c.name === "tr") rows.push(c); else if (c.name !== "table") collect(c); } };
  collect(el);
  const cells = rows.map((r) => r.children.filter(isEl).filter((c) => c.name === "td" || c.name === "th").map((c) => inline(flatten(c.children)).trim().replace(/\|/g, "\\|")));
  const width = Math.max(0, ...cells.map((r) => r.length));
  if (!width) return "";
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  // Markdown tables need a header row; a document's table usually has one, and where it does not the first row serves.
  return [line(cells[0]!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...cells.slice(1).map(line)].join("\n");
}
/** A cell or list item can hold paragraphs; inside one line of Markdown they become runs of text. */
function flatten(nodes: ChildNode[]): ChildNode[] {
  const out: ChildNode[] = [];
  for (const n of nodes) { if (isEl(n) && BLOCK.has(n.name)) { if (out.length) out.push({ type: "text", data: " " } as ChildNode); out.push(...flatten(n.children)); } else out.push(n); }
  return out;
}

function blocks(nodes: ChildNode[], out: string[], depth = 0): void {
  let run: ChildNode[] = [];
  const flush = () => { const s = inline(run).trim(); if (s) out.push(s); run = []; };
  for (const n of nodes) {
    if (!isEl(n)) { run.push(n); continue; }
    const t = n.name;
    if (t === "script" || t === "style" || t === "head" || t === "title") continue;
    if (!BLOCK.has(t) && !hasBlock(n)) { run.push(n); continue; }
    flush();
    const h = /^h([1-6])$/.exec(t);
    // Written so they read back at the same level: the page title is the h1, so a document's top heading is "#", which renders as h2.
    if (h) { const s = inline(n.children).trim(); if (s) out.push(`${"#".repeat(Math.min(3, Math.max(1, Number(h[1]) - 1)))} ${s.replace(/\*\*/g, "")}`); continue; }
    if (t === "ul" || t === "ol") {
      const items: string[] = []; let i = Number(n.attribs.start) || 1;
      for (const li of n.children.filter(isEl).filter((c) => c.name === "li")) {
        const own = li.children.filter((c) => !(isEl(c) && (c.name === "ul" || c.name === "ol")));
        const s = inline(flatten(own)).trim();
        if (s) items.push(`${"  ".repeat(depth)}${t === "ol" ? `${i++}.` : "-"} ${s}`);
        for (const sub of li.children.filter(isEl).filter((c) => c.name === "ul" || c.name === "ol")) { const nested: string[] = []; blocks([sub], nested, depth + 1); items.push(...nested); }
      }
      if (items.length) out.push(items.join("\n"));
      continue;
    }
    if (t === "table") { const s = table(n); if (s) out.push(s); continue; }
    if (t === "blockquote") { const inner: string[] = []; blocks(n.children, inner); if (inner.length) out.push(inner.join("\n\n").split("\n").map((l) => `> ${l}`).join("\n")); continue; }
    if (t === "pre") { const s = inline(n.children).trim(); if (s) out.push(s); continue; }
    if (t === "hr") { out.push("---"); continue; }
    blocks(n.children, out, depth);
  }
  flush();
}

export function htmlToMarkdown(html: string): string {
  const out: string[] = [];
  blocks(parseDocument(html).children, out);
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}
