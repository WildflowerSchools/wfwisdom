import { createHash, randomBytes } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { and, eq, getDb, gt, isNull, lt, mcpClients, mcpGrants, mcpTokens, sql, users } from "@wfw/db";
import { resolveUser } from "../auth.js";
import { logger } from "../logger.js";

/**
 * Wisdom as an OAuth authorization server for the Claude connector.
 *
 * Why Wisdom issues its own tokens rather than handing Claude a Google token: the connector has to act
 * as a Wisdom user — teacher leader or staff, with their language and region choices — and that mapping
 * exists only here. So sign-in is the web app's own Google sign-in, and what Claude holds is an opaque
 * token that means "this Wisdom user", revocable here without touching their Google account.
 *
 * The flow: Claude registers itself (RFC 7591), sends the person to /authorize, they sign in with Google
 * if they are not already, see a page naming what is asking, and approve. Claude then swaps the code for
 * an access token (an hour) and a refresh token (ninety days, renewed on use).
 */
export const SCOPE = "wisdom";
const ACCESS_SECONDS = 3600;
const REFRESH_DAYS = 90;
const GRANT_MINUTES = 15;
// A used refresh token stays good this long, so a client whose first attempt at renewing was cut off
// mid-reply can try again rather than being signed out for a dropped connection.
const REFRESH_GRACE_SECONDS = 60;

export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const rand = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId) {
    const [row] = await getDb().select({ info: mcpClients.info }).from(mcpClients).where(eq(mcpClients.clientId, clientId));
    return row ? (row.info as unknown as OAuthClientInformationFull) : undefined;
  },
  async registerClient(client) {
    // The SDK has already generated the id and secret; this only has to remember them.
    const full = client as OAuthClientInformationFull;
    await getDb().insert(mcpClients).values({ clientId: full.client_id, info: full as unknown as Record<string, unknown> });
    return full;
  },
};

