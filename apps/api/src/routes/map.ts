import { Router, type Request } from "express";
import { z } from "zod";
import { and, desc, eq, getDb, inArray, isNull, itemFlags, itemMeta, items, jobs, placements, signals, sql, subjobs, users } from "@wfw/db";
import { GENERAL_REGION, STAGES, isResourceLanguage, parseRegionFilter, type JobSummary, type ResourceLanguage, type StageKey } from "@wfw/shared";
import { requireUser } from "../auth.js";
import { getSettings } from "../settings.js";
import { itemsForSubjob, mostUsed, parseTypes, postsBySourceId, startHere, subjobItemCounts, titleExpr, toSummary, itemSelect, type ItemRow, type ReaderFilters, visibleWhere } from "../services/items.js";
import { dropDuplicateByline, mergeAdjacentLists, stripContentTokens } from "../lib/html.js";
import { freshenBriefly } from "./native.js";
import { googleKindOfMime, googleUrl, isGoogleAppsMime } from "../services/native.js";
import { readerLanguage, readerRegions } from "../services/language-pref.js";

/** The region filter for the stage counts, which are raw SQL over an aliased items table. */
const regionSql = (regions: string[]) => {
  if (!regions.length) return sql``;
  const parts = [];
  if (regions.includes(GENERAL_REGION)) parts.push(sql`coalesce(array_length(i.regions, 1), 0) = 0`);
  const keys = regions.filter((r) => r !== GENERAL_REGION);
  if (keys.length) parts.push(sql`i.regions && array[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}]::text[]`);
  return sql` and (${sql.join(parts, sql` or `)})`;
};

export const mapRouter = Router();
mapRouter.use(requireUser);
const isStage = (s: unknown): s is StageKey => typeof s === "string" && STAGES.some((x) => x.key === s);
/** The language filter comes from the query string; when it is missing we use what the reader last chose. */
const requestLanguage = (req: Request): Promise<ResourceLanguage> =>
  isResourceLanguage(req.query.lang) ? Promise.resolve(req.query.lang) : readerLanguage(req.user!.id);
/** Likewise for the regions, which the reader may tick several of. */
const requestRegions = (req: Request): Promise<string[]> =>
  req.query.regions !== undefined ? Promise.resolve(parseRegionFilter(req.query.regions)) : readerRegions(req.user!.id);
/** The whole filter row, as every list route needs it. */
async function requestFilters(req: Request): Promise<ReaderFilters & { language: ResourceLanguage; regions: string[] }> {
  const [language, regions] = await Promise.all([requestLanguage(req), requestRegions(req)]);
  return { language, regions, types: parseTypes(req.query.types) };
}

mapRouter.get("/", async (req, res) => {
  const staff = req.user!.role === "staff";
  const db = getDb();
  const js = await db.select().from(jobs).orderBy(jobs.sort);
  const ss = await db.select().from(subjobs).orderBy(subjobs.sort);
  const f = await requestFilters(req);
  const lang = f.language;
  // The same filters the job page applies, so the number beside a job matches the cards under it.
  const cmap = await subjobItemCounts(staff, f);
  const stageRows = await db.execute(sql`select s as stage, count(distinct i.id)::int as n from items i join item_meta m on m.item_id = i.id cross join lateral unnest(m.stages) as s where i.removed_at is null and coalesce(m.hidden, false) = false ${lang === "all" ? sql`` : sql`and i.language = ${lang}`} ${regionSql(f.regions)} ${staff ? sql`` : sql`and not exists (select 1 from placements p join subjobs sj on sj.id = p.subjob_id join jobs j on j.id = sj.job_id where p.item_id = i.id and p.is_primary and j.staff_only)`} group by s`);
  const stageCounts = Object.fromEntries((stageRows.rows as { stage: string; n: number }[]).map((r) => [r.stage, r.n]));
  const out: JobSummary[] = js.filter((j) => staff || !j.hidden).map((j) => ({ id: j.id, key: j.key, name: j.name, description: j.description, staffOnly: j.staffOnly, hidden: j.hidden,
    subjobs: ss.filter((s) => s.jobId === j.id).map((s) => ({ id: s.id, key: s.key, name: s.name, description: s.description, stages: s.stages as StageKey[], itemCount: cmap.get(s.id) ?? 0 })) }));
  res.json({ jobs: out, stages: STAGES, stageCounts, language: lang, regions: f.regions });
});

