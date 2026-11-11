import { and, eq, getDb, inArray, itemChunks, itemMeta, items, jobs, placements, sql, subjobs } from "@wfw/db";
import type { ItemSummary, ResourceLanguage } from "@wfw/shared";
import { embed, respondJson, respond } from "../lib/openai.js";
import { logger } from "../logger.js";
import { getSettings } from "../settings.js";
import { filterWhere, itemsByIds, toSummary, visibleWhere, type ItemRow } from "./items.js";
import { loadVectors, searchVectors, vectorCount, vectorsVersion } from "./vectors.js";

const REWRITE_SYSTEM = (jobs: { key: string; name: string }[]) => `You widen a teacher leader's search for Wildflower Schools' knowledge base (Connected). Expand shorthand (SSJ = School Startup Journey, TL = teacher leader, ETL = emerging teacher leader, ops guide, hub, flexible tuition, 501c3, TC = Transparent Classroom). Keep the query under 20 words and do not add topics the searcher did not ask about.
Return search terms, not a question and not a sentence: no "what is", no "how do I". Do not add "Wildflower" or "Wildflower Schools" to words that did not carry it. If the words are already plain search terms with no shorthand to expand, return them exactly as typed.
Also pick the one job the search is about, or "none".
Jobs: ${jobs.map((j) => `${j.key} = ${j.name}`).join("; ")}
Return JSON {"query": string, "keywords": string[] (3-6), "job": string}.`;
const REWRITE_SCHEMA = { name: "rewrite", schema: { type: "object", additionalProperties: false, required: ["query", "keywords", "job"], properties: { query: { type: "string" }, keywords: { type: "array", items: { type: "string" } }, job: { type: "string" } } } };
export interface SearchResponse { query: string; rewritten: string | null; mode: "semantic" | "keyword"; results: ItemSummary[]; }

/** Recent searches are answered from memory: the same words from the same kind of reader give the same list for a while. */
const cache = new Map<string, { at: number; version: number; value: SearchResponse }>();
const CACHE_TTL = 10 * 60_000;
function cached(key: string): SearchResponse | null { const c = cache.get(key); if (!c) return null; if (Date.now() - c.at > CACHE_TTL || c.version !== vectorsVersion()) { cache.delete(key); return null; } return c.value; }
function remember(key: string, value: SearchResponse): void { if (cache.size > 300) cache.delete(cache.keys().next().value!); cache.set(key, { at: Date.now(), version: vectorsVersion(), value }); }

/**
 * One tsquery per arm, OR'd together, or null when there is nothing to ask for.
 *
 * `websearch_to_tsquery` ANDs the words within a single string, so handing it the reader's words, the
 * model's rewrite and every keyword joined together turned each of them into a requirement. On
 * "school startup journey" that narrowed the keyword candidates from 97 items to 12 and dropped the
 * School Startup Journey series itself — the rewrite was acting as a filter instead of a hint.
 * Each arm is its own tsquery and the arms are OR'd; `ts_rank_cd` still puts an item that satisfies
 * every arm above one that only carries a single keyword.
 */
export function ftsQuery(texts: string[]): ReturnType<typeof sql> | null {
  const arms = [...new Set(texts.map((t) => t.trim()).filter(Boolean))].slice(0, 8);
  if (!arms.length) return null;
  return sql`(${sql.join(arms.map((t) => sql`websearch_to_tsquery('english', ${t})`), sql` || `)})`;
}

const SEARCH_STOP = new Set(["the", "and", "for", "with", "from", "how", "our", "your", "what", "when", "does", "about", "into", "that", "this"]);
const searchWords = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
const searchStem = (t: string) => t.replace(/(ies|es|s)$/, "");
/** The words the reader typed, minus filler. Two letters is the floor, so "SSJ", "990" and "ABA" count. */
export const typedTerms = (query: string): string[] => [...new Set(searchWords(query).filter((t) => !SEARCH_STOP.has(t)))];
/**
 * How much of what the reader typed the title carries, from 0 to 1.
 *
 * Someone who types a name they remember is looking for the thing called that, so this outweighs how
 * often the words turn up in a body. Cover density counts every occurrence, which is why "roots" put
 * "Wildflower's Roots in Research" fourth, behind three long documents that mention the word.
 */
export function titleCoverage(query: string, title: string): number {
  const typed = typedTerms(query);
  if (!typed.length) return 0;
  const lower = title.toLowerCase();
  const words = searchWords(title).map(searchStem);
  return typed.filter((t) => words.includes(searchStem(t)) || lower.includes(t)).length / typed.length;
}

