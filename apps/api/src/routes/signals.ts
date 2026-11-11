import { Router } from "express";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { recordSignal } from "../services/signals.js";
export const signalsRouter = Router();
signalsRouter.use(requireUser);
signalsRouter.post("/", async (req, res) => {
  const body = z.object({ itemId: z.string().uuid(), kind: z.enum(["click", "search_click", "helpful_yes", "helpful_no"]), context: z.record(z.unknown()).optional() }).parse(req.body);
  await recordSignal(req.user!.id, body.itemId, body.kind, body.context ?? {});
  res.json({ ok: true });
});
