import "dotenv/config";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { ZodError } from "zod";
import { closeDb } from "@wfw/db";
import { resolveUser } from "./auth.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { OpenAIError } from "./lib/openai.js";
import { mountConnector } from "./mcp/index.js";
import { adminRouter } from "./routes/admin.js";
import { flagRouter, reviewRouter } from "./routes/stewardship.js";
import { authRouter } from "./routes/auth.js";
import { filesRouter } from "./routes/files.js";
import { adminFeedbackRouter, feedbackRouter } from "./routes/feedback.js";
import { materialsRouter } from "./routes/materials.js";
import { contributionsRouter, nativeAdminRouter, nativeFilesRouter } from "./routes/native.js";
import { myItemsRouter } from "./routes/my-items.js";
import { mapRouter } from "./routes/map.js";
import { meRouter } from "./routes/me.js";
import { adminQuestionsRouter } from "./routes/questions.js";
import { searchRouter } from "./routes/search.js";
import { signalsRouter } from "./routes/signals.js";
import { submissionsRouter } from "./routes/submissions.js";
import { typesRouter } from "./routes/types.js";
import { catchUpIndexOnBoot, startScheduler } from "./scheduler.js";
import { loadVectors } from "./services/vectors.js";
import { markStaleRuns } from "./services/indexer.js";
import { getSettings } from "./settings.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(env.isProd ? helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"], fontSrc: ["'self'", "https://fonts.gstatic.com"], imgSrc: ["'self'", "data:", "https:"], mediaSrc: ["'self'", "blob:"], frameSrc: ["'self'", "https://docs.google.com", "https://drive.google.com", "https://www.youtube.com", "https://www.youtube-nocookie.com", "https://player.vimeo.com", "https://www.loom.com"], connectSrc: ["'self'"] } } }) : helmet({ contentSecurityPolicy: false }));
// The Claude connector, ahead of CORS and the per-address rate limit for the reasons given where it is defined.
mountConnector(app);
app.use(cors({ origin: env.isProd ? env.appBaseUrl : true, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));
app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false }));
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => (req.url ?? "").startsWith("/assets") } }));

app.get("/api/status", async (_req, res) => { const s = await getSettings(); res.json({ status: "ok", service: "wfwisdom", environment: env.nodeEnv, killSwitch: s.killSwitch }); });
app.use("/api", (_req, res, next) => { res.setHeader("cache-control", "private, no-store"); next(); });
app.use("/api/auth", authRouter);
app.use("/api", resolveUser);
app.get("/api/me", (req, res) => res.json({ user: req.user ?? null }));
app.use("/api/map", mapRouter);
app.use("/api/feedback", feedbackRouter);
app.use("/api/me/materials", materialsRouter);
app.use("/api/contributions", contributionsRouter);
app.use("/api/me/items", myItemsRouter);
app.use("/api/admin/native", nativeAdminRouter);
app.use("/api/files/native", nativeFilesRouter);
app.use("/api/files", filesRouter);
app.use("/api/me", meRouter);
app.use("/api/admin/feedback", adminFeedbackRouter);
app.use("/api/admin/questions", adminQuestionsRouter);
app.use("/api/search", searchRouter);
app.use("/api/signals", signalsRouter);
app.use("/api/types", typesRouter);
app.use("/api/submissions", submissionsRouter);
app.use("/api/admin/review", reviewRouter);
app.use("/api/flags", flagRouter);
app.use("/api/admin", adminRouter);

const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (existsSync(resolve(webDist, "index.html"))) {
  app.use(express.static(webDist, { maxAge: "1h", index: false }));
  app.get("/{*path}", (req, res, next) => { if (req.path.startsWith("/api/")) return next(); res.setHeader("cache-control", "no-store"); res.sendFile(resolve(webDist, "index.html")); });
}

const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  if (error instanceof ZodError) { res.status(400).json({ error: "Invalid request", issues: error.issues }); return; }
  if (error instanceof OpenAIError) { res.status(502).json({ error: error.message }); return; }
  if (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "LIMIT_FILE_SIZE") { res.status(413).json({ error: "File is too large" }); return; }
  req.log.error({ err: error }, "Request failed");
  const message = error instanceof Error ? error.message : "Unexpected error";
  res.status(500).json({ error: env.isProd ? "Request failed" : message });
};
app.use(errorHandler);

const server = app.listen(env.port, "0.0.0.0", () => {
  logger.info({ port: env.port, env: env.nodeEnv }, "Wildflower Wisdom API listening");
  void markStaleRuns().catch((e) => logger.warn({ err: (e as Error).message }, "stale run cleanup failed"));
  void loadVectors().catch((e) => logger.warn({ err: (e as Error).message }, "vector load failed"));
  startScheduler();
  if (env.isProd) catchUpIndexOnBoot();
});
async function shutdown(signal: string) { logger.info({ signal }, "shutting down"); server.close(async () => { await closeDb(); process.exit(0); }); }
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
