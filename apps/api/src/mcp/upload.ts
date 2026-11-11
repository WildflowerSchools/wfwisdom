import { Router, type Response } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { and, eq, getDb, gt, isNull, mcpUploads, users } from "@wfw/db";
import { logger } from "../logger.js";
import { createNativeItem } from "../routes/native.js";
import { getSettings } from "../settings.js";
import { esc, hash, page, rand } from "./oauth.js";

/**
 * Sending a file from a person's own device.
 *
 * A tool call carries text, not files, so a PDF on someone's laptop cannot go through Claude. Instead
 * Claude asks for a link (the `request_upload_link` tool), the person opens it and picks the file, and
 * it arrives as a contribution exactly as one sent from the Share page does: pending for a teacher
 * leader, published for staff.
 *
 * The link is the whole authorization: unguessable, good for one file, and short-lived. It does not ask
 * for a sign-in because the person asking Claude may never have opened the web app in this browser, and
 * what the link allows is only what they could already do there.
 */
const LINK_MINUTES = 30;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

export async function createUploadLink(userId: string, base: string, meta: { title?: string; description?: string; note?: string; materialTypeKey?: string }): Promise<{ link: string; minutes: number }> {
  const token = rand(24);
  await getDb().insert(mcpUploads).values({ hash: hash(token), userId, meta, expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000) });
  return { link: `${base}/upload/${token}`, minutes: LINK_MINUTES };
}

async function ticket(token: string) {
  const [t] = await getDb().select({ ticket: mcpUploads, name: users.name, email: users.email, role: users.role }).from(mcpUploads).innerJoin(users, eq(users.id, mcpUploads.userId)).where(and(eq(mcpUploads.hash, hash(token)), isNull(mcpUploads.usedAt), gt(mcpUploads.expiresAt, new Date())));
  return t ?? null;
}
const gone = (res: Response) => { res.status(410).type("html").send(page("This link has been used or has expired", "<p>Each link takes one file and lasts half an hour. Ask Claude for a new one.</p>")); };

export const uploadRouter = Router();
uploadRouter.use((_req, res, next) => { res.setHeader("cache-control", "no-store"); res.setHeader("referrer-policy", "no-referrer"); next(); });
// Opened from a person's own browser, so a per-address limit is the right kind here, unlike on /mcp.
uploadRouter.use(rateLimit({ windowMs: 10 * 60_000, limit: 40, standardHeaders: "draft-8", legacyHeaders: false }));

uploadRouter.get("/:token", async (req, res) => {
  try {
    const t = await ticket(String(req.params.token));
    if (!t) { gone(res); return; }
    const m = t.ticket.meta;
    res.type("html").send(page("Send a file to Wildflower Wisdom", `
<p>Sending as <strong>${esc(t.name)}</strong> <span style="color:#566c66">(${esc(t.email)})</span>.</p>
${m.title ? `<p>Title: <strong>${esc(m.title)}</strong></p>` : ""}
<form method="post" enctype="multipart/form-data" style="display:flex;flex-direction:column;gap:16px;margin-top:18px">
<label for="file" style="font-weight:700">Choose the file</label>
<input id="file" type="file" name="file" required>
<button type="submit" style="align-self:flex-start;background:#137070;color:#fffdf8;border:0;font:inherit;font-weight:700;padding:10px 18px;border-radius:8px;cursor:pointer">Send</button>
</form>
<p style="color:#566c66;font-size:.9rem;margin-top:18px">${t.role === "staff" ? "It will be published straight away. Place it on the map afterwards." : "Foundation staff review it before it appears in the library."} Word, PowerPoint and Excel files become Google Docs, Slides and Sheets.</p>`));
  } catch (e) { logger.error({ err: (e as Error).message }, "upload page failed"); res.status(500).type("html").send(page("Wildflower Wisdom", "<p>Something went wrong. Ask Claude for a new link.</p>")); }
});

uploadRouter.post("/:token", upload.single("file"), async (req, res) => {
  const tokenHash = hash(String(req.params.token));
  try {
    const t = await ticket(String(req.params.token));
    if (!t) { gone(res); return; }
    const s = await getSettings();
    // The same ceiling the Share page applies.
    if (!req.file) { res.status(400).type("html").send(page("No file was chosen", `<p><a href="" style="color:#137070">Go back and choose a file.</a></p>`)); return; }
    if (req.file.size > Math.max(s.maxUploadBytes, 25 * 1024 * 1024)) { res.status(413).type("html").send(page("That file is too large", `<p>The limit is 25 MB. Put it in Google Drive and give Claude the link.</p>`)); return; }
    // Claim the link before doing the work, so a double submit cannot create two resources.
    const [claimed] = await getDb().update(mcpUploads).set({ usedAt: new Date() }).where(and(eq(mcpUploads.hash, tokenHash), isNull(mcpUploads.usedAt))).returning({ hash: mcpUploads.hash });
    if (!claimed) { gone(res); return; }
    const staff = t.role === "staff";
    const m = t.ticket.meta;
    let id: string;
    try { ({ id } = await createNativeItem({ kind: "file", title: m.title, description: m.description ?? null, file: req.file, materialTypeKey: m.materialTypeKey ?? null, note: m.note ?? null, status: staff ? "published" : "pending", authorUserId: t.ticket.userId, by: `${t.name} <${t.email}>` })); }
    catch (e) {
      // The file never became a resource, so the link is given back for another try.
      await getDb().update(mcpUploads).set({ usedAt: null }).where(eq(mcpUploads.hash, tokenHash));
      res.status(400).type("html").send(page("That file could not be saved", `<p>${esc((e as Error).message)}</p><p><a href="" style="color:#137070">Try again.</a></p>`)); return;
    }
    await getDb().update(mcpUploads).set({ itemId: id }).where(eq(mcpUploads.hash, tokenHash));
    res.type("html").send(page("Sent", `<p><strong>${esc(req.file.originalname)}</strong> has been sent to Wildflower Wisdom.</p><p>${staff ? "It is published. Go back to Claude to place it on the map." : "Foundation staff will review it. You can go back to Claude."}</p>`));
  } catch (e) { logger.error({ err: (e as Error).message }, "upload failed"); res.status(500).type("html").send(page("Wildflower Wisdom", "<p>Something went wrong. Ask Claude for a new link.</p>")); }
});
// multer reports an oversized file as an error rather than a request the handler sees.
uploadRouter.use(((err, _req, res, next) => { if (err && (err as { code?: string }).code === "LIMIT_FILE_SIZE") { res.status(413).type("html").send(page("That file is too large", "<p>The limit is 25 MB. Put it in Google Drive and give Claude the link.</p>")); return; } next(err); }) as import("express").ErrorRequestHandler);
