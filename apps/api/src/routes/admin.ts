import { Router, type Request } from "express";
import { z } from "zod";
import { and, asc, auditLog, inArray, basePromptVersions, desc, eq, getDb, indexRuns, itemMeta, items, jobs, materialTypeVersions, materialTypes, placements, sql, submissions, subjobs, taxonomyRetirements, typeResources, users, chatTurns, searchLog } from "@wfw/db";
import { DOC_TYPES, REGIONS, SETTING_DEFAULTS, STAGES, type ReviewResult, type Settings } from "@wfw/shared";
import { actor, requireStaff } from "../auth.js";
import { respondJson } from "../lib/openai.js";
import { isIndexing, runReindex, applySeeds } from "../services/indexer.js";
import { importStatus, isImporting, runImport } from "../services/import-connected.js";
import { itemSelect, parseTypes, subjobPlacementCounts, toSummary, typeWhere, type ItemRow } from "../services/items.js";
import { usageToday } from "../services/limits.js";
import { REVIEW_SCHEMA, buildSystemPrompt, currentBasePrompt } from "../services/review.js";
import { CurationError, applyMetaPatch, metaPatchSchema, moveItem, moveSchema } from "../services/curation.js";
import { recomputeScores } from "../services/score.js";
import { search } from "../services/search.js";
import { getSettings, setSetting, validateSetting } from "../settings.js";
import { loadVectors, vectorCount } from "../services/vectors.js";

export const adminRouter = Router();
adminRouter.use(requireStaff);
const audit = (req: Request, action: string, target: string, detail?: Record<string, unknown>) => getDb().insert(auditLog).values({ actor: actor(req), action, target, detail: detail ?? null });

// ---- dashboard
adminRouter.get("/overview", async (_req, res) => {
  const db = getDb();
  const [counts] = await db.select({ items: sql<number>`count(*) filter (where removed_at is null)::int`, withText: sql<number>`count(*) filter (where removed_at is null and has_text)::int`, linkOnly: sql<number>`count(*) filter (where removed_at is null and link_only)::int` }).from(items);
  const [pending] = await db.select({ n: sql<number>`count(*)::int` }).from(itemMeta).where(eq(itemMeta.reviewStatus, "pending"));
  const [userCount] = await db.select({ n: sql<number>`count(*)::int`, staff: sql<number>`count(*) filter (where role='staff')::int` }).from(users);
  const lastRuns = await db.select().from(indexRuns).where(sql`${indexRuns.kind} <> 'import'`).orderBy(desc(indexRuns.startedAt)).limit(5);
  const [subs] = await db.select({ total: sql<number>`count(*)::int`, cost: sql<number>`coalesce(sum(cost_usd),0)::float` }).from(submissions);
  res.json({ counts: { ...counts, chunks: vectorCount(), pendingReview: pending?.n ?? 0, users: userCount?.n ?? 0, staff: userCount?.staff ?? 0, submissions: subs?.total ?? 0, submissionCost: subs?.cost ?? 0 }, usageToday: await usageToday(), indexing: isIndexing(), importing: isImporting(), lastRuns, settings: await getSettings(true) });
});

// ---- settings
adminRouter.get("/settings", async (_req, res) => res.json({ settings: await getSettings(true), defaults: SETTING_DEFAULTS }));
adminRouter.put("/settings", async (req, res) => {
  const body = z.record(z.unknown()).parse(req.body);
  for (const [k, v] of Object.entries(body)) { const err = validateSetting(k, v); if (err) { res.status(400).json({ error: err }); return; } }
  for (const [k, v] of Object.entries(body)) await setSetting(k as keyof Settings, v as never, actor(req));
  res.json({ settings: await getSettings(true) });
});

