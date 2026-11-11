import express, { type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { eq, getDb, users } from "@wfw/db";
import { isResourceLanguage, parseRegionFilter, type SessionUser } from "@wfw/shared";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { SCOPE, oauthPagesRouter, oauthProvider } from "./oauth.js";
import { buildServer } from "./tools.js";
import { uploadRouter } from "./upload.js";

/** The same shape `resolveUser` gives a web session, so every service sees a connector user as it sees a signed-in one. */
export async function connectorUser(userId: string): Promise<SessionUser | null> {
  const [u] = await getDb().select({ id: users.id, email: users.email, name: users.name, role: users.role, resourceLanguage: users.resourceLanguage, resourceRegions: users.resourceRegions }).from(users).where(eq(users.id, userId));
  if (!u) return null;
  return { id: u.id, email: u.email, name: u.name, role: u.role === "staff" ? "staff" : "teacher_leader", resourceLanguage: isResourceLanguage(u.resourceLanguage) ? u.resourceLanguage : "all", resourceRegions: parseRegionFilter(u.resourceRegions) };
}

const rpcError = (res: Response, status: number, message: string) => { res.status(status).json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }); };

/**
 * Mounts the Claude connector: the OAuth endpoints at the root, where the MCP spec requires them, the
 * sign-in pages under /oauth, the one-time upload pages under /upload, and the MCP endpoint itself at /mcp.
 *
 * It has to be mounted before the app's own rate limit and CORS. Every connector request arrives from
 * Anthropic's servers rather than from the person's browser, so a per-address limit sized for one
 * reader would throttle the whole network as if it were one person; the limits here are per signed-in
 * user instead. The SDK's handlers set the CORS headers the protocol asks for.
 */
export function mountConnector(app: Express): void {
  const issuer = new URL(env.appBaseUrl);
  const resource = new URL("/mcp", issuer);
  app.use(mcpAuthRouter({
    provider: oauthProvider, issuerUrl: issuer, resourceServerUrl: resource, scopesSupported: [SCOPE], resourceName: "Wildflower Wisdom",
    // Token renewals for everyone come from the same few addresses, so the SDK's per-address default (50 in 15 minutes) is far too low.
    tokenOptions: { rateLimit: { windowMs: 60_000, limit: 600 } },
    // A client registers once and keeps its secret. An expiring secret would quietly disconnect everyone a month after launch.
    clientRegistrationOptions: { clientSecretExpirySeconds: 0, rateLimit: { windowMs: 3600_000, limit: 300 } },
  }));
  app.use("/oauth", oauthPagesRouter);
  app.use("/upload", uploadRouter);

  const bearer = requireBearerAuth({ verifier: oauthProvider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) });
  const perUser = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: (req) => String((req as Request).auth?.extra?.userId ?? "unknown"), handler: (_req, res) => rpcError(res, 429, "Too many requests. Wait a minute and try again.") });

  // Stateless: each request gets its own server and transport, so nothing is lost when the deployment
  // scales to zero between requests, and a tool list is always built for the person the token belongs to.
  app.post("/mcp", bearer, perUser, express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    try {
      const user = await connectorUser(String(req.auth?.extra?.userId ?? ""));
      if (!user) { rpcError(res, 401, "This connection is no longer valid. Reconnect Wildflower Wisdom."); return; }
      const server = buildServer(user);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      logger.error({ err: (e as Error).message }, "connector request failed");
      if (!res.headersSent) rpcError(res, 500, "Wildflower Wisdom could not handle that request.");
    }
  });
  // No server-to-client stream and no session to end, which is what GET and DELETE are for.
  app.get("/mcp", (_req, res) => { res.setHeader("allow", "POST"); rpcError(res, 405, "Use POST."); });
  app.delete("/mcp", (_req, res) => { res.setHeader("allow", "POST"); rpcError(res, 405, "Use POST."); });
}