mapRouter.get("/home", async (req, res) => {
  const staff = req.user!.role === "staff";
  const s = await getSettings();
  const stage = isStage(req.query.stage) ? req.query.stage : null;
  const [u] = await getDb().select({ stage: users.stage }).from(users).where(eq(users.id, req.user!.id));
  const effective = stage ?? (isStage(u?.stage) ? u!.stage as StageKey : null);
  const f = await requestFilters(req);
  const [start, used] = await Promise.all([effective ? startHere(effective, staff, s.startHereCap, f) : Promise.resolve([]), mostUsed(staff, 8, f)]);
  res.json({ stage: effective, startHere: start, mostUsed: used, stages: STAGES, language: f.language, regions: f.regions });
});

mapRouter.post("/stage", async (req, res) => {
  const body = z.object({ stage: z.string().nullable() }).parse(req.body);
  if (body.stage !== null && !isStage(body.stage)) { res.status(400).json({ error: "Unknown stage" }); return; }
  await getDb().update(users).set({ stage: body.stage }).where(eq(users.id, req.user!.id));
  res.json({ ok: true });
});

/** One job with its sub-jobs and the top few resources in each, for the explorer view. */
mapRouter.get("/job/:key", async (req, res) => {
  const staff = req.user!.role === "staff";
  const db = getDb();
  const [j] = await db.select().from(jobs).where(eq(jobs.key, String(req.params.key)));
  if (!j || (j.hidden && !staff)) { res.status(404).json({ error: "Not found" }); return; }
  const ss = await db.select().from(subjobs).where(eq(subjobs.jobId, j.id)).orderBy(subjobs.sort);
  const perSub = Number(req.query.limit ?? 3);
  const f = await requestFilters(req);
  const out = await Promise.all(ss.map(async (sj) => { const list = await itemsForSubjob(sj.id, staff, f); return { id: sj.id, key: sj.key, name: sj.name, description: sj.description, stages: sj.stages as StageKey[], itemCount: list.length, items: list.slice(0, perSub) }; }));
  res.json({ job: { id: j.id, key: j.key, name: j.name, description: j.description, staffOnly: j.staffOnly }, subjobs: out });
});

mapRouter.get("/subjob/:key", async (req, res) => {
  const staff = req.user!.role === "staff";
  const db = getDb();
  const [s] = await db.select({ id: subjobs.id, key: subjobs.key, name: subjobs.name, description: subjobs.description, stages: subjobs.stages, jobId: subjobs.jobId }).from(subjobs).where(eq(subjobs.key, String(req.params.key)));
  if (!s) { res.status(404).json({ error: "Not found" }); return; }
  const [j] = await db.select().from(jobs).where(eq(jobs.id, s.jobId));
  const list = await itemsForSubjob(s.id, staff, await requestFilters(req));
  res.json({ subjob: { ...s, stages: s.stages as StageKey[] }, job: j ? { id: j.id, key: j.key, name: j.name } : null, items: list });
});