// ---- indexing
adminRouter.post("/reindex", async (req, res) => {
  if (isIndexing()) { res.status(409).json({ error: "A re-index is already running" }); return; }
  const full = req.body?.full === true;
  const id = await runReindex(actor(req), { full });
  await audit(req, "reindex.start", id, { full });
  res.status(202).json({ runId: id });
});
adminRouter.post("/rescore", async (req, res) => { const r = await recomputeScores(); await audit(req, "score.recompute", "all", r); res.json(r); });
adminRouter.post("/apply-seeds", async (req, res) => { await applySeeds(); await loadVectors(true); await audit(req, "seeds.apply", "all"); res.json({ ok: true }); });
// ---- moving off Connected
adminRouter.get("/import/status", async (_req, res) => res.json(await importStatus()));
adminRouter.post("/import/start", async (req, res) => {
  const b = z.object({ limit: z.number().int().positive().max(5000).optional(), dryRun: z.boolean().optional() }).parse(req.body ?? {});
  if (isImporting()) { res.status(409).json({ error: "An import is already running" }); return; }
  try { const id = await runImport(actor(req), b); await audit(req, "import.start", id, b); res.status(202).json({ runId: id }); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
adminRouter.get("/runs", async (_req, res) => res.json({ runs: await getDb().select().from(indexRuns).orderBy(desc(indexRuns.startedAt)).limit(20), indexing: isIndexing() }));
adminRouter.get("/runs/:id", async (req, res) => { const [r] = await getDb().select().from(indexRuns).where(eq(indexRuns.id, String(req.params.id))); r ? res.json(r) : res.status(404).json({ error: "Not found" }); });

// ---- taxonomy
/**
 * The seed inserts every job and sub-job in seed-taxonomy.json and skips the ones already there, so a
 * removed one used to reappear empty on the next deploy — its key was gone, and there was nothing left for
 * the insert to conflict with. Removing one records that its absence is deliberate; creating one with the
 * same key again takes the record away.
 */
const retire = (req: Request, kind: "job" | "subjob", key: string, reason: string) =>
  getDb().insert(taxonomyRetirements).values({ kind, key, retiredBy: actor(req), reason }).onConflictDoNothing();
const unretire = (kind: "job" | "subjob", key: string) =>
  getDb().delete(taxonomyRetirements).where(and(eq(taxonomyRetirements.kind, kind), eq(taxonomyRetirements.key, key)));

adminRouter.post("/jobs", async (req, res) => {
  const b = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]*$/), name: z.string().min(1), description: z.string().nullable().optional(), staffOnly: z.boolean().optional(), hidden: z.boolean().optional() }).parse(req.body);
  const [max] = await getDb().select({ m: sql<number>`coalesce(max(sort),0)` }).from(jobs);
  await unretire("job", b.key);
  const [j] = await getDb().insert(jobs).values({ key: b.key, name: b.name, description: b.description ?? null, staffOnly: b.staffOnly ?? false, hidden: b.hidden ?? false, sort: (max?.m ?? 0) + 10 }).returning();
  await audit(req, "job.create", b.key); res.json(j);
});
adminRouter.patch("/jobs/:id", async (req, res) => {
  const b = z.object({ name: z.string().min(1).optional(), description: z.string().nullable().optional(), staffOnly: z.boolean().optional(), hidden: z.boolean().optional(), sort: z.number().int().optional() }).parse(req.body);
  const [j] = await getDb().update(jobs).set(b).where(eq(jobs.id, String(req.params.id))).returning();
  await audit(req, "job.update", String(req.params.id), b); res.json(j);
});
adminRouter.delete("/jobs/:id", async (req, res) => {
  const [n] = await getDb().select({ n: sql<number>`count(*)::int` }).from(subjobs).where(eq(subjobs.jobId, String(req.params.id)));
  if ((n?.n ?? 0) > 0) { res.status(400).json({ error: "Move or delete its sub-jobs first" }); return; }
  const [gone] = await getDb().delete(jobs).where(eq(jobs.id, String(req.params.id))).returning({ key: jobs.key });
  if (gone) await retire(req, "job", gone.key, "deleted");
  await audit(req, "job.delete", String(req.params.id), gone ? { key: gone.key } : undefined); res.json({ ok: true });
});
adminRouter.post("/subjobs", async (req, res) => {
  const b = z.object({ jobId: z.string().uuid(), key: z.string().regex(/^[a-z][a-z0-9_.]*$/), name: z.string().min(1), description: z.string().nullable().optional(), stages: z.array(z.enum(STAGES.map((s) => s.key) as [string, ...string[]])).optional() }).parse(req.body);
  const [max] = await getDb().select({ m: sql<number>`coalesce(max(sort),0)` }).from(subjobs).where(eq(subjobs.jobId, b.jobId));
  await unretire("subjob", b.key);
  const [s] = await getDb().insert(subjobs).values({ jobId: b.jobId, key: b.key, name: b.name, description: b.description ?? null, stages: b.stages ?? [], sort: (max?.m ?? 0) + 10 }).returning();
  await audit(req, "subjob.create", b.key); res.json(s);
});
adminRouter.patch("/subjobs/:id", async (req, res) => {
  const b = z.object({ jobId: z.string().uuid().optional(), name: z.string().min(1).optional(), description: z.string().nullable().optional(), stages: z.array(z.string()).optional(), sort: z.number().int().optional() }).parse(req.body);
  const [s] = await getDb().update(subjobs).set(b).where(eq(subjobs.id, String(req.params.id))).returning();
  await audit(req, "subjob.update", String(req.params.id), b); res.json(s);
});
adminRouter.post("/subjobs/:id/merge-into/:targetId", async (req, res) => {
  const db = getDb(); const from = String(req.params.id), to = String(req.params.targetId);
  await db.execute(sql`insert into placements (item_id, subjob_id, is_primary, source, why, position) select item_id, ${to}::uuid, is_primary, source, why, position from placements where subjob_id = ${from}::uuid on conflict (item_id, subjob_id) do nothing`);
  const [merged] = await db.delete(subjobs).where(eq(subjobs.id, from)).returning({ key: subjobs.key });
  if (merged) await retire(req, "subjob", merged.key, `merged into ${to}`);
  await audit(req, "subjob.merge", from, { into: to, ...(merged ? { key: merged.key } : {}) }); res.json({ ok: true });
});
adminRouter.delete("/subjobs/:id", async (req, res) => {
  const [n] = await getDb().select({ n: sql<number>`count(*)::int` }).from(placements).where(eq(placements.subjobId, String(req.params.id)));
  if ((n?.n ?? 0) > 0) { res.status(400).json({ error: "This sub-job still has items; merge it into another sub-job instead" }); return; }
  const [gone] = await getDb().delete(subjobs).where(eq(subjobs.id, String(req.params.id))).returning({ key: subjobs.key });
  if (gone) await retire(req, "subjob", gone.key, "deleted");
  await audit(req, "subjob.delete", String(req.params.id), gone ? { key: gone.key } : undefined); res.json({ ok: true });
});
adminRouter.put("/reorder", async (req, res) => {
  const b = z.object({ jobs: z.array(z.string().uuid()).optional(), subjobs: z.array(z.string().uuid()).optional() }).parse(req.body);
  const db = getDb();
  for (const [i, id] of (b.jobs ?? []).entries()) await db.update(jobs).set({ sort: i * 10 }).where(eq(jobs.id, id));
  for (const [i, id] of (b.subjobs ?? []).entries()) await db.update(subjobs).set({ sort: i * 10 }).where(eq(subjobs.id, id));
  res.json({ ok: true });
});

