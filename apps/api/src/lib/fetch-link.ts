import { GOOGLE_DOC_RE, normalizeWs, stripHtml } from "./text.js";
import { fetchGoogleDocText } from "./google-docs.js";

/** Text of a link a teacher leader shares: a Google Doc/Sheet/Slides export, or the readable text of a web page. */
export async function fetchLinkText(url: string, maxChars = 80_000): Promise<{ title: string; text: string; status: "ok" | "private" | "error" }> {
  const g = new RegExp(GOOGLE_DOC_RE.source).exec(url);
  if (g) {
    const r = await fetchGoogleDocText(g[1] ?? "document", g[2] ?? "", maxChars);
    const title = r.text.split("\n").find((l) => l.trim().length > 3)?.trim().slice(0, 120) || `Google ${g[1] === "spreadsheets" ? "Sheet" : g[1] === "presentation" ? "Slides" : "Doc"}`;
    return { title, text: r.text, status: r.status };
  }
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20_000);
    const r = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": "WildflowerWisdom/1.0 (+https://mywildflower.replit.app)" } }).finally(() => clearTimeout(t));
    if (!r.ok) return { title: url, text: "", status: r.status === 401 || r.status === 403 ? "private" : "error" };
    const ct = r.headers.get("content-type") ?? "";
    const raw = (await r.text()).slice(0, 3_000_000);
    if (!ct.includes("html") && !ct.includes("text")) return { title: url, text: "", status: "error" };
    const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(raw)?.[1]?.trim() || new URL(url).hostname;
    const body = raw.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<nav[\s\S]*?<\/nav>/gi, "").replace(/<footer[\s\S]*?<\/footer>/gi, "");
    return { title, text: normalizeWs(stripHtml(body)).slice(0, maxChars), status: "ok" };
  } catch { return { title: url, text: "", status: "error" }; }
}
