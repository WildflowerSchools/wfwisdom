import { and, desc, eq, getDb, inArray, itemMeta, items, placements, sql, subjobs, jobs } from "@wfw/db";
import { GENERAL_REGION, type ItemLanguage, type ItemSummary, type ResourceLanguage, type StageKey } from "@wfw/shared";
import { stripContentTokens } from "../lib/html.js";

/**
 * The title a reader sees: staff's own, or Connected's when staff have not set one.
 *
 * Used everywhere a title is read rather than only in the lists, so a renamed item reads the same on the
 * map, on its own page, in a series' contents and in search. Every query using it has to join item_meta.
 */
export const titleExpr = sql<string>`coalesce(${itemMeta.displayTitle}, ${items.title})`;

export const itemSelect = {
  id: items.id, title: titleExpr, url: items.url, kind: items.sourceKind, description: sql<string | null>`nullif(coalesce(${itemMeta.displayDescription}, ${items.description}), '')`, summary: items.summary, contentType: items.contentType,
  updatedAt: items.sourceUpdatedAt, views: items.views, linkOnly: items.linkOnly, attachments: items.attachments, seriesTitles: items.seriesTitles, language: items.language, regions: items.regions,
  score: sql<number>`coalesce(${itemMeta.score}, 0)`, curation: itemMeta.curation, hidden: sql<boolean>`coalesce(${itemMeta.hidden}, false)`, dated: itemMeta.datedLabel, reviewStatus: itemMeta.reviewStatus,
  nativeKind: items.nativeKind, childPostIds: items.childPostIds, childItemIds: items.childItemIds, nativeAttachments: items.nativeAttachments,
  author: sql<string | null>`nullif(btrim(coalesce(${itemMeta.displayAuthor}, ${items.authorName})), '')`,
};
export type ItemRow = { author?: string | null; id: string; title: string; url: string; kind: string; description: string | null; summary: string | null; contentType: string | null; updatedAt: Date | null; views: number; linkOnly: boolean; attachments: { id: number }[]; seriesTitles: string[]; language: string; regions: string[]; score: number; curation: string | null; hidden: boolean; dated: string | null; reviewStatus: string | null; nativeKind?: string | null; childPostIds?: number[]; childItemIds?: string[]; nativeAttachments?: { driveId: string }[] };

export function toSummary(r: ItemRow, why?: string | null): ItemSummary {
  return { id: r.id, title: r.title, author: r.author?.replace(/\s+/g, " ") || null, url: r.url, kind: r.kind as ItemSummary["kind"], description: r.description ? stripContentTokens(r.description) : null, summary: r.summary ? stripContentTokens(r.summary) : null, contentType: r.contentType, updatedAt: r.updatedAt?.toISOString() ?? null, views: r.views, score: Math.round(r.score), curation: (r.curation as ItemSummary["curation"]) ?? null, dated: r.dated ?? null, linkOnly: r.linkOnly, attachmentCount: r.attachments.length + (r.nativeAttachments?.length ?? 0), seriesTitles: r.seriesTitles, language: (r.language as ItemLanguage) ?? "unknown", regions: r.regions ?? [], why: why ?? null, isSeries: isSeriesRow(r) };
}
export const isSeriesRow = (r: { kind: string; nativeKind?: string | null }) => r.kind === "series" || r.nativeKind === "series";
/** Series come first on the map; within each group the usual ranking applies. */
export function rankSeriesFirst(a: ItemRow & { position?: number | null }, b: ItemRow & { position?: number | null }): number {
  const sa = isSeriesRow(a) ? 0 : 1, sb = isSeriesRow(b) ? 0 : 1; if (sa !== sb) return sa - sb;
  return rank(a, b);
}
/** A roster of people or programs: built as a series so its entries nest, but presented as a list. */
export const RESOURCE_LIST = "resource_list";
export const isResourceListRow = (r: { contentType?: string | null }) => r.contentType === RESOURCE_LIST;
/** The reader's document type filter (keys from DOC_TYPES). Empty means everything. */
export const typeWhere = (types: string[] | null | undefined) => {
  if (!types?.length) return undefined;
  const parts = [];
  // A resource list is a series underneath, so it is matched on its content type and left out of "Series":
  // otherwise the coaches and consultants rosters would show up under both filters.
  if (types.includes(RESOURCE_LIST)) parts.push(sql`${items.contentType} = ${RESOURCE_LIST}`);
  if (types.includes("series")) parts.push(sql`((${items.sourceKind} = 'series' or ${items.nativeKind} = 'series') and coalesce(${items.contentType}, '') <> ${RESOURCE_LIST})`);
  if (types.includes("question")) parts.push(sql`(${items.sourceKind} = 'question' or ${items.contentType} = 'question')`);
  const ct = types.filter((t) => t !== "series" && t !== "question" && t !== RESOURCE_LIST);
  if (ct.length) parts.push(sql`(${items.contentType} in (${sql.join(ct.map((t) => sql`${t}`), sql`, `)}) and ${items.sourceKind} <> 'series' and coalesce(${items.nativeKind}, '') <> 'series')`);
  return sql`(${sql.join(parts, sql` or `)})`;
};
export function parseTypes(v: unknown): string[] { return typeof v === "string" && v ? v.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20) : []; }
/** Effective sort: hidden excluded, pinned position, essential, recommended, then score. */
export function rank(a: ItemRow & { position?: number | null }, b: ItemRow & { position?: number | null }): number {
  const pa = a.position ?? 1e9, pb = b.position ?? 1e9; if (pa !== pb) return pa - pb;
  const ca = a.curation === "essential" ? 2 : a.curation === "recommended" ? 1 : 0, cb = b.curation === "essential" ? 2 : b.curation === "recommended" ? 1 : 0;
  if (ca !== cb) return cb - ca;
  return b.score - a.score;
}
export const visibleWhere = (staff: boolean) => staff ? sql`${items.removedAt} is null and ${items.status} = 'published'` : sql`${items.removedAt} is null and ${items.status} = 'published' and coalesce(${itemMeta.hidden}, false) = false`;
/** The reader's language filter. "all" keeps everything, including items whose language is unknown. */
export const languageWhere = (lang: ResourceLanguage | null | undefined) => (lang && lang !== "all" ? sql`${items.language} = ${lang}` : undefined);
/**
 * The reader's region filter: the union of whatever options they ticked, and everything when they
 * ticked none. Each tick stands on its own — Minnesota means Minnesota's material and nothing else —
 * so a teacher leader who also wants the material written for nowhere in particular ticks that too.
 */