/**
 * How many resources sit in each sub-job, for the Organize page.
 *
 * The map's own count answers a reader's question — how many cards will I see — and nests a series' posts
 * inside the series. Staff dragging resources between sub-jobs need the other number: how many rows this
 * sub-job opens. Keyed by sub-job id.
 */
adminRouter.get("/subjob-counts", async (_req, res) => {
  res.json({ counts: Object.fromEntries(await subjobPlacementCounts()) });
});

// ---- items and curation
adminRouter.get("/items", async (req, res) => {
  const db = getDb();
  const q = String(req.query.q ?? "").trim(); const subjobKey = String(req.query.subjob ?? ""); const filter = String(req.query.filter ?? "");
  const page = Math.max(0, Number(req.query.page ?? 0));
  // The Organize page lists a whole sub-job at once, so it asks for more than the default page.
  const size = Math.min(200, Math.max(1, Number(req.query.size ?? 50) || 50));
  const conds = [sql`${items.removedAt} is null`];
  if (q) conds.push(sql`(lower(coalesce(${itemMeta.displayTitle}, ${items.title})) like ${"%" + q.toLowerCase() + "%"} or "items"."fts" @@ websearch_to_tsquery('english', ${q}))`);
  if (subjobKey) conds.push(sql`exists (select 1 from placements p join subjobs s on s.id = p.subjob_id where p.item_id = ${items.id} and s.key = ${subjobKey})`);
  if (filter === "unplaced") conds.push(sql`not exists (select 1 from placements p where p.item_id = ${items.id})`);
  if (filter === "hidden") conds.push(sql`coalesce(${itemMeta.hidden}, false)`);
  if (filter === "curated") conds.push(sql`${itemMeta.curation} is not null`);
  if (filter === "dated") conds.push(sql`${itemMeta.datedLabel} is not null`);
  if (filter === "linkonly") conds.push(eq(items.linkOnly, true));
  // The same document types a reader filters by, so staff narrow the list the way the map reads it.
  const typed = typeWhere(parseTypes(req.query.types));
  if (typed) conds.push(typed);
  const rows = await db.select({ ...itemSelect, displayTitle: itemMeta.displayTitle, displayAuthor: itemMeta.displayAuthor, displayDescription: itemMeta.displayDescription, displayPublishedAt: itemMeta.displayPublishedAt, pinnedStage: itemMeta.pinnedStage, pinnedPosition: itemMeta.pinnedPosition, staffNote: itemMeta.staffNote, hasText: items.hasText }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(...conds)).orderBy(desc(sql`coalesce(${itemMeta.score},0)`), desc(items.views)).limit(size).offset(page * size);
  const ids = rows.map((r) => r.id);
  const pl = ids.length ? await db.select({ itemId: placements.itemId, key: subjobs.key, name: subjobs.name, isPrimary: placements.isPrimary, position: placements.position }).from(placements).innerJoin(subjobs, eq(subjobs.id, placements.subjobId)).where(inArray(placements.itemId, ids)) : [];
  res.json({ items: rows.map((r) => ({ ...toSummary(r as ItemRow), displayTitle: r.displayTitle, displayAuthor: r.displayAuthor, displayDescription: r.displayDescription, displayPublishedAt: r.displayPublishedAt, hidden: r.hidden, pinnedStage: r.pinnedStage, pinnedPosition: r.pinnedPosition, staffNote: r.staffNote, reviewStatus: r.reviewStatus, hasText: r.hasText, placements: pl.filter((p) => p.itemId === r.id) })), page, size });
});
adminRouter.patch("/items/:id/meta", async (req, res) => {
  const b = metaPatchSchema.parse(req.body);
  try { await applyMetaPatch(String(req.params.id), b, actor(req)); } catch (e) { if (e instanceof CurationError) { res.status(e.status).json({ error: e.message }); return; } throw e; }
  res.json({ ok: true });
});
/**
 * The document type a reader filters by and sees on the card. Kept apart from the meta route because it
 * lives on the item itself, not on the curation record — and "series" is not offered: that is how an item
 * is built, not what it is. A roster of people is tagged "resource_list" and still nests like a series.
 */
