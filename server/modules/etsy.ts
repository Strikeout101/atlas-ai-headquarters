import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret } from "../oauth/helpers.ts";
import { appendAutonomyLedger } from "./autonomy-store.ts";
import { isBusinessKey, type BusinessKey } from "./businesses.ts";
import { markInitiativeLaunched, recordInitiativeMetric } from "./experiments.ts";
import { upsertProviderLedgerEntry } from "./finance-store.ts";
import { applyApprovedShopChanges, canChangeShop, ensureEtsyShopSchema, refreshShopProfile } from "./etsy-shop.ts";
import {
  applyRevisionLocally,
  ensureListingSchema,
  ETSY_WHEN_MADE,
  ETSY_WHO_MADE,
  getListing,
  markListingPublished,
  revisionChanges,
  type ListingPackage,
} from "./listings.ts";

/**
 * Etsy Open API v3 for the Ventures shop: connect with OAuth (PKCE), push approved listing packages as drafts, publish
 * them, and read paid orders, fees and refunds into the ledger.
 *
 * Facts from Etsy's OpenAPI spec (etsy.com/openapi/generated/oas/3.0.0.json) and auth docs:
 *   - every request: `x-api-key: <keystring>:<shared_secret>`; user calls also `Authorization: Bearer <user_id>.<token>`
 *     (the access token Etsy returns already starts with the user id)
 *   - authorize at https://www.etsy.com/oauth/connect, tokens at https://api.etsy.com/v3/public/oauth/token;
 *     access tokens last 1 hour, refresh tokens 90 days; PKCE with S256 is required
 *   - the redirect address must be https and match the registered one exactly. ATLAS runs on plain http, so the owner
 *     registers any https address, approves on Etsy, and pastes the address the browser lands on back into ATLAS.
 *
 * Built before the owner's Etsy app existed (2026-11-18): verified against the spec and fakes, not yet against live
 * Etsy. The mapping of payment-ledger entry types to fees and refunds is a best guess until real entries are seen.
 *
 * Also (2026-11-21): approved revisions change live listings (title, description, tags, price through inventory,
 * images, files); listings of stopped initiatives are deactivated; every shop listing is mirrored into
 * `etsy_shop_listings` so ATLAS sees listings it did not create and changes made on Etsy; the daily request quota
 * Etsy reports is tracked so background work pauses before it runs out.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export const ETSY_API = "https://api.etsy.com/v3/application";
export const ETSY_AUTHORIZE_URL = "https://www.etsy.com/oauth/connect";
export const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
/** shops_w (2026-11-22) lets approved shop changes set the title, announcement, messages and sections. */
export const ETSY_SCOPES = ["listings_r", "listings_w", "shops_r", "shops_w", "transactions_r"] as const;
export const ETSY_SYNC_INTERVAL_MS = 30 * 60_000;
const AUTH_TTL_MS = 15 * 60_000;
const REFRESH_EARLY_MS = 2 * 60_000;
const PAGE = 100;
const MAX_PAGES = 20;
const FIRST_SYNC_LOOKBACK_S = 90 * 86_400;
/** Listing states getListingsByShop accepts; every one is read so nothing in the shop is missed. */
export const ETSY_LISTING_STATES = ["active", "inactive", "draft", "expired", "sold_out"] as const;
const MAX_IMAGES = 10;
const MAX_FILES = 5;
/** Background work pauses when fewer requests than this are left today (or 2% of the daily limit, if larger). */
const QUOTA_FLOOR = 50;
/**
 * The owner's app allows 10 requests a second and 10,000 a day (2026-11-21). Calls are spaced at least this far
 * apart (8 a second), process-wide, to stay under the per-second limit with room to spare.
 * `ETSY_MIN_INTERVAL_MS` overrides it (tests set 0).
 */
const DEFAULT_MIN_INTERVAL_MS = 125;
let nextRequestAt = 0;

async function waitForSlot(sleep: (ms: number) => Promise<void>): Promise<void> {
  const configured = Number(process.env.ETSY_MIN_INTERVAL_MS);
  const gap = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MIN_INTERVAL_MS;
  if (!gap) return;
  const now = Date.now();
  const wait = nextRequestAt - now;
  nextRequestAt = Math.max(now, nextRequestAt) + gap;
  if (wait > 0) await sleep(wait);
}

export interface EtsyDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function fail(message: string): never {
  throw new Error(message);
}