export const regionWhere = (regions: string[] | null | undefined) => {
  if (!regions?.length) return undefined;
  const parts = [];
  if (regions.includes(GENERAL_REGION)) parts.push(sql`coalesce(array_length(${items.regions}, 1), 0) = 0`);
  const keys = regions.filter((r) => r !== GENERAL_REGION);
  // Array overlap: the item carries any one of the ticked regions. Uses the GIN index on items.regions.
  if (keys.length) parts.push(sql`${items.regions} && array[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}]::text[]`);
  return parts.length ? sql`(${sql.join(parts, sql` or `)})` : undefined;
};

/** What the reader's filter row narrows a list to. A missing field means that filter is not narrowing. */
export interface ReaderFilters { language?: ResourceLanguage; regions?: string[]; types?: string[] }
/** Every reader-facing list runs through this, so the filter row means the same thing everywhere. */
export const filterWhere = (f: ReaderFilters = {}) => and(languageWhere(f.language), regionWhere(f.regions), typeWhere(f.types));

/**
 * Items placed in a sub-job for the map: series first, and a post that belongs to one of those series is listed inside
 * the series card rather than as a card of its own.
 */
export async function itemsForSubjob(subjobId: string, staff: boolean, f: ReaderFilters = {}): Promise<ItemSummary[]> {
  const db = getDb();
  const rows = await db.select({ ...itemSelect, position: placements.position, why: placements.why, isPrimary: placements.isPrimary }).from(placements).innerJoin(items, eq(items.id, placements.itemId)).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(eq(placements.subjobId, subjobId), visibleWhere(staff), filterWhere(f)));
  return nestSeries(rows.sort(rankSeriesFirst) as (ItemRow & { why?: string | null })[], staff);
}
/**
 * How many cards each sub-job actually shows, keyed by sub-job id.
 *
 * This has to agree with `itemsForSubjob`, which nests a series' own items inside the series card
 * instead of listing them beside it. Counting placement rows did not: the job list on the map claimed
 * 87 resources for "Find coaches, consultants, and vendors" where the page showed 42, because every
 * post belonging to a series was counted once on its own and once inside its series.
 *
 * The reader's filters decide which rows can appear as cards; children are resolved against visibility
 * alone, which is what `nestSeries` does, so an item hidden from the reader never nests anything away.
 * A series that belongs to another series on the page nests away like anything else, matching nestSeries.
 */