adminRouter.patch("/items/:id/type", async (req, res) => {
  const allowed = DOC_TYPES.map((t) => t.key).filter((k) => k !== "series");
  const b = z.object({ contentType: z.string().refine((v) => allowed.includes(v), "Unknown document type").nullable() }).parse(req.body);
  const id = String(req.params.id);
  const [updated] = await getDb().update(items).set({ contentType: b.contentType }).where(eq(items.id, id)).returning({ id: items.id });
  if (!updated) { res.status(404).json({ error: "Item not found" }); return; }
  await audit(req, "item.type", id, b); res.json({ ok: true });
});
/**
 * Which regions an item is written for. Material mirrored from Connected gets these from its audience
 * taxa at index time; an item written here has no audiences, so staff set them by hand. Empty means it
 * applies wherever the reader is.
 */
adminRouter.patch("/items/:id/regions", async (req, res) => {
  const keys = REGIONS.map((r) => r.key);
  const b = z.object({ regions: z.array(z.string().refine((v) => keys.includes(v), "Unknown region")).max(keys.length) }).parse(req.body);
  const id = String(req.params.id);
  const [updated] = await getDb().update(items).set({ regions: [...new Set(b.regions)].sort() }).where(eq(items.id, id)).returning({ id: items.id });
  if (!updated) { res.status(404).json({ error: "Item not found" }); return; }
  await audit(req, "item.regions", id, b); res.json({ ok: true });
});
adminRouter.put("/items/:id/placements", async (req, res) => {
  const b = z.object({ placements: z.array(z.object({ subjobKey: z.string(), isPrimary: z.boolean(), position: z.number().int().nullable().optional() })).max(6) }).parse(req.body);
  const db = getDb(); const id = String(req.params.id);
  const subs = await db.select({ id: subjobs.id, key: subjobs.key }).from(subjobs);
  const byKey = new Map(subs.map((s) => [s.key, s.id]));
  await db.delete(placements).where(eq(placements.itemId, id));
  for (const p of b.placements) { const sid = byKey.get(p.subjobKey); if (sid) await db.insert(placements).values({ itemId: id, subjobId: sid, isPrimary: p.isPrimary, source: "staff", position: p.position ?? null }).onConflictDoNothing(); }
  await audit(req, "item.placements", id, b); res.json({ ok: true });
});
// The rules for a move (what stays primary, what a copy leaves behind) are in services/curation.ts.
adminRouter.post("/items/:id/move", async (req, res) => {
  const b = moveSchema.parse(req.body);
  try { res.json({ ok: true, ...(await moveItem(String(req.params.id), b, actor(req))) }); } catch (e) { if (e instanceof CurationError) { res.status(e.status).json({ error: e.message }); return; } throw e; }
});
adminRouter.get("/retirement-queue", async (req, res) => {
  const status = String(req.query.status ?? "pending");
  const rows = await getDb().select({ ...itemSelect, reason: itemMeta.modelOutdatedReason, reviewedBy: itemMeta.reviewedBy, reviewedAt: itemMeta.reviewedAt }).from(items).innerJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(sql`${items.removedAt} is null`, eq(itemMeta.reviewStatus, status))).orderBy(desc(items.views)).limit(300);
  res.json({ items: rows.map((r) => ({ ...toSummary(r as ItemRow), reason: r.reason, reviewedBy: r.reviewedBy, reviewedAt: r.reviewedAt })) });
});
adminRouter.post("/retirement-queue/:id", async (req, res) => {
  const b = z.object({ decision: z.enum(["keep", "dated", "hidden"]), datedLabel: z.string().max(40).optional() }).parse(req.body);
  const id = String(req.params.id);
  const [it] = await getDb().select({ upd: items.sourceUpdatedAt }).from(items).where(eq(items.id, id));
  const label = b.decision === "dated" ? (b.datedLabel ?? `Dated ${it?.upd?.getUTCFullYear() ?? ""}`.trim()) : null;
  await getDb().insert(itemMeta).values({ itemId: id, reviewStatus: b.decision, datedLabel: label, hidden: b.decision === "hidden", reviewedBy: actor(req), reviewedAt: new Date() }).onConflictDoUpdate({ target: itemMeta.itemId, set: { reviewStatus: b.decision, datedLabel: label, hidden: b.decision === "hidden", reviewedBy: actor(req), reviewedAt: new Date(), updatedAt: new Date() } });
  await audit(req, "retirement.decide", id, b); res.json({ ok: true });
});
adminRouter.get("/item-search", async (req, res) => { const q = String(req.query.q ?? ""); if (q.length < 2) { res.json({ results: [] }); return; } const r = await search(q, { staff: true, limit: 10 }); res.json({ results: r.results }); });