export function ensureEtsySchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS etsy_connection (
    id INTEGER PRIMARY KEY CHECK(id=1),
    business TEXT NOT NULL DEFAULT 'ventures',
    keystring TEXT NOT NULL DEFAULT '', shared_secret_enc TEXT NOT NULL DEFAULT '', redirect_uri TEXT NOT NULL DEFAULT '',
    access_token_enc TEXT NOT NULL DEFAULT '', refresh_token_enc TEXT NOT NULL DEFAULT '', expires_at INTEGER,
    user_id TEXT, shop_id TEXT, shop_name TEXT,
    auth_state TEXT, auth_verifier_enc TEXT, auth_started_at INTEGER,
    auto_publish INTEGER NOT NULL DEFAULT 0 CHECK(auto_publish IN (0,1)),
    sync_enabled INTEGER NOT NULL DEFAULT 1 CHECK(sync_enabled IN (0,1)),
    receipts_after INTEGER, ledger_after INTEGER,
    last_test_at INTEGER, last_test_ok INTEGER, last_error TEXT, last_sync_at INTEGER, last_sync_error TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO etsy_connection(id) VALUES (1);
  CREATE TABLE IF NOT EXISTS etsy_shop_listings (
    listing_id TEXT PRIMARY KEY, state TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]', price_minor INTEGER, currency TEXT, url TEXT, num_favorers INTEGER, quantity INTEGER,
    taxonomy_id INTEGER, who_made TEXT, when_made TEXT, last_modified INTEGER, seen_at INTEGER NOT NULL
  );`);
  const have = new Set(
    (db.prepare("PRAGMA table_info(etsy_connection)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  const mirror = new Set(
    (db.prepare("PRAGMA table_info(etsy_shop_listings)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!mirror.has("views")) db.exec("ALTER TABLE etsy_shop_listings ADD COLUMN views INTEGER");
  for (const column of ["rate_limit_per_day", "rate_remaining_today", "rate_seen_at"])
    if (!have.has(column)) db.exec(`ALTER TABLE etsy_connection ADD COLUMN ${column} INTEGER`);
  ensureListingSchema(db);
}

function row(db: Db): Row {
  ensureEtsySchema(db);
  return db.prepare("SELECT * FROM etsy_connection WHERE id=1").get() as Row;
}

const decrypt = (value: unknown) => (typeof value === "string" && value ? decryptSecret(value) : "");

/** What the owner sees. Secrets and tokens are never returned, only whether they are set. */
export function etsySettings(db: Db) {
  const r = row(db);
  return {
    business: String(r.business),
    keystring: String(r.keystring),
    shared_secret_set: Boolean(r.shared_secret_enc),
    redirect_uri: String(r.redirect_uri),
    connected: Boolean(r.access_token_enc && r.shop_id),
    shop_id: (r.shop_id as string | null) ?? null,
    shop_name: (r.shop_name as string | null) ?? null,
    expires_at: (r.expires_at as number | null) ?? null,
    auto_publish: Boolean(r.auto_publish),
    sync_enabled: Boolean(r.sync_enabled),
    last_test_at: (r.last_test_at as number | null) ?? null,
    last_test_ok: r.last_test_ok === null || r.last_test_ok === undefined ? null : Boolean(r.last_test_ok),
    last_error: (r.last_error as string | null) ?? null,
    last_sync_at: (r.last_sync_at as number | null) ?? null,
    last_sync_error: (r.last_sync_error as string | null) ?? null,
    scopes: [...ETSY_SCOPES],
    rate_limit_per_day: (r.rate_limit_per_day as number | null) ?? null,
    rate_remaining_today: (r.rate_remaining_today as number | null) ?? null,
    rate_seen_at: (r.rate_seen_at as number | null) ?? null,
    quota_low: etsyQuotaLow(db),
    // Connected before shops_w was asked for: the owner reconnects once so agents' shop changes can be applied.
    can_change_shop: canChangeShop(db),
    shop_listings: Number(
      (db.prepare("SELECT COUNT(*) AS n FROM etsy_shop_listings WHERE state<>'removed'").get() as { n: number }).n,
    ),
  };
}

/**
 * True when Etsy's last reported daily allowance is nearly used. Etsy sends `x-remaining-today` on every successful
 * call; the window is a sliding 24 hours, so a reading older than a day says nothing.
 */
export function etsyQuotaLow(db: Db, now = Date.now()): boolean {
  const r = db
    .prepare("SELECT rate_limit_per_day, rate_remaining_today, rate_seen_at FROM etsy_connection WHERE id=1")
    .get() as Row | undefined;
  if (!r || r.rate_remaining_today === null || r.rate_seen_at === null) return false;
  if (now - Number(r.rate_seen_at) > 86_400_000) return false;
  const floor = Math.max(QUOTA_FLOOR, Math.ceil(Number(r.rate_limit_per_day ?? 0) * 0.02));
  return Number(r.rate_remaining_today) < floor;
}

function recordQuota(db: Db, headers: Headers, now: number): void {
  const remaining = headers.get("x-remaining-today");
  if (remaining === null || !Number.isFinite(Number(remaining))) return;
  const limit = Number(headers.get("x-limit-per-day"));
  db.prepare("UPDATE etsy_connection SET rate_limit_per_day=?, rate_remaining_today=?, rate_seen_at=? WHERE id=1").run(
    Number.isFinite(limit) && limit > 0 ? limit : null,
    Number(remaining),
    now,
  );
}

export function saveEtsySettings(db: Db, input: Row, now = Date.now()) {
  const current = row(db);
  const keystring =
    input.keystring === undefined
      ? String(current.keystring)
      : typeof input.keystring === "string"
        ? input.keystring.trim()
        : fail("invalid_keystring");
  if (keystring.length > 200 || /[\s:]/.test(keystring)) fail("invalid_keystring");
  let secretEnc = String(current.shared_secret_enc);
  if (input.shared_secret !== undefined) {
    if (typeof input.shared_secret !== "string" || input.shared_secret.length > 200) fail("invalid_shared_secret");
    secretEnc = input.shared_secret.trim() ? encryptSecret(input.shared_secret.trim()) : "";
  }
  let redirect = String(current.redirect_uri);
  if (input.redirect_uri !== undefined) {
    if (typeof input.redirect_uri !== "string") fail("invalid_redirect_uri");
    redirect = input.redirect_uri.trim();
    if (redirect) {
      let parsed: URL;
      try {
        parsed = new URL(redirect);
      } catch {
        return fail("invalid_redirect_uri");
      }
      if (parsed.protocol !== "https:" || parsed.hash) fail("etsy_redirect_must_be_https");
    }
  }
  const bool = (key: string, fallback: unknown) => {
    if (input[key] === undefined) return fallback ? 1 : 0;
    if (typeof input[key] !== "boolean") fail(`invalid_${key}`);
    return input[key] ? 1 : 0;
  };
  const business = input.business === undefined ? current.business : input.business;
  if (!isBusinessKey(business)) fail("invalid_business");
  const credentialsChanged = keystring !== current.keystring || secretEnc !== current.shared_secret_enc;
  db.prepare(
    `UPDATE etsy_connection SET business=?, keystring=?, shared_secret_enc=?, redirect_uri=?, auto_publish=?, sync_enabled=?,
     ${credentialsChanged ? "access_token_enc='', refresh_token_enc='', expires_at=NULL, user_id=NULL, shop_id=NULL, shop_name=NULL," : ""}
     updated_at=? WHERE id=1`,
  ).run(
    business,
    keystring,
    secretEnc,
    redirect,
    bool("auto_publish", current.auto_publish),
    bool("sync_enabled", current.sync_enabled),
    now,
  );
  return etsySettings(db);
}

const base64url = (buffer: Buffer) =>
  buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** PKCE (RFC 7636): a 43-character verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
}

/** Step 1 of connecting: the address the owner opens to approve ATLAS on Etsy. */
export function startEtsyConnect(db: Db, now = Date.now()): { url: string } {
  const r = row(db);
  if (!r.keystring || !r.shared_secret_enc) fail("etsy_credentials_required");
  if (!r.redirect_uri) fail("etsy_redirect_required");
  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(24));
  db.prepare(
    "UPDATE etsy_connection SET auth_state=?, auth_verifier_enc=?, auth_started_at=?, updated_at=? WHERE id=1",
  ).run(state, encryptSecret(verifier), now, now);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: String(r.keystring),
    redirect_uri: String(r.redirect_uri),
    scope: ETSY_SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { url: `${ETSY_AUTHORIZE_URL}?${params.toString().replace(/\+/g, "%20")}` };
}

async function tokenRequest(form: Record<string, string>, deps: EtsyDeps): Promise<Row> {
  const response = await (deps.fetch ?? fetch)(ETSY_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await response.json().catch(() => ({}))) as Row;
  if (!response.ok || typeof body.access_token !== "string")
    fail(`etsy_token_failed: ${String(body.error_description ?? body.error ?? response.status).slice(0, 200)}`);
  return body;
}

function saveTokens(db: Db, body: Row, now: number): void {
  const access = String(body.access_token);
  const userId = access.includes(".") ? access.split(".")[0] : null;
  db.prepare(
    `UPDATE etsy_connection SET access_token_enc=?, refresh_token_enc=CASE WHEN ?='' THEN refresh_token_enc ELSE ? END,
     expires_at=?, user_id=COALESCE(?, user_id), updated_at=? WHERE id=1`,
  ).run(
    encryptSecret(access),
    typeof body.refresh_token === "string" ? body.refresh_token : "",
    typeof body.refresh_token === "string" ? encryptSecret(body.refresh_token) : "",
    now + Number(body.expires_in ?? 3600) * 1000,
    userId,
    now,
  );
}

/**
 * Step 2: the owner pastes the address Etsy sent them to (it does not load, because ATLAS is not at that address).
 * The state must match the one ATLAS started, within 15 minutes.
 */
export async function completeEtsyConnect(db: Db, pasted: unknown, deps: EtsyDeps = {}) {
  const now = deps.now?.() ?? Date.now();
  const r = row(db);
  if (typeof pasted !== "string" || !pasted.trim()) fail("etsy_paste_the_address");
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    return fail("etsy_paste_the_address");
  }
  if (url.searchParams.get("error"))
    fail(`etsy_denied: ${url.searchParams.get("error_description") ?? url.searchParams.get("error")}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) fail("etsy_code_missing");
  if (!r.auth_state || state !== r.auth_state) fail("etsy_state_mismatch");
  if (!r.auth_started_at || now - Number(r.auth_started_at) > AUTH_TTL_MS) fail("etsy_connect_expired");
  const body = await tokenRequest(
    {
      grant_type: "authorization_code",
      client_id: String(r.keystring),
      redirect_uri: String(r.redirect_uri),
      code,
      code_verifier: decrypt(r.auth_verifier_enc),
    },
    deps,
  );
  saveTokens(db, body, now);
  ensureEtsyShopSchema(db);
  db.prepare(
    "UPDATE etsy_connection SET auth_state=NULL, auth_verifier_enc=NULL, auth_started_at=NULL, granted_scopes=? WHERE id=1",
  ).run(ETSY_SCOPES.join(" "));
  return testEtsyConnection(db, deps);
}

async function accessToken(db: Db, deps: EtsyDeps, force = false): Promise<string> {
  const r = row(db);
  if (!r.access_token_enc) fail("etsy_not_connected");
  const now = deps.now?.() ?? Date.now();
  if (!force && r.expires_at && Number(r.expires_at) - REFRESH_EARLY_MS > now) return decrypt(r.access_token_enc);
  const refresh = decrypt(r.refresh_token_enc);
  if (!refresh) fail("etsy_reconnect_required");
  const body = await tokenRequest(
    { grant_type: "refresh_token", client_id: String(r.keystring), refresh_token: refresh },
    deps,
  );
  saveTokens(db, body, now);
  return String(body.access_token);
}