export async function subjobItemCounts(staff: boolean, f: ReaderFilters = {}): Promise<Map<string, number>> {
  const fw = filterWhere(f);
  const rows = await getDb().execute(sql`
    with vis as (
      select items.id, items.source_kind, items.native_kind, items.child_post_ids, items.child_item_ids
      from items left join item_meta on item_meta.item_id = items.id
      where ${visibleWhere(staff)}${fw ? sql` and ${fw}` : sql``}
    ),
    vis_all as (
      select items.id, items.source_kind, items.source_id, items.imported_from
      from items left join item_meta on item_meta.item_id = items.id
      where ${visibleWhere(staff)}
    ),
    placed as (
      select placements.subjob_id, vis.id as item_id, vis.source_kind, vis.native_kind, vis.child_post_ids, vis.child_item_ids
      from placements join vis on vis.id = placements.item_id
    ),
    kids as (
      select placed.subjob_id, c.item_id
      from placed
      cross join lateral (
        select vis_all.id as item_id
        from jsonb_array_elements_text(coalesce(placed.child_item_ids, '[]'::jsonb)) as e(cid)
        join vis_all on vis_all.id::text = e.cid
        union
        select vis_all.id as item_id
        from jsonb_array_elements_text(coalesce(placed.child_post_ids, '[]'::jsonb)) as e2(pid)
        join vis_all on (vis_all.source_kind <> 'native' and vis_all.source_id::text = e2.pid)
                     or (vis_all.imported_from->>'sourceId' = e2.pid)
      ) as c
      where placed.source_kind = 'series' or placed.native_kind = 'series'
    )
    select placed.subjob_id as subjob_id, count(*)::int as n
    from placed
    where not exists (select 1 from kids where kids.subjob_id = placed.subjob_id and kids.item_id = placed.item_id)
    group by placed.subjob_id`);
  return new Map((rows.rows as { subjob_id: string; n: number }[]).map((r) => [r.subjob_id, Number(r.n)]));
}

/**
 * How many resources are *placed* in each sub-job, keyed by sub-job id.
 *
 * Deliberately not the same number as `subjobItemCounts`. That one counts the cards a reader sees, so a
 * post belonging to a series is counted once, inside its series. Staff moving resources around are working
 * on the placements themselves: the series and each of its posts are separate rows they can drag, remove
 * or merge, so the number beside a sub-job on Organize has to be the number of rows it opens. On "501c3
 * status and the group exemption" those two readings are 5 and 35.
 *
 * Only removed items are left out — a hidden or unpublished one still holds a placement staff can act on.
 */
export async function subjobPlacementCounts(): Promise<Map<string, number>> {
  const rows = await getDb().execute(sql`
    select placements.subjob_id as subjob_id, count(*)::int as n
    from placements join items on items.id = placements.item_id
    where items.removed_at is null
    group by placements.subjob_id`);
  return new Map((rows.rows as { subjob_id: string; n: number }[]).map((r) => [r.subjob_id, Number(r.n)]));
}

/**
 * Items by their Connected id, whether still mirrored or already imported (imported_from).
 *
 * A series lists its contents as bare Connected ids, and those contents are not always posts: a series
 * can gather other series. Matching only posts meant a set of modules gathered under one series resolved
 * to nothing, so the parent card listed no contents and each module kept a card of its own.
 *
 * A post wins a tie, because that is the kind a series' contents nearly always are.
 */
