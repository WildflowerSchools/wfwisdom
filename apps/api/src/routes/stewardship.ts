import { Router } from "express";
import { z } from "zod";
import { actor, requireStaff, requireUser } from "../auth.js";
import { CurationError } from "../services/curation.js";
import { flagItem, markReviewed, reviewList, setSteward, stewardCandidates } from "../services/stewardship.js";

const fail = (res: import("express").Response, e: unknown) => { if (e instanceof CurationError) { res.status(e.status).json({ error: e.message }); return; } throw e; };

/** Staff's list of the library by how long each resource has gone unreviewed. */
export const reviewRouter = Router();
reviewRouter.use(requireStaff);
reviewRouter.get("/", async (req, res) => {
  res.json({ items: await reviewList(req.user!, { mine: req.query.mine === "1" }), people: await stewardCandidates(), me: req.user!.id });
});
reviewRouter.post("/:id/reviewed", async (req, res) => {
  try { res.json(await markReviewed(z.string().uuid().parse(req.params.id), actor(req))); } catch (e) { fail(res, e); }
});
reviewRouter.post("/:id/steward", async (req, res) => {
  const b = z.object({ userId: z.string().uuid().nullable() }).parse(req.body);
  try { res.json(await setSteward(z.string().uuid().parse(req.params.id), { userId: b.userId }, actor(req))); } catch (e) { fail(res, e); }
});

/** Any signed-in reader can say a resource looks out of date. */
export const flagRouter = Router();
flagRouter.use(requireUser);
flagRouter.post("/:id", async (req, res) => {
  const b = z.object({ note: z.string().max(1000).nullable().optional() }).parse(req.body ?? {});
  try { await flagItem(z.string().uuid().parse(req.params.id), req.user!.id, b.note); res.json({ ok: true }); } catch (e) { fail(res, e); }
});
