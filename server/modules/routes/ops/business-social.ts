import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Express } from "express";
import { decryptSecret, encryptSecret } from "../../../oauth/helpers.ts";
import { hasValidCsrfToken, shouldRequireCsrf } from "../../../security/auth.ts";
import { BUSINESS_SQL_LIST, isBusinessKey, syncBusinessCheck, type BusinessKey } from "../../businesses.ts";

type Business = BusinessKey;
type Platform = "instagram";
type SocialRow = {
  id: string;
  business: Business;
  platform: Platform;
  username: string;
  token_enc: string;
  provider_user_id: string | null;
  display_name: string | null;
  last_test_at: number | null;
  last_test_ok: number | null;
  updated_at: number;
};

export function ensureBusinessSocialSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS business_social_accounts (
    id TEXT PRIMARY KEY, business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
    platform TEXT NOT NULL CHECK(platform = 'instagram'),
    username TEXT NOT NULL, token_enc TEXT NOT NULL DEFAULT '', provider_user_id TEXT, display_name TEXT,
    last_test_at INTEGER, last_test_ok INTEGER CHECK(last_test_ok IN (0,1)), updated_at INTEGER NOT NULL,
    UNIQUE(business,platform,username)
  )`);
  syncBusinessCheck(db, "business_social_accounts");
}

function safeAccount(row: SocialRow) {
  const { token_enc, ...value } = row;
  return {
    ...value,
    profile_url: `https://www.instagram.com/${row.username}/`,
    has_access_token: Boolean(token_enc),
    connection_status: !token_enc ? "not_connected" : row.last_test_ok === 1 ? "verified" : "configured",
    last_test_ok: row.last_test_ok === null ? null : row.last_test_ok === 1,
  };
}

export function listSocialAccountsForAgent(db: DatabaseSync) {
  return (
    db.prepare("SELECT * FROM business_social_accounts ORDER BY business,platform,username").all() as SocialRow[]
  ).map((row) => {
    const { id, business, platform, username, profile_url, connection_status, provider_user_id, display_name } =
      safeAccount(row);
    return { id, business, platform, username, profile_url, connection_status, provider_user_id, display_name };
  });
}

function username(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim().replace(/^@/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(result) ? result : null;
}
function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= 16384 && !/[\r\n\0]/.test(value);
}
type Probe = { ok: true; id: string; name: string } | { ok: false; error: string };

async function testSocialProfile(row: SocialRow, token: string): Promise<Probe> {
  try {
    // Only the provider endpoints below are allowed; saved profile links never determine requests.
    const endpoint = new URL("https://graph.instagram.com/v27.0/me");
    endpoint.searchParams.set("fields", "user_id,username");
    const response = await fetch(endpoint, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 429) return { ok: false, error: "social_rate_limited" };
    if (response.status === 401 || response.status === 403) return { ok: false, error: "social_authorization_failed" };
    if (!response.ok) return { ok: false, error: "social_provider_rejected" };
    type Profile = { user_id?: unknown; username?: unknown };
    const result = (await response.json()) as Profile & { error?: unknown; data?: Profile[] };
    if (result?.error) {
      return { ok: false, error: "social_authorization_or_scope_failed" };
    }
    const profile = Array.isArray(result?.data) ? result.data[0] : result;
    const id = profile?.user_id;
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(id) || id.includes(token))
      return { ok: false, error: "social_invalid_profile_response" };
    const handle = username(profile?.username);
    if (!handle) return { ok: false, error: "social_missing_profile_scope" };
    if (handle !== row.username) return { ok: false, error: "social_account_mismatch" };
    return { ok: true, id, name: handle };
  } catch {
    // Never expose provider payloads, tokens embedded in request URLs, or raw network errors.
    return { ok: false, error: "social_connection_failed" };
  }
}

export type InstagramMedia = {
  id: string;
  /** Meta currently documents captions for Facebook Login, so this Instagram Login reader leaves them absent. */
  caption: null;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM" | null;
  permalink: string | null;
  timestamp: string | null;
};
export type InstagramMediaResult = { ok: true; items: InstagramMedia[] } | { ok: false; error: string };

function safeInstagramPermalink(value: unknown, token: string): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !["instagram.com", "www.instagram.com"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname.includes(token)
    )
      return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/** Fixed read-only endpoint, one page and ten normalized objects. Credentials/paging URLs never leave the server. */