export async function postsBySourceId(sourceIds: number[], staff: boolean): Promise<Map<number, ItemRow & { sourceId: number }>> {
  const out = new Map<number, ItemRow & { sourceId: number }>();
  if (!sourceIds.length) return out;
  const ids = sql.join(sourceIds.map((x) => sql`${x}`), sql`, `);
  const rows = await getDb().select({ ...itemSelect, sourceKind: items.sourceKind, sourceId: sql<number>`case when ${items.importedFrom}->>'sourceId' is not null then (${items.importedFrom}->>'sourceId')::bigint else ${items.sourceId} end`.mapWith(Number) }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id))
    .where(and(sql`(${items.sourceId} in (${ids}) and ${items.sourceKind} <> 'native') or ((${items.importedFrom}->>'sourceId')::bigint in (${ids}))`, visibleWhere(staff)));
  for (const r of rows) { const prev = out.get(r.sourceId); if (!prev || r.sourceKind === "post") out.set(r.sourceId, r as ItemRow & { sourceId: number }); }
  return out;
}
/** Attach each series' items (in order) and drop those items from the standalone list. */
export async function nestSeries(rows: (ItemRow & { why?: string | null })[], staff: boolean): Promise<ItemSummary[]> {
  const db = getDb();
  const series = rows.filter(isSeriesRow);
  const postIds = [...new Set(series.flatMap((s) => s.childPostIds ?? []))];
  const nativeIds = [...new Set(series.flatMap((s) => s.childItemIds ?? []))];
  const byPost = new Map<number, { id: string; title: string }>(); const byId = new Map<string, { id: string; title: string }>();
  for (const [sid, c] of await postsBySourceId(postIds, staff)) byPost.set(sid, { id: c.id, title: c.title });
  if (nativeIds.length) for (const c of await db.select({ id: items.id, title: titleExpr }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(inArray(items.id, nativeIds), visibleWhere(staff)))) byId.set(c.id, { id: c.id, title: c.title });
  const nested = new Set<string>();
  const parentOf = new Map<string, string>();
  const childrenOf = (s: ItemRow) => { const out: { id: string; title: string }[] = []; for (const pid of s.childPostIds ?? []) { const c = byPost.get(pid); if (c) out.push(c); } for (const id of s.childItemIds ?? []) { const c = byId.get(id); if (c) out.push(c); } for (const c of out) { nested.add(c.id); if (!parentOf.has(c.id)) parentOf.set(c.id, s.id); } return out; };
  const withChildren = rows.map((r) => ({ r, children: isSeriesRow(r) ? childrenOf(r) : [] }));
  /**
   * A series that belongs to another series on the same page is shown inside it, not beside it. Series
   * used to be kept at the top level unconditionally, so a set of modules gathered under one series still
   * listed every module as its own card.
   *
   * Two series that each claim the other would otherwise both disappear, so a parent chain that loops
   * back on itself counts as no parent at all.
   */
  const nestedUnderAnother = (id: string) => {
    const seen = new Set<string>([id]);
    for (let p = parentOf.get(id); p; p = parentOf.get(p)) { if (seen.has(p)) return false; seen.add(p); }
    return nested.has(id);
  };
  return withChildren.filter(({ r }) => !nestedUnderAnother(r.id)).map(({ r, children }) => ({ ...toSummary(r, r.why ?? null), ...(children.length ? { children } : {}) }));
}
export async function startHere(stage: StageKey, staff: boolean, cap: number, f: ReaderFilters = {}): Promise<ItemSummary[]> {
  const db = getDb();
  const pinned = await db.select({ ...itemSelect, position: itemMeta.pinnedPosition }).from(items).innerJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(eq(itemMeta.pinnedStage, stage), visibleWhere(staff), filterWhere(f))).orderBy(itemMeta.pinnedPosition);
  const out: (ItemRow & { position?: number | null })[] = [...pinned];
  if (out.length < cap) {
    const ids = new Set(out.map((o) => o.id));
    const ess = await db.selectDistinctOn([items.id], { ...itemSelect }).from(items).innerJoin(itemMeta, eq(itemMeta.itemId, items.id)).innerJoin(placements, eq(placements.itemId, items.id)).innerJoin(subjobs, eq(subjobs.id, placements.subjobId)).innerJoin(jobs, eq(jobs.id, subjobs.jobId))
      .where(and(sql`${itemMeta.curation} in ('essential','recommended')`, sql`${stage} = any(${subjobs.stages})`, eq(jobs.hidden, false), eq(jobs.staffOnly, false), visibleWhere(staff), filterWhere(f)));
    for (const e of ess.sort(rank)) if (!ids.has(e.id)) { out.push(e); ids.add(e.id); }
  }
  return out.slice(0, cap).map((r) => toSummary(r));
}
export async function mostUsed(staff: boolean, limit = 8, f: ReaderFilters = {}): Promise<ItemSummary[]> {
  const db = getDb();
  const rows = await db.select({ ...itemSelect, clicks: itemMeta.wfClicks30d }).from(items).innerJoin(itemMeta, eq(itemMeta.itemId, items.id)).innerJoin(placements, and(eq(placements.itemId, items.id), eq(placements.isPrimary, true))).innerJoin(subjobs, eq(subjobs.id, placements.subjobId)).innerJoin(jobs, eq(jobs.id, subjobs.jobId))
    .where(and(visibleWhere(staff), eq(jobs.staffOnly, false), sql`${itemMeta.datedLabel} is null`, filterWhere(f))).orderBy(desc(sql`coalesce(${itemMeta.wfClicks30d},0) * 10 + ${items.views} / greatest(1, extract(epoch from (now() - coalesce(${items.publishedAt}, now()))) / 2592000)`)).limit(limit);
  return rows.map((r) => toSummary(r as ItemRow));
}
export async function itemsByIds(ids: string[], staff: boolean, f: ReaderFilters = {}): Promise<Map<string, ItemRow>> {
  if (!ids.length) return new Map();
  const rows = await getDb().select(itemSelect).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id)).where(and(inArray(items.id, ids), visibleWhere(staff), filterWhere(f)));
  return new Map(rows.map((r) => [r.id, r as ItemRow]));
}