export interface EtsyRequest {
  query?: Record<string, string | number | boolean | undefined>;
  /** Form fields; an array sends the field once per value. */
  form?: Record<string, string | string[]>;
  multipart?: FormData;
  json?: unknown;
  /** Calls that only need the app key (taxonomy). */
  appOnly?: boolean;
}

/** One API call: refreshes the token when needed, retries once after a 401, and waits on 429 (`retry-after`). */
export async function etsyRequest(
  db: Db,
  method: string,
  apiPath: string,
  req: EtsyRequest = {},
  deps: EtsyDeps = {},
): Promise<Row> {
  const r = row(db);
  if (!r.keystring || !r.shared_secret_enc) fail("etsy_credentials_required");
  const apiKey = `${r.keystring}:${decrypt(r.shared_secret_enc)}`;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query ?? {})) if (value !== undefined) query.set(key, String(value));
  const url = `${ETSY_API}${apiPath}${query.size ? `?${query}` : ""}`;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let refreshed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const headers: Record<string, string> = { "x-api-key": apiKey, accept: "application/json" };
    if (!req.appOnly) headers.authorization = `Bearer ${await accessToken(db, deps)}`;
    let body: string | FormData | undefined;
    if (req.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(req.form))
        for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
      body = params.toString();
    } else if (req.multipart)
      body = req.multipart; // fetch sets the multipart boundary itself
    else if (req.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.json);
    }
    await waitForSlot(sleep);
    const response = await (deps.fetch ?? fetch)(url, { method, headers, body, signal: AbortSignal.timeout(60_000) });
    recordQuota(db, response.headers, deps.now?.() ?? Date.now());
    if (response.status === 401 && !req.appOnly && !refreshed) {
      refreshed = true;
      await accessToken(db, deps, true);
      continue;
    }
    if (response.status === 429 && attempt < 3) {
      const wait = Math.min(30, Math.max(1, Number(response.headers.get("retry-after") ?? 2)));
      await sleep(wait * 1000);
      continue;
    }
    const text = await response.text();
    let parsed: Row = {};
    try {
      parsed = text ? (JSON.parse(text) as Row) : {};
    } catch {
      parsed = { raw: text.slice(0, 300) };
    }
    if (!response.ok) fail(`etsy_api_${response.status}: ${String(parsed.error ?? parsed.raw ?? "").slice(0, 200)}`);
    return parsed;
  }
  return fail("etsy_rate_limited");
}

/** Who is connected, and which shop. */
export async function testEtsyConnection(db: Db, deps: EtsyDeps = {}) {
  const now = deps.now?.() ?? Date.now();
  try {
    const me = await etsyRequest(db, "GET", "/users/me", {}, deps);
    if (!me.shop_id) fail("etsy_no_shop: this Etsy account has no shop yet");
    let shopName: string | null = null;
    try {
      const shop = await etsyRequest(db, "GET", `/shops/${me.shop_id}`, {}, deps);
      shopName = typeof shop.shop_name === "string" ? shop.shop_name : null;
    } catch {
      shopName = null;
    }
    db.prepare(
      "UPDATE etsy_connection SET user_id=?, shop_id=?, shop_name=?, last_test_at=?, last_test_ok=1, last_error=NULL, updated_at=? WHERE id=1",
    ).run(String(me.user_id), String(me.shop_id), shopName, now, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : "etsy_test_failed";
    db.prepare("UPDATE etsy_connection SET last_test_at=?, last_test_ok=0, last_error=?, updated_at=? WHERE id=1").run(
      now,
      message.slice(0, 300),
      now,
    );
    throw error;
  }
  return etsySettings(db);
}

export function disconnectEtsy(db: Db, now = Date.now()) {
  row(db);
  db.prepare(
    "UPDATE etsy_connection SET access_token_enc='', refresh_token_enc='', expires_at=NULL, user_id=NULL, shop_id=NULL, shop_name=NULL, updated_at=? WHERE id=1",
  ).run(now);
  return etsySettings(db);
}

// --- Taxonomy (categories) -------------------------------------------------------------------------------------

let taxonomyCache: { at: number; nodes: Array<{ id: number; name: string; path: string }> } | null = null;

/** Etsy categories matching the words of `query`, for agents choosing a listing's `taxonomy_id`. Needs only the app key. */
export async function searchEtsyTaxonomy(db: Db, query: unknown, deps: EtsyDeps = {}) {
  const words = (typeof query === "string" ? query : "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
  if (!words.length) fail("invalid_query");
  const now = deps.now?.() ?? Date.now();
  if (!taxonomyCache || now - taxonomyCache.at > 86_400_000) {
    const body = await etsyRequest(db, "GET", "/seller-taxonomy/nodes", { appOnly: true }, deps);
    const nodes: Array<{ id: number; name: string; path: string }> = [];
    const walk = (list: unknown, trail: string[]) => {
      if (!Array.isArray(list)) return;
      for (const node of list as Row[]) {
        const name = String(node.name ?? "");
        const next = [...trail, name];
        nodes.push({ id: Number(node.id), name, path: next.join(" > ") });
        walk(node.children, next);
      }
    };
    walk(body.results, []);
    taxonomyCache = { at: now, nodes };
  }
  return taxonomyCache.nodes
    .map((node) => ({ ...node, score: words.filter((word) => node.path.toLowerCase().includes(word)).length }))
    .filter((node) => node.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, 12)
    .map(({ score: _score, ...node }) => node);
}

// --- Market research (public Etsy search) ---------------------------------------------------------------------

export const ETSY_SEARCH_SORTS = ["score", "created", "price", "updated"] as const;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Active Etsy listings matching `keywords`, for research agents: how many compete, what they charge, how much
 * attention they get (favorites, views) and which tags they use. Etsy's public listing search
 * (findAllListingsActive) needs only the app key; Etsy's own search pages refuse automated readers.
 * Titles and tags come from other sellers, so the gateway screens them like any outside text.
 */
export async function searchEtsyListings(db: Db, input: Row, deps: EtsyDeps = {}) {
  const keywords = typeof input.keywords === "string" ? input.keywords.trim() : "";
  if (keywords.length < 2 || keywords.length > 200) fail("invalid_keywords");
  const sortOn = input.sort_on === undefined ? "score" : input.sort_on;
  if (!(ETSY_SEARCH_SORTS as readonly unknown[]).includes(sortOn)) fail("invalid_sort_on");
  const limit = input.limit === undefined ? 25 : input.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) fail("invalid_limit");
  const offset = input.offset === undefined ? 0 : input.offset;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > 10_000) fail("invalid_offset");
  const price = (key: string) => {
    const value = input[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000) fail(`invalid_${key}`);
    return value;
  };
  const taxonomy = input.taxonomy_id;
  if (taxonomy !== undefined && (typeof taxonomy !== "number" || !Number.isSafeInteger(taxonomy) || taxonomy < 1))
    fail("invalid_taxonomy_id");
  const body = await etsyRequest(
    db,
    "GET",
    "/listings/active",
    {
      appOnly: true,
      query: {
        keywords,
        sort_on: String(sortOn),
        sort_order: input.sort_order === "asc" ? "asc" : "desc",
        limit,
        offset,
        min_price: price("min_price"),
        max_price: price("max_price"),
        taxonomy_id: taxonomy as number | undefined,
      },
    },
    deps,
  );
  const listings = results(body).map((listing) => {
    const money = moneyMinor(listing.price);
    return {
      listing_id: String(listing.listing_id ?? ""),
      title: String(listing.title ?? "").slice(0, 200),
      price: money ? money.minor / 100 : null,
      currency: money?.currency ?? null,
      num_favorers: Number.isFinite(Number(listing.num_favorers)) ? Number(listing.num_favorers) : null,
      views: Number.isFinite(Number(listing.views)) ? Number(listing.views) : null,
      tags: Array.isArray(listing.tags) ? listing.tags.map(String).slice(0, 13) : [],
      // Etsy marks digital listings with listing_type (download or both) and lists their files in file_data ("1 PDF").
      is_digital: ["download", "both"].includes(String(listing.listing_type)) || Boolean(listing.file_data),
      files: typeof listing.file_data === "string" && listing.file_data ? listing.file_data.slice(0, 60) : null,
      listed_at: Number.isFinite(Number(listing.original_creation_timestamp))
        ? new Date(Number(listing.original_creation_timestamp) * 1000).toISOString().slice(0, 10)
        : null,
      url: typeof listing.url === "string" && listing.url.startsWith("https://") ? listing.url.split("?")[0] : null,
    };
  });
  // Price summary in the most common currency (Etsy reports each listing in its shop's currency).
  const currencies = new Map<string, number>();
  for (const listing of listings)
    if (listing.currency) currencies.set(listing.currency, (currencies.get(listing.currency) ?? 0) + 1);
  const currency = [...currencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const prices = listings
    .filter((listing) => listing.currency === currency && listing.price !== null)
    .map((listing) => Math.round(listing.price! * 100));
  const tagCounts = new Map<string, number>();
  for (const listing of listings)
    for (const tag of listing.tags) tagCounts.set(tag.toLowerCase(), (tagCounts.get(tag.toLowerCase()) ?? 0) + 1);
  const average = (key: "num_favorers" | "views") => {
    const values = listings.map((listing) => listing[key]).filter((value): value is number => value !== null);
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  };
  return {
    source: "Etsy public listing search",
    keywords,
    total_active_listings: Number.isFinite(Number(body.count)) ? Number(body.count) : null,
    returned: listings.length,
    summary: {
      price_currency: currency,
      price_min: prices.length ? Math.min(...prices) / 100 : null,
      price_median: median(prices) === null ? null : median(prices)! / 100,
      price_max: prices.length ? Math.max(...prices) / 100 : null,
      average_favorites: average("num_favorers"),
      average_views: average("views"),
      digital_share: listings.length
        ? Math.round((listings.filter((listing) => listing.is_digital).length / listings.length) * 100) / 100
        : null,
      common_tags: [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([tag, count]) => ({ tag, count })),
    },
    listings,
    note: "Favorites and views are lifetime counts for each listing; Etsy's API does not report other shops' sales.",
  };
}

// --- Listings ----------------------------------------------------------------------------------------------------

function projectRoot(db: Db, projectId: string | null): string {
  if (!projectId) fail("etsy_listing_needs_project");
  const project = db.prepare("SELECT project_path FROM projects WHERE id=?").get(projectId) as Row | undefined;
  if (!project?.project_path) fail("etsy_listing_needs_project");
  return path.resolve(String(project.project_path));
}

function projectFile(root: string, relative: string): string {
  const full = path.resolve(root, relative);
  if (full !== root && !full.startsWith(root + path.sep)) fail("etsy_file_outside_project");
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) fail(`etsy_file_missing: ${relative}`);
  return full;
}

