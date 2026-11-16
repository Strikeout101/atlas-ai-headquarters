import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { encryptSecret, decryptSecret } from "../oauth/helpers.ts";
import { isBusinessKey } from "./businesses.ts";
import { ensureFinanceSchema, reconcilePaidDeals } from "./finance-store.ts";

export const SQUARE_API_VERSION = "2026-09-16";
export const SQUARE_SYNC_INTERVAL_MS = 15 * 60_000;
const ORIGINS = { production: "https://connect.squareup.com", sandbox: "https://connect.squareupsandbox.com" } as const;
const PROCESSED_SOURCES = new Set(["CARD", "BANK_ACCOUNT", "WALLET", "BUY_NOW_PAY_LATER", "SQUARE_ACCOUNT"]);
const active = new WeakSet<DatabaseSync>();
type Row = Record<string, any>;
export interface SquareDeps {
  fetch?: typeof fetch;
  now?: () => number;
  maxPages?: number;
}

export function ensureSquareSchema(db: DatabaseSync): void {
  ensureFinanceSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS square_connection (
    id INTEGER PRIMARY KEY CHECK(id=1), environment TEXT NOT NULL DEFAULT 'production' CHECK(environment IN ('production','sandbox')),
    token_enc TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    history_since TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, locations_json TEXT NOT NULL DEFAULT '[]',
    last_test_at INTEGER, last_sync_at INTEGER, last_sync_error TEXT, watermark TEXT, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS square_location_mappings (business TEXT PRIMARY KEY,location_id TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS square_receipts (
    environment TEXT NOT NULL,payment_id TEXT NOT NULL,business TEXT NOT NULL,location_id TEXT NOT NULL,
    status TEXT NOT NULL,source_type TEXT NOT NULL,currency TEXT NOT NULL,gross_minor INTEGER NOT NULL,
    refunded_minor INTEGER NOT NULL,net_minor INTEGER NOT NULL,fee_minor INTEGER NOT NULL,fee_known INTEGER NOT NULL,
    provider_updated_at INTEGER NOT NULL,occurred_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    PRIMARY KEY(environment,payment_id)
  );`);
  const now = Date.now();
  db.prepare("INSERT OR IGNORE INTO square_connection(id,history_since,updated_at) VALUES(1,?,?)").run(
    new Date(now - 365 * 86400000).toISOString(),
    now,
  );
}
function connection(db: DatabaseSync): Row {
  return db.prepare("SELECT * FROM square_connection WHERE id=1").get() as Row;
}
function mappings(db: DatabaseSync): Row[] {
  return db.prepare("SELECT business,location_id FROM square_location_mappings ORDER BY business").all();
}
export function squareSettings(db: DatabaseSync) {
  ensureSquareSchema(db);
  const row = connection(db);
  return {
    environment: row.environment,
    token_configured: Boolean(row.token_enc),
    enabled: Boolean(row.enabled),
    history_since: row.history_since,
    locations: JSON.parse(row.locations_json),
    mappings: mappings(db),
    last_test_at: row.last_test_at,
    last_sync_at: row.last_sync_at,
    last_sync_error: row.last_sync_error,
    watermark: row.watermark,
    fee_unknown: Number((db.prepare("SELECT COUNT(*) AS n FROM square_receipts WHERE fee_known=0").get() as Row).n),
  };
}
function iso(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("square_invalid_history_since");
  return new Date(value).toISOString();
}
export function saveSquareSettings(db: DatabaseSync, input: Record<string, unknown>, now = Date.now()) {
  ensureSquareSchema(db);
  const before = connection(db);
  const environment = input.environment ?? before.environment;
  if (environment !== "production" && environment !== "sandbox") throw new Error("square_invalid_environment");
  if ("enabled" in input && typeof input.enabled !== "boolean") throw new Error("square_invalid_enabled");
  if ("clear_token" in input && typeof input.clear_token !== "boolean") throw new Error("square_invalid_clear_token");
  if ("token" in input && (typeof input.token !== "string" || input.token.length > 4096))
    throw new Error("square_invalid_token");
  const plaintext = typeof input.token === "string" ? input.token.trim() : "";
  if (plaintext && /\s/.test(plaintext)) throw new Error("square_invalid_token");
  const token = input.clear_token === true ? "" : plaintext ? encryptSecret(plaintext) : before.token_enc;
  const changed = environment !== before.environment || token !== before.token_enc;
  const since = "history_since" in input ? iso(input.history_since) : before.history_since;
  if (Date.parse(since) > now || Date.parse(since) < Date.parse("1970-01-01T00:00:00Z"))
    throw new Error("square_invalid_history_since");
  if (
    db
      .prepare("SELECT 1 FROM square_receipts WHERE environment=? AND occurred_at<? LIMIT 1")
      .get(environment, Date.parse(since))
  )
    throw new Error("square_history_would_exclude_imported_receipts");
  const enabled = changed ? false : (input.enabled ?? Boolean(before.enabled));
  if (enabled && (!token || !JSON.parse(before.locations_json).length || !mappings(db).length))
    throw new Error("square_test_and_map_before_enabling");
  db.exec("SAVEPOINT square_settings");
  try {
    db.prepare(
      `UPDATE square_connection SET environment=?,token_enc=?,enabled=?,history_since=?,revision=revision+1,
      locations_json=?,last_test_at=?,watermark=?,last_sync_error=NULL,updated_at=? WHERE id=1`,
    ).run(
      environment,
      token,
      enabled ? 1 : 0,
      since,
      changed ? "[]" : before.locations_json,
      changed ? null : before.last_test_at,
      changed || since !== before.history_since ? null : before.watermark,
      now,
    );
    if (changed) db.exec("DELETE FROM square_location_mappings");
    db.exec("RELEASE square_settings");
  } catch (error) {
    db.exec("ROLLBACK TO square_settings; RELEASE square_settings");
    throw error;
  }
  return squareSettings(db);
}
export function saveSquareMappings(db: DatabaseSync, input: unknown, now = Date.now()) {
  ensureSquareSchema(db);
  const row = connection(db),
    known = JSON.parse(row.locations_json) as Row[];
  if (!Array.isArray(input) || input.length > 3) throw new Error("square_invalid_mappings");
  const businesses = new Set<string>(),
    locations = new Set<string>();
  for (const map of input) {
    if (
      !map ||
      !isBusinessKey(map.business) ||
      typeof map.location_id !== "string" ||
      !known.some((l) => l.id === map.location_id) ||
      businesses.has(map.business) ||
      locations.has(map.location_id)
    )
      throw new Error("square_invalid_mappings");
    const prior = db
      .prepare("SELECT business FROM square_receipts WHERE environment=? AND location_id=? AND business<>? LIMIT 1")
      .get(row.environment, map.location_id, map.business);
    if (prior) throw new Error("square_location_history_business_locked");
    businesses.add(map.business);
    locations.add(map.location_id);
  }
  db.exec("SAVEPOINT square_mappings");
  try {
    db.exec("DELETE FROM square_location_mappings");
    for (const map of input)
      db.prepare("INSERT INTO square_location_mappings(business,location_id) VALUES(?,?)").run(
        map.business,
        map.location_id,
      );
    db.prepare(
      "UPDATE square_connection SET revision=revision+1,watermark=NULL,enabled=CASE WHEN ?=0 THEN 0 ELSE enabled END,updated_at=? WHERE id=1",
    ).run(input.length, now);
    db.exec("RELEASE square_mappings");
  } catch (error) {
    db.exec("ROLLBACK TO square_mappings; RELEASE square_mappings");
    throw error;
  }
  return squareSettings(db);
}
async function readSquare(
  config: Row,
  pathname: "/v2/locations" | "/v2/payments",
  query: URLSearchParams,
  deps: SquareDeps,
): Promise<Row> {
  const url = new URL(pathname, ORIGINS[config.environment as keyof typeof ORIGINS]);
  url.search = query.toString();
  const response = await (deps.fetch ?? fetch)(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${decryptSecret(config.token_enc)}`, "Square-Version": SQUARE_API_VERSION },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`square_http_${response.status}`);
  const data = (await response.json()) as Row;
  if (!data || typeof data !== "object" || Array.isArray(data) || (Array.isArray(data.errors) && data.errors.length))
    throw new Error("square_invalid_response");
  return data;
}
function assertCurrent(db: DatabaseSync, config: Row) {
  if (connection(db).revision !== config.revision) throw new Error("square_configuration_changed");
}
export async function testSquareConnection(db: DatabaseSync, deps: SquareDeps = {}) {
  ensureSquareSchema(db);
  const row = connection(db);
  if (!row.token_enc) throw new Error("square_token_required");
  const data = await readSquare(row, "/v2/locations", new URLSearchParams(), deps);
  if (!Array.isArray(data.locations)) throw new Error("square_invalid_locations");
  const seen = new Set<string>();
  const locations = data.locations.map((location: Row) => {
    if (
      typeof location.id !== "string" ||
      !location.id ||
      seen.has(location.id) ||
      typeof location.currency !== "string" ||
      !/^[A-Z]{3}$/.test(location.currency)
    )
      throw new Error("square_invalid_locations");
    seen.add(location.id);
    return {
      id: location.id,
      name: typeof location.name === "string" ? location.name.slice(0, 200) : location.id,
      currency: location.currency,
      status: location.status === "ACTIVE" ? "ACTIVE" : "INACTIVE",
    };
  });
  assertCurrent(db, row);
  db.prepare("UPDATE square_connection SET locations_json=?,last_test_at=?,revision=revision+1 WHERE id=1").run(
    JSON.stringify(locations),
    deps.now?.() ?? Date.now(),
  );
  return squareSettings(db);
}
function money(value: unknown, currency?: string, allowNegative = false): { amount: number; currency: string } {
  const row = value as Row;
  if (
    !row ||
    !Number.isSafeInteger(row.amount) ||
    (!allowNegative && row.amount < 0) ||
    typeof row.currency !== "string" ||
    !/^[A-Z]{3}$/.test(row.currency) ||
    (currency && row.currency !== currency)
  )
    throw new Error("square_invalid_money");
  return { amount: row.amount, currency: row.currency };
}
function normalizePayment(payment: Row, map: Row, config: Row, known: Row[], now: number, prior?: Row): Row {
  if (
    typeof payment.id !== "string" ||
    !payment.id ||
    payment.id.length > 192 ||
    payment.location_id !== map.location_id ||
    typeof payment.status !== "string"
  )
    throw new Error("square_invalid_payment");
  const updated = Date.parse(payment.updated_at),
    occurred = Date.parse(payment.created_at);
  if (!Number.isFinite(updated) || !Number.isFinite(occurred) || updated > now + 60000)
    throw new Error("square_invalid_payment_time");
  const location = known.find((l) => l.id === map.location_id);
  if (!location) throw new Error("square_unknown_location");
  const total = money(
    payment.total_money ?? { amount: prior?.gross_minor ?? 0, currency: prior?.currency ?? location.currency },
    location.currency,
  );
  if (payment.status === "COMPLETED" && !payment.total_money) throw new Error("square_invalid_money");
  const refund = payment.refunded_money ? money(payment.refunded_money, total.currency).amount : 0;
  if (refund > total.amount) throw new Error("square_invalid_refund");
  let fee = 0;
  const feeKnown = Array.isArray(payment.processing_fee);
  if (payment.processing_fee !== undefined && !feeKnown) throw new Error("square_invalid_fee");
  if (feeKnown)
    for (const entry of payment.processing_fee) {
      fee += money(entry.amount_money, total.currency, true).amount;
      if (!Number.isSafeInteger(fee)) throw new Error("square_invalid_fee");
    }
  const verified =
    config.environment === "production" && payment.status === "COMPLETED" && PROCESSED_SOURCES.has(payment.source_type);
  return {
    environment: config.environment,
    payment_id: payment.id,
    business: map.business,
    location_id: map.location_id,
    status: payment.status,
    source_type: typeof payment.source_type === "string" ? payment.source_type : "UNKNOWN",
    currency: total.currency,
    gross_minor: total.amount,
    refunded_minor: refund,
    net_minor: Math.max(0, total.amount - refund),
    fee_minor: fee,
    fee_known: feeKnown && fee >= 0 ? 1 : 0,
    provider_updated_at: updated,
    occurred_at: occurred,
    updated_at: now,
    verified,
  };
}
function upsertReceipt(db: DatabaseSync, payment: Row): void {
  const prior = db
    .prepare("SELECT * FROM square_receipts WHERE environment=? AND payment_id=?")
    .get(payment.environment, payment.payment_id) as Row | undefined;
  if (prior && prior.provider_updated_at > payment.provider_updated_at) return;
  const external = `${payment.environment}:${payment.payment_id}`;
  for (const [source, kind, amount, verified] of [
    ["square_payment", "revenue", payment.net_minor, payment.verified],
    ["square_fee", "expense", Math.max(0, payment.fee_minor), payment.verified && payment.fee_known],
  ] as const) {
    const existing = db
      .prepare("SELECT * FROM ledger_entries WHERE source=? AND external_id=?")
      .get(source, external) as Row | undefined;
    if (existing && (existing.business !== payment.business || existing.currency !== payment.currency))
      throw new Error("square_receipt_scope_changed");
    db.prepare(
      `INSERT INTO ledger_entries(id,business,kind,amount_minor,currency,source,external_id,verified,description,occurred_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,external_id) DO UPDATE SET amount_minor=excluded.amount_minor,
      verified=excluded.verified,description=excluded.description,occurred_at=excluded.occurred_at,updated_at=excluded.updated_at`,
    ).run(
      existing?.id ?? randomUUID(),
      payment.business,
      kind,
      amount,
      payment.currency,
      source,
      external,
      verified ? 1 : 0,
      source === "square_payment"
        ? `Square ${payment.status.toLowerCase()} payment, net of recorded refunds`
        : `Square processing fees${payment.fee_known ? "" : " (not available yet)"}`,
      payment.occurred_at,
      payment.updated_at,
      payment.updated_at,
    );
  }
  db.prepare(
    `INSERT INTO square_receipts(environment,payment_id,business,location_id,status,source_type,currency,gross_minor,refunded_minor,net_minor,fee_minor,fee_known,provider_updated_at,occurred_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(environment,payment_id) DO UPDATE SET status=excluded.status,source_type=excluded.source_type,
    gross_minor=excluded.gross_minor,refunded_minor=excluded.refunded_minor,net_minor=excluded.net_minor,fee_minor=excluded.fee_minor,fee_known=excluded.fee_known,
    provider_updated_at=excluded.provider_updated_at,updated_at=excluded.updated_at`,
  ).run(
    payment.environment,
    payment.payment_id,
    payment.business,
    payment.location_id,
    payment.status,
    payment.source_type,
    payment.currency,
    payment.gross_minor,
    payment.refunded_minor,
    payment.net_minor,
    payment.fee_minor,
    payment.fee_known,
    payment.provider_updated_at,
    payment.occurred_at,
    payment.updated_at,
  );
}
/** GET-only, staged pagination: no partial import or advancing watermark after incomplete reads. */
export async function syncSquarePayments(db: DatabaseSync, deps: SquareDeps = {}) {
  ensureSquareSchema(db);
  if (active.has(db)) throw new Error("square_sync_in_progress");
  active.add(db);
  const config = connection(db),
    maps = mappings(db),
    now = deps.now?.() ?? Date.now();
  try {
    if (!config.token_enc) throw new Error("square_token_required");
    if (!maps.length) throw new Error("square_locations_required");
    const staged = new Map<string, Row>(),
      known = JSON.parse(config.locations_json) as Row[];
    for (const map of maps) {
      let cursor: string | undefined;
      const cursors = new Set<string>();
      for (let page = 0; ; page++) {
        if (page >= (deps.maxPages ?? 100)) throw new Error("square_pagination_incomplete");
        const query = new URLSearchParams({
          location_id: map.location_id,
          limit: "100",
          begin_time: config.history_since,
          end_time: new Date(now).toISOString(),
          sort_field: "UPDATED_AT",
          sort_order: "ASC",
          updated_at_end_time: new Date(now).toISOString(),
        });
        if (config.watermark)
          query.set("updated_at_begin_time", new Date(Date.parse(config.watermark) - 5 * 60000).toISOString());
        if (cursor) query.set("cursor", cursor);
        const data = await readSquare(config, "/v2/payments", query, deps);
        assertCurrent(db, config);
        if (data.payments !== undefined && !Array.isArray(data.payments)) throw new Error("square_invalid_response");
        for (const raw of data.payments ?? []) {
          const prior =
            typeof raw?.id === "string"
              ? (db
                  .prepare("SELECT * FROM square_receipts WHERE environment=? AND payment_id=?")
                  .get(config.environment, raw.id) as Row | undefined)
              : undefined;
          const payment = normalizePayment(raw, map, config, known, now, prior),
            key = payment.payment_id;
          const previous = staged.get(key);
          if (previous && (previous.business !== payment.business || previous.location_id !== payment.location_id))
            throw new Error("square_payment_location_conflict");
          if (!previous || previous.provider_updated_at <= payment.provider_updated_at) staged.set(key, payment);
        }
        if (!data.cursor) break;
        if (typeof data.cursor !== "string" || cursors.has(data.cursor))
          throw new Error("square_pagination_incomplete");
        cursors.add(data.cursor);
        cursor = data.cursor;
      }
    }
    assertCurrent(db, config);
    db.exec("SAVEPOINT square_import");
    try {
      for (const payment of staged.values()) upsertReceipt(db, payment);
      reconcilePaidDeals(db);
      db.prepare("UPDATE square_connection SET watermark=?,last_sync_at=?,last_sync_error=NULL WHERE id=1").run(
        new Date(now).toISOString(),
        now,
      );
      db.exec("RELEASE square_import");
    } catch (error) {
      db.exec("ROLLBACK TO square_import; RELEASE square_import");
      throw error;
    }
    return { ok: true as const, imported: staged.size, settings: squareSettings(db) };
  } catch (error) {
    const code =
      error instanceof Error && /^square_[a-z0-9_]+$/.test(error.message) ? error.message : "square_sync_failed";
    if (connection(db).revision === config.revision)
      db.prepare("UPDATE square_connection SET last_sync_error=? WHERE id=1").run(code);
    throw new Error(code);
  } finally {
    active.delete(db);
  }
}
export async function runSquareSyncTick(db: DatabaseSync, deps: SquareDeps = {}): Promise<void> {
  ensureSquareSchema(db);
  const row = connection(db),
    now = deps.now?.() ?? Date.now();
  if (
    !row.enabled ||
    !row.token_enc ||
    (row.last_sync_at && now - row.last_sync_at < SQUARE_SYNC_INTERVAL_MS) ||
    active.has(db)
  )
    return;
  await syncSquarePayments(db, deps);
}