async function issueTokens(clientId: string, userId: string, scopes: string[], resource: string | null): Promise<OAuthTokens> {
  const db = getDb();
  const access = `wfa_${rand()}`, refresh = `wfr_${rand()}`;
  const now = Date.now();
  await db.insert(mcpTokens).values([
    { hash: hash(access), kind: "access", clientId, userId, scopes, resource, expiresAt: new Date(now + ACCESS_SECONDS * 1000) },
    { hash: hash(refresh), kind: "refresh", clientId, userId, scopes, resource, expiresAt: new Date(now + REFRESH_DAYS * 86400_000) },
  ]);
  // Nothing else sweeps these tables, and issuing is the one moment a sweep is guaranteed to keep happening.
  void Promise.all([db.delete(mcpTokens).where(lt(mcpTokens.expiresAt, new Date(now - 86400_000))), db.delete(mcpGrants).where(lt(mcpGrants.expiresAt, new Date(now - 86400_000)))]).catch((e: Error) => logger.warn({ err: e.message }, "connector token sweep failed"));
  return { access_token: access, token_type: "bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: scopes.join(" ") };
}

export const oauthProvider: OAuthServerProvider = {
  get clientsStore() { return clientsStore; },

  /** The SDK has checked the client and its redirect URI by now. Park the request and go and ask the person. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = rand(24);
    await getDb().insert(mcpGrants).values({ id, clientId: client.client_id, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge, state: params.state ?? null, scopes: params.scopes?.length ? params.scopes : [SCOPE], resource: params.resource?.href ?? null, expiresAt: new Date(Date.now() + GRANT_MINUTES * 60_000) });
    res.redirect(`/oauth/consent?g=${id}`);
  },

  async challengeForAuthorizationCode(client, authorizationCode) {
    const [g] = await getDb().select({ codeChallenge: mcpGrants.codeChallenge }).from(mcpGrants).where(and(eq(mcpGrants.codeHash, hash(authorizationCode)), eq(mcpGrants.clientId, client.client_id), gt(mcpGrants.expiresAt, new Date())));
    if (!g) throw new InvalidGrantError("That authorization code is not valid");
    return g.codeChallenge;
  },

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri) {
    // Claiming the code and reading it are one statement, so two exchanges racing for it cannot both win.
    const [g] = await getDb().update(mcpGrants).set({ usedAt: new Date() }).where(and(eq(mcpGrants.codeHash, hash(authorizationCode)), eq(mcpGrants.clientId, client.client_id), isNull(mcpGrants.usedAt), gt(mcpGrants.expiresAt, new Date()))).returning();
    if (!g || !g.userId) throw new InvalidGrantError("That authorization code is not valid");
    if (redirectUri && redirectUri !== g.redirectUri) throw new InvalidGrantError("The redirect address does not match the one the code was issued for");
    return issueTokens(client.client_id, g.userId, g.scopes, g.resource);
  },

  async exchangeRefreshToken(client, refreshToken, scopes) {
    const db = getDb();
    const [t] = await db.select().from(mcpTokens).where(and(eq(mcpTokens.hash, hash(refreshToken)), eq(mcpTokens.kind, "refresh"), eq(mcpTokens.clientId, client.client_id), gt(mcpTokens.expiresAt, new Date())));
    if (!t) throw new InvalidGrantError("That refresh token is not valid");
    // Renewing replaces the refresh token; the old one is left a short grace period rather than deleted.
    await db.update(mcpTokens).set({ expiresAt: new Date(Date.now() + REFRESH_GRACE_SECONDS * 1000) }).where(and(eq(mcpTokens.hash, t.hash), gt(mcpTokens.expiresAt, new Date(Date.now() + REFRESH_GRACE_SECONDS * 1000))));
    // A client may ask for less than it was granted, never more.
    const granted = scopes?.length ? scopes.filter((s) => t.scopes.includes(s)) : t.scopes;
    return issueTokens(client.client_id, t.userId, granted, t.resource);
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const [t] = await getDb().select().from(mcpTokens).where(and(eq(mcpTokens.hash, hash(token)), eq(mcpTokens.kind, "access"), gt(mcpTokens.expiresAt, new Date())));
    if (!t) throw new InvalidTokenError("That access token is not valid or has expired");
    return { token, clientId: t.clientId, scopes: t.scopes, expiresAt: Math.floor(t.expiresAt.getTime() / 1000), ...(t.resource ? { resource: new URL(t.resource) } : {}), extra: { userId: t.userId } };
  },

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await getDb().delete(mcpTokens).where(and(eq(mcpTokens.hash, hash(request.token)), eq(mcpTokens.clientId, client.client_id)));
  },
};

/** Sign every connector out for one person. Used when staff remove access; the web session is separate. */
export async function revokeConnectorAccess(userId: string): Promise<number> {
  const rows = await getDb().delete(mcpTokens).where(eq(mcpTokens.userId, userId)).returning({ hash: mcpTokens.hash });
  return rows.length;
}

export function page(title: string, body: string): string {
  // No script and no external assets, so the app's production content security policy needs no exception.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f4f6f2;color:#294844;font-family:'Avenir Next',Avenir,'Helvetica Neue',Arial,sans-serif;line-height:1.45">
<main style="max-width:480px;margin:10vh auto;padding:28px;background:#fff;border:1px solid #cbdad4;border-radius:12px">
<h1 style="font-family:Garamond,'Times New Roman',serif;font-weight:500;color:#137070;margin:0 0 12px;font-size:1.7rem">${esc(title)}</h1>${body}</main></body></html>`;
}
const problem = (res: Response, status: number, message: string) => { res.status(status).type("html").send(page("Wildflower Wisdom", `<p>${esc(message)}</p><p>Go back to Claude and try connecting again.</p>`)); };

/**
 * The pages a person sees while connecting. Approval is a link, not a form: the reply is a redirect to
 * Claude, and a browser applies the page's form-action policy to where a form post is redirected, which
 * would block it. The link carries a one-time token that only this page, served to the signed-in
 * person, has ever shown — so another site cannot approve on their behalf by sending them to a URL.
 */
export const oauthPagesRouter = Router();
oauthPagesRouter.use((_req, res, next) => { res.setHeader("cache-control", "no-store"); res.setHeader("referrer-policy", "no-referrer"); next(); });
oauthPagesRouter.use(resolveUser);

async function pendingGrant(id: string) {
  const [g] = await getDb().select().from(mcpGrants).where(and(eq(mcpGrants.id, id), isNull(mcpGrants.codeHash), gt(mcpGrants.expiresAt, new Date())));
  return g ?? null;
}

oauthPagesRouter.get("/consent", async (req, res) => {
  try {
    const id = String(req.query.g ?? "");
    const g = id ? await pendingGrant(id) : null;
    if (!g) { problem(res, 400, "This connection request has expired or was already used."); return; }
    if (!req.user) { res.redirect(`/api/auth/google?next=${encodeURIComponent(`/oauth/consent?g=${id}`)}`); return; }
    const client = await clientsStore.getClient(g.clientId);
    const approve = rand(24);
    await getDb().update(mcpGrants).set({ approveHash: hash(approve), userId: req.user.id }).where(eq(mcpGrants.id, id));
    const name = client?.client_name?.trim() || "An application";
    const host = new URL(g.redirectUri).host;
    const role = req.user.role === "staff" ? "Foundation staff" : "teacher leader";
    res.type("html").send(page("Connect to Wildflower Wisdom", `
<p><strong>${esc(name)}</strong> is asking to use Wildflower Wisdom as you.</p>
<p style="background:#e1f3f0;border-radius:8px;padding:10px 12px;margin:14px 0">${esc(req.user.name)}<br><span style="color:#566c66">${esc(req.user.email)} · ${role}</span></p>
<p>It will be able to search and read the library, record the questions you ask it, send questions and resources to Foundation staff for you${req.user.role === "staff" ? ", and make the curation changes you ask for" : ""}.</p>
<p style="color:#566c66;font-size:.9rem">After you approve, you will be sent to <strong>${esc(host)}</strong>. Only continue if you started this from Claude.</p>
<p style="display:flex;gap:10px;flex-wrap:wrap;margin:22px 0 0">
<a href="/oauth/approve?g=${encodeURIComponent(id)}&amp;t=${approve}" style="background:#137070;color:#fffdf8;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:8px">Allow</a>
<a href="/oauth/deny?g=${encodeURIComponent(id)}&amp;t=${approve}" style="color:#137070;padding:10px 18px;border:1px solid #cbdad4;border-radius:8px;text-decoration:none">Cancel</a></p>`));
  } catch (e) { logger.error({ err: (e as Error).message }, "connector consent page failed"); problem(res, 500, "Something went wrong while connecting."); }
});

async function decide(req: Request, res: Response, allow: boolean): Promise<void> {
  try {
    const id = String(req.query.g ?? ""), token = String(req.query.t ?? "");
    const g = id ? await pendingGrant(id) : null;
    // The grant has to be this signed-in person's, and the token the one their consent page was given.
    if (!g || !req.user || g.userId !== req.user.id || !g.approveHash || g.approveHash !== hash(token)) { problem(res, 400, "This connection request has expired or was already used."); return; }
    const to = new URL(g.redirectUri);
    if (g.state) to.searchParams.set("state", g.state);
    if (!allow) {
      await getDb().delete(mcpGrants).where(eq(mcpGrants.id, id));
      to.searchParams.set("error", "access_denied");
      res.redirect(to.href); return;
    }
    const code = rand();
    // Only an undecided grant can take a code, so a second click on Allow cannot mint a second one.
    const [done] = await getDb().update(mcpGrants).set({ codeHash: hash(code), approveHash: null, expiresAt: new Date(Date.now() + 5 * 60_000) }).where(and(eq(mcpGrants.id, id), isNull(mcpGrants.codeHash))).returning({ id: mcpGrants.id });
    if (!done) { problem(res, 400, "This connection request was already used."); return; }
    to.searchParams.set("code", code);
    res.redirect(to.href);
  } catch (e) { logger.error({ err: (e as Error).message }, "connector approval failed"); problem(res, 500, "Something went wrong while connecting."); }
}
oauthPagesRouter.get("/approve", (req, res) => decide(req, res, true));
oauthPagesRouter.get("/deny", (req, res) => decide(req, res, false));

/** Who has a connector signed in, for the staff report. */
export async function connectedUserCount(): Promise<number> {
  const [r] = await getDb().select({ n: sql<number>`count(distinct ${mcpTokens.userId})::int` }).from(mcpTokens).innerJoin(users, eq(users.id, mcpTokens.userId)).where(and(eq(mcpTokens.kind, "refresh"), gt(mcpTokens.expiresAt, new Date())));
  return r?.n ?? 0;
}
