import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { and, desc, eq, getDb, inArray, itemMeta, itemVersions, items, jobs, placements, sql, subjobs, users, auditLog, materialTypes } from "@wfw/db";
import { actor, requireStaff, requireUser } from "../auth.js";
import { extractText } from "../lib/extract.js";
import { embedItems, summarizeItems } from "../services/indexer.js";
import { copyToWisdomDrive, driveDownload, driveMeta, exportGoogle, googleUrl, inWisdomDrive, mirrorImages, guessMime, hasEmbeddedImages, isGoogleAppsMime, markdownToHtml, parseGoogleLink, readNativeContent, refreshNativeItem, snapshotIfChanged, toNodeStream, uploadToDrive, type GoogleKind, type NativeKind } from "../services/native.js";
import { resolveLanguage } from "../services/language.js";
import { getSettings } from "../settings.js";
import { loadVectors } from "../services/vectors.js";
import { sha } from "../lib/text.js";
import { env } from "../env.js";
import { sanitizeBody } from "../lib/html.js";
import { htmlToMarkdown } from "../lib/markdown.js";
import { logger } from "../logger.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

interface CreateInput { kind: NativeKind; title?: string; description?: string | null; url?: string; file?: Express.Multer.File; bodyMarkdown?: string; childItemIds?: string[]; materialTypeKey?: string | null; note?: string | null; status: "published" | "pending"; authorUserId: string; by: string }

/** Create a native item from a Google link, an uploaded file, written text, or a list of items. */
export async function createNativeItem(input: CreateInput): Promise<{ id: string }> {
  const db = getDb();
  let googleFileId: string | null = null; let googleKind: GoogleKind | null = null; let driveMime: string | null = null; let url = ""; let title = input.title?.trim() ?? "";
  if (input.kind === "google") {
    const g = parseGoogleLink(input.url ?? ""); if (!g) throw new Error("That is not a Google Docs, Sheets, Slides, or Drive link");
    googleFileId = g.id; googleKind = g.kind; url = googleUrl(g.kind, g.id);
    const meta = await driveMeta(g.id); if (meta) { driveMime = meta.mimeType; if (!title) title = meta.name; if (meta.webViewLink) url = meta.webViewLink; }
    // Without the service account (or for a file shared only by link) the export itself carries the title.
    if (!title) { const ex = await exportGoogle(g.kind, g.id, driveMime); if (ex.status !== "ok") throw new Error(ex.status === "private" ? "That Google file is private. Share it with anyone with the link, or with the Wildflower Wisdom service account." : "That Google file could not be read."); title = ex.title?.trim() || "Untitled Google file"; }
  } else if (input.kind === "file") {
    const f = input.file; if (!f) throw new Error("No file was uploaded");
    const mime = guessMime(f.originalname, f.mimetype);
    const meta = await uploadToDrive(f.buffer, f.originalname, mime, true);
    googleFileId = meta.id; driveMime = meta.mimeType; url = meta.webViewLink ?? googleUrl("file", meta.id);
    googleKind = meta.mimeType === "application/vnd.google-apps.document" ? "document" : meta.mimeType === "application/vnd.google-apps.spreadsheet" ? "spreadsheets" : meta.mimeType === "application/vnd.google-apps.presentation" ? "presentation" : "file";
    if (!title) title = f.originalname.replace(/\.[a-z0-9]+$/i, "");
  }
  if (!title) throw new Error("A title is needed");
  const kind: NativeKind = input.kind === "file" && googleKind !== "file" ? "google" : input.kind;
  const contentType = kind === "google" ? (googleKind === "spreadsheets" ? "Google Sheet" : googleKind === "presentation" ? "Google Slides" : "Google Doc") : kind === "file" ? ((driveMime ?? "").includes("pdf") ? "PDF" : (driveMime ?? "").startsWith("video/") ? "Video" : (driveMime ?? "").startsWith("image/") ? "Image" : "File") : kind === "text" ? "Note" : "Series";
  const [row] = await db.insert(items).values({ sourceKind: "native", sourceId: sql`nextval('native_item_seq')`, title, description: input.description?.trim() || null, url: url || "pending", authorName: null, publishedAt: new Date(), sourceUpdatedAt: new Date(), contentType, nativeKind: kind, googleFileId, googleKind, driveMime, authorUserId: input.authorUserId, status: input.status, contributionNote: input.note ?? null, materialTypeKey: input.materialTypeKey ?? null, childItemIds: input.childItemIds ?? [], bodyMarkdown: input.bodyMarkdown ?? null, indexedAt: new Date() }).returning({ id: items.id });
  const id = row!.id;
  if (!url) await db.update(items).set({ url: `/item/${id}` }).where(eq(items.id, id));
  // Uploaded files that stay files (PDF, images): extract text once for search.
  if (kind === "file" && input.file) {
    try { const { text } = await extractText(input.file.buffer, input.file.originalname, input.file.mimetype); if (text.trim()) { const content = await readNativeContent({ nativeKind: "file", googleFileId, googleKind: "file", driveMime, bodyMarkdown: null, title }); await db.update(items).set({ bodyText: text.slice(0, 400_000), bodyHtml: content.html, hasText: text.length >= 300, contentHash: sha(`${title}||${text}`), language: (await resolveLanguage({ title, body: text })) ?? "unknown" }).where(eq(items.id, id)); await snapshotIfChanged(id, { ...content, text, hash: sha(`${title}||${text}`) }, title, null, input.by); } } catch { /* text is optional for files */ }
  } else await refreshNativeItem(id, input.by);
  if (input.status === "published") await publishNative(id);
  return { id };
}

