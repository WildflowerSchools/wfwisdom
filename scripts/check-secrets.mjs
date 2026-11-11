#!/usr/bin/env node
// Verifies every secret wfwisdom needs against its real service. Prints one line per secret.
// Never prints secret values. Run: node scripts/check-secrets.mjs
import net from "node:net";
import { createSign } from "node:crypto";
const results = [];
const ok = (name, msg) => results.push(`OK    ${name}: ${msg}`);
const bad = (name, msg) => results.push(`FAIL  ${name}: ${msg}`);
const missing = (name) => results.push(`MISSING ${name}`);
const env = (k) => process.env[k]?.trim();
const withTimeout = (p, ms = 20000) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);

async function checkOpenAI() {
  const key = env("OPENAI_API_KEY"); if (!key) return missing("OPENAI_API_KEY");
  const r = await withTimeout(fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } }));
  if (!r.ok) return bad("OPENAI_API_KEY", `HTTP ${r.status}`);
  const ids = (await r.json()).data.map((m) => m.id);
  const need = ["gpt-5.6-sol", "gpt-5.6-luna", "text-embedding-3-small"].filter((m) => !ids.includes(m));
  return need.length ? bad("OPENAI_API_KEY", `valid but missing models: ${need.join(", ")}`) : ok("OPENAI_API_KEY", `valid; sol, luna, embeddings available (${ids.length} models)`);
}
async function checkBloomfire() {
  const key = env("BLOOMFIRE_API_KEY"), email = env("BLOOMFIRE_LOGIN_EMAIL");
  if (!key) return missing("BLOOMFIRE_API_KEY"); if (!email) return missing("BLOOMFIRE_LOGIN_EMAIL");
  const r = await withTimeout(fetch("https://connected.wildflowerschools.org/api/v2/login", { method: "POST", headers: { "content-type": "application/json", "bloomfire-requested-fields": "session_token" }, body: JSON.stringify({ email, api_key: key }) }));
  if (!r.ok) return bad("BLOOMFIRE_API_KEY + BLOOMFIRE_LOGIN_EMAIL", `login HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const { session_token } = await r.json();
  const me = await withTimeout(fetch("https://connected.wildflowerschools.org/api/v2/users/me", { headers: { Authorization: `Bloomfire-Session-Token ${session_token}` } }));
  const u = await me.json();
  return u?.id ? ok("BLOOMFIRE_API_KEY + BLOOMFIRE_LOGIN_EMAIL", `session token issued for ${u.first_name} ${u.last_name} (role ${u.role ?? "n/a"})`) : bad("BLOOMFIRE_API_KEY", "token issued but users/me returned no id");
}
async function checkGoogle() {
  const id = env("GOOGLE_CLIENT_ID"), secret = env("GOOGLE_CLIENT_SECRET");
  if (!id) return missing("GOOGLE_CLIENT_ID"); if (!secret) return missing("GOOGLE_CLIENT_SECRET");
  if (!id.endsWith(".apps.googleusercontent.com")) return bad("GOOGLE_CLIENT_ID", "does not look like an OAuth client id");
  // A bogus code exchange distinguishes bad credentials (invalid_client) from good ones (invalid_grant).
  const body = new URLSearchParams({ code: "bogus", client_id: id, client_secret: secret, redirect_uri: "https://mywildflower.replit.app/api/auth/google/callback", grant_type: "authorization_code" });
  const r = await withTimeout(fetch("https://oauth2.googleapis.com/token", { method: "POST", body }));
  const j = await r.json().catch(() => ({}));
  if (j.error === "invalid_grant") return ok("GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET", "client id and secret accepted by Google (bogus code rejected as expected)");
  if (j.error === "invalid_client") return bad("GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET", `Google rejected the client: ${j.error_description ?? ""}`);
  if (j.error === "redirect_uri_mismatch") return bad("GOOGLE_CLIENT_ID", "credentials fine but the production redirect URI is not registered on the client");
  return bad("GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET", `unexpected response ${r.status} ${j.error ?? ""} ${j.error_description ?? ""}`);
}
async function checkResend() {
  const key = env("RESEND_API_KEY"); if (!key) return missing("RESEND_API_KEY");
  // A lookup of a nonexistent email id returns 404 for a valid key and 401 for an invalid one, without sending anything.
  const r = await withTimeout(fetch("https://api.resend.com/emails/00000000-0000-0000-0000-000000000000", { headers: { Authorization: `Bearer ${key}` } }));
  if (r.status === 401 || r.status === 403) return bad("RESEND_API_KEY", `HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const d = await withTimeout(fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${key}` } }));
  if (!d.ok) return ok("RESEND_API_KEY", `valid (sending-only key; cannot list domains, HTTP ${d.status})`);
  const domains = ((await d.json()).data ?? []).map((x) => `${x.name} (${x.status})`);
  return ok("RESEND_API_KEY", `valid; domains: ${domains.join(", ") || "none added yet (only onboarding@resend.dev can send)"}`);
}
async function checkSendGrid() {
  const key = env("SENDGRID_API_KEY"); if (!key) return results.push("INFO  SENDGRID_API_KEY: not set (not needed; Resend is the mailer)");
  const r = await withTimeout(fetch("https://api.sendgrid.com/v3/scopes", { headers: { Authorization: `Bearer ${key}` } }));
  if (!r.ok) return bad("SENDGRID_API_KEY", `HTTP ${r.status}`);
  const scopes = (await r.json()).scopes ?? [];
  const canSend = scopes.includes("mail.send");
  const v = await withTimeout(fetch("https://api.sendgrid.com/v3/verified_senders", { headers: { Authorization: `Bearer ${key}` } }));
  const senders = v.ok ? ((await v.json()).results ?? []).map((s) => s.from_email) : [];
  const d = await withTimeout(fetch("https://api.sendgrid.com/v3/whitelabel/domains", { headers: { Authorization: `Bearer ${key}` } }));
  const domains = d.ok ? (await d.json()).filter((x) => x.valid).map((x) => x.domain) : [];
  return (canSend ? ok : bad)("SENDGRID_API_KEY", `${canSend ? "has" : "LACKS"} mail.send; verified senders: ${senders.join(", ") || "none"}; authenticated domains: ${domains.join(", ") || "none"}`);
}
async function checkDatabase() {
  const url = env("DATABASE_URL"); if (!url) return missing("DATABASE_URL");
  let u; try { u = new URL(url); } catch { return bad("DATABASE_URL", "not a valid URL"); }
  const port = Number(u.port || 5432);
  const reach = await new Promise((res) => { const s = net.connect({ host: u.hostname, port, timeout: 8000 }); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); s.on("timeout", () => { s.destroy(); res(false); }); });
  if (!reach) return bad("DATABASE_URL", `cannot reach ${u.hostname}:${port}`);
  try { const { default: pg } = await import("pg"); const c = new pg.Client({ connectionString: url, ssl: u.hostname.includes("localhost") ? undefined : { rejectUnauthorized: false } }); await c.connect(); const r = await c.query("select version()"); await c.end(); return ok("DATABASE_URL", `connected; ${r.rows[0].version.split(",")[0]}`); }
  catch (e) { return e?.code === "ERR_MODULE_NOT_FOUND" ? ok("DATABASE_URL", `host ${u.hostname}:${port} reachable (pg driver not installed yet, login untested)`) : bad("DATABASE_URL", `connect failed: ${e.message}`); }
}

async function saToken(sa, scope, sub) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const claims = { iss: sa.client_email, scope, aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat: now, exp: now + 600 };
  if (sub) claims.sub = sub;
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const r = await withTimeout(fetch(sa.token_uri ?? "https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }) }));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${j.error ?? r.status}: ${j.error_description ?? ""}`.trim());
  return j.access_token;
}
async function checkGoogleDrive() {
  const raw = env("GOOGLE_SERVICE_ACCOUNT_JSON"); if (!raw) return results.push("INFO  GOOGLE_SERVICE_ACCOUNT_JSON: not set (optional; private Google files and the shared drive are unreachable)");
  let sa; try { sa = JSON.parse(raw); } catch { return bad("GOOGLE_SERVICE_ACCOUNT_JSON", "not valid JSON; paste the whole key file"); }
  if (!sa.client_email || !sa.private_key) return bad("GOOGLE_SERVICE_ACCOUNT_JSON", "JSON lacks client_email/private_key; this is not a service account key file");
  const SCOPE = "https://www.googleapis.com/auth/drive";
  let direct; try { direct = await saToken(sa, SCOPE, null); ok("GOOGLE_SERVICE_ACCOUNT_JSON", `key accepted; service account ${sa.client_email}`); }
  catch (e) { return bad("GOOGLE_SERVICE_ACCOUNT_JSON", `Google rejected the key: ${e.message}`); }
  const sub = env("GOOGLE_IMPERSONATE_EMAIL");
  let asUser = null;
  if (!sub) results.push("INFO  GOOGLE_IMPERSONATE_EMAIL: not set (optional; private My Drive files stay unreadable)");
  else {
    try { asUser = await saToken(sa, SCOPE, sub); const a = await withTimeout(fetch("https://www.googleapis.com/drive/v3/about?fields=user", { headers: { Authorization: `Bearer ${asUser}` } })); const u = (await a.json()).user;
      ok("GOOGLE_IMPERSONATE_EMAIL", `domain-wide delegation works; acting as ${u?.emailAddress ?? sub}`); }
    catch (e) { bad("GOOGLE_IMPERSONATE_EMAIL", `delegation not authorized yet for ${sub} (${e.message}). Check the client ID and scope under Domain-wide delegation; propagation can take a while. Shared-drive access still works directly.`); }
  }
  const driveId = env("GOOGLE_SHARED_DRIVE_ID");
  if (!driveId) return results.push("INFO  GOOGLE_SHARED_DRIVE_ID: not set (optional until native content lands)");
  for (const [label, token] of [["service account", direct], ["impersonated user", asUser]]) {
    if (!token) continue;
    const h = { headers: { Authorization: `Bearer ${token}` } };
    // Accept either a shared drive id or a folder id (a folder inside a shared drive, or in someone's My Drive).
    let r = await withTimeout(fetch(`https://www.googleapis.com/drive/v3/drives/${encodeURIComponent(driveId)}?fields=id,name,capabilities(canAddChildren)`, h));
    let j = await r.json().catch(() => ({}));
    let where = "shared drive";
    if (!r.ok) {
      r = await withTimeout(fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}?supportsAllDrives=true&fields=id,name,mimeType,driveId,owners(emailAddress),capabilities(canAddChildren,canListChildren)`, h));
      j = await r.json().catch(() => ({}));
      if (!r.ok) { bad("GOOGLE_SHARED_DRIVE_ID", `${label} cannot open ${driveId}: ${j.error?.message ?? r.status}. Use the id from the shared drive or folder URL and share it with the service account.`); continue; }
      if (j.mimeType !== "application/vnd.google-apps.folder") { bad("GOOGLE_SHARED_DRIVE_ID", `${label}: ${driveId} is a file ("${j.name}"), not a folder or shared drive`); continue; }
      where = j.driveId ? "folder inside a shared drive" : `folder in My Drive of ${(j.owners ?? []).map((o) => o.emailAddress).join(", ") || "someone"} (files there leave with that account; a shared drive is safer)`;
    }
    const f = await withTimeout(fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`'${driveId}' in parents and trashed=false`)}&includeItemsFromAllDrives=true&supportsAllDrives=true&pageSize=1&fields=files(id)`, h));
    const listed = f.ok ? "can list files" : `cannot list files (HTTP ${f.status})`;
    (j.capabilities?.canAddChildren ? ok : bad)("GOOGLE_SHARED_DRIVE_ID", `${label} opens "${j.name}" (${where}); ${listed}; ${j.capabilities?.canAddChildren ? "can add files" : "CANNOT add files (needs Content manager, Manager, or Editor)"}`);
  }
}
function checkSession() {
  const s = env("SESSION_SECRET"); if (!s) return missing("SESSION_SECRET");
  return s.length >= 32 ? ok("SESSION_SECRET", `${s.length} chars`) : bad("SESSION_SECRET", `only ${s.length} chars; use 64`);
}
function checkOptional() {
  for (const k of ["APP_BASE_URL", "STAFF_DOMAIN"]) env(k) ? ok(k, "set") : results.push(`INFO  ${k}: not set (optional; defaults apply)`);
}
await Promise.allSettled([checkOpenAI(), checkBloomfire(), checkGoogle(), checkResend(), checkSendGrid(), checkDatabase(), checkGoogleDrive()]).then((rs) => rs.forEach((r) => r.status === "rejected" && bad("check", r.reason?.message ?? String(r.reason))));
checkSession(); checkOptional();
console.log(results.sort().join("\n"));
process.exit(results.some((l) => l.startsWith("FAIL") || l.startsWith("MISSING")) ? 1 : 0);