function shopId(db: Db): string {
  const r = row(db);
  if (!r.access_token_enc || !r.shop_id) fail("etsy_not_connected");
  return String(r.shop_id);
}

const altText = (listing: Pick<ListingPackage, "title">, index: number, total: number) =>
  `${listing.title} - image ${index + 1} of ${total}`.slice(0, 250);

function normalTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((tag) => String(tag).trim().toLowerCase()).sort();
}

/**
 * Etsy's spec describes tags as "a comma-separated list" but types the field as an array, and no live example
 * confirms which form-encoding it keeps. ATLAS sends the comma form first and reads back what Etsy saved; if Etsy
 * did not keep every tag, it sends each tag as its own field and checks again. A response without tags is not checked.
 */
async function ensureTags(db: Db, shop: string, etsyId: string, tags: string[], saved: unknown, deps: EtsyDeps) {
  const want = tags.map((tag) => tag.trim().toLowerCase()).sort();
  const got = normalTags(saved);
  if (!got || JSON.stringify(got) === JSON.stringify(want)) return;
  const retried = await etsyRequest(
    db,
    "PATCH",
    `/shops/${shop}/listings/${etsyId}`,
    { form: { tags: tags.length ? tags : [""] } },
    deps,
  );
  const again = normalTags(retried.tags);
  if (again && JSON.stringify(again) !== JSON.stringify(want))
    fail(`etsy_tags_not_saved: Etsy kept ${again.length} of ${want.length} tags`);
}

async function uploadImages(
  db: Db,
  shop: string,
  etsyId: string,
  listing: Pick<ListingPackage, "title">,
  files: string[],
  from: number,
  deps: EtsyDeps,
) {
  for (let index = from; index < files.length; index++) {
    const form = new FormData();
    form.append("image", new Blob([fs.readFileSync(files[index])]), path.basename(files[index]));
    form.append("rank", String(index + 1));
    form.append("alt_text", altText(listing, index, files.length));
    await etsyRequest(db, "POST", `/shops/${shop}/listings/${etsyId}/images`, { multipart: form }, deps);
  }
}

async function uploadFiles(db: Db, shop: string, etsyId: string, files: string[], from: number, deps: EtsyDeps) {
  for (let index = from; index < files.length; index++) {
    const form = new FormData();
    form.append("file", new Blob([fs.readFileSync(files[index])]), path.basename(files[index]));
    form.append("name", path.basename(files[index]));
    form.append("rank", String(index + 1));
    await etsyRequest(db, "POST", `/shops/${shop}/listings/${etsyId}/files`, { multipart: form }, deps);
  }
}

const results = (body: Row): Row[] => (Array.isArray(body.results) ? (body.results as Row[]) : []);

function checkMediaCounts(images: string[], files: string[]) {
  if (images.length > MAX_IMAGES) fail(`etsy_too_many_images: Etsy allows ${MAX_IMAGES}`);
  if (files.length > MAX_FILES) fail(`etsy_too_many_files: Etsy allows ${MAX_FILES}`);
}

/**
 * Creates the Etsy draft for an approved package: listing, then images (with alt text), then the digital files.
 * A draft is not public. Re-running after a partial failure continues on the same Etsy listing and uploads only the
 * images and files that are still missing. An approved revision is applied to its live listing instead.
 */
export async function pushListingDraft(db: Db, listingId: string, deps: EtsyDeps = {}) {
  const listing = getListing(db, listingId) ?? fail("listing_not_found");
  if (listing.platform !== "etsy") fail("listing_not_etsy");
  if (listing.status !== "approved") fail("listing_not_approved");
  if (listing.revision_of) return applyEtsyRevision(db, listingId, deps);
  if (!listing.taxonomy_id) fail("listing_taxonomy_required");
  const shop = shopId(db);
  const root = projectRoot(db, listing.project_id);
  const images = listing.mockups.map((file) => projectFile(root, file));
  const files = listing.files.map((file) => projectFile(root, file));
  checkMediaCounts(images, files);
  let etsyId = listing.etsy_listing_id;
  let haveImages = 0;
  let haveFiles = 0;
  if (!etsyId) {
    const created = await etsyRequest(
      db,
      "POST",
      `/shops/${shop}/listings`,
      {
        form: {
          quantity: "999",
          title: listing.title,
          description: listing.description,
          price: (listing.price_minor / 100).toFixed(2),
          who_made: listing.who_made,
          when_made: listing.when_made,
          taxonomy_id: String(listing.taxonomy_id),
          is_supply: "false",
          type: "download",
          ...(listing.tags.length ? { tags: listing.tags.join(",") } : {}),
        },
      },
      deps,
    );
    if (!created.listing_id) fail("etsy_listing_not_created");
    etsyId = String(created.listing_id);
    db.prepare("UPDATE listing_packages SET etsy_listing_id=?, etsy_state='draft', updated_at=? WHERE id=?").run(
      etsyId,
      deps.now?.() ?? Date.now(),
      listing.id,
    );
    if (listing.tags.length) await ensureTags(db, shop, etsyId, listing.tags, created.tags, deps);
  } else {
    haveImages = results(await etsyRequest(db, "GET", `/listings/${etsyId}/images`, {}, deps)).length;
    haveFiles = results(await etsyRequest(db, "GET", `/shops/${shop}/listings/${etsyId}/files`, {}, deps)).length;
  }
  await uploadImages(db, shop, etsyId, listing, images, haveImages, deps);
  await uploadFiles(db, shop, etsyId, files, haveFiles, deps);
  return getListing(db, listing.id)!;
}