export async function listInstagramMediaForAgent(db: DatabaseSync, accountId: string): Promise<InstagramMediaResult> {
  const row = db.prepare("SELECT * FROM business_social_accounts WHERE id=?").get(accountId) as SocialRow | undefined;
  if (!row) return { ok: false, error: "social_account_not_found" };
  if (
    row.platform !== "instagram" ||
    !row.token_enc ||
    row.last_test_ok !== 1 ||
    !row.provider_user_id ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(row.provider_user_id)
  )
    return { ok: false, error: "social_account_not_verified" };
  let token: string;
  try {
    token = decryptSecret(row.token_enc);
  } catch {
    return { ok: false, error: "social_credential_store_unavailable" };
  }
  try {
    const endpoint = new URL(`https://graph.instagram.com/v27.0/${encodeURIComponent(row.provider_user_id)}/media`);
    endpoint.searchParams.set("fields", "id,media_type,permalink,timestamp");
    endpoint.searchParams.set("limit", "10");
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 429) return { ok: false, error: "social_rate_limited" };
    if (response.status === 401 || response.status === 403) return { ok: false, error: "social_authorization_failed" };
    if (!response.ok) return { ok: false, error: "social_provider_rejected" };
    const result = (await response.json()) as { data?: unknown; error?: unknown };
    if (result?.error) return { ok: false, error: "social_authorization_or_scope_failed" };
    if (!Array.isArray(result?.data)) return { ok: false, error: "social_invalid_media_response" };
    const current = db.prepare("SELECT * FROM business_social_accounts WHERE id=?").get(accountId) as
      | SocialRow
      | undefined;
    if (
      !current ||
      current.token_enc !== row.token_enc ||
      current.username !== row.username ||
      current.provider_user_id !== row.provider_user_id ||
      current.updated_at !== row.updated_at ||
      current.last_test_ok !== 1
    )
      return { ok: false, error: "social_account_changed_during_read" };
    const items: InstagramMedia[] = [];
    for (const value of result.data.slice(0, 10)) {
      if (!value || typeof value !== "object") continue;
      const media = value as Record<string, unknown>;
      if (typeof media.id !== "string" || !/^[a-zA-Z0-9_-]{1,160}$/.test(media.id) || media.id.includes(token))
        continue;
      const mediaType = ["IMAGE", "VIDEO", "CAROUSEL_ALBUM"].includes(String(media.media_type))
        ? (media.media_type as InstagramMedia["media_type"])
        : null;
      const date =
        typeof media.timestamp === "string" && media.timestamp.length <= 64 ? Date.parse(media.timestamp) : NaN;
      items.push({
        id: media.id,
        caption: null,
        media_type: mediaType,
        permalink: safeInstagramPermalink(media.permalink, token),
        timestamp: Number.isFinite(date) ? new Date(date).toISOString() : null,
      });
    }
    return { ok: true, items };
  } catch {
    return { ok: false, error: "social_connection_failed" };
  }
}

