import { and, eq, getDb, itemMeta, signals, sql } from "@wfw/db";

export type SignalKind = "click" | "search_click" | "helpful_yes" | "helpful_no";

/** Record that a reader opened or voted on a resource, and keep the counters on item_meta in step. */
export async function recordSignal(userId: string, itemId: string, kind: SignalKind, context: Record<string, unknown> = {}): Promise<void> {
  const db = getDb();
  // One vote per reader: a new one replaces whatever they said before.
  if (kind === "helpful_yes" || kind === "helpful_no") {
    await db.delete(signals).where(and(eq(signals.itemId, itemId), eq(signals.userId, userId), sql`kind in ('helpful_yes','helpful_no')`));
  }
  await db.insert(signals).values({ itemId, userId, kind, context });
  if (kind.startsWith("helpful")) {
    const [v] = await db.select({ yes: sql<number>`count(*) filter (where kind='helpful_yes')::int`, no: sql<number>`count(*) filter (where kind='helpful_no')::int` }).from(signals).where(eq(signals.itemId, itemId));
    await db.insert(itemMeta).values({ itemId, wfHelpfulYes: v?.yes ?? 0, wfHelpfulNo: v?.no ?? 0 }).onConflictDoUpdate({ target: itemMeta.itemId, set: { wfHelpfulYes: v?.yes ?? 0, wfHelpfulNo: v?.no ?? 0 } });
  } else {
    await db.insert(itemMeta).values({ itemId, wfClicks30d: 1 }).onConflictDoUpdate({ target: itemMeta.itemId, set: { wfClicks30d: sql`${itemMeta.wfClicks30d} + 1` } });
  }
}
