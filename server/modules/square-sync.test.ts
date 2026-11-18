import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { ensureAutonomySchema } from "./autonomy-store.ts";
import {
  ensureSquareSchema,
  squareSettings,
  saveSquareSettings,
  saveSquareMappings,
  testSquareConnection,
  syncSquarePayments,
  runSquareSyncTick,
  createSquareConnection,
  deleteSquareConnection,
  listSquareConnections,
} from "./square-sync.ts";
vi.mock("../oauth/helpers.ts", () => ({
  encryptSecret: (value: string) => `sealed:${value}`,
  decryptSecret: (value: string) => value.replace(/^sealed:/, ""),
}));
const dbs: DatabaseSync[] = [];
const NOW = Date.parse("2026-11-16T18:00:00Z");
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
const locations = [
  { id: "location-1", name: "Ventures", currency: "USD", status: "ACTIVE" },
  { id: "location-2", name: "Tech", currency: "USD", status: "ACTIVE" },
];
function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: "payment-1",
    location_id: "location-1",
    status: "COMPLETED",
    source_type: "CARD",
    total_money: { amount: 1500, currency: "USD" },
    refunded_money: { amount: 0, currency: "USD" },
    processing_fee: [{ amount_money: { amount: 74, currency: "USD" } }],
    created_at: "2021-01-04T12:00:00Z",
    updated_at: "2026-11-16T17:00:00Z",
    ...overrides,
  };
}
function harness() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  ensureAutonomySchema(db);
  db.exec("CREATE TABLE business_contacts(id TEXT PRIMARY KEY)");
  ensureSquareSchema(db);
  let payments: unknown[] = [payment()];
  const fetcher = vi.fn<typeof fetch>(
    async (input) =>
      new Response(JSON.stringify(new URL(String(input)).pathname === "/v2/locations" ? { locations } : { payments }), {
        status: 200,
      }),
  );
  const deps = { fetch: fetcher, now: () => NOW };
  const configure = async (environment: "production" | "sandbox" = "production") => {
    saveSquareSettings(db, { token: "private-square-token", environment, history_since: "2020-01-01T00:00:00Z" }, NOW);
    await testSquareConnection(db, deps);
    saveSquareMappings(db, [{ business: "ventures", location_id: "location-1" }], NOW);
  };
  const ledger = (source = "square_payment") =>
    db.prepare("SELECT * FROM ledger_entries WHERE source=?").get(source) as Record<string, unknown> | undefined;
  return {
    db,
    fetcher,
    deps,
    configure,
    ledger,
    setPayments: (value: unknown[]) => {
      payments = value;
    },
  };
}
describe("Square secret settings and location authority", () => {
  it("stores an encrypted token, keeps omitted or blank secrets, and clears only explicitly without removing receipts", async () => {
    const h = harness();
    await h.configure();
    await syncSquarePayments(h.db, h.deps);
    expect(h.db.prepare("SELECT token_enc FROM square_connection").get()).toMatchObject({
      token_enc: "sealed:private-square-token",
    });
    expect(JSON.stringify(squareSettings(h.db))).not.toMatch(/private-square-token|sealed:/);
    saveSquareSettings(h.db, { token: "" }, NOW);
    expect(squareSettings(h.db).token_configured).toBe(true);
    saveSquareSettings(h.db, { enabled: true }, NOW);
    expect(squareSettings(h.db).enabled).toBe(true);
    saveSquareSettings(h.db, { clear_token: true }, NOW);
    expect(squareSettings(h.db)).toMatchObject({
      enabled: false,
      token_configured: false,
      locations: [],
      mappings: [],
    });
    expect(h.ledger()).toMatchObject({ verified: 1, amount_minor: 1500 });
  });
  it("requires testing and mapping after token or environment changes and preserves history", async () => {
    const h = harness();
    await h.configure();
    await syncSquarePayments(h.db, h.deps);
    saveSquareSettings(h.db, { token: "different-token" }, NOW);
    expect(squareSettings(h.db)).toMatchObject({ locations: [], mappings: [], enabled: false });
    expect(() => saveSquareSettings(h.db, { enabled: true }, NOW)).toThrow("square_test_and_map_before_enabling");
    expect(() => saveSquareMappings(h.db, [{ business: "ventures", location_id: "location-1" }], NOW)).toThrow(
      "square_invalid_mappings",
    );
    expect(h.ledger()).toMatchObject({ verified: 1 });
  });
  it("validates known locations, unique business/location mappings, and locks historical business scope", async () => {
    const h = harness();
    await h.configure();
    for (const maps of [
      [{ business: "unknown", location_id: "location-1" }],
      [{ business: "ventures", location_id: "missing" }],
      [
        { business: "ventures", location_id: "location-1" },
        { business: "tech", location_id: "location-1" },
      ],
    ])
      expect(() => saveSquareMappings(h.db, maps, NOW)).toThrow("square_invalid_mappings");
    await syncSquarePayments(h.db, h.deps);
    expect(() => saveSquareMappings(h.db, [{ business: "tech", location_id: "location-1" }], NOW)).toThrow(
      "square_location_history_business_locked",
    );
    expect(squareSettings(h.db).mappings).toEqual([{ business: "ventures", location_id: "location-1" }]);
  });
  it("rejects coverage narrowing past imported receipts and resets the watermark when expanding history", async () => {
    const h = harness();
    await h.configure();
    await syncSquarePayments(h.db, h.deps);
    expect(() => saveSquareSettings(h.db, { history_since: "2025-01-01T00:00:00Z" }, NOW)).toThrow(
      "square_history_would_exclude_imported_receipts",
    );
    expect(squareSettings(h.db).history_since).toBe("2020-01-01T00:00:00.000Z");
    expect(() =>
      saveSquareSettings(h.db, { token: "rotated-token", history_since: "2025-01-01T00:00:00Z" }, NOW),
    ).toThrow("square_history_would_exclude_imported_receipts");
    saveSquareSettings(h.db, { history_since: "2010-01-01T00:00:00Z" }, NOW);
    expect(squareSettings(h.db).watermark).toBeNull();
  });

  it("rejects a late location test after credentials change", async () => {
    const h = harness();
    saveSquareSettings(h.db, { token: "first-token" }, NOW);
    const fetcher = vi.fn<typeof fetch>(async () => {
      saveSquareSettings(h.db, { token: "second-token" }, NOW);
      return new Response(JSON.stringify({ locations }));
    });
    await expect(testSquareConnection(h.db, { fetch: fetcher, now: () => NOW })).rejects.toThrow(
      "square_configuration_changed",
    );
    expect(squareSettings(h.db).locations).toEqual([]);
  });
});
describe("Square GET-only verified imports", () => {
  it("imports production processor-completed net payments and fees idempotently with no attribution", async () => {
    const h = harness();
    await h.configure();
    await syncSquarePayments(h.db, h.deps);
    await syncSquarePayments(h.db, h.deps);
    expect(h.ledger()).toMatchObject({
      business: "ventures",
      kind: "revenue",
      amount_minor: 1500,
      verified: 1,
      external_id: "production:payment-1",
      deal_id: null,
      opportunity_id: null,
    });
    expect(h.ledger("square_fee")).toMatchObject({ kind: "expense", amount_minor: 74, verified: 1 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get()).toMatchObject({ n: 2 });
    for (const [url, options] of h.fetcher.mock.calls) {
      expect(new URL(String(url)).origin).toBe("https://connect.squareup.com");
      expect(["/v2/locations", "/v2/payments"]).toContain(new URL(String(url)).pathname);
      expect(options).toMatchObject({ method: "GET", redirect: "error" });
    }
  });
  it.each(["CARD", "BANK_ACCOUNT", "WALLET", "BUY_NOW_PAY_LATER", "SQUARE_ACCOUNT"])(
    "verifies only supported processor source %s",
    async (source) => {
      const h = harness();
      await h.configure();
      h.setPayments([payment({ source_type: source })]);
      await syncSquarePayments(h.db, h.deps);
      expect(h.ledger()?.verified).toBe(1);
    },
  );
  it.each(["CASH", "EXTERNAL", "UNKNOWN"])("does not turn %s records into verified income", async (source) => {
    const h = harness();
    await h.configure();
    h.setPayments([payment({ source_type: source })]);
    await syncSquarePayments(h.db, h.deps);
    expect(h.ledger()?.verified).toBe(0);
    expect(h.ledger("square_fee")?.verified).toBe(0);
  });
  it("isolates sandbox receipts and never verifies sandbox totals", async () => {
    const h = harness();
    await h.configure("sandbox");
    await syncSquarePayments(h.db, h.deps);
    expect(h.ledger()).toMatchObject({ external_id: "sandbox:payment-1", verified: 0 });
    expect(
      h.fetcher.mock.calls.every(([url]) => new URL(String(url)).origin === "https://connect.squareupsandbox.com"),
    ).toBe(true);
  });
  it("reconciles cumulative refunds once, preserves links, and rolls paid deals back when evidence disappears", async () => {
    const h = harness();
    await h.configure();
    await syncSquarePayments(h.db, h.deps);
    h.db.exec(
      "INSERT INTO deals(id,business,title,stage,expected_amount_minor,currency,created_at,updated_at) VALUES ('deal','ventures','Service order','won',1400,'USD',1,1); UPDATE ledger_entries SET deal_id='deal' WHERE source='square_payment'",
    );
    await syncSquarePayments(h.db, h.deps);
    expect(h.db.prepare("SELECT stage FROM deals WHERE id='deal'").get()).toMatchObject({ stage: "paid" });
    h.setPayments([payment({ refunded_money: { amount: 300, currency: "USD" }, updated_at: "2026-11-16T17:30:00Z" })]);
    await syncSquarePayments(h.db, h.deps);
    await syncSquarePayments(h.db, h.deps);
    expect(h.ledger()).toMatchObject({ amount_minor: 1200, deal_id: "deal" });
    expect(h.db.prepare("SELECT stage FROM deals WHERE id='deal'").get()).toMatchObject({ stage: "won" });
    h.setPayments([payment({ status: "CANCELED", updated_at: "2026-11-16T17:40:00Z" })]);
    await syncSquarePayments(h.db, h.deps);
    expect(h.ledger()?.verified).toBe(0);
  });
  it("invalidates a previously verified payment when a newer noncompleted response omits its total", async () => {
    const h = harness();
    await h.configure();
    await syncSquarePayments(h.db, h.deps);
    h.setPayments([
      payment({
        status: "FAILED",
        total_money: undefined,
        refunded_money: { amount: 500, currency: "USD" },
        updated_at: "2026-11-16T17:30:00Z",
      }),
    ]);
    await syncSquarePayments(h.db, h.deps);
    expect(h.ledger()).toMatchObject({ verified: 0 });
    expect(h.ledger("square_fee")).toMatchObject({ verified: 0 });
  });

  it("ignores older provider updates instead of resurrecting refunded income", async () => {
    const h = harness();
    await h.configure();
    h.setPayments([payment({ refunded_money: { amount: 500, currency: "USD" }, updated_at: "2026-11-16T17:30:00Z" })]);
    await syncSquarePayments(h.db, h.deps);
    h.setPayments([payment()]);
    await syncSquarePayments(h.db, h.deps);
    expect(h.ledger()?.amount_minor).toBe(1000);
  });
  it.each(["missing", "negative"])("keeps %s fee evidence unknown without fabricated verified zero", async (mode) => {
    const h = harness();
    await h.configure();
    h.setPayments([
      payment({
        processing_fee: mode === "missing" ? undefined : [{ amount_money: { amount: -20, currency: "USD" } }],
      }),
    ]);
    await syncSquarePayments(h.db, h.deps);
    expect(h.ledger("square_fee")).toMatchObject({ verified: 0, amount_minor: 0 });
    expect(squareSettings(h.db).fee_unknown).toBe(1);
    expect(h.db.prepare("SELECT fee_minor FROM square_receipts").get()).toMatchObject({
      fee_minor: mode === "missing" ? 0 : -20,
    });
  });
  it("rejects location mismatch, unsafe amounts, and mismatched fee currencies atomically", async () => {
    for (const overrides of [
      { location_id: "location-2" },
      { total_money: { amount: 9007199254740992, currency: "USD" } },
      { processing_fee: [{ amount_money: { amount: 20, currency: "EUR" } }] },
      { refunded_money: { amount: 2000, currency: "USD" } },
    ]) {
      const h = harness();
      await h.configure();
      h.setPayments([payment(), payment({ ...overrides, id: "bad-payment" })]);
      await expect(syncSquarePayments(h.db, h.deps)).rejects.toThrow("square_");
      expect(h.db.prepare("SELECT * FROM ledger_entries").all()).toHaveLength(0);
      expect(squareSettings(h.db).watermark).toBeNull();
    }
  });
});
describe("Square complete pagination, coverage, and stale-operation fences", () => {
  it("uses full explicit created coverage and incremental updated watermark overlap", async () => {
    const h = harness();
    await h.configure();
    await syncSquarePayments(h.db, h.deps);
    await syncSquarePayments(h.db, { ...h.deps, now: () => NOW + 60000 });
    const calls = h.fetcher.mock.calls.filter(([url]) => new URL(String(url)).pathname === "/v2/payments");
    const first = new URL(String(calls[0][0])),
      second = new URL(String(calls[1][0]));
    expect(first.searchParams.get("begin_time")).toBe("2020-01-01T00:00:00.000Z");
    expect(second.searchParams.get("begin_time")).toBe(first.searchParams.get("begin_time"));
    expect(second.searchParams.get("updated_at_begin_time")).toBe(new Date(NOW - 5 * 60000).toISOString());
    expect(second.searchParams.get("sort_field")).toBe("UPDATED_AT");
    expect(second.searchParams.get("limit")).toBe("100");
  });
  it("follows pagination before importing any rows or advancing watermark", async () => {
    const h = harness();
    await h.configure();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response(JSON.stringify({ payments: [payment()], cursor: "next" })))
      .mockImplementationOnce(async (input) => {
        expect(h.db.prepare("SELECT * FROM ledger_entries").all()).toHaveLength(0);
        expect(new URL(String(input)).searchParams.get("cursor")).toBe("next");
        return new Response(JSON.stringify({ payments: [payment({ id: "second-payment" })] }));
      });
    await syncSquarePayments(h.db, { ...h.deps, fetch: fetcher });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get()).toMatchObject({ n: 4 });
    expect(squareSettings(h.db).watermark).toBe(new Date(NOW).toISOString());
  });
  it.each(["http", "cycle", "cap"])("keeps pagination %s failures incomplete with no partial imports", async (mode) => {
    const h = harness();
    await h.configure();
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ payments: [payment()], cursor: "again" })),
    );
    if (mode === "http")
      fetcher
        .mockImplementationOnce(async () => new Response(JSON.stringify({ payments: [payment()], cursor: "again" })))
        .mockImplementationOnce(async () => new Response("{}", { status: 503 }));
    await expect(
      syncSquarePayments(h.db, { ...h.deps, fetch: fetcher, maxPages: mode === "cap" ? 1 : 5 }),
    ).rejects.toThrow(mode === "http" ? "square_http_503" : "square_pagination_incomplete");
    expect(h.db.prepare("SELECT * FROM ledger_entries").all()).toHaveLength(0);
    expect(squareSettings(h.db).watermark).toBeNull();
  });
  it("rejects mapping or credential changes while awaiting a response", async () => {
    for (const change of ["mapping", "token"]) {
      const h = harness();
      await h.configure();
      const fetcher = vi.fn<typeof fetch>(async () => {
        if (change === "mapping") saveSquareMappings(h.db, [], NOW);
        else saveSquareSettings(h.db, { token: "rotated-token" }, NOW);
        return new Response(JSON.stringify({ payments: [payment()] }));
      });
      await expect(syncSquarePayments(h.db, { ...h.deps, fetch: fetcher })).rejects.toThrow(
        "square_configuration_changed",
      );
      expect(h.db.prepare("SELECT * FROM ledger_entries").all()).toHaveLength(0);
      expect(squareSettings(h.db).watermark).toBeNull();
    }
  });
  it("does not call Square until the owner enables periodic sync", async () => {
    const h = harness();
    await h.configure();
    h.fetcher.mockClear();
    await runSquareSyncTick(h.db, h.deps);
    expect(h.fetcher).not.toHaveBeenCalled();
    saveSquareSettings(h.db, { enabled: true }, NOW);
    await runSquareSyncTick(h.db, h.deps);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    await runSquareSyncTick(h.db, h.deps);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("several Square accounts", () => {
  const primroseLocations = [{ id: "location-p", name: "Primrose", currency: "USD", status: "ACTIVE" }];
  function multi() {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    applyBaseSchema(db);
    ensureAutonomySchema(db);
    db.exec("CREATE TABLE business_contacts(id TEXT PRIMARY KEY)");
    ensureSquareSchema(db);
    // Each token sees its own account's locations and payments; the same payment id exists in both on purpose.
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const token = String((init?.headers as Record<string, string>).Authorization);
      const primrose = token.includes("primrose");
      const body =
        new URL(String(input)).pathname === "/v2/locations"
          ? { locations: primrose ? primroseLocations : locations }
          : {
              payments: [
                payment(primrose ? { location_id: "location-p", total_money: { amount: 9900, currency: "USD" } } : {}),
              ],
            };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const deps = { fetch: fetcher, now: () => NOW };
    return { db, deps, fetcher };
  }

  it("keeps a separate token, locations and sync per account, and payment ids never collide", async () => {
    const { db, deps } = multi();
    saveSquareSettings(db, { token: "main-token", history_since: "2020-01-01T00:00:00Z" }, NOW);
    await testSquareConnection(db, deps);
    saveSquareMappings(db, [{ business: "ventures", location_id: "location-1" }], NOW);

    const primrose = createSquareConnection(
      db,
      { label: "Primrose Events", token: "primrose-token", history_since: "2020-01-01T00:00:00Z" },
      NOW,
    );
    expect(primrose).toMatchObject({ id: 2, label: "Primrose Events", token_configured: true, enabled: false });
    await testSquareConnection(db, deps, primrose.id);
    expect(squareSettings(db, primrose.id).locations).toEqual(primroseLocations);
    // A business can only take money from one account.
    expect(() =>
      saveSquareMappings(db, [{ business: "ventures", location_id: "location-p" }], NOW, primrose.id),
    ).toThrow("square_business_mapped_in_other_account");
    saveSquareMappings(db, [{ business: "rental", location_id: "location-p" }], NOW, primrose.id);

    await syncSquarePayments(db, deps);
    await syncSquarePayments(db, deps, primrose.id);
    expect(
      db.prepare("SELECT connection_id, business, net_minor FROM square_receipts ORDER BY connection_id").all(),
    ).toEqual([
      { connection_id: 1, business: "ventures", net_minor: 1500 },
      { connection_id: 2, business: "rental", net_minor: 9900 },
    ]);
    expect(
      db
        .prepare("SELECT external_id, business FROM ledger_entries WHERE source='square_payment' ORDER BY external_id")
        .all(),
    ).toEqual([
      { external_id: "production:c2:payment-1", business: "rental" },
      { external_id: "production:payment-1", business: "ventures" },
    ]);
    expect(listSquareConnections(db).map((c) => [c.id, c.receipts])).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });

  it("changing one account's token clears only that account's mappings", async () => {
    const { db, deps } = multi();
    saveSquareSettings(db, { token: "main-token" }, NOW);
    await testSquareConnection(db, deps);
    saveSquareMappings(db, [{ business: "tech", location_id: "location-2" }], NOW);
    const primrose = createSquareConnection(db, { label: "Primrose", token: "primrose-token" }, NOW);
    await testSquareConnection(db, deps, primrose.id);
    saveSquareMappings(db, [{ business: "rental", location_id: "location-p" }], NOW, primrose.id);
    saveSquareSettings(db, { token: "primrose-token-2" }, NOW, primrose.id);
    expect(squareSettings(db, primrose.id).mappings).toEqual([]);
    expect(squareSettings(db).mappings).toEqual([{ business: "tech", location_id: "location-2" }]);
  });

  it("syncs every enabled account in the tick, and one failing account does not stop the others", async () => {
    const { db, deps, fetcher } = multi();
    saveSquareSettings(db, { token: "main-token", history_since: "2020-01-01T00:00:00Z" }, NOW);
    await testSquareConnection(db, deps);
    saveSquareMappings(db, [{ business: "ventures", location_id: "location-1" }], NOW);
    saveSquareSettings(db, { enabled: true }, NOW);
    const primrose = createSquareConnection(
      db,
      { label: "Primrose", token: "primrose-token", history_since: "2020-01-01T00:00:00Z" },
      NOW,
    );
    await testSquareConnection(db, deps, primrose.id);
    saveSquareMappings(db, [{ business: "rental", location_id: "location-p" }], NOW, primrose.id);
    saveSquareSettings(db, { enabled: true }, NOW, primrose.id);
    fetcher.mockImplementationOnce(async () => new Response("{}", { status: 500 }));
    await expect(runSquareSyncTick(db, deps)).rejects.toThrow("square_http_500");
    expect(squareSettings(db).last_sync_error).toBe("square_http_500");
    expect(squareSettings(db, primrose.id)).toMatchObject({ last_sync_error: null, receipts: 1 });
  });

  it("removes only an account that imported nothing, and never the last one", async () => {
    const { db, deps } = multi();
    expect(() => deleteSquareConnection(db, 1)).toThrow("square_last_connection");
    const spare = createSquareConnection(db, { label: "Spare" }, NOW);
    deleteSquareConnection(db, spare.id);
    expect(listSquareConnections(db).map((c) => c.id)).toEqual([1]);
    const primrose = createSquareConnection(
      db,
      { label: "Primrose", token: "primrose-token", history_since: "2020-01-01T00:00:00Z" },
      NOW,
    );
    await testSquareConnection(db, deps, primrose.id);
    saveSquareMappings(db, [{ business: "rental", location_id: "location-p" }], NOW, primrose.id);
    await syncSquarePayments(db, deps, primrose.id);
    expect(() => deleteSquareConnection(db, primrose.id)).toThrow("square_connection_has_receipts");
    expect(() => squareSettings(db, 99)).toThrow("square_connection_not_found");
  });

  it("upgrades a single-account database without changing any row", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    applyBaseSchema(db);
    ensureAutonomySchema(db);
    db.exec(`CREATE TABLE business_contacts(id TEXT PRIMARY KEY);
      CREATE TABLE square_connection (
        id INTEGER PRIMARY KEY CHECK(id=1), environment TEXT NOT NULL DEFAULT 'production' CHECK(environment IN ('production','sandbox')),
        token_enc TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        history_since TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, locations_json TEXT NOT NULL DEFAULT '[]',
        last_test_at INTEGER, last_sync_at INTEGER, last_sync_error TEXT, watermark TEXT, updated_at INTEGER NOT NULL);
      CREATE TABLE square_location_mappings (business TEXT PRIMARY KEY,location_id TEXT NOT NULL UNIQUE);
      CREATE TABLE square_receipts (
        environment TEXT NOT NULL,payment_id TEXT NOT NULL,business TEXT NOT NULL,location_id TEXT NOT NULL,
        status TEXT NOT NULL,source_type TEXT NOT NULL,currency TEXT NOT NULL,gross_minor INTEGER NOT NULL,
        refunded_minor INTEGER NOT NULL,net_minor INTEGER NOT NULL,fee_minor INTEGER NOT NULL,fee_known INTEGER NOT NULL,
        provider_updated_at INTEGER NOT NULL,occurred_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        PRIMARY KEY(environment,payment_id));
      INSERT INTO square_connection VALUES (1,'production','sealed:old',1,'2025-11-16T00:00:00.000Z',5,'[{"id":"L1"}]',1,2,NULL,'w',3);
      INSERT INTO square_location_mappings VALUES ('tech','L1');
      INSERT INTO square_receipts VALUES ('production','pay-1','tech','L1','COMPLETED','CARD','USD',100,0,100,3,1,1,1,1);`);
    ensureSquareSchema(db);
    ensureSquareSchema(db);
    expect(squareSettings(db)).toMatchObject({
      id: 1,
      label: "Main Square account",
      enabled: true,
      token_configured: true,
      watermark: "w",
      mappings: [{ business: "tech", location_id: "L1" }],
      receipts: 1,
    });
    expect(db.prepare("SELECT connection_id, payment_id, net_minor FROM square_receipts").all()).toEqual([
      { connection_id: 1, payment_id: "pay-1", net_minor: 100 },
    ]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});
