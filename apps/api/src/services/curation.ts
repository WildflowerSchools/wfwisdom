import { z } from "zod";
import { and, auditLog, eq, getDb, inArray, itemMeta, items, placements, subjobs } from "@wfw/db";

/**
 * Staff changes to a resource's curation record and to where it sits on the map.
 *
 * These lived in the admin routes until the Claude connector needed them too. They are here, rather
 * than copied, because both carry rules that are easy to get subtly wrong: which empty values mean
 * "fall back to Connected" and which mean "show nothing", and keeping exactly one primary placement.
 */
export class CurationError extends Error { constructor(message: string, public status: 400 | 404) { super(message); } }

export const metaPatchSchema = z.object({ curation: z.enum(["essential", "recommended"]).nullable().optional(), hidden: z.boolean().optional(), displayTitle: z.string().trim().max(300).nullable().optional(), displayAuthor: z.string().trim().max(200).nullable().optional(), displayDescription: z.string().trim().max(2000).nullable().optional(), displayPublishedAt: z.string().trim().max(40).nullable().optional(), datedLabel: z.string().max(40).nullable().optional(), pinnedStage: z.string().nullable().optional(), pinnedPosition: z.number().int().nullable().optional(), staffNote: z.string().max(500).nullable().optional(), reviewStatus: z.enum(["none", "pending", "keep", "dated", "hidden"]).optional() });
export type MetaPatch = z.infer<typeof metaPatchSchema>;

export async function applyMetaPatch(id: string, b: MetaPatch, actorName: string): Promise<void> {
  const set: Record<string, unknown> = { ...b, updatedAt: new Date() };
  // An emptied box means "use the title Connected carries", not a title that is the empty string.
  if (b.displayTitle !== undefined) set.displayTitle = b.displayTitle || null;
  if (b.displayAuthor !== undefined) set.displayAuthor = b.displayAuthor || null;
  // Empty is meaningful here: it shows no description at all, where null falls back to Connected's.
  if (b.displayDescription !== undefined) set.displayDescription = b.displayDescription;
  // A date the material states about itself. An unparseable value is refused rather than stored as null,
  // which would silently read as "no override" and quietly put the Connected date back.
  if (b.displayPublishedAt !== undefined) {
    if (!b.displayPublishedAt) set.displayPublishedAt = null;
    else { const d = new Date(b.displayPublishedAt); if (Number.isNaN(d.getTime())) throw new CurationError("Could not read that date", 400); set.displayPublishedAt = d; }
  }
  if (b.reviewStatus && b.reviewStatus !== "pending" && b.reviewStatus !== "none") { set.reviewedBy = actorName; set.reviewedAt = new Date(); }
  await getDb().insert(itemMeta).values({ itemId: id, ...(set as object) }).onConflictDoUpdate({ target: itemMeta.itemId, set });
  await getDb().insert(auditLog).values({ actor: actorName, action: "item.meta", target: id, detail: b });
}

export const moveSchema = z.object({ from: z.string().nullable().optional(), to: z.string(), copy: z.boolean().default(false) });
export type MoveRequest = z.infer<typeof moveSchema>;

/**
 * Move one resource from one sub-job to another, or copy it into a second one.
 *
 * Kept apart from replacing an item's whole set of placements, which needs the caller to already know
 * every placement it has. This says what the staff member actually did — moved this resource to that
 * sub-job — and leaves the item's other placements alone. A move that lands where the item already
 * sits just drops the old placement.
 */
export async function moveItem(id: string, b: MoveRequest, actorName: string): Promise<{ moved: boolean }> {
  const db = getDb();
  const [item] = await db.select({ id: items.id }).from(items).where(eq(items.id, id));
  if (!item) throw new CurationError("Item not found", 404);
  const subs = await db.select({ id: subjobs.id, key: subjobs.key }).from(subjobs).where(inArray(subjobs.key, [b.to, ...(b.from ? [b.from] : [])]));
  const to = subs.find((s) => s.key === b.to);
  const from = b.from ? subs.find((s) => s.key === b.from) : undefined;
  if (!to || (b.from && !from)) throw new CurationError("Sub-job not found", 404);
  if (from && from.id === to.id) return { moved: false };
  // The item keeps its standing: a resource that was the primary of where it came from stays primary.
  const [old] = from ? await db.select({ isPrimary: placements.isPrimary, position: placements.position, why: placements.why }).from(placements).where(and(eq(placements.itemId, id), eq(placements.subjobId, from.id))) : [];
  await db.insert(placements).values({ itemId: id, subjobId: to.id, isPrimary: !b.copy && (old?.isPrimary ?? false), source: "staff", position: old?.position ?? null, why: old?.why ?? null }).onConflictDoNothing();
  if (from && !b.copy) await db.delete(placements).where(and(eq(placements.itemId, id), eq(placements.subjobId, from.id)));
  // Dropping the primary placement — onto a sub-job the item was already in, say — would otherwise leave
  // it placed everywhere and primary nowhere, which is what the map ranks and "most used" reads.
  const rest = await db.select({ subjobId: placements.subjobId, isPrimary: placements.isPrimary }).from(placements).where(eq(placements.itemId, id));
  if (rest.length && !rest.some((p) => p.isPrimary)) {
    const promote = rest.find((p) => p.subjobId === to.id) ?? rest[0]!;
    await db.update(placements).set({ isPrimary: true }).where(and(eq(placements.itemId, id), eq(placements.subjobId, promote.subjobId)));
  }
  await db.insert(auditLog).values({ actor: actorName, action: b.copy ? "item.placement.copy" : "item.placement.move", target: id, detail: b });
  return { moved: true };
}
