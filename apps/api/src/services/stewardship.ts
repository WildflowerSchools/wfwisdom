import { and, asc, auditLog, eq, getDb, isNull, itemFlags, itemMeta, items, sql, users } from "@wfw/db";
import { creditNames } from "@wfw/shared";
import { RESOURCE_LIST, titleExpr } from "./items.js";
import { CurationError } from "./curation.js";

/**
 * Keeping the library right: who looks after each resource, when it was last looked over, and what
 * readers have flagged.
 *
 * Nothing here schedules a review. Staff asked for a list ordered by how long each resource has gone
 * unreviewed and to work it themselves, so the only state is the date someone last said "this stands".
 */
export interface ReviewRow {
  id: string; title: string; type: string; author: string | null; steward: string | null; stewardId: string | null;
  updatedAt: string | null; reviewedAt: string | null; reviewedBy: string | null; hidden: boolean; dated: string | null;
  place: string | null; flags: number; flagNote: string | null; mine: boolean;
}
const iso = (d: Date | string | null) => d ? new Date(d).toISOString() : null;

export async function reviewList(me: { id: string; name: string }, opts: { mine?: boolean } = {}): Promise<ReviewRow[]> {
  const rows = await getDb().select({
    id: items.id, title: titleExpr, contentType: items.contentType, sourceKind: items.sourceKind, nativeKind: items.nativeKind,
    author: sql<string | null>`nullif(btrim(coalesce(${itemMeta.displayAuthor}, ${items.authorName})), '')`,
    stewardId: itemMeta.stewardUserId, steward: sql<string | null>`(select u.name from users u where u.id = ${itemMeta.stewardUserId})`,
    updatedAt: items.sourceUpdatedAt, reviewedAt: itemMeta.reviewedAt, reviewedBy: itemMeta.reviewedBy,
    hidden: sql<boolean>`coalesce(${itemMeta.hidden}, false)`, dated: itemMeta.datedLabel,
    place: sql<string | null>`(select j.name || ' · ' || s.name from placements p join subjobs s on s.id = p.subjob_id join jobs j on j.id = s.job_id where p.item_id = ${items.id} order by p.is_primary desc limit 1)`,
    flags: sql<number>`(select count(*)::int from item_flags f where f.item_id = ${items.id} and f.resolved_at is null)`,
    flagNote: sql<string | null>`(select f.note from item_flags f where f.item_id = ${items.id} and f.resolved_at is null and f.note is not null order by f.created_at desc limit 1)`,
  }).from(items).leftJoin(itemMeta, eq(itemMeta.itemId, items.id))
    // removed_at is the indexer's "gone from Connected"; an unpublished contribution is not yet the library's to review.
    .where(and(isNull(items.removedAt), eq(items.status, "published")))
    // Longest unreviewed first. Never reviewed sorts ahead of everything, oldest material first.
    .orderBy(sql`${itemMeta.reviewedAt} asc nulls first`, sql`${items.sourceUpdatedAt} asc nulls first`, asc(items.id));
  const out = rows.map((r) => ({
    id: r.id, title: r.title, author: r.author?.replace(/\s+/g, " ") ?? null, steward: r.steward, stewardId: r.stewardId,
    type: r.contentType === RESOURCE_LIST ? RESOURCE_LIST : r.sourceKind === "series" || r.nativeKind === "series" ? "series" : r.sourceKind === "question" ? "question" : r.contentType ?? "other",
    updatedAt: iso(r.updatedAt), reviewedAt: iso(r.reviewedAt), reviewedBy: r.reviewedBy, hidden: r.hidden, dated: r.dated, place: r.place, flags: r.flags, flagNote: r.flagNote,
    mine: r.stewardId === me.id || creditNames(r.author, me.name),
  }));
  return opts.mine ? out.filter((r) => r.mine) : out;
}

/** "I have read this and it stands." Closes the open flags on it, since answering them is what a review is. */
export async function markReviewed(id: string, actorName: string, note?: string | null): Promise<{ reviewedAt: string; flagsClosed: number }> {
  const db = getDb();
  const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, id));
  if (!item) throw new CurationError("Item not found", 404);
  const at = new Date();
  const set = { reviewedBy: actorName, reviewedAt: at, updatedAt: at };
  await db.insert(itemMeta).values({ itemId: id, ...set }).onConflictDoUpdate({ target: itemMeta.itemId, set });
  const closed = await db.update(itemFlags).set({ resolvedAt: at, resolvedBy: actorName }).where(and(eq(itemFlags.itemId, id), isNull(itemFlags.resolvedAt))).returning({ id: itemFlags.id });
  await db.insert(auditLog).values({ actor: actorName, action: "item.reviewed", target: id, detail: { note: note ?? null, flagsClosed: closed.length } });
  return { reviewedAt: at.toISOString(), flagsClosed: closed.length };
}

/** One open flag per person per resource: saying it twice adds nothing, but a newer note replaces the older. */
export async function flagItem(id: string, userId: string, note?: string | null): Promise<void> {
  const db = getDb();
  const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, id));
  if (!item) throw new CurationError("Item not found", 404);
  const text = note?.trim().slice(0, 1000) || null;
  const [open] = await db.select({ id: itemFlags.id }).from(itemFlags).where(and(eq(itemFlags.itemId, id), eq(itemFlags.userId, userId), isNull(itemFlags.resolvedAt)));
  if (open) { if (text) await db.update(itemFlags).set({ note: text }).where(eq(itemFlags.id, open.id)); return; }
  await db.insert(itemFlags).values({ itemId: id, userId, note: text });
}

/** Staff who can be given a resource to look after. */
export async function stewardCandidates(): Promise<{ id: string; name: string; email: string }[]> {
  return getDb().select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.role, "staff")).orderBy(asc(users.name));
}

/** Give a resource a steward, by user id or email, or take the steward away with null. */
export async function setSteward(id: string, who: { userId?: string | null; email?: string | null }, actorName: string): Promise<{ steward: string | null }> {
  const db = getDb();
  const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, id));
  if (!item) throw new CurationError("Item not found", 404);
  let u: { id: string; name: string } | undefined;
  if (who.userId || who.email) {
    [u] = await db.select({ id: users.id, name: users.name }).from(users).where(who.userId ? eq(users.id, who.userId) : sql`lower(${users.email}) = ${who.email!.trim().toLowerCase()}`);
    // A steward has to be someone who can sign in and see their list, so a name that is not a user is refused.
    if (!u) throw new CurationError("No one with that address has signed in to Wisdom yet. They need to sign in once before they can be a steward.", 400);
  }
  const set = { stewardUserId: u?.id ?? null, updatedAt: new Date() };
  await db.insert(itemMeta).values({ itemId: id, ...set }).onConflictDoUpdate({ target: itemMeta.itemId, set });
  await db.insert(auditLog).values({ actor: actorName, action: "item.steward", target: id, detail: { steward: u?.name ?? null } });
  return { steward: u?.name ?? null };
}