export function registerBusinessSocialRoutes(app: Express, db: DatabaseSync): void {
  ensureBusinessSocialSchema(db);
  const base = "/api/business/social-accounts";
  app.use(base, (req, res, next) => {
    if (req.header("x-agent-task-token")) return res.status(403).json({ error: "owner_access_required" });
    if (req.method !== "GET" && shouldRequireCsrf(req) && !hasValidCsrfToken(req))
      return res.status(403).json({ error: "csrf_token_required" });
    next();
  });
  app.get(base, (_req, res) =>
    res.json({
      ok: true,
      items: (
        db.prepare("SELECT * FROM business_social_accounts ORDER BY business,platform,username").all() as SocialRow[]
      ).map(safeAccount),
    }),
  );
  app.get(`${base}/:id/media`, async (req, res) => {
    const result = await listInstagramMediaForAgent(db, String(req.params.id));
    return res.json(result);
  });
  app.post(base, (req, res) => {
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !["business", "platform", "username", "access_token"].includes(key))
    )
      return res.status(400).json({ error: "invalid_social_account_fields" });
    if (!isBusinessKey(body.business)) return res.status(400).json({ error: "invalid_business" });
    if (body.platform !== "instagram") return res.status(400).json({ error: "invalid_social_platform" });
    const handle = username(body.username);
    if (!handle) return res.status(400).json({ error: "invalid_social_username" });
    if ("access_token" in body && !validToken(body.access_token))
      return res.status(400).json({ error: "invalid_social_access_token" });
    if (
      db
        .prepare("SELECT 1 FROM business_social_accounts WHERE business=? AND platform=? AND username=?")
        .get(body.business, body.platform, handle)
    )
      return res.status(409).json({ error: "social_account_exists" });
    try {
      const token = body.access_token?.trim() ?? "";
      const id = randomUUID();
      db.prepare(
        "INSERT INTO business_social_accounts (id,business,platform,username,token_enc,updated_at) VALUES (?,?,?,?,?,?)",
      ).run(id, body.business, body.platform, handle, token ? encryptSecret(token) : "", Date.now());
      return res.status(201).json({
        ok: true,
        item: safeAccount(db.prepare("SELECT * FROM business_social_accounts WHERE id=?").get(id) as SocialRow),
      });
    } catch {
      return res.status(503).json({ error: "social_credential_store_unavailable" });
    }
  });
  app.patch(`${base}/:id`, (req, res) => {
    const id = String(req.params.id);
    const current = db.prepare("SELECT * FROM business_social_accounts WHERE id=?").get(id) as SocialRow | undefined;
    if (!current) return res.status(404).json({ error: "social_account_not_found" });
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      !Object.keys(body).length ||
      Object.keys(body).some((key) => !["username", "access_token", "clear_access_token"].includes(key))
    )
      return res.status(400).json({ error: "invalid_social_account_fields" });
    const handle = "username" in body ? username(body.username) : current.username;
    if (!handle) return res.status(400).json({ error: "invalid_social_username" });
    if ("access_token" in body && !validToken(body.access_token))
      return res.status(400).json({ error: "invalid_social_access_token" });
    if ("clear_access_token" in body && typeof body.clear_access_token !== "boolean")
      return res.status(400).json({ error: "invalid_social_account_fields" });
    if (body.clear_access_token && body.access_token?.trim())
      return res.status(400).json({ error: "conflicting_social_token_fields" });
    if (
      db
        .prepare("SELECT 1 FROM business_social_accounts WHERE business=? AND platform=? AND username=? AND id<>?")
        .get(current.business, current.platform, handle, id)
    )
      return res.status(409).json({ error: "social_account_exists" });
    try {
      const replacement = body.access_token?.trim();
      const token = body.clear_access_token ? "" : replacement ? encryptSecret(replacement) : current.token_enc;
      const changed = handle !== current.username || token !== current.token_enc;
      db.prepare(
        `UPDATE business_social_accounts SET username=?,token_enc=?,updated_at=?,
        provider_user_id=?,display_name=?,last_test_at=?,last_test_ok=? WHERE id=?`,
      ).run(
        handle,
        token,
        Date.now(),
        changed ? null : current.provider_user_id,
        changed ? null : current.display_name,
        changed ? null : current.last_test_at,
        changed ? null : current.last_test_ok,
        id,
      );
      return res.json({
        ok: true,
        item: safeAccount(db.prepare("SELECT * FROM business_social_accounts WHERE id=?").get(id) as SocialRow),
      });
    } catch {
      return res.status(503).json({ error: "social_credential_store_unavailable" });
    }
  });
  const testing = new Set<string>();
  app.post(`${base}/:id/test`, async (req, res) => {
    const id = String(req.params.id);
    const current = db.prepare("SELECT * FROM business_social_accounts WHERE id=?").get(id) as SocialRow | undefined;
    if (!current) return res.status(404).json({ error: "social_account_not_found" });
    if (!current.token_enc) return res.status(400).json({ error: "social_access_token_required" });
    if (testing.has(id)) return res.status(409).json({ error: "social_test_in_progress" });
    let token: string;
    try {
      token = decryptSecret(current.token_enc);
    } catch {
      return res.status(503).json({ error: "social_credential_store_unavailable" });
    }
    testing.add(id);
    try {
      const probe = await testSocialProfile(current, token);
      const updated = db
        .prepare(
          `UPDATE business_social_accounts SET provider_user_id=?,display_name=?,last_test_at=?,last_test_ok=?
        WHERE id=? AND token_enc=? AND username=? AND updated_at=?`,
        )
        .run(
          probe.ok ? probe.id : null,
          probe.ok ? probe.name : null,
          Date.now(),
          probe.ok ? 1 : 0,
          id,
          current.token_enc,
          current.username,
          current.updated_at,
        );
      const row = db.prepare("SELECT * FROM business_social_accounts WHERE id=?").get(id) as SocialRow | undefined;
      if (!row || !updated.changes) return res.status(409).json({ error: "social_account_changed_during_test" });
      return res.json({ ok: probe.ok, item: safeAccount(row), ...(!probe.ok ? { error: probe.error } : {}) });
    } finally {
      testing.delete(id);
    }
  });
  app.post(`${base}/:id/disconnect`, (req, res) => {
    const id = String(req.params.id);
    const updated = db
      .prepare(
        "UPDATE business_social_accounts SET token_enc='',provider_user_id=NULL,display_name=NULL,last_test_at=NULL,last_test_ok=NULL,updated_at=? WHERE id=?",
      )
      .run(Date.now(), id);
    if (!updated.changes) return res.status(404).json({ error: "social_account_not_found" });
    return res.json({
      ok: true,
      item: safeAccount(db.prepare("SELECT * FROM business_social_accounts WHERE id=?").get(id) as SocialRow),
    });
  });
  app.delete(`${base}/:id`, (req, res) => {
    const deleted = db.prepare("DELETE FROM business_social_accounts WHERE id=?").run(String(req.params.id));
    return deleted.changes ? res.json({ ok: true }) : res.status(404).json({ error: "social_account_not_found" });
  });
}
