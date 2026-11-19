import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret } from "../oauth/helpers.ts";
import { isBusinessKey, type BusinessKey } from "./businesses.ts";
import { recordOpportunityMetric } from "./experiments.ts";
import { upsertProviderLedgerEntry } from "./finance-store.ts";
import { ensureListingSchema, getListing, markListingPublished } from "./listings.ts";

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
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export const ETSY_API = "https://api.etsy.com/v3/application";
export const ETSY_AUTHORIZE_URL = "https://www.etsy.com/oauth/connect";
export const ETSY_TOKEN_URL = "https://api.etsy.com/v3/public/oauth/token";
export const ETSY_SCOPES = ["listings_r", "listings_w", "shops_r", "transactions_r"] as const;
export const ETSY_SYNC_INTERVAL_MS = 30 * 60_000;
const AUTH_TTL_MS = 15 * 60_000;
const REFRESH_EARLY_MS = 2 * 60_000;
const PAGE = 100;
const MAX_PAGES = 20;
const FIRST_SYNC_LOOKBACK_S = 90 * 86_400;

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
  INSERT OR IGNORE INTO etsy_connection(id) VALUES (1);`);
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
  };
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
  db.prepare(
    "UPDATE etsy_connection SET auth_state=NULL, auth_verifier_enc=NULL, auth_started_at=NULL WHERE id=1",
  ).run();
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
  form?: Record<string, string>;
  multipart?: FormData;
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
      body = new URLSearchParams(req.form).toString();
    } else if (req.multipart) body = req.multipart; // fetch sets the multipart boundary itself
    const response = await (deps.fetch ?? fetch)(url, { method, headers, body, signal: AbortSignal.timeout(60_000) });
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

/**
 * Creates the Etsy draft for an approved package: listing, then images, then the digital files, then `type=download`.
 * A draft is not public. Re-running after a partial failure continues on the same Etsy listing.
 */
export async function pushListingDraft(db: Db, listingId: string, deps: EtsyDeps = {}) {
  const listing = getListing(db, listingId) ?? fail("listing_not_found");
  if (listing.platform !== "etsy") fail("listing_not_etsy");
  if (listing.status !== "approved") fail("listing_not_approved");
  if (!listing.taxonomy_id) fail("listing_taxonomy_required");
  const shop = shopId(db);
  const root = projectRoot(db, listing.project_id);
  const images = listing.mockups.map((file) => projectFile(root, file));
  const files = listing.files.map((file) => projectFile(root, file));
  let etsyId = listing.etsy_listing_id;
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
    db.prepare("UPDATE listing_packages SET etsy_listing_id=?, updated_at=? WHERE id=?").run(
      etsyId,
      deps.now?.() ?? Date.now(),
      listing.id,
    );
    for (const [index, file] of images.entries()) {
      const form = new FormData();
      form.append("image", new Blob([fs.readFileSync(file)]), path.basename(file));
      form.append("rank", String(index + 1));
      await etsyRequest(db, "POST", `/shops/${shop}/listings/${etsyId}/images`, { multipart: form }, deps);
    }
    for (const [index, file] of files.entries()) {
      const form = new FormData();
      form.append("file", new Blob([fs.readFileSync(file)]), path.basename(file));
      form.append("name", path.basename(file));
      form.append("rank", String(index + 1));
      await etsyRequest(db, "POST", `/shops/${shop}/listings/${etsyId}/files`, { multipart: form }, deps);
    }
  }
  return getListing(db, listing.id)!;
}

/** Makes the Etsy draft public (Etsy charges its listing fee) and marks the package published. */
export async function publishEtsyListing(db: Db, listingId: string, deps: EtsyDeps = {}) {
  const listing = getListing(db, listingId) ?? fail("listing_not_found");
  if (listing.status !== "approved") fail("listing_not_approved");
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
  return markListingPublished(db, listingId, url, deps.now?.() ?? Date.now(), { recordFee: false });
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

function opportunityForEtsyListing(db: Db, etsyListingId: unknown): string | null {
  if (etsyListingId === undefined || etsyListingId === null) return null;
  const found = db
    .prepare(
      "SELECT opportunity_id FROM listing_packages WHERE etsy_listing_id=? AND opportunity_id IS NOT NULL LIMIT 1",
    )
    .get(String(etsyListingId)) as Row | undefined;
  return (found?.opportunity_id as string | undefined) ?? null;
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
): Promise<Row[]> {
  const out: Row[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = await etsyRequest(db, "GET", apiPath, { query: { ...query, limit: PAGE, offset: page * PAGE } }, deps);
    const results = Array.isArray(body.results) ? (body.results as Row[]) : [];
    out.push(...results);
    if (results.length < PAGE) break;
  }
  return out;
}

/** Paid orders into verified revenue, fees and refunds into expenses, favorites into experiment metrics. */
export async function syncEtsy(db: Db, deps: EtsyDeps = {}) {
  const now = deps.now?.() ?? Date.now();
  const r = row(db);
  const shop = shopId(db);
  const business = (isBusinessKey(r.business) ? r.business : "ventures") as BusinessKey;
  const nowS = Math.floor(now / 1000);
  const counts = { receipts: 0, fees: 0, refunds: 0, listings: 0 };
  try {
    const receiptsAfter = Number(r.receipts_after ?? nowS - FIRST_SYNC_LOOKBACK_S);
    const receipts = await pages(
      db,
      `/shops/${shop}/receipts`,
      { min_last_modified: receiptsAfter, sort_on: "updated", sort_order: "asc" },
      deps,
    );
    const salesByOpportunity = new Map<string, { sales: number; revenue: number; currency: string; listing: string }>();
    for (const receipt of receipts) {
      const subtotal = moneyMinor(receipt.subtotal) ?? moneyMinor(receipt.total_price);
      if (!subtotal) continue;
      const canceled = String(receipt.status ?? "").toLowerCase() === "canceled";
      const paid = receipt.is_paid === true && !canceled;
      const transactions = Array.isArray(receipt.transactions) ? (receipt.transactions as Row[]) : [];
      const opportunityId = transactions.map((t) => opportunityForEtsyListing(db, t.listing_id)).find(Boolean) ?? null;
      upsertProviderLedgerEntry(
        db,
        {
          business,
          kind: "revenue",
          amount_minor: paid ? Math.max(0, subtotal.minor) : 0,
          currency: subtotal.currency,
          source: "etsy_receipt",
          external_id: `etsy:${shop}:receipt:${receipt.receipt_id}`,
          verified: paid,
          description:
            `Etsy order ${receipt.receipt_id}${canceled ? " (canceled)" : paid ? "" : " (not paid yet)"}: ${transactions
              .map((t) => String(t.title ?? ""))
              .join(", ")}`.slice(0, 300),
          occurred_at: Number(receipt.created_timestamp ?? nowS) * 1000,
          opportunity_id: opportunityId,
        },
        now,
      );
      counts.receipts++;
      if (opportunityId && paid) {
        const entry = salesByOpportunity.get(opportunityId) ?? {
          sales: 0,
          revenue: 0,
          currency: subtotal.currency,
          listing: String(transactions[0]?.listing_id ?? ""),
        };
        entry.sales += transactions.reduce((sum, t) => sum + Number(t.quantity ?? 1), 0) || 1;
        entry.revenue += subtotal.minor;
        salesByOpportunity.set(opportunityId, entry);
      }
    }
    const ledgerAfter = Number(r.ledger_after ?? nowS - FIRST_SYNC_LOOKBACK_S);
    const entries = await pages(
      db,
      `/shops/${shop}/payment-account/ledger-entries`,
      { min_created: ledgerAfter, max_created: nowS },
      deps,
    );
    for (const entry of entries) {
      const type = classifyLedgerEntry(entry);
      if (!type) continue;
      const opportunityId = String(entry.reference_type ?? "")
        .toLowerCase()
        .includes("listing")
        ? opportunityForEtsyListing(db, entry.reference_id)
        : null;
      upsertProviderLedgerEntry(
        db,
        {
          business,
          kind: "expense",
          amount_minor: Math.abs(Math.round(Number(entry.amount))),
          currency: typeof entry.currency === "string" ? entry.currency : "USD",
          source: type === "refund" ? "etsy_refund" : "etsy_fee",
          external_id: `etsy:${shop}:ledger:${entry.entry_id}`,
          verified: true,
          description: `Etsy ${type === "refund" ? "refund" : "fee"}: ${String(entry.description ?? entry.ledger_type ?? "").slice(0, 200)}`,
          occurred_at: Number(entry.created_timestamp ?? entry.create_date ?? nowS) * 1000,
          opportunity_id: opportunityId,
        },
        now,
      );
      counts[type === "refund" ? "refunds" : "fees"]++;
    }
    const listings = await pages(db, `/shops/${shop}/listings`, { state: "active" }, deps);
    for (const listing of listings) {
      const opportunityId = opportunityForEtsyListing(db, listing.listing_id);
      if (!opportunityId) continue;
      const sales = salesByOpportunity.get(opportunityId);
      recordOpportunityMetric(
        db,
        {
          opportunity_id: opportunityId,
          listing_id: String(listing.listing_id),
          favorers: Number.isFinite(Number(listing.num_favorers)) ? Number(listing.num_favorers) : null,
          sales: sales?.sales ?? 0,
          revenue_minor: sales?.revenue ?? 0,
          currency: sales?.currency ?? null,
        },
        now,
      );
      counts.listings++;
    }
    db.prepare(
      "UPDATE etsy_connection SET receipts_after=?, ledger_after=?, last_sync_at=?, last_sync_error=NULL, updated_at=? WHERE id=1",
    ).run(Math.max(receiptsAfter, nowS - 3600), nowS - 3600, now, now);
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
  const approved = db
    .prepare(
      "SELECT id, etsy_listing_id FROM listing_packages WHERE platform='etsy' AND status='approved' ORDER BY decided_at",
    )
    .all() as Row[];
  for (const listing of approved) {
    try {
      if (settings.auto_publish) await publishEtsyListing(db, String(listing.id), deps);
      else if (!listing.etsy_listing_id) await pushListingDraft(db, String(listing.id), deps);
    } catch (error) {
      db.prepare("UPDATE etsy_connection SET last_sync_error=? WHERE id=1").run(
        `listing ${String(listing.id).slice(0, 8)}: ${(error instanceof Error ? error.message : "push failed").slice(0, 250)}`,
      );
    }
  }
  await syncEtsy(db, deps);
}