/** Makes the Etsy draft public (Etsy charges its listing fee) and marks the package published. */
export async function publishEtsyListing(db: Db, listingId: string, deps: EtsyDeps = {}) {
  const listing = getListing(db, listingId) ?? fail("listing_not_found");
  if (listing.status !== "approved") fail("listing_not_approved");
  if (listing.revision_of) return applyEtsyRevision(db, listingId, deps);
  if (!listing.etsy_listing_id) await pushListingDraft(db, listingId, deps);
  const fresh = getListing(db, listingId)!;
  const shop = shopId(db);
  const updated = await etsyRequest(
    db,
    "PATCH",
    `/shops/${shop}/listings/${fresh.etsy_listing_id}`,
    { form: { state: "active" } },
    deps,
  );
  const url =
    typeof updated.url === "string" && updated.url.startsWith("https://")
      ? updated.url
      : `https://www.etsy.com/listing/${fresh.etsy_listing_id}`;
  db.prepare("UPDATE listing_packages SET etsy_state='active' WHERE id=?").run(listingId);
  return markListingPublished(db, listingId, url, deps.now?.() ?? Date.now(), { recordFee: false });
}

/**
 * Sets one price on every offering through the listing's inventory: Etsy's updateListing does not take a price.
 * A listing whose price differs by option (set on Etsy) is refused rather than flattened.
 */
async function setEtsyPrice(db: Db, etsyId: string, priceMinor: number, deps: EtsyDeps) {
  const inventory = await etsyRequest(db, "GET", `/listings/${etsyId}/inventory`, {}, deps);
  const products = Array.isArray(inventory.products) ? (inventory.products as Row[]) : [];
  if (!products.length) fail("etsy_inventory_missing");
  const onProperty = (key: string) => (Array.isArray(inventory[key]) ? (inventory[key] as number[]) : []);
  if (onProperty("price_on_property").length) fail("etsy_price_varies_by_option: change this price on Etsy");
  const price = Number((priceMinor / 100).toFixed(2));
  await etsyRequest(
    db,
    "PUT",
    `/listings/${etsyId}/inventory`,
    {
      json: {
        products: products.map((product) => ({
          sku: typeof product.sku === "string" ? product.sku : "",
          property_values: (Array.isArray(product.property_values) ? (product.property_values as Row[]) : []).map(
            (value) => ({
              property_id: value.property_id,
              value_ids: value.value_ids,
              scale_id: value.scale_id ?? null,
              property_name: value.property_name,
              values: value.values,
            }),
          ),
          offerings: (Array.isArray(product.offerings) ? (product.offerings as Row[]) : [])
            .filter((offering) => offering.is_deleted !== true)
            .map((offering) => ({
              price,
              quantity: Number(offering.quantity ?? 1),
              is_enabled: offering.is_enabled !== false,
              ...(offering.readiness_state_id ? { readiness_state_id: offering.readiness_state_id } : {}),
            })),
        })),
        price_on_property: [],
        quantity_on_property: onProperty("quantity_on_property"),
        sku_on_property: onProperty("sku_on_property"),
      },
    },
    deps,
  );
}

/**
 * Replaces a live listing's images or files with new ones without ever leaving it empty: all but one of the old
 * ones are removed, the new ones uploaded, then the last old one removed. Re-running after a failure ends in the
 * same place.
 */
async function replaceMedia(
  db: Db,
  kind: "images" | "files",
  shop: string,
  etsyId: string,
  listing: Pick<ListingPackage, "title">,
  next: string[],
  deps: EtsyDeps,
) {
  const listPath = kind === "images" ? `/listings/${etsyId}/images` : `/shops/${shop}/listings/${etsyId}/files`;
  const idKey = kind === "images" ? "listing_image_id" : "listing_file_id";
  const max = kind === "images" ? MAX_IMAGES : MAX_FILES;
  const old = results(await etsyRequest(db, "GET", listPath, {}, deps)).map((item) => String(item[idKey]));
  const keep = next.length < max ? old.slice(0, 1) : [];
  const remove = (id: string) => etsyRequest(db, "DELETE", `/shops/${shop}/listings/${etsyId}/${kind}/${id}`, {}, deps);
  for (const id of old.filter((id) => !keep.includes(id))) await remove(id);
  if (kind === "images") await uploadImages(db, shop, etsyId, listing, next, 0, deps);
  else await uploadFiles(db, shop, etsyId, next, 0, deps);
  for (const id of keep) await remove(id);
}

/**
 * Applies an approved revision to its live Etsy listing: title, description and tags through updateListing, price
 * through inventory, then images and files. Afterwards the live package holds the new content, the revision is
 * marked published, and experiment variants tied to the revision are measured from this moment.
 */
export async function applyEtsyRevision(db: Db, revisionId: string, deps: EtsyDeps = {}) {
  const revision = getListing(db, revisionId) ?? fail("listing_not_found");
  if (!revision.revision_of) fail("listing_not_revision");
  if (revision.status !== "approved") fail("listing_not_approved");
  const target = getListing(db, revision.revision_of) ?? fail("listing_not_found");
  if (!target.etsy_listing_id) fail("listing_not_revisable");
  const shop = shopId(db);
  const etsyId = target.etsy_listing_id;
  const changes = revisionChanges(revision, target);
  const needsFiles = changes.includes("images") || changes.includes("files");
  const root = needsFiles ? projectRoot(db, revision.project_id) : "";
  const images = changes.includes("images") ? revision.mockups.map((file) => projectFile(root, file)) : [];
  const files = changes.includes("files") ? revision.files.map((file) => projectFile(root, file)) : [];
  checkMediaCounts(images, files);
  const form: Record<string, string> = {};
  if (changes.includes("title")) form.title = revision.title;
  if (changes.includes("description")) form.description = revision.description;
  if (changes.includes("tags")) form.tags = revision.tags.join(",");
  if (Object.keys(form).length) {
    const updated = await etsyRequest(db, "PATCH", `/shops/${shop}/listings/${etsyId}`, { form }, deps);
    if (changes.includes("tags")) await ensureTags(db, shop, etsyId, revision.tags, updated.tags, deps);
  }
  if (changes.includes("price")) await setEtsyPrice(db, etsyId, revision.price_minor, deps);
  if (changes.includes("images")) await replaceMedia(db, "images", shop, etsyId, revision, images, deps);
  if (changes.includes("files")) await replaceMedia(db, "files", shop, etsyId, revision, files, deps);
  const now = deps.now?.() ?? Date.now();
  db.exec("SAVEPOINT etsy_revision");
  try {
    applyRevisionLocally(db, revision.id, now);
    markListingPublished(db, revision.id, target.listing_url ?? `https://www.etsy.com/listing/${etsyId}`, now, {
      recordFee: false,
    });
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='initiative_variants'").get())
      db.prepare("UPDATE initiative_variants SET started_at=? WHERE listing_id=? AND ended_at IS NULL").run(
        now,
        revision.id,
      );
    appendAutonomyLedger(
      db,
      {
        event: "etsy_revised",
        business: target.business,
        sourceId: target.id,
        message: `Changed ${changes.join(", ") || "nothing"} on Etsy listing "${target.title.slice(0, 100)}"`,
      },
      now,
    );
    db.exec("RELEASE etsy_revision");
  } catch (error) {
    db.exec("ROLLBACK TO etsy_revision; RELEASE etsy_revision");
    throw error;
  }
  return getListing(db, revision.id)!;
}

/**
 * Takes down (state inactive) the live Etsy listings of stopped initiatives, so a stopped experiment stops
 * renewing and showing. Only listings ATLAS created: an existing listing the owner brought in is never taken down.
 * Restarting the initiative does not reactivate it; the owner does that on Etsy.
 */
