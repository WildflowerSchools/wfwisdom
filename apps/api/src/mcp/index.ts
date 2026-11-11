import express, { type Express, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
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
  // These routes sit ahead of the app's request logger, and without a line per request a failed
  // connection from Claude leaves nothing to look at. Paths only: no query strings, which carry codes
  // and state, and the upload token is cut out of its path.
  const paths = ["/mcp", "/authorize", "/token", "/register", "/revoke", "/oauth", "/upload", "/.well-known"];
  app.use(paths, (req, res, next) => {
    const started = Date.now();
    res.on("finish", () => logger.info({ method: req.method, path: (req.originalUrl.split("?")[0] ?? "").replace(/^\/upload\/.+/, "/upload/:token"), status: res.statusCode, ms: Date.now() - started, agent: String(req.headers["user-agent"] ?? "").slice(0, 80) }, "connector request"));
    next();
  });
  // helmet's default, same-origin, cuts a sign-in window off from the page that opened it for good, even
  // after the window returns to that page's own site. A client that opens sign-in in a popup and waits to
  // hear back from it would then wait forever. Only the pages a person passes through while connecting.
  app.use(["/authorize", "/oauth"], (_req, res, next) => { res.setHeader("Cross-Origin-Opener-Policy", "unsafe-none"); next(); });
  app.use(mcpAuthRouter({
    provider: oauthProvider, issuerUrl: issuer, resourceServerUrl: resource, scopesSupported: [SCOPE], resourceName: "Wildflower Wisdom",
    // Token renewals for everyone come from the same few addresses, so the SDK's per-address default (50 in 15 minutes) is far too low.
    tokenOptions: { rateLimit: { windowMs: 60_000, limit: 600 } },
    // A client registers once and keeps its secret. An expiring secret would quietly disconnect everyone a month after launch.
    clientRegistrationOptions: { clientSecretExpirySeconds: 0, rateLimit: { windowMs: 3600_000, limit: 300 } },
  }));
  // Clients look for the discovery documents in more than one place: with the resource's path and
  // without it, in either order. The SDK serves one of each. The other two are answered here, and
  // anything else under /.well-known is a plain 404: left alone it would fall through to the web
  // app, which answers every unknown path with its HTML page and a 200, and a client that takes that
  // for a discovery document fails on it instead of trying the next address.
  const open = (res: Response) => { res.setHeader("access-control-allow-origin", "*"); res.setHeader("cache-control", "no-store"); return res; };
  app.get("/.well-known/oauth-protected-resource", (_req, res) => { open(res).json({ resource: resource.href, authorization_servers: [issuer.href], scopes_supported: [SCOPE], resource_name: "Wildflower Wisdom" }); });
  app.get("/.well-known/oauth-authorization-server/mcp", (_req, res) => { open(res).json(createOAuthMetadata({ provider: oauthProvider, issuerUrl: issuer, scopesSupported: [SCOPE] })); });
  app.use("/.well-known", (_req, res) => { open(res).status(404).json({ error: "not_found" }); });
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