// ---- material types
adminRouter.get("/types", async (_req, res) => {
  const db = getDb();
  const ts = await db.select().from(materialTypes).orderBy(asc(materialTypes.sort));
  const counts = await db.select({ typeId: submissions.typeId, n: sql<number>`count(*)::int` }).from(submissions).groupBy(submissions.typeId);
  const cm = new Map(counts.map((c) => [c.typeId, c.n]));
  res.json({ types: ts.map((t) => ({ ...t, submissionCount: cm.get(t.id) ?? 0 })), basePrompt: await currentBasePrompt() });
});
adminRouter.get("/types/:id", async (req, res) => {
  const db = getDb(); const id = String(req.params.id);
  const [t] = await db.select().from(materialTypes).where(eq(materialTypes.id, id));
  if (!t) { res.status(404).json({ error: "Not found" }); return; }
  const versions = await db.select({ version: materialTypeVersions.version, note: materialTypeVersions.note, createdBy: materialTypeVersions.createdBy, createdAt: materialTypeVersions.createdAt }).from(materialTypeVersions).where(eq(materialTypeVersions.typeId, id)).orderBy(desc(materialTypeVersions.version));
  const resources = await db.select({ ...itemSelect, sort: typeResources.sort }).from(typeResources).innerJoin(items, eq(items.id, typeResources.itemId)).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(eq(typeResources.typeId, id)).orderBy(asc(typeResources.sort));
  res.json({ type: t, versions, resources: resources.map((r) => toSummary(r as ItemRow)) });
});
adminRouter.get("/types/:id/versions/:v", async (req, res) => {
  const [v] = await getDb().select().from(materialTypeVersions).where(and(eq(materialTypeVersions.typeId, String(req.params.id)), eq(materialTypeVersions.version, Number(req.params.v))));
  v ? res.json(v) : res.status(404).json({ error: "Not found" });
});
const typeBody = z.object({ name: z.string().min(1).optional(), shortDescription: z.string().nullable().optional(), jobKey: z.string().nullable().optional(), guideMd: z.string().min(1).optional(), rubric: z.array(z.object({ criterion: z.string().min(1), description: z.string() })).min(1).max(8).optional(), reviewerNotes: z.string().optional(), model: z.string().nullable().optional(), reasoningEffort: z.enum(["low", "medium", "high"]).nullable().optional(), active: z.boolean().optional(), note: z.string().max(300).optional() });
adminRouter.post("/types", async (req, res) => {
  const b = typeBody.extend({ key: z.string().regex(/^[a-z][a-z0-9_]*$/), name: z.string().min(1), guideMd: z.string().min(1), rubric: z.array(z.object({ criterion: z.string().min(1), description: z.string() })).min(1) }).parse(req.body);
  const db = getDb();
  const [max] = await db.select({ m: sql<number>`coalesce(max(sort),0)` }).from(materialTypes);
  const [t] = await db.insert(materialTypes).values({ key: b.key, name: b.name, shortDescription: b.shortDescription ?? null, jobKey: b.jobKey ?? null, guideMd: b.guideMd, rubric: b.rubric, reviewerNotes: b.reviewerNotes ?? "", model: b.model ?? null, reasoningEffort: b.reasoningEffort ?? null, sort: (max?.m ?? 0) + 10, updatedBy: actor(req) }).returning();
  await db.insert(materialTypeVersions).values({ typeId: t!.id, version: 1, name: t!.name, shortDescription: t!.shortDescription, guideMd: t!.guideMd, rubric: t!.rubric, reviewerNotes: t!.reviewerNotes, note: b.note ?? "Created", createdBy: actor(req) });
  await audit(req, "type.create", b.key); res.json(t);
});
adminRouter.patch("/types/:id", async (req, res) => {
  const b = typeBody.parse(req.body); const db = getDb(); const id = String(req.params.id);
  const [cur] = await db.select().from(materialTypes).where(eq(materialTypes.id, id));
  if (!cur) { res.status(404).json({ error: "Not found" }); return; }
  const contentChanged = (b.guideMd !== undefined && b.guideMd !== cur.guideMd) || (b.rubric !== undefined && JSON.stringify(b.rubric) !== JSON.stringify(cur.rubric)) || (b.reviewerNotes !== undefined && b.reviewerNotes !== cur.reviewerNotes) || (b.name !== undefined && b.name !== cur.name);
  const version = contentChanged ? cur.version + 1 : cur.version;
  const { note, ...fields } = b;
  const [t] = await db.update(materialTypes).set({ ...fields, version, updatedAt: new Date(), updatedBy: actor(req) }).where(eq(materialTypes.id, id)).returning();
  if (contentChanged && t) await db.insert(materialTypeVersions).values({ typeId: id, version, name: t.name, shortDescription: t.shortDescription, guideMd: t.guideMd, rubric: t.rubric, reviewerNotes: t.reviewerNotes, note: note ?? null, createdBy: actor(req) });
  await audit(req, "type.update", id, { version, note }); res.json(t);
});
adminRouter.post("/types/:id/restore/:v", async (req, res) => {
  const db = getDb(); const id = String(req.params.id);
  const [v] = await db.select().from(materialTypeVersions).where(and(eq(materialTypeVersions.typeId, id), eq(materialTypeVersions.version, Number(req.params.v))));
  const [cur] = await db.select({ version: materialTypes.version }).from(materialTypes).where(eq(materialTypes.id, id));
  if (!v || !cur) { res.status(404).json({ error: "Not found" }); return; }
  const version = cur.version + 1;
  const [t] = await db.update(materialTypes).set({ name: v.name, shortDescription: v.shortDescription, guideMd: v.guideMd, rubric: v.rubric, reviewerNotes: v.reviewerNotes, version, updatedAt: new Date(), updatedBy: actor(req) }).where(eq(materialTypes.id, id)).returning();
  await db.insert(materialTypeVersions).values({ typeId: id, version, name: v.name, shortDescription: v.shortDescription, guideMd: v.guideMd, rubric: v.rubric, reviewerNotes: v.reviewerNotes, note: `Restored version ${v.version}`, createdBy: actor(req) });
  res.json(t);
});
adminRouter.put("/types/:id/resources", async (req, res) => {
  const b = z.object({ itemIds: z.array(z.string().uuid()).max(20) }).parse(req.body); const db = getDb(); const id = String(req.params.id);
  await db.delete(typeResources).where(eq(typeResources.typeId, id));
  for (const [i, itemId] of b.itemIds.entries()) await db.insert(typeResources).values({ typeId: id, itemId, sort: i }).onConflictDoNothing();
  await audit(req, "type.resources", id, { n: b.itemIds.length }); res.json({ ok: true });
});
adminRouter.post("/types/:id/test", async (req, res) => {
  const b = z.object({ draft: z.string().min(40).max(30000), guideMd: z.string().optional(), rubric: z.array(z.object({ criterion: z.string(), description: z.string() })).optional(), reviewerNotes: z.string().optional(), basePrompt: z.string().optional(), model: z.string().optional(), effort: z.enum(["low", "medium", "high"]).optional() }).parse(req.body);
  const s = await getSettings();
  const [t] = await getDb().select().from(materialTypes).where(eq(materialTypes.id, String(req.params.id)));
  if (!t) { res.status(404).json({ error: "Not found" }); return; }
  const built = await buildSystemPrompt(t.id, b.draft, { basePrompt: b.basePrompt, guide: b.guideMd, rubric: b.rubric, reviewerNotes: b.reviewerNotes });
  const model = b.model ?? t.model ?? s.reviewModel; const effort = b.effort ?? (t.reasoningEffort as "low" | "medium" | "high" | null) ?? (s.reviewEffort as "low" | "medium" | "high");
  const started = Date.now();
  const r = await respondJson<ReviewResult>({ model, effort, maxOutput: s.maxReviewOutputTokens, system: built.system, user: `Here is the draft submitted as a '${built.typeName}'. Review it.\n\n---\n${b.draft}\n---`, schema: REVIEW_SCHEMA, timeoutMs: 300_000 });
  await getDb().insert(submissions).values({ userId: req.user!.id, typeId: t.id, typeVersion: t.version, basePromptVersion: built.baseVersion, title: `Prompt test by ${req.user!.name}`, source: "test", draftText: b.draft, charCount: b.draft.length, status: "done", model, reasoningEffort: effort, review: r.data, verdict: r.data.verdict, usage: r.usage as unknown as Record<string, number>, costUsd: r.cost.toFixed(5), completedAt: new Date() });
  res.json({ review: r.data, model, effort, usage: r.usage, costUsd: r.cost, seconds: (Date.now() - started) / 1000, systemPromptChars: built.system.length });
});