export async function deactivateStoppedListings(db: Db, deps: EtsyDeps = {}) {
  const shop = shopId(db);
  const rows = db
    .prepare(
      `SELECT l.id, l.etsy_listing_id, l.title, l.business, o.stop_reason FROM listing_packages l
       JOIN initiatives o ON o.id = l.initiative_id
       WHERE o.status='stopped' AND l.platform='etsy' AND l.status='published' AND l.revision_of IS NULL
         AND l.etsy_adopted=0 AND l.etsy_listing_id IS NOT NULL AND COALESCE(l.etsy_state,'active')='active'`,
    )
    .all() as Row[];
  let done = 0;
  for (const listing of rows) {
    await etsyRequest(
      db,
      "PATCH",
      `/shops/${shop}/listings/${listing.etsy_listing_id}`,
      { form: { state: "inactive" } },
      deps,
    );
    const now = deps.now?.() ?? Date.now();
    db.prepare("UPDATE listing_packages SET etsy_state='inactive', updated_at=? WHERE id=?").run(
      now,
      String(listing.id),
    );
    appendAutonomyLedger(
      db,
      {
        event: "etsy_deactivated",
        business: isBusinessKey(listing.business) ? listing.business : null,
        sourceId: String(listing.id),
        message:
          `Took down Etsy listing "${String(listing.title).slice(0, 100)}": its initiative stopped (${String(listing.stop_reason ?? "no reason")})`.slice(
            0,
            300,
          ),
      },
      now,
    );
    done++;
  }
  return done;
}

// --- Shop listings (everything in the shop, including listings ATLAS did not create) --------------------------

function parseTags(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Reads every listing in the shop (all states) into `etsy_shop_listings`, then brings ATLAS's packages in line with
 * Etsy: their Etsy state, an approved draft the owner published on Etsy becomes published, and title, description,
 * tags or price the owner changed on Etsy replace ATLAS's copy (unless an approved revision is still waiting to be
 * applied). A listing missing from a complete read is marked removed.
 */
async function syncShopListings(db: Db, shop: string, deps: EtsyDeps, now: number) {
  const seen = new Map<string, Row>();
  let complete = true;
  for (const state of ETSY_LISTING_STATES) {
    const rows = await pages(db, `/shops/${shop}/listings`, { state }, deps);
    complete &&= rows.complete;
    for (const listing of rows) {
      const id = String(listing.listing_id ?? "");
      if (id && !seen.has(id)) seen.set(id, { ...listing, state: listing.state ?? state });
    }
  }
  const upsert = db.prepare(
    `INSERT INTO etsy_shop_listings (listing_id,state,title,description,tags,price_minor,currency,url,num_favorers,quantity,
       taxonomy_id,who_made,when_made,last_modified,seen_at,views) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(listing_id) DO UPDATE SET state=excluded.state,title=excluded.title,description=excluded.description,
       tags=excluded.tags,price_minor=excluded.price_minor,currency=excluded.currency,url=excluded.url,
       num_favorers=excluded.num_favorers,views=excluded.views,quantity=excluded.quantity,taxonomy_id=excluded.taxonomy_id,
       who_made=excluded.who_made,when_made=excluded.when_made,last_modified=excluded.last_modified,seen_at=excluded.seen_at`,
  );
  const num = (value: unknown) => (Number.isFinite(Number(value)) && value !== null ? Number(value) : null);
  for (const [id, listing] of seen) {
    const price = moneyMinor(listing.price);
    upsert.run(
      id,
      String(listing.state),
      String(listing.title ?? "").slice(0, 140),
      String(listing.description ?? "").slice(0, 12000),
      JSON.stringify(Array.isArray(listing.tags) ? listing.tags.map(String).slice(0, 13) : []),
      price?.minor ?? null,
      price?.currency ?? null,
      typeof listing.url === "string" && listing.url.startsWith("https://") ? listing.url : null,
      num(listing.num_favorers),
      num(listing.quantity),
      num(listing.taxonomy_id),
      typeof listing.who_made === "string" ? listing.who_made : null,
      typeof listing.when_made === "string" ? listing.when_made : null,
      num(listing.last_modified_timestamp ?? listing.updated_timestamp),
      now,
      num(listing.views),
    );
  }
  if (complete) db.prepare("UPDATE etsy_shop_listings SET state='removed' WHERE seen_at<>?").run(now);

  let changed = 0;
  const packages = db
    .prepare(
      `SELECT id FROM listing_packages WHERE platform='etsy' AND etsy_listing_id IS NOT NULL AND revision_of IS NULL
       AND status IN ('approved','published')`,
    )
    .all() as Array<{ id: string }>;
  for (const { id } of packages) {
    const pkg = getListing(db, id)!;
    const mirror = db.prepare("SELECT * FROM etsy_shop_listings WHERE listing_id=?").get(pkg.etsy_listing_id) as
      | Row
      | undefined;
    if (!mirror || mirror.state === "removed") {
      if (complete) db.prepare("UPDATE listing_packages SET etsy_state='removed' WHERE id=?").run(id);
      continue;
    }
    db.prepare("UPDATE listing_packages SET etsy_state=? WHERE id=?").run(String(mirror.state), id);
    if (pkg.status === "approved" && mirror.state === "active") {
      markListingPublished(db, id, mirror.url ?? `https://www.etsy.com/listing/${pkg.etsy_listing_id}`, now, {
        recordFee: false,
      });
      continue;
    }
    if (pkg.status !== "published") continue;
    const waiting = db
      .prepare("SELECT 1 FROM listing_packages WHERE revision_of=? AND status='approved' LIMIT 1")
      .get(id);
    if (waiting) continue;
    const tags = parseTags(mirror.tags);
    const price = mirror.price_minor === null ? pkg.price_minor : Number(mirror.price_minor);
    const title = String(mirror.title) || pkg.title;
    const description = String(mirror.description) || pkg.description;
    const sameTags = JSON.stringify(normalTags(tags)) === JSON.stringify(normalTags(pkg.tags));
    if (title === pkg.title && description === pkg.description && sameTags && price === pkg.price_minor) continue;
    db.prepare("UPDATE listing_packages SET title=?,description=?,tags=?,price_minor=?,updated_at=? WHERE id=?").run(
      title,
      description,
      JSON.stringify(sameTags ? pkg.tags : tags),
      price,
      now,
      id,
    );
    changed++;
  }
  const active = [...seen.values()].filter((listing) => listing.state === "active");
  return { seen: seen.size, changed, active };
}