/** Embed, summarize, and reload search vectors for a newly published native item. */
export async function publishNative(id: string): Promise<void> {
  const s = await getSettings(); const log = () => {};
  try { await embedItems([id], s.embeddingModel, log); await summarizeItems([id], s.assistModel, log); await loadVectors(true); } catch (e) { console.warn(`[native] publish indexing failed for ${id}: ${(e as Error).message}`); }
}

const contributionSelect = { id: items.id, title: items.title, description: items.description, url: items.url, status: items.status, nativeKind: items.nativeKind, googleKind: items.googleKind, materialTypeKey: items.materialTypeKey, contributionNote: items.contributionNote, declineNote: items.declineNote, createdAt: items.publishedAt, authorName: users.name, authorEmail: users.email, authorUserId: items.authorUserId };

/** Anyone signed in can share a Google file or upload one for staff review. */
export const contributionsRouter = Router();
contributionsRouter.use(requireUser);
contributionsRouter.get("/", async (req, res) => {
  const rows = await getDb().select(contributionSelect).from(items).leftJoin(users, eq(users.id, items.authorUserId)).where(and(eq(items.sourceKind, "native"), eq(items.authorUserId, req.user!.id))).orderBy(desc(items.publishedAt));
  res.json({ contributions: rows });
});
contributionsRouter.post("/", upload.single("file"), async (req, res) => {
  const body = z.object({ title: z.string().max(200).optional(), url: z.string().url().max(2000).optional(), note: z.string().max(4000).optional(), materialTypeKey: z.string().max(80).optional(), description: z.string().max(600).optional() }).parse(req.body);
  const s = await getSettings();
  if (req.file && req.file.size > Math.max(s.maxUploadBytes, 25 * 1024 * 1024)) { res.status(413).json({ error: "That file is too large" }); return; }
  try {
    const staff = req.user!.role === "staff";
    const r = await createNativeItem({ kind: req.file ? "file" : "google", title: body.title, description: body.description ?? null, url: body.url, file: req.file, materialTypeKey: body.materialTypeKey ?? null, note: body.note ?? null, status: staff ? "published" : "pending", authorUserId: req.user!.id, by: actor(req) });
    res.status(201).json(r);
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

// The three staff decisions below are functions rather than route bodies because the Claude connector
// makes the same decisions (apps/api/src/mcp/tools.ts) and has to make them the same way.
export const approveSchema = z.object({ subjobKeys: z.array(z.string()).default([]), stages: z.array(z.string()).default([]), title: z.string().max(200).optional(), description: z.string().max(600).nullable().optional(),
  /** A contributed Google link stays the contributor's file unless it is copied. See approveContribution. */
  copyToWisdom: z.boolean().default(true) });
/** Publish a contribution, put it on the map, and index it. False when there is no such native item. */
export async function approveContribution(id: string, body: z.infer<typeof approveSchema>, by: string): Promise<boolean> {
  const db = getDb();
  const [it] = await db.select({ id: items.id, status: items.status, title: items.title, nativeKind: items.nativeKind, googleKind: items.googleKind, googleFileId: items.googleFileId }).from(items).where(and(eq(items.id, id), eq(items.sourceKind, "native")));
  if (!it) return false;
  // A linked resource publishes whatever its Google file says, as soon as it says it. Left pointing at a
  // contributor's own file, that is their later edits going out unreviewed, and a resource that breaks the
  // day they delete the file or leave. So approval copies the file into the Wisdom Drive and links to the
  // copy, unless staff choose to stay with the original because its owner will keep it up. Done before
  // anything is published, so a file Google will not let us copy leaves the contribution still waiting.
  let copiedFrom: string | null = null;
  if (body.copyToWisdom && it.nativeKind === "google" && it.googleFileId && !(await inWisdomDrive(it.googleFileId))) {
    const copy = await copyToWisdomDrive(it.googleFileId, body.title?.trim() || it.title);
    copiedFrom = it.googleFileId;
    await db.update(items).set({ googleFileId: copy.id, url: copy.webViewLink ?? googleUrl((it.googleKind ?? "document") as GoogleKind, copy.id), driveMime: copy.mimeType, nativeModifiedAt: null }).where(eq(items.id, id));
  }
  await db.update(items).set({ status: "published", declineNote: null, ...(body.title ? { title: body.title.trim() } : {}), ...(body.description !== undefined ? { description: body.description?.trim() || null } : {}) }).where(eq(items.id, id));
  await setPlacements(id, body.subjobKeys, body.stages);
  await refreshNativeItem(id, by); await publishNative(id);
  await db.insert(auditLog).values({ actor: by, action: "contribution.approve", target: id, detail: { ...body, ...(copiedFrom ? { copiedFrom } : {}) } as unknown as Record<string, unknown> }).catch(() => undefined);
  return true;
}
export async function declineContribution(id: string, note: string | null, by: string): Promise<void> {
  const db = getDb();
  await db.update(items).set({ status: "declined", declineNote: note }).where(and(eq(items.id, id), eq(items.sourceKind, "native")));
  await db.insert(auditLog).values({ actor: by, action: "contribution.decline", target: id, detail: { note } }).catch(() => undefined);
}
/**
 * The other direction: stop reading from the Google Doc and hold the page in Wisdom.
 *
 * After this the Wisdom record is the only one that matters. The document's content comes in as the
 * Markdown the editor here works in, with its tables, and its pictures pointing at the copies Wisdom
 * keeps. The Google file is left exactly as it is, and its address is returned so staff can remove it:
 * leaving two editable copies around is the thing this exists to prevent, but deleting someone's file
 * is not Wisdom's to do. Only a Google Doc can be held; a Sheet or Slides has no page to become.
 * Throws with a message for the person.
 */
export async function detachToHeld(id: string, by: string): Promise<{ formerGoogleUrl: string; chars: number; pictures: number; tables: number }> {
  const db = getDb();
  const [it] = await db.select().from(items).where(and(eq(items.id, id), eq(items.sourceKind, "native")));
  if (!it) throw new Error("That is not a resource Wisdom keeps itself. One still read from Connected cannot be held until it has been imported.");
  if (it.nativeKind !== "google" || !it.googleFileId) throw new Error("This resource is not linked to a Google file");
  if (it.googleKind !== "document") throw new Error("Only a Google Doc can be held in Wisdom. A Sheet or Slides stays linked to its file.");
  // Read now, not from the stored copy: what is held should be the document as it stands at this moment.
  const read = await readNativeContent(it);
  if (read.status !== "ok") throw new Error(read.status === "private" ? "Wisdom can no longer read that Google Doc, so it cannot bring the content in. Share it with Wisdom again first." : "Google did not return the document. Try again in a moment.");
  let html = read.html; let inlineImages = it.inlineImages ?? [];
  if (/<img\b[^>]*?\bsrc="https?:/.test(html)) {
    const m = await mirrorImages(html, inlineImages, undefined, read.embedded); html = m.html; inlineImages = m.images;
    // A picture still at a Google address will break once the link is cut, and one still at a stand-in address was never stored at all. Better to stop than to hold a page that loses its header.
    if (/<img\b[^>]*?\bsrc="https?:\/\/[^"]*google/.test(html) || hasEmbeddedImages(html)) throw new Error("Wisdom could not keep a copy of every picture in the document, so it was left linked. Try again; if it keeps failing, the picture may be too large.");
  }
  const markdown = htmlToMarkdown(html);
  if (!markdown.trim()) throw new Error("The document came back empty, so it was left linked.");
  const formerGoogleUrl = it.url;
  await db.update(items).set({ nativeKind: "text", bodyMarkdown: markdown, googleFileId: null, googleKind: null, driveMime: null, nativeModifiedAt: null, inlineImages, url: `/item/${id}`, contentType: sql`case when ${items.contentType} = 'Google Doc' then 'Note' else ${items.contentType} end` }).where(eq(items.id, id));
  await refreshNativeItem(id, `${by} (held in Wisdom)`);
  if (it.status === "published") await publishNative(id);
  await db.insert(auditLog).values({ actor: by, action: "native.detach", target: id, detail: { fileId: it.googleFileId, formerGoogleUrl } }).catch(() => undefined);
  return { formerGoogleUrl, chars: markdown.length, pictures: (markdown.match(/!\[[^\]]*\]\(/g) ?? []).length, tables: (markdown.match(/^\| --- /gm) ?? []).length };
}

const OPEN_CHECK_MS = 5 * 60_000;
/**
 * A linked resource is re-read when someone opens it, if its Google file has changed.
 *
 * The nightly run was the only thing that picked up an edit made in Google, so a correction could sit
 * unseen for a day. Opening the resource now asks Drive when the file last changed, which is one small
 * request, and re-reads it only if that is newer than what Wisdom holds. Each resource is checked at
 * most once every five minutes however many people open it. The caller decides how long to wait: a
 * reader gets the page either way, fresh if Google answered in time.
 */
export async function refreshOnOpen(id: string, onStale?: () => void): Promise<boolean> {
  const db = getDb();
  // Claiming the check and testing whether one is due are a single statement, so ten people opening the same page cause one check.
  const [it] = await db.update(items).set({ indexedAt: new Date() }).where(and(eq(items.id, id), eq(items.sourceKind, "native"), eq(items.status, "published"), sql`${items.nativeKind} in ('google','file')`, sql`${items.googleFileId} is not null`, sql`(${items.indexedAt} is null or ${items.indexedAt} < ${new Date(Date.now() - OPEN_CHECK_MS)})`)).returning({ googleFileId: items.googleFileId, nativeModifiedAt: items.nativeModifiedAt });
  if (!it?.googleFileId) return false;
  const meta = await driveMeta(it.googleFileId);
  if (!meta?.modifiedTime || (it.nativeModifiedAt && new Date(meta.modifiedTime).getTime() <= it.nativeModifiedAt.getTime())) return false;
  onStale?.();
  const r = await refreshNativeItem(id, "refresh on open");
  // Search catches up behind the reader; nobody waits on an embedding to see a page.
  if (r.changed) void publishNative(id).catch((e: Error) => logger.warn({ err: e.message, itemId: id }, "re-indexing after a refresh on open failed"));
  return r.changed;
}
/**
 * refreshOnOpen, for a bounded time: the page is served whether or not Google has answered.
 *
 * Asking Drive whether the file changed gets `ms`. Once it says yes, the re-read gets until `staleMs`:
 * exporting a document, keeping its pictures and checking its language took longer than three seconds
 * in practice, so the person who opened an edited resource was served the old copy and only the next
 * open was right. Waiting longer is paid only by the first open after an edit, which is the one open
 * that would otherwise be wrong.
 */
export async function freshenBriefly(id: string, ms = 3000, staleMs = 15_000): Promise<void> {
  let stale = false;
  const work = refreshOnOpen(id, () => { stale = true; }).catch((e: Error) => { logger.warn({ err: e.message, itemId: id }, "refresh on open failed"); });
  const wait = (n: number) => new Promise((r) => setTimeout(r, n).unref());
  await Promise.race([work, wait(ms)]);
  if (stale) await Promise.race([work, wait(Math.max(0, staleMs - ms))]);
}

/** Turn a page written here into a Google Doc in the Wisdom Drive, so it can be edited like everything else. Throws with a message for the person. */
export async function toGoogleDoc(id: string, by: string): Promise<{ url: string | null; refreshed: { changed: boolean; status: string } }> {
  const db = getDb();
  const [it] = await db.select().from(items).where(and(eq(items.id, id), eq(items.sourceKind, "native")));
  if (!it || it.nativeKind !== "text") throw new Error("Only a page written here can be turned into a Google Doc");
  const html = `<html><body>${[it.introHtml ?? "", markdownToHtml(it.bodyMarkdown ?? "")].filter(Boolean).join("\n").replace(/href="\/(c|item)\//g, `href="${env.appBaseUrl}/$1/`)}</body></html>`;
  const meta = await uploadToDrive(Buffer.from(html, "utf8"), it.title, "text/html", true, it.importedFrom?.folderId ? { parent: it.importedFrom.folderId } : {});
  await db.update(items).set({ nativeKind: "google", googleFileId: meta.id, googleKind: "document", driveMime: meta.mimeType, url: meta.webViewLink ?? googleUrl("document", meta.id), introHtml: null, bodyMarkdown: null, nativeModifiedAt: null, contentType: sql`case when ${items.contentType} in ('Note', 'question') then 'Google Doc' else ${items.contentType} end` }).where(eq(items.id, id));
  const r = await refreshNativeItem(id, `${by} (to Google Doc)`);
  if (it.status === "published") await publishNative(id);
  await db.insert(auditLog).values({ actor: by, action: "native.to_google", target: id, detail: { fileId: meta.id } }).catch(() => undefined);
  return { url: meta.webViewLink, refreshed: r };
}

/** Staff: add and edit resources, review contributions, restore versions. */
export const nativeAdminRouter = Router();
nativeAdminRouter.use(requireStaff);
nativeAdminRouter.get("/contributions", async (req, res) => {
  const status = String(req.query.status ?? "pending");
  const rows = await getDb().select({ ...contributionSelect, bodyText: sql<string>`left(coalesce(${items.bodyText}, ''), 600)` }).from(items).leftJoin(users, eq(users.id, items.authorUserId)).where(and(eq(items.sourceKind, "native"), status === "all" ? sql`true` : eq(items.status, status))).orderBy(desc(items.publishedAt)).limit(200);
  const types = await getDb().select({ key: materialTypes.key, name: materialTypes.name, jobKey: materialTypes.jobKey }).from(materialTypes);
  res.json({ contributions: rows, types });
});
nativeAdminRouter.post("/", upload.single("file"), async (req, res) => {
  const body = z.object({ kind: z.enum(["google", "file", "text", "series"]), title: z.string().max(200).optional(), description: z.string().max(600).optional(), url: z.string().url().max(2000).optional(), bodyMarkdown: z.string().max(200_000).optional(), childItemIds: z.string().optional(), subjobKeys: z.string().optional(), stages: z.string().optional() }).parse(req.body);
  try {
    const r = await createNativeItem({ kind: body.kind, title: body.title, description: body.description ?? null, url: body.url, file: req.file, bodyMarkdown: body.bodyMarkdown, childItemIds: body.childItemIds ? JSON.parse(body.childItemIds) as string[] : [], status: "published", authorUserId: req.user!.id, by: actor(req) });
    await setPlacements(r.id, body.subjobKeys ? JSON.parse(body.subjobKeys) as string[] : [], body.stages ? JSON.parse(body.stages) as string[] : []);
    await getDb().insert(auditLog).values({ actor: actor(req), action: "native.create", target: r.id, detail: { kind: body.kind, title: body.title } }).catch(() => undefined);
    res.status(201).json(r);
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
export async function setPlacements(itemId: string, subjobKeys: string[], stages: string[]): Promise<void> {
  const db = getDb();
  if (subjobKeys.length) {
    const subs = await db.select({ id: subjobs.id, key: subjobs.key }).from(subjobs).where(inArray(subjobs.key, subjobKeys));
    await db.delete(placements).where(eq(placements.itemId, itemId));
    for (const [i, k] of subjobKeys.entries()) { const sub = subs.find((x) => x.key === k); if (sub) await db.insert(placements).values({ itemId, subjobId: sub.id, isPrimary: i === 0, source: "staff" }).onConflictDoNothing(); }
  }
  await db.insert(itemMeta).values({ itemId, stages }).onConflictDoUpdate({ target: itemMeta.itemId, set: { stages } });
}
nativeAdminRouter.get("/:id", async (req, res) => {
  const db = getDb();
  const [it] = await db.select().from(items).where(and(eq(items.id, String(req.params.id)), eq(items.sourceKind, "native")));
  if (!it) { res.status(404).json({ error: "Not found" }); return; }
  const versions = await db.select({ id: itemVersions.id, version: itemVersions.version, title: itemVersions.title, createdAt: itemVersions.createdAt, createdBy: itemVersions.createdBy, sourceModifiedAt: itemVersions.sourceModifiedAt, chars: sql<number>`length(coalesce(${itemVersions.bodyText}, ''))::int` }).from(itemVersions).where(eq(itemVersions.itemId, it.id)).orderBy(desc(itemVersions.version));
  const pl = await db.select({ key: subjobs.key, name: subjobs.name, jobName: jobs.name, isPrimary: placements.isPrimary }).from(placements).innerJoin(subjobs, eq(subjobs.id, placements.subjobId)).innerJoin(jobs, eq(jobs.id, subjobs.jobId)).where(eq(placements.itemId, it.id)).orderBy(desc(placements.isPrimary));
  const [meta] = await db.select({ stages: itemMeta.stages }).from(itemMeta).where(eq(itemMeta.itemId, it.id));
  const children = it.childItemIds.length ? await db.select({ id: items.id, title: items.title }).from(items).where(inArray(items.id, it.childItemIds)) : [];
  res.json({ item: { id: it.id, title: it.title, description: it.description, url: it.url, status: it.status, nativeKind: it.nativeKind, googleKind: it.googleKind, googleFileId: it.googleFileId, driveMime: it.driveMime, bodyMarkdown: it.bodyMarkdown, childItemIds: it.childItemIds, materialTypeKey: it.materialTypeKey, contributionNote: it.contributionNote, declineNote: it.declineNote, nativeModifiedAt: it.nativeModifiedAt, language: it.language, introHtml: it.introHtml, nativeAttachments: it.nativeAttachments, importedFrom: it.importedFrom ? { kind: it.importedFrom.kind, sourceId: it.importedFrom.sourceId } : null, importedAt: it.importedAt }, versions, placements: pl, stages: meta?.stages ?? [], children: it.childItemIds.map((id) => children.find((c) => c.id === id)).filter(Boolean) });
});
nativeAdminRouter.patch("/:id", async (req, res) => {
  const body = z.object({ title: z.string().max(200).optional(), description: z.string().max(600).nullable().optional(), bodyMarkdown: z.string().max(200_000).optional(), childItemIds: z.array(z.string().uuid()).optional(), url: z.string().url().optional(), subjobKeys: z.array(z.string()).optional(), stages: z.array(z.string()).optional(), language: z.enum(["en", "es", "unknown"]).optional(), introHtml: z.string().max(200_000).nullable().optional(), removeAttachment: z.string().optional() }).parse(req.body);
  const db = getDb(); const id = String(req.params.id);
  const [it] = await db.select().from(items).where(and(eq(items.id, id), eq(items.sourceKind, "native")));
  if (!it) { res.status(404).json({ error: "Not found" }); return; }
  const set: Record<string, unknown> = {};
  if (body.title !== undefined) set.title = body.title.trim();
  if (body.description !== undefined) set.description = body.description?.trim() || null;
  if (body.bodyMarkdown !== undefined) set.bodyMarkdown = body.bodyMarkdown;
  if (body.childItemIds !== undefined) set.childItemIds = body.childItemIds;
  if (body.language !== undefined) set.language = body.language;
  if (body.introHtml !== undefined) set.introHtml = body.introHtml ? sanitizeBody(body.introHtml) : null;
  if (body.removeAttachment) set.nativeAttachments = (it.nativeAttachments ?? []).filter((a) => a.driveId !== body.removeAttachment);
  if (body.url !== undefined) { const g = parseGoogleLink(body.url); if (!g) { res.status(400).json({ error: "That is not a Google link" }); return; } set.googleFileId = g.id; set.googleKind = g.kind; set.url = googleUrl(g.kind, g.id); set.nativeModifiedAt = null; }
  if (Object.keys(set).length) await db.update(items).set(set).where(eq(items.id, id));
  if (body.subjobKeys !== undefined || body.stages !== undefined) await setPlacements(id, body.subjobKeys ?? [], body.stages ?? (await db.select({ stages: itemMeta.stages }).from(itemMeta).where(eq(itemMeta.itemId, id)))[0]?.stages ?? []);
  const r = await refreshNativeItem(id, actor(req));
  if (r.changed && it.status === "published") await publishNative(id);
  await db.insert(auditLog).values({ actor: actor(req), action: "native.update", target: id, detail: Object.keys(body) as unknown as Record<string, unknown> }).catch(() => undefined);
  res.json({ ok: true, refreshed: r });
});
nativeAdminRouter.post("/:id/refresh", async (req, res) => { const r = await refreshNativeItem(String(req.params.id), actor(req)); if (r.changed) await publishNative(String(req.params.id)); res.json(r); });
nativeAdminRouter.get("/:id/versions/:version", async (req, res) => {
  const [v] = await getDb().select().from(itemVersions).where(and(eq(itemVersions.itemId, String(req.params.id)), eq(itemVersions.version, Number(req.params.version))));
  if (!v) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ version: v });
});
/** Restore a snapshot: text items get their markdown back; Google items get a new Google Doc made from the snapshot, and the item points at it. */
nativeAdminRouter.post("/:id/versions/:version/restore", async (req, res) => {
  const db = getDb(); const id = String(req.params.id);
  const [it] = await db.select().from(items).where(and(eq(items.id, id), eq(items.sourceKind, "native")));
  const [v] = await db.select().from(itemVersions).where(and(eq(itemVersions.itemId, id), eq(itemVersions.version, Number(req.params.version))));
  if (!it || !v) { res.status(404).json({ error: "Not found" }); return; }
  try {
    if (it.nativeKind === "text") await db.update(items).set({ bodyMarkdown: v.bodyMarkdown ?? "", title: v.title }).where(eq(items.id, id));
    else if (it.nativeKind === "google" && v.bodyHtml) {
      const html = `<html><body>${v.bodyHtml}</body></html>`;
      const meta = await uploadToDrive(Buffer.from(html, "utf8"), `${v.title} (restored v${v.version})`, "text/html", true);
      await db.update(items).set({ googleFileId: meta.id, googleKind: "document", driveMime: meta.mimeType, url: meta.webViewLink ?? googleUrl("document", meta.id), nativeModifiedAt: null }).where(eq(items.id, id));
    } else { res.status(400).json({ error: "This kind of item cannot be restored automatically" }); return; }
    const r = await refreshNativeItem(id, `${actor(req)} (restore v${v.version})`);
    if (it.status === "published") await publishNative(id);
    await db.insert(auditLog).values({ actor: actor(req), action: "native.restore", target: id, detail: { version: v.version } }).catch(() => undefined);
    res.json({ ok: true, url: (await db.select({ url: items.url }).from(items).where(eq(items.id, id)))[0]?.url, refreshed: r });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
/** Turn a page written or imported here into a Google Doc, so it is edited in Google like everything else. */
nativeAdminRouter.post("/:id/to-google", async (req, res) => {
  try { res.json({ ok: true, ...(await toGoogleDoc(String(req.params.id), actor(req))) }); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
nativeAdminRouter.post("/:id/detach", async (req, res) => {
  try { res.json({ ok: true, ...(await detachToHeld(String(req.params.id), actor(req))) }); } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
nativeAdminRouter.post("/contributions/:id/approve", async (req, res) => {
  const body = approveSchema.parse(req.body);
  // The one way approval fails for a reason staff can act on: Google refusing the copy.
  try { if (!(await approveContribution(String(req.params.id), body, actor(req)))) { res.status(404).json({ error: "Not found" }); return; } }
  catch (e) { res.status(400).json({ error: `${(e as Error).message} You can publish it linked to the contributor's own file instead.` }); return; }
  res.json({ ok: true });
});
nativeAdminRouter.post("/contributions/:id/decline", async (req, res) => {
  const body = z.object({ note: z.string().max(2000).optional() }).parse(req.body);
  await declineContribution(String(req.params.id), body.note ?? null, actor(req));
  res.json({ ok: true });
});
nativeAdminRouter.delete("/:id", async (req, res) => {
  const db = getDb(); const id = String(req.params.id);
  await db.update(items).set({ removedAt: new Date() }).where(and(eq(items.id, id), eq(items.sourceKind, "native")));
  await db.insert(auditLog).values({ actor: actor(req), action: "native.remove", target: id }).catch(() => undefined);
  res.status(204).end();
});

/** Streams a file kept in the Wisdom Drive folder (PDFs, images, video) to signed-in readers. */
export const nativeFilesRouter = Router();
nativeFilesRouter.use(requireUser);
nativeFilesRouter.get("/:fileId", async (req, res) => {
  const fileId = String(req.params.fileId);
  if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) { res.status(400).json({ error: "Bad id" }); return; }
  const [it] = await getDb().select({ id: items.id, driveMime: items.driveMime, title: items.title, status: items.status, authorUserId: items.authorUserId, nativeAttachments: items.nativeAttachments, inlineImages: items.inlineImages, googleFileId: items.googleFileId }).from(items).where(and(eq(items.sourceKind, "native"), sql`${items.googleFileId} = ${fileId} or ${items.nativeAttachments} @> ${JSON.stringify([{ driveId: fileId }])}::jsonb or ${items.inlineImages} @> ${JSON.stringify([{ driveId: fileId }])}::jsonb`)).limit(1);
  if (!it || (it.status !== "published" && req.user!.role !== "staff" && it.authorUserId !== req.user!.id)) { res.status(404).json({ error: "Not found" }); return; }
  const att = it.googleFileId === fileId ? null : (it.nativeAttachments ?? []).find((a) => a.driveId === fileId) ?? null;
  // A picture inside a document: served as the image it is, never as the document's own type.
  const pic = !att && it.googleFileId !== fileId ? (it.inlineImages ?? []).find((a) => a.driveId === fileId) ?? null : null;
  const mime = pic ? pic.mime : att ? att.mime : it.driveMime; const name = pic ? "picture" : att ? att.name : it.title;
  try {
    const up = await driveDownload(fileId, typeof req.headers.range === "string" ? req.headers.range : undefined, mime);
    if (!up.ok && up.status !== 206) { res.status(502).json({ error: `Drive returned ${up.status}` }); return; }
    res.status(up.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) { const v = up.headers.get(h); if (v) res.setHeader(h, v); }
    if (!up.headers.get("content-type") && mime) res.setHeader("content-type", mime);
    res.setHeader("content-disposition", `${req.query.download ? "attachment" : "inline"}; filename="${name.replace(/[^\w.\- ]+/g, "_")}${isGoogleAppsMime(mime) ? ".pdf" : ""}"`);
    res.setHeader("cache-control", "private, max-age=3600");
    if (!up.body) { res.end(); return; }
    toNodeStream(up.body).pipe(res);
  } catch (e) { res.status(502).json({ error: (e as Error).message }); }
});