mapRouter.get("/item/:id", async (req, res) => {
  const staff = req.user!.role === "staff";
  const db = getDb();
  // A resource linked to a Google file picks up an edit made there when it is opened, not only overnight.
  await freshenBriefly(String(req.params.id));
  const [r] = await db.select({ ...itemSelect, authorName: sql<string | null>`coalesce(${itemMeta.displayAuthor}, ${items.authorName})`, publishedAt: sql<Date | null>`coalesce(${itemMeta.displayPublishedAt}, ${items.publishedAt})`, categories: items.categories, audiences: items.audiences, linkedDocs: items.linkedDocs, attachmentsFull: items.attachments, bodyHtml: items.bodyHtml, bodyText: items.bodyText, childPostIds: items.childPostIds, childItemIds: items.childItemIds, sourceKind: items.sourceKind, sourceId: items.sourceId, nativeKind: items.nativeKind, googleKind: items.googleKind, googleFileId: items.googleFileId, authorUserId: items.authorUserId, status: items.status, bodyMarkdown: items.bodyMarkdown, nativeAttachments: items.nativeAttachments, importedFrom: items.importedFrom, importError: items.importError }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(eq(items.id, String(req.params.id)), visibleWhere(staff)));
  if (!r) { res.status(404).json({ error: "Not found" }); return; }
  const pl = await db.select({ key: subjobs.key, name: subjobs.name, jobName: jobs.name, jobKey: jobs.key, isPrimary: placements.isPrimary }).from(placements).innerJoin(subjobs, eq(subjobs.id, placements.subjobId)).innerJoin(jobs, eq(jobs.id, subjobs.jobId)).where(eq(placements.itemId, r.id)).orderBy(desc(placements.isPrimary));
  const [votes] = await db.select({ yes: sql<number>`count(*) filter (where kind='helpful_yes')::int`, no: sql<number>`count(*) filter (where kind='helpful_no')::int` }).from(signals).where(eq(signals.itemId, r.id));
  const mine = await db.select({ kind: signals.kind }).from(signals).where(and(eq(signals.itemId, r.id), eq(signals.userId, req.user!.id), sql`kind in ('helpful_yes','helpful_no')`)).orderBy(desc(signals.createdAt)).limit(1);
  const childIds = (r.childPostIds ?? []).slice(0, 200);
  const byId = await postsBySourceId(childIds, staff);
  let contents = childIds.map((id) => byId.get(id)).filter((c): c is NonNullable<typeof c> => !!c).map((c) => toSummary(c));
  // Native series list other items by id.
  const nativeChildIds = (r.childItemIds ?? []).slice(0, 200);
  if (nativeChildIds.length) { const kids = await db.select({ ...itemSelect }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(inArray(items.id, nativeChildIds), visibleWhere(staff))); const kById = new Map(kids.map((k) => [k.id, k])); contents = nativeChildIds.map((id) => kById.get(id)).filter((k): k is NonNullable<typeof k> => !!k).map((k) => toSummary(k as ItemRow)); }
  const author = r.authorUserId ? (await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, r.authorUserId)))[0] ?? null : null;
  const nativeSeries = r.sourceKind === "native" ? await db.select({ id: items.id, title: titleExpr, childItemIds: items.childItemIds }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(eq(items.sourceKind, "native"), eq(items.nativeKind, "series"), eq(items.status, "published"), isNull(items.removedAt), sql`${items.childItemIds} @> ${JSON.stringify([r.id])}::jsonb`)) : [];
  // Series this post belongs to, with every post in order, so the page can show its siblings.
  const connectedPostId = r.sourceKind === "post" ? r.sourceId : r.importedFrom?.kind === "post" ? r.importedFrom.sourceId : null;
  const seriesRows = connectedPostId ? await db.select({ id: items.id, title: titleExpr, childPostIds: items.childPostIds }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(eq(items.sourceKind, "series"), isNull(items.removedAt), sql`${items.childPostIds} @> ${JSON.stringify([connectedPostId])}::jsonb`)) : [];
  const nativeSeriesNav = await Promise.all(nativeSeries.map(async (sr) => { const ids = (sr.childItemIds ?? []).slice(0, 200); const rows = ids.length ? await db.select({ id: items.id, title: titleExpr }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(inArray(items.id, ids), visibleWhere(staff))) : []; const m = new Map(rows.map((x) => [x.id, x])); return { seriesId: sr.id, seriesTitle: sr.title, posts: ids.map((id) => m.get(id)).filter((x): x is NonNullable<typeof x> => !!x).map((x) => ({ id: x.id, title: x.title, current: x.id === r.id })) }; }));
  const connectedSeriesNav = await Promise.all(seriesRows.map(async (sr) => {
    const ids = (sr.childPostIds ?? []).slice(0, 200);
    const bySource = await postsBySourceId(ids, staff);
    return { seriesId: sr.id, seriesTitle: sr.title, posts: ids.map((sid) => bySource.get(sid)).filter((x): x is NonNullable<typeof x> => !!x).map((x) => ({ id: x.id, title: x.title, current: x.id === r.id })) };
  }));
  const seriesNav = [...connectedSeriesNav, ...nativeSeriesNav];
  // Items with no stored HTML yet (indexed before full content landed) fall back to their plain text.
  const raw = r.bodyHtml ?? (r.bodyText ? `<p>${r.bodyText.split(/\n{2,}/).slice(0, 80).map((p) => p.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!))).join("</p><p>")}</p>` : "");
  // Files from Connected (streamed while it exists) and files in Drive are presented the same way.
  const kindOf = (t: string) => t === "Image" ? "image" : t === "Video" ? "video" : t === "Audio" ? "audio" : t === "PreviewableDocument" || t === "Document" ? "document" : "file";
  const attachments = [
    ...r.attachmentsFull.map((a) => ({ key: `c${a.id}`, src: `/api/files/${a.id}`, name: a.name, kind: kindOf(a.type), bytes: a.bytes, mime: a.mime ?? null, openUrl: null as string | null })),
    ...(r.nativeAttachments ?? []).map((a) => ({ key: `d${a.driveId}`, src: `/api/files/native/${a.driveId}`, name: a.name, kind: a.kind, bytes: a.bytes, mime: a.mime, openUrl: isGoogleAppsMime(a.mime) ? googleUrl(googleKindOfMime(a.mime), a.driveId) : null })),
  ];
  // A video is shown at the top of the page rather than in the body, so its figure is taken out of the HTML.
  const video = attachments.find((a) => a.kind === "video") ?? null;
  // Lists the source split into single-item pieces are rejoined here as well as at index time, so items
  // stored before that existed stop rendering "1. 1. 1." without waiting for a re-index.
  const stripped = dropDuplicateByline(mergeAdjacentLists(stripContentTokens(raw)), r.authorName);
  const withoutVideo = video ? stripped.replace(new RegExp(`<figure class="wf-media" data-(?:content|drive)-id="${video.key.slice(1)}">[\\s\\S]*?</figure>`, "g"), "") : stripped;
  const [reviewed] = await db.select({ reviewedAt: itemMeta.reviewedAt, reviewedBy: itemMeta.reviewedBy }).from(itemMeta).where(eq(itemMeta.itemId, r.id));
  const [myFlag] = req.user ? await db.select({ id: itemFlags.id }).from(itemFlags).where(and(eq(itemFlags.itemId, r.id), eq(itemFlags.userId, req.user.id), isNull(itemFlags.resolvedAt))).limit(1) : [];
  res.json({ item: { ...toSummary(r as ItemRow), authorName: r.authorName, reviewedAt: staff ? reviewed?.reviewedAt ?? null : null, reviewedBy: staff ? reviewed?.reviewedBy ?? null : null, flagged: !!myFlag, publishedAt: r.publishedAt, categories: r.categories, audiences: r.audiences, bodyHtml: withoutVideo, primaryVideo: video, attachments, linkedDocs: r.linkedDocs.map((d) => ({ url: d.url, kind: d.kind, status: d.status })), contents, seriesNav, native: r.sourceKind === "native" ? { kind: r.nativeKind, googleKind: r.googleKind, googleFileId: r.googleFileId, status: r.status, author, imported: !!r.importedFrom } : null, // So a page with nothing on it can say whether the source is empty or the last import failed.
    importError: staff ? r.importError ?? null : null }, placements: pl, votes: { yes: votes?.yes ?? 0, no: votes?.no ?? 0, mine: mine[0]?.kind ?? null } });
});

/** Resolve a Connected post/series/question id to the wfwisdom item (used for links inside imported content). */
mapRouter.get("/by-source/:kind/:sourceId", async (req, res) => {
  const kind = String(req.params.kind), sourceId = Number(req.params.sourceId);
  if (!["post", "series", "question"].includes(kind) || !Number.isFinite(sourceId)) { res.status(400).json({ error: "Bad reference" }); return; }
  const [r] = await getDb().select({ id: items.id, title: titleExpr, url: items.url }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(sql`(${items.sourceKind} = ${kind} and ${items.sourceId} = ${sourceId}) or ${items.importedFrom} @> ${JSON.stringify({ kind, sourceId })}::jsonb`, isNull(items.removedAt))).limit(1);
  if (!r) { res.status(404).json({ error: "Not in Wildflower Wisdom" }); return; }
  res.json(r);
});