/** The shop as ATLAS last read it, with the package each listing belongs to (if any). */
export function etsyShopListings(db: Db) {
  ensureEtsySchema(db);
  const rows = db
    .prepare(
      `SELECT s.*, l.id AS package_id, l.initiative_id, l.etsy_adopted FROM etsy_shop_listings s
       LEFT JOIN listing_packages l ON l.etsy_listing_id = s.listing_id AND l.revision_of IS NULL
         AND l.status IN ('approved','published')
       ORDER BY CASE s.state WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'removed' THEN 9 ELSE 2 END, s.title
       LIMIT 500`,
    )
    .all() as Row[];
  return rows.map((row) => ({
    listing_id: String(row.listing_id),
    state: String(row.state),
    title: String(row.title),
    description: String(row.description),
    tags: parseTags(row.tags),
    price_minor: (row.price_minor as number | null) ?? null,
    currency: (row.currency as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    num_favorers: (row.num_favorers as number | null) ?? null,
    views: (row.views as number | null) ?? null,
    quantity: (row.quantity as number | null) ?? null,
    seen_at: Number(row.seen_at),
    package_id: (row.package_id as string | null) ?? null,
    initiative_id: (row.initiative_id as string | null) ?? null,
    adopted: Boolean(row.etsy_adopted),
  }));
}

/**
 * Owner: brings an existing shop listing into ATLAS as a published package, optionally tied to an initiative so its
 * sales and favorites count there and agents can propose revisions of it. Its images and files stay on Etsy.
 */
export function adoptEtsyListing(db: Db, etsyListingId: string, input: Row = {}, now = Date.now()) {
  ensureEtsySchema(db);
  const mirror =
    (db.prepare("SELECT * FROM etsy_shop_listings WHERE listing_id=?").get(etsyListingId) as Row | undefined) ??
    fail("etsy_listing_not_found");
  if (mirror.state === "removed") fail("etsy_listing_removed");
  const existing = db
    .prepare(
      "SELECT id FROM listing_packages WHERE etsy_listing_id=? AND revision_of IS NULL AND status IN ('approved','published')",
    )
    .get(etsyListingId);
  if (existing) fail("etsy_listing_already_in_atlas");
  const business = String(row(db).business);
  let initiativeId: string | null = null;
  let projectId: string | null = null;
  if (input.initiative_id !== undefined && input.initiative_id !== null && input.initiative_id !== "") {
    const initiative = db
      .prepare("SELECT id, business, project_id FROM initiatives WHERE id=?")
      .get(String(input.initiative_id)) as Row | undefined;
    if (!initiative || initiative.business !== business) fail("invalid_initiative_id");
    initiativeId = String(initiative.id);
    projectId = (initiative.project_id as string | null) ?? null;
  }
  const id = randomUUID();
  const whoMade = (ETSY_WHO_MADE as readonly unknown[]).includes(mirror.who_made) ? String(mirror.who_made) : "i_did";
  const whenMade = (ETSY_WHEN_MADE as readonly unknown[]).includes(mirror.when_made)
    ? String(mirror.when_made)
    : "made_to_order";
  db.prepare(
    `INSERT INTO listing_packages (id,business,platform,project_id,initiative_id,title,description,tags,price_minor,currency,
      files,mockups,notes,fee_minor,fee_currency,status,listing_url,decided_by,decision_reason,submitted_at,decided_at,
      published_at,created_at,updated_at,taxonomy_id,who_made,when_made,etsy_listing_id,etsy_state,etsy_adopted)
     VALUES (?,?,'etsy',?,?,?,?,?,?,?,'[]','[]','',0,'USD','published',?,'owner','Brought in from the Etsy shop',?,?,?,?,?,?,?,?,?,?,1)`,
  ).run(
    id,
    business,
    projectId,
    initiativeId,
    String(mirror.title) || `Etsy listing ${etsyListingId}`,
    String(mirror.description),
    String(mirror.tags ?? "[]"),
    Number(mirror.price_minor ?? 0),
    String(mirror.currency ?? "USD"),
    (mirror.url as string | null) ?? `https://www.etsy.com/listing/${etsyListingId}`,
    now,
    now,
    now,
    now,
    now,
    (mirror.taxonomy_id as number | null) ?? null,
    whoMade,
    whenMade,
    etsyListingId,
    String(mirror.state),
  );
  if (initiativeId && mirror.state === "active") markInitiativeLaunched(db, initiativeId, now);
  return getListing(db, id)!;
}

// --- Sync --------------------------------------------------------------------------------------------------------

function moneyMinor(value: unknown): { minor: number; currency: string } | null {
  if (!value || typeof value !== "object") return null;
  const money = value as Row;
  const amount = Number(money.amount);
  const divisor = Number(money.divisor) || 100;
  const currency = typeof money.currency_code === "string" ? money.currency_code : "USD";
  if (!Number.isFinite(amount)) return null;
  return { minor: Math.round((amount / divisor) * 100), currency };
}

function initiativeForEtsyListing(db: Db, etsyListingId: unknown): string | null {
  if (etsyListingId === undefined || etsyListingId === null) return null;
  const found = db
    .prepare("SELECT initiative_id FROM listing_packages WHERE etsy_listing_id=? AND initiative_id IS NOT NULL LIMIT 1")
    .get(String(etsyListingId)) as Row | undefined;
  return (found?.initiative_id as string | undefined) ?? null;
}

/** Payment-ledger entries: which ones are costs. Payouts and sale credits are skipped (sales come from receipts). */
export function classifyLedgerEntry(entry: Row): "fee" | "refund" | null {
  const amount = Number(entry.amount);
  const kind = `${entry.ledger_type ?? ""} ${entry.description ?? ""} ${entry.reference_type ?? ""}`.toLowerCase();
  if (!Number.isFinite(amount) || amount >= 0) return null;
  if (/disburse|deposit|payout|transfer|withdraw/.test(kind)) return null;
  if (/refund/.test(kind)) return "refund";
  return "fee";
}

async function pages(
  db: Db,
  apiPath: string,
  query: Record<string, string | number | boolean>,
  deps: EtsyDeps,
): Promise<Row[] & { complete: boolean }> {
  const out = Object.assign([] as Row[], { complete: false });
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await etsyRequest(db, "GET", apiPath, { query: { ...query, limit: PAGE, offset: page * PAGE } }, deps);
    const results = Array.isArray(body.results) ? (body.results as Row[]) : [];
    out.push(...results);
    if (results.length < PAGE) {
      out.complete = true;
      break;
    }
  }
  return out;
}

/**
 * Etsy refuses a min_created..max_created span over 31 days (2678400 s); ATLAS asks for at most 30 days at a time.
 * The same windows are used for receipts (by last-modified time) so no list request is unbounded.
 */
export const ETSY_WINDOW_S = 30 * 86_400;
/** Each sync re-reads this much before the saved checkpoint, for records Etsy shows a little late. */
export const ETSY_OVERLAP_S = 3600;
/** The longest history an owner can ask to re-read. */
export const ETSY_MAX_HISTORY_DAYS = 3 * 365;
const MIN_WINDOW_S = 3600;

/**
 * Reads a time-filtered list from `from` to `to` (Unix seconds) in consecutive windows Etsy accepts, every page of
 * each. A window with more rows than ATLAS pages through (2,000) is split in half until it fits, so nothing is
 * cut off. `handle` gets each completed window's rows and its end, so the caller can save a checkpoint there:
 * a failure part way resumes at the last completed window.
 */
async function forEachWindow(
  db: Db,
  apiPath: string,
  keys: { min: string; max: string },
  range: { from: number; to: number },
  extra: Record<string, string | number | boolean>,
  deps: EtsyDeps,
  handle: (rows: Row[], windowEnd: number) => void,
): Promise<void> {
  let start = range.from;
  while (start < range.to) {
    let end = Math.min(start + ETSY_WINDOW_S, range.to);
    for (;;) {
      const rows = await pages(db, apiPath, { ...extra, [keys.min]: start, [keys.max]: end }, deps);
      if (rows.complete) {
        handle(rows, end);
        break;
      }
      if (end - start <= MIN_WINDOW_S) fail(`etsy_window_too_dense: more than ${MAX_PAGES * PAGE} records in one hour`);
      end = start + Math.floor((end - start) / 2);
    }
    start = end;
  }
}

export interface EtsySyncOptions {
  /** Re-read this many days of orders and payment records instead of starting from the saved checkpoints. */
  historyDays?: number;
}

/**
 * Paid orders into verified revenue, fees and refunds into expenses, favorites into experiment metrics.
 *
 * Orders and payment records are read from a saved checkpoint (minus a one-hour overlap) up to now, in windows of
 * at most 30 days, every page of each. The checkpoint moves forward after each completed window and never moves
 * back. Records seen twice (overlap, window edges, a repeated sync) are written once: they are keyed by Etsy's own
 * receipt and ledger-entry ids, both here and in the ledger.
 */