/** A keyword candidate: its rank over the whole document, and its rank over the title alone. */
type FtsRow = { id: string; rank: number; titleRank: number };

/**
 * `rewrite: false` skips the model's rewrite of the query. The Claude connector passes it: Claude has
 * already turned the person's question into search words before calling, so a second model doing the
 * same job only adds a call and a delay. `jobKey` is the hint the rewrite would otherwise have supplied.
 */
export async function search(query: string, opts: { staff: boolean; limit?: number; userId?: string | null; language?: ResourceLanguage; regions?: string[]; rewrite?: boolean; jobKey?: string | null }): Promise<SearchResponse> {
  const s = await getSettings();
  const db = getDb();
  const limit = opts.limit ?? 10;
  const reader = { language: opts.language, regions: opts.regions };
  const key = `${query.trim().toLowerCase()}|${opts.staff}|${opts.language ?? "all"}|${[...(opts.regions ?? [])].sort().join("+") || "all"}|${limit}|${opts.rewrite === false ? `norewrite:${opts.jobKey ?? ""}` : "rewrite"}`;
  const hit = cached(key);
  if (hit) return hit;
  let rewritten: string | null = null; let keywords: string[] = []; let jobKey: string | null = opts.rewrite === false ? opts.jobKey ?? null : null;
  let mode: SearchResponse["mode"] = "semantic";
  let ranked: { itemId: string; rel: number }[] = [];
  let ftsRows: FtsRow[] = [];
  const fts = (texts: string[]) => {
    const q = ftsQuery(texts);
    if (!q) return Promise.resolve([] as FtsRow[]);
    // The title as its own vector, so a match on it can be told apart from a match anywhere in the body.
    const titleVec = sql`to_tsvector('english', coalesce(${itemMeta.displayTitle}, ${items.title}))`;
    return db.select({ id: items.id, rank: sql<number>`ts_rank_cd(${sql.raw('"items"."fts"')}, ${q})`, titleRank: sql<number>`ts_rank_cd(${titleVec}, ${q})` }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id))
      // A staff title is not in the generated column, which is built from Connected's title, so it is matched here too.
      .where(and(visibleWhere(opts.staff), filterWhere(reader), sql`(${sql.raw('"items"."fts"')} @@ ${q} or ${titleVec} @@ ${q})`))
      // Title matches first. Cover density counts every occurrence, so without this a long document that
      // mentions the word repeatedly outranks the one named after it and can fall outside the candidates
      // entirely: on "roots", "Wildflower's Roots in Research" came fourth behind three bodies.
      .orderBy(sql`3 desc, 2 desc`).limit(60).catch(() => [] as FtsRow[]);
  };
  try {
    // The model's rewrite and the embedding of the words as typed run side by side; the rewrite's embedding follows.
    const ai = !s.killSwitch;
    const [rw, raw] = await Promise.all([
      ai && opts.rewrite !== false ? db.select({ key: jobs.key, name: jobs.name }).from(jobs).where(eq(jobs.hidden, false)).then(async (jobList) => { const r = await respondJson<{ query: string; keywords: string[]; job: string }>({ model: s.assistModel, system: REWRITE_SYSTEM(jobList), user: query, schema: REWRITE_SCHEMA, maxOutput: 200, timeoutMs: 10_000 }); return { ...r.data, jobList }; }).catch((e: Error) => { logger.warn({ err: e.message }, "search rewrite unavailable"); return null; }) : Promise.resolve(null),
      ai ? embed([query], s.embeddingModel).then((r) => r.vectors[0] ?? null).catch(() => null) : Promise.resolve(null),
      loadVectors(),
    ]);
    if (rw) { rewritten = rw.query; keywords = rw.keywords; jobKey = rw.jobList.some((j) => j.key === rw.job) ? rw.job : null; }
    const [second, rows] = await Promise.all([ai && rewritten && rewritten.toLowerCase() !== query.toLowerCase() ? embed([rewritten], s.embeddingModel).then((r) => r.vectors[0] ?? null).catch(() => null) : Promise.resolve(null), fts([query, rewritten ?? "", ...keywords])]);
    ftsRows = rows;
    const v = raw && second ? raw.map((x, i) => (x + (second[i] ?? 0)) / 2) : raw;
    if (v && vectorCount() > 0) ranked = searchVectors(v, 60).map((r) => ({ itemId: r.itemId, rel: r.score }));
  } catch (e) { logger.warn({ err: (e as Error).message }, "semantic search unavailable, falling back to keyword"); ftsRows = await fts([query]); }
  // Hybrid: fuse semantic ranks with keyword (full-text) ranks by reciprocal rank fusion, so items that match on both rise.
  if (ranked.length === 0) {
    mode = "keyword";
    // With no semantic pass to fuse with, the keyword rank alone decides the order, so the title
    // signal has to be carried into it rather than left behind in the SQL ordering.
    ranked = ftsRows.map((r) => ({ itemId: r.id, rel: 10 * Number(r.titleRank) + Number(r.rank) }));
    if (ranked.length === 0) {
      const like = await db.select({ id: items.id }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(visibleWhere(opts.staff), filterWhere(reader), sql`lower(coalesce(${itemMeta.displayTitle}, ${items.title})) like ${"%" + query.toLowerCase() + "%"}`)).limit(30);
      ranked = like.map((r) => ({ itemId: r.id, rel: 0.5 }));
    }
  } else {
    const fused = new Map<string, number>();
    ranked.forEach((r, i) => fused.set(r.itemId, (fused.get(r.itemId) ?? 0) + 1 / (30 + i)));
    ftsRows.forEach((r, i) => fused.set(r.id, (fused.get(r.id) ?? 0) + 0.8 / (30 + i)));
    ranked = [...fused.entries()].map(([itemId, rel]) => ({ itemId, rel })).sort((a, b) => b.rel - a.rel).slice(0, 60);
  }
  // Semantic hits are filtered here rather than in the vector index, so the filter row applies to every path.
  const map = await itemsByIds(ranked.map((r) => r.itemId), opts.staff, reader);
  const inJob = new Set<string>();
  if (jobKey && ranked.length) {
    const rows = await db.select({ itemId: placements.itemId }).from(placements).innerJoin(subjobs, eq(subjobs.id, placements.subjobId)).innerJoin(jobs, eq(jobs.id, subjobs.jobId)).where(and(eq(jobs.key, jobKey), inArray(placements.itemId, ranked.map((r) => r.itemId))));
    for (const r of rows) inJob.add(r.itemId);
  }
  const maxRel = Math.max(...ranked.map((r) => r.rel), 1e-6); const minRel = Math.min(...ranked.map((r) => r.rel), maxRel);
  // The words the reader actually typed decide the title boost; the model's keywords only widen the net.
  const terms = [...new Set([...typedTerms(query), ...searchWords(keywords.join(" "))])];
  const scored = ranked.filter((r) => map.has(r.itemId)).map((r) => {
    const it = map.get(r.itemId) as ItemRow;
    const rel = maxRel > minRel ? (r.rel - minRel) / (maxRel - minRel) : 1; // spread relevance across the candidate set
    const title = it.title.toLowerCase();
    const covered = titleCoverage(query, it.title);
    const hits = terms.filter((t) => title.includes(t)).length;
    const final = rel * (0.8 + 0.2 * (it.score / 100)) + 0.45 * covered + 0.05 * Math.min(hits, 3) + (inJob.has(it.id) ? 0.15 : 0) - (it.dated ? 0.1 : 0);
    return { it, final };
  }).sort((a, b) => b.final - a.final).slice(0, limit);
  const out: SearchResponse = { query, rewritten, mode, results: scored.map((r) => toSummary(r.it)) };
  remember(key, out);
  return out;
}

/** Retrieve passages for chat: best chunks with their item titles. */
export async function retrievePassages(question: string, staff: boolean, k = 8): Promise<{ itemId: string; title: string; url: string; text: string }[]> {
  const s = await getSettings();
  await loadVectors();
  const db = getDb();
  let hits: { itemId: string; chunkId: string }[] = [];
  if (vectorCount() > 0) { const { vectors } = await embed([question], s.embeddingModel); const v = vectors[0]; if (v) hits = searchVectors(v, k * 2); }
  const map = await itemsByIds(hits.map((h) => h.itemId), staff);
  const chosen = hits.filter((h) => map.has(h.itemId)).slice(0, k);
  if (!chosen.length) return [];
  const chunks = await db.select({ id: itemChunks.id, text: itemChunks.text }).from(itemChunks).where(inArray(itemChunks.id, chosen.map((c) => c.chunkId)));
  const textById = new Map(chunks.map((r) => [r.id, r.text]));
  return chosen.map((c) => { const it = map.get(c.itemId)!; return { itemId: it.id, title: it.title, url: it.url, text: (textById.get(c.chunkId) ?? "").slice(0, 2500) }; });
}
export { respond };