// ---- base prompt
adminRouter.get("/base-prompt", async (_req, res) => res.json({ current: await currentBasePrompt(), versions: await getDb().select({ version: basePromptVersions.version, note: basePromptVersions.note, createdBy: basePromptVersions.createdBy, createdAt: basePromptVersions.createdAt }).from(basePromptVersions).orderBy(desc(basePromptVersions.version)) }));
adminRouter.get("/base-prompt/:v", async (req, res) => { const [v] = await getDb().select().from(basePromptVersions).where(eq(basePromptVersions.version, Number(req.params.v))); v ? res.json(v) : res.status(404).json({ error: "Not found" }); });
adminRouter.post("/base-prompt", async (req, res) => {
  const b = z.object({ text: z.string().min(50), note: z.string().max(300).optional() }).parse(req.body);
  const [v] = await getDb().insert(basePromptVersions).values({ text: b.text, note: b.note ?? null, createdBy: actor(req) }).returning();
  await audit(req, "baseprompt.update", String(v!.version)); res.json(v);
});

// ---- submissions log
adminRouter.get("/submissions", async (req, res) => {
  const page = Math.max(0, Number(req.query.page ?? 0)); const size = 50; const typeId = String(req.query.typeId ?? "");
  const rows = await getDb().select({ id: submissions.id, title: submissions.title, status: submissions.status, verdict: submissions.verdict, createdAt: submissions.createdAt, source: submissions.source, charCount: submissions.charCount, costUsd: submissions.costUsd, model: submissions.model, userName: users.name, userEmail: users.email, typeName: materialTypes.name, typeKey: materialTypes.key, typeVersion: submissions.typeVersion, contributed: submissions.contributed })
    .from(submissions).innerJoin(users, eq(users.id, submissions.userId)).innerJoin(materialTypes, eq(materialTypes.id, submissions.typeId)).where(typeId ? eq(submissions.typeId, typeId) : sql`true`).orderBy(desc(submissions.createdAt)).limit(size).offset(page * size);
  res.json({ submissions: rows, page, size });
});
adminRouter.get("/submissions/:id", async (req, res) => {
  const [row] = await getDb().select({ sub: submissions, userName: users.name, userEmail: users.email, typeName: materialTypes.name, typeKey: materialTypes.key }).from(submissions).innerJoin(users, eq(users.id, submissions.userId)).innerJoin(materialTypes, eq(materialTypes.id, submissions.typeId)).where(eq(submissions.id, String(req.params.id)));
  row ? res.json({ ...row.sub, userName: row.userName, userEmail: row.userEmail, typeName: row.typeName, typeKey: row.typeKey }) : res.status(404).json({ error: "Not found" });
});
adminRouter.get("/activity", async (_req, res) => {
  const db = getDb();
  const searches = await db.select({ query: searchLog.query, mode: searchLog.mode, resultCount: searchLog.resultCount, createdAt: searchLog.createdAt }).from(searchLog).orderBy(desc(searchLog.createdAt)).limit(50);
  const chats = await db.select({ question: chatTurns.question, covered: chatTurns.covered, createdAt: chatTurns.createdAt, cost: chatTurns.costUsd }).from(chatTurns).orderBy(desc(chatTurns.createdAt)).limit(50);
  const audits = await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(50);
  res.json({ searches, chats, audits });
});
adminRouter.get("/users", async (_req, res) => res.json({ users: await getDb().select({ id: users.id, email: users.email, name: users.name, role: users.role, createdAt: users.createdAt, lastLoginAt: users.lastLoginAt, stage: users.stage }).from(users).orderBy(desc(users.lastLoginAt)).limit(500) }));