export async function syncEtsy(db: Db, deps: EtsyDeps = {}, options: EtsySyncOptions = {}) {
  const now = deps.now?.() ?? Date.now();
  const r = row(db);
  const shop = shopId(db);
  const business = (isBusinessKey(r.business) ? r.business : "ventures") as BusinessKey;
  const nowS = Math.floor(now / 1000);
  const counts = { receipts: 0, fees: 0, refunds: 0, listings: 0, shop_listings: 0, changed_on_etsy: 0, windows: 0 };
  let historyFrom: number | null = null;
  if (options.historyDays !== undefined) {
    const days = options.historyDays;
    if (!Number.isSafeInteger(days) || days < 1 || days > ETSY_MAX_HISTORY_DAYS) fail("invalid_history_days");
    historyFrom = nowS - days * 86_400;
  }
  const startFrom = (checkpoint: unknown) =>
    historyFrom ??
    (checkpoint === null || checkpoint === undefined
      ? nowS - FIRST_SYNC_LOOKBACK_S
      : Math.min(nowS, Number(checkpoint)) - ETSY_OVERLAP_S);
  const saveCheckpoint = (column: "receipts_after" | "ledger_after", end: number) =>
    db
      .prepare(`UPDATE etsy_connection SET ${column}=MAX(COALESCE(${column}, 0), ?), updated_at=? WHERE id=1`)
      .run(end, now);
  try {
    const seenReceipts = new Set<string>();
    const salesByInitiative = new Map<string, { sales: number; revenue: number; currency: string; listing: string }>();
    await forEachWindow(
      db,
      `/shops/${shop}/receipts`,
      { min: "min_last_modified", max: "max_last_modified" },
      { from: startFrom(r.receipts_after), to: nowS },
      { sort_on: "updated", sort_order: "asc" },
      deps,
      (receipts, windowEnd) => {
        counts.windows++;
        for (const receipt of receipts) {
          const receiptId = String(receipt.receipt_id ?? "");
          if (!receiptId || seenReceipts.has(receiptId)) continue;
          seenReceipts.add(receiptId);
          const subtotal = moneyMinor(receipt.subtotal) ?? moneyMinor(receipt.total_price);
          if (!subtotal) continue;
          const canceled = String(receipt.status ?? "").toLowerCase() === "canceled";
          const paid = receipt.is_paid === true && !canceled;
          const transactions = Array.isArray(receipt.transactions) ? (receipt.transactions as Row[]) : [];
          const initiativeId =
            transactions.map((t) => initiativeForEtsyListing(db, t.listing_id)).find(Boolean) ?? null;
          upsertProviderLedgerEntry(
            db,
            {
              business,
              kind: "revenue",
              amount_minor: paid ? Math.max(0, subtotal.minor) : 0,
              currency: subtotal.currency,
              source: "etsy_receipt",
              external_id: `etsy:${shop}:receipt:${receiptId}`,
              verified: paid,
              description:
                `Etsy order ${receiptId}${canceled ? " (canceled)" : paid ? "" : " (not paid yet)"}: ${transactions
                  .map((t) => String(t.title ?? ""))
                  .join(", ")}`.slice(0, 300),
              occurred_at: Number(receipt.created_timestamp ?? nowS) * 1000,
              initiative_id: initiativeId,
            },
            now,
          );
          counts.receipts++;
          if (initiativeId && paid) {
            const entry = salesByInitiative.get(initiativeId) ?? {
              sales: 0,
              revenue: 0,
              currency: subtotal.currency,
              listing: String(transactions[0]?.listing_id ?? ""),
            };
            entry.sales += transactions.reduce((sum, t) => sum + Number(t.quantity ?? 1), 0) || 1;
            entry.revenue += subtotal.minor;
            salesByInitiative.set(initiativeId, entry);
          }
        }
        saveCheckpoint("receipts_after", windowEnd);
      },
    );
    const seenEntries = new Set<string>();
    await forEachWindow(
      db,
      `/shops/${shop}/payment-account/ledger-entries`,
      { min: "min_created", max: "max_created" },
      { from: startFrom(r.ledger_after), to: nowS },
      {},
      deps,
      (entries, windowEnd) => {
        counts.windows++;
        for (const entry of entries) {
          const entryId = String(entry.entry_id ?? "");
          if (!entryId || seenEntries.has(entryId)) continue;
          seenEntries.add(entryId);
          const type = classifyLedgerEntry(entry);
          if (!type) continue;
          const initiativeId = String(entry.reference_type ?? "")
            .toLowerCase()
            .includes("listing")
            ? initiativeForEtsyListing(db, entry.reference_id)
            : null;
          upsertProviderLedgerEntry(
            db,
            {
              business,
              kind: "expense",
              amount_minor: Math.abs(Math.round(Number(entry.amount))),
              currency: typeof entry.currency === "string" ? entry.currency : "USD",
              source: type === "refund" ? "etsy_refund" : "etsy_fee",
              external_id: `etsy:${shop}:ledger:${entryId}`,
              verified: true,
              description: `Etsy ${type === "refund" ? "refund" : "fee"}: ${String(entry.description ?? entry.ledger_type ?? "").slice(0, 200)}`,
              occurred_at: Number(entry.created_timestamp ?? entry.create_date ?? nowS) * 1000,
              initiative_id: initiativeId,
            },
            now,
          );
          counts[type === "refund" ? "refunds" : "fees"]++;
        }
        saveCheckpoint("ledger_after", windowEnd);
      },
    );
    const shopSync = await syncShopListings(db, shop, deps, now);
    // The shop itself (title, announcement, logo and banner present, sections), for the shop setup step.
    await refreshShopProfile(db, deps).catch(() => null);
    counts.shop_listings = shopSync.seen;
    counts.changed_on_etsy = shopSync.changed;
    for (const listing of shopSync.active) {
      const initiativeId = initiativeForEtsyListing(db, listing.listing_id);
      if (!initiativeId) continue;
      const sales = salesByInitiative.get(initiativeId);
      recordInitiativeMetric(
        db,
        {
          initiative_id: initiativeId,
          listing_id: String(listing.listing_id),
          favorers: Number.isFinite(Number(listing.num_favorers)) ? Number(listing.num_favorers) : null,
          views: Number.isFinite(Number(listing.views)) && listing.views !== null ? Number(listing.views) : null,
          sales: sales?.sales ?? 0,
          revenue_minor: sales?.revenue ?? 0,
          currency: sales?.currency ?? null,
        },
        now,
      );
      counts.listings++;
    }
    db.prepare("UPDATE etsy_connection SET last_sync_at=?, last_sync_error=NULL, updated_at=? WHERE id=1").run(
      now,
      now,
    );
  } catch (error) {
    db.prepare("UPDATE etsy_connection SET last_sync_error=?, updated_at=? WHERE id=1").run(
      (error instanceof Error ? error.message : "etsy_sync_failed").slice(0, 300),
      now,
    );
    throw error;
  }
  return counts;
}

/**
 * The background job: pushes approved Etsy packages as drafts, publishes them when the owner turned on
 * auto-publish, then syncs money. Does nothing unless connected and sync is on.
 */
export async function runEtsyTick(db: Db, deps: EtsyDeps = {}): Promise<void> {
  const settings = etsySettings(db);
  if (!settings.connected || !settings.sync_enabled) return;
  const now = deps.now?.() ?? Date.now();
  if (etsyQuotaLow(db, now)) {
    db.prepare("UPDATE etsy_connection SET last_sync_error=? WHERE id=1").run(
      `Paused: Etsy's daily request allowance is nearly used (${settings.rate_remaining_today} left). Sync resumes as it refills.`,
    );
    return;
  }
  // Nothing new goes out for an initiative that has been stopped.
  const approved = db
    .prepare(
      `SELECT l.id, l.etsy_listing_id, l.revision_of FROM listing_packages l
       LEFT JOIN initiatives o ON o.id = l.initiative_id
       WHERE l.platform='etsy' AND l.status='approved' AND COALESCE(o.status,'') <> 'stopped' ORDER BY l.decided_at`,
    )
    .all() as Row[];
  const failures: string[] = [];
  for (const listing of approved) {
    try {
      // An approved revision changes a listing that is already live, so it is applied whether or not auto-publish is on.
      if (listing.revision_of) await applyEtsyRevision(db, String(listing.id), deps);
      else if (settings.auto_publish) await publishEtsyListing(db, String(listing.id), deps);
      else if (!listing.etsy_listing_id) await pushListingDraft(db, String(listing.id), deps);
    } catch (error) {
      failures.push(
        `listing ${String(listing.id).slice(0, 8)}: ${(error instanceof Error ? error.message : "push failed").slice(0, 250)}`,
      );
    }
  }
  try {
    await applyApprovedShopChanges(db, deps);
  } catch (error) {
    failures.push(`shop: ${(error instanceof Error ? error.message : "failed").slice(0, 250)}`);
  }
  try {
    await deactivateStoppedListings(db, deps);
  } catch (error) {
    failures.push(`deactivate: ${(error instanceof Error ? error.message : "failed").slice(0, 250)}`);
  }
  await syncEtsy(db, deps);
  // syncEtsy clears the error on success; listing problems found above stay visible until the next clean tick.
  if (failures.length)
    db.prepare("UPDATE etsy_connection SET last_sync_error=? WHERE id=1").run(failures.join(" | ").slice(0, 300));
}
