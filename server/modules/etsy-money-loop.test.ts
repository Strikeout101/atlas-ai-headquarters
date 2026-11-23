import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  applyShopChange,
  decideShopChange,
  markShopChangeOwnerDone,
  proposeShopChange,
  queueShopSetupIfNeeded,
  refreshShopProfile,
  shopChangeApprover,
  shopNeedsSetup,
  shopProfile,
} from "./etsy-shop.ts";
import { listPendingApprovals } from "./routes/ops/approvals.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "./bootstrap/schema/task-schema-migrations.ts";
import { ensureAutonomySchema } from "./autonomy-store.ts";
import { buildProposalPrompt, ensureAgentProposalSchema, parseProposalReply } from "./agent-proposals.ts";
import {
  ensureFinanceSchema,
  financeOverview,
  upsertProviderLedgerEntry,
  getFinancialGoalProgress,
} from "./finance-store.ts";
import { saveRecurringCost, setCostsComplete, profitLines } from "./profit.ts";
import {
  createListing,
  createRevision,
  decideListing,
  getListing,
  listingApprover,
  markListingPublished,
  submitListing,
  setFeeBudget,
  updateListing,
} from "./listings.ts";
import {
  adoptEtsyListing,
  applyEtsyRevision,
  classifyLedgerEntry,
  completeEtsyConnect,
  deactivateStoppedListings,
  etsyQuotaLow,
  etsyShopListings,
  runEtsyTick,
  searchEtsyListings,
  etsyRequest,
  pkcePair,
  publishEtsyListing,
  pushListingDraft,
  saveEtsySettings,
  startEtsyConnect,
  syncEtsy,
} from "./etsy.ts";
import { generateImage, mockupHtml, registerImage, renderMockup, saveStudioSettings, findChrome } from "./studio.ts";
import { searchMedia } from "./media-library.ts";
import {
  evaluateInitiatives,
  initiativeBudgetBlock,
  restartInitiative,
  saveExperimentRules,
  startVariant,
  variantResults,
} from "./experiments.ts";
import { ensureAutonomyEngineSchema } from "./autonomy-engine.ts";
import { getPlaybook, proposeInitiative, savePlaybook } from "./playbooks.ts";
import { applyWorkModelMigration } from "./bootstrap/schema/work-model-migration.ts";
import { ensureWorkEngineSchema, initiativeStartBlock } from "./work-engine.ts";

let projectDir: string;
beforeAll(() => {
  process.env.OAUTH_ENCRYPTION_SECRET ||= "test-secret-for-etsy-money-loop-0123456789";
  process.env.ETSY_MIN_INTERVAL_MS = "0";
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-etsy-"));
  fs.mkdirSync(path.join(projectDir, "products"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "products", "planner.pdf"), "%PDF-1.4 fake");
  // 1x1 PNG
  fs.writeFileSync(
    path.join(projectDir, "products", "page.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
});
afterAll(() => fs.rmSync(projectDir, { recursive: true, force: true }));

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

const NOW = Date.UTC(2026, 10, 18, 15);

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  applyWorkModelMigration(db);
  ensureAutonomySchema(db);
  ensureAgentProposalSchema(db);
  ensureFinanceSchema(db);
  ensureAutonomyEngineSchema(db);
  ensureWorkEngineSchema(db);
  db.prepare(
    "INSERT INTO projects (id,name,project_path,core_goal,created_at,updated_at,business) VALUES ('p1','Etsy shop',?,'Sell digital products',1,1,'ventures')",
  ).run(projectDir);
  db.exec(`
    INSERT INTO departments (id,name,name_ko,name_ja,name_zh,icon,color,sort_order) VALUES
      ('planning','Planning','','','','','#000',1),('design','Design','','','','','#000',2);
    INSERT INTO agents (id,name,role,cli_provider,department_id) VALUES
      ('lead-p','Sage','team_leader','codex','planning'),('lead-d','Iris','team_leader','codex','design');
    INSERT INTO business_goals (id,business,project_id,metric,target,period_start,period_end,created_at,updated_at)
      VALUES ('g0','ventures',NULL,'revenue',100,0,1,1,1);
    INSERT INTO initiatives (id,business,project_id,goal_id,title,description,budget,status,created_at,updated_at)
      VALUES ('o1','ventures','p1','g0','Budget planner','Monthly planner',5,'in_progress',1,1);`);
  return db;
}

/** A fake Etsy that records every call. */
function fakeEtsy(
  routes: Record<
    string,
    (init: RequestInit, url: URL) => { status?: number; body: unknown; headers?: Record<string, string> }
  >,
) {
  const calls: Array<{ method: string; url: URL; init: RequestInit }> = [];
  const fetchFn = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, url, init });
    const key = Object.keys(routes).find((pattern) => {
      const [m, p] = pattern.split(" ");
      return m === method && new RegExp(`^${p}$`).test(url.pathname);
    });
    if (!key) return new Response(JSON.stringify({ error: `no route ${method} ${url.pathname}` }), { status: 404 });
    const result = routes[key](init, url);
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: result.headers });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function connected(db: DatabaseSync) {
  saveEtsySettings(
    db,
    { keystring: "abc123", shared_secret: "s3cret", redirect_uri: "https://localhost/atlas-etsy" },
    NOW,
  );
  db.prepare(
    "UPDATE etsy_connection SET access_token_enc=?, refresh_token_enc=?, expires_at=?, user_id='42', shop_id='777' WHERE id=1",
  ).run(...encrypted("42.access"), NOW + 3_600_000);
}
function encrypted(access: string): [string, string] {
  // Use the module's own encryption through settings save + connect is heavy; encrypt directly.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { encryptSecret } = require("../oauth/helpers.ts") as typeof import("../oauth/helpers.ts");
  return [encryptSecret(access), encryptSecret("refresh-1")];
}

function approvedEtsyListing(db: DatabaseSync) {
  setFeeBudget(db, 500, NOW);
  const draft = createListing(
    db,
    {
      business: "ventures",
      platform: "etsy",
      title: "Budget planner",
      description: "Printable monthly budget planner",
      tags: ["planner", "budget"],
      price_minor: 450,
      files: ["products/planner.pdf"],
      mockups: ["products/page.png"],
      project_id: "p1",
      initiative_id: "o1",
      taxonomy_id: 2078,
    },
    {},
    NOW,
  );
  submitListing(db, draft.id, NOW);
  return decideListing(db, draft.id, true, "owner", "", NOW);
}

describe("Etsy connection", () => {
  it("starts OAuth with PKCE S256 and the required scopes", () => {
    const db = harness();
    expect(() => startEtsyConnect(db, NOW)).toThrow("etsy_credentials_required");
    expect(() => saveEtsySettings(db, { redirect_uri: "http://localhost/cb" })).toThrow("etsy_redirect_must_be_https");
    saveEtsySettings(
      db,
      { keystring: "abc123", shared_secret: "s3cret", redirect_uri: "https://localhost/atlas-etsy" },
      NOW,
    );
    const url = new URL(startEtsyConnect(db, NOW).url);
    expect(url.origin + url.pathname).toBe("https://www.etsy.com/oauth/connect");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("listings_r listings_w shops_r shops_w transactions_r");
    expect(url.searchParams.get("client_id")).toBe("abc123");
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toContain("=");
  });

  it("exchanges the pasted address for tokens, rejecting a wrong state", async () => {
    const db = harness();
    saveEtsySettings(
      db,
      { keystring: "abc123", shared_secret: "s3cret", redirect_uri: "https://localhost/atlas-etsy" },
      NOW,
    );
    const state = new URL(startEtsyConnect(db, NOW).url).searchParams.get("state")!;
    const { fetchFn, calls } = fakeEtsy({
      "POST /v3/public/oauth/token": () => ({
        body: { access_token: "42.tok", refresh_token: "r1", expires_in: 3600, token_type: "Bearer" },
      }),
      "GET /v3/application/users/me": () => ({ body: { user_id: 42, shop_id: 777 } }),
      "GET /v3/application/shops/777": () => ({ body: { shop_id: 777, shop_name: "EduardoCapital" } }),
    });
    await expect(
      completeEtsyConnect(db, `https://localhost/atlas-etsy?code=c1&state=wrong`, { fetch: fetchFn, now: () => NOW }),
    ).rejects.toThrow("etsy_state_mismatch");
    const settings = await completeEtsyConnect(db, `https://localhost/atlas-etsy?code=c1&state=${state}`, {
      fetch: fetchFn,
      now: () => NOW + 1000,
    });
    expect(settings).toMatchObject({ connected: true, shop_id: "777", shop_name: "EduardoCapital" });
    const token = calls.find((c) => c.url.pathname.endsWith("/oauth/token"))!;
    const form = new URLSearchParams(String(token.init.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const me = calls.find((c) => c.url.pathname.endsWith("/users/me"))!;
    expect((me.init.headers as Record<string, string>)["x-api-key"]).toBe("abc123:s3cret");
    expect((me.init.headers as Record<string, string>).authorization).toBe("Bearer 42.tok");
  });

  it("refreshes an expired token and waits on 429", async () => {
    const db = harness();
    connected(db);
    db.prepare("UPDATE etsy_connection SET expires_at=? WHERE id=1").run(NOW - 1);
    let limited = true;
    const waits: number[] = [];
    const { fetchFn, calls } = fakeEtsy({
      "POST /v3/public/oauth/token": () => ({
        body: { access_token: "42.fresh", refresh_token: "r2", expires_in: 3600 },
      }),
      "GET /v3/application/users/me": () => {
        if (limited) {
          limited = false;
          return { status: 429, body: {}, headers: { "retry-after": "3" } };
        }
        return { body: { user_id: 42, shop_id: 777 } };
      },
    });
    await etsyRequest(
      db,
      "GET",
      "/users/me",
      {},
      { fetch: fetchFn, now: () => NOW, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([3000]);
    const refresh = calls.find((c) => c.url.pathname.endsWith("/oauth/token"))!;
    expect(new URLSearchParams(String(refresh.init.body)).get("grant_type")).toBe("refresh_token");
    expect((calls.at(-1)!.init.headers as Record<string, string>).authorization).toBe("Bearer 42.fresh");
  });

  it("pushes an approved package as a download draft with its images and files, then publishes without a double fee", async () => {
    const db = harness();
    connected(db);
    const listing = approvedEtsyListing(db);
    const { fetchFn, calls } = fakeEtsy({
      "POST /v3/application/shops/777/listings": () => ({ status: 201, body: { listing_id: 9001 } }),
      "POST /v3/application/shops/777/listings/9001/images": () => ({ body: { listing_image_id: 1 } }),
      "POST /v3/application/shops/777/listings/9001/files": () => ({ body: { listing_file_id: 2 } }),
      "PATCH /v3/application/shops/777/listings/9001": () => ({
        body: { listing_id: 9001, url: "https://www.etsy.com/listing/9001/budget-planner" },
      }),
    });
    const pushed = await pushListingDraft(db, listing.id, { fetch: fetchFn, now: () => NOW });
    expect(pushed.etsy_listing_id).toBe("9001");
    const create = new URLSearchParams(String(calls[0].init.body));
    expect(Object.fromEntries(create)).toMatchObject({
      type: "download",
      price: "4.50",
      who_made: "i_did",
      when_made: "made_to_order",
      taxonomy_id: "2078",
      tags: "planner,budget",
    });
    expect(calls[1].init.body).toBeInstanceOf(FormData);
    expect((calls[1].init.body as FormData).get("image")).toBeTruthy();
    expect((calls[2].init.body as FormData).get("file")).toBeTruthy();
    const published = await publishEtsyListing(db, listing.id, { fetch: fetchFn, now: () => NOW });
    expect(published).toMatchObject({
      status: "published",
      listing_url: "https://www.etsy.com/listing/9001/budget-planner",
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT status, launched_at FROM initiatives WHERE id='o1'").get()).toEqual({
      status: "launched",
      launched_at: NOW,
    });
  });

  it("syncs paid orders as verified revenue once, fees and refunds as costs, and skips payouts", async () => {
    const db = harness();
    connected(db);
    const listing = approvedEtsyListing(db);
    db.prepare("UPDATE listing_packages SET etsy_listing_id='9001' WHERE id=?").run(listing.id);
    const receipt = {
      receipt_id: 555,
      status: "paid",
      is_paid: true,
      subtotal: { amount: 450, divisor: 100, currency_code: "USD" },
      created_timestamp: Math.floor(NOW / 1000),
      transactions: [{ listing_id: 9001, title: "Budget planner", quantity: 1 }],
    };
    const { fetchFn } = fakeEtsy({
      "GET /v3/application/shops/777/receipts": () => ({ body: { count: 1, results: [receipt] } }),
      "GET /v3/application/shops/777/payment-account/ledger-entries": () => ({
        body: {
          results: [
            {
              entry_id: 1,
              amount: -20,
              currency: "USD",
              description: "listing fee",
              ledger_type: "listing",
              reference_type: "listing",
              reference_id: "9001",
              created_timestamp: 1,
            },
            {
              entry_id: 2,
              amount: -30,
              currency: "USD",
              description: "transaction fee",
              ledger_type: "transaction",
              created_timestamp: 1,
            },
            {
              entry_id: 3,
              amount: -1000,
              currency: "USD",
              description: "Deposit to bank",
              ledger_type: "disbursement",
              created_timestamp: 1,
            },
            {
              entry_id: 4,
              amount: 450,
              currency: "USD",
              description: "Payment",
              ledger_type: "payment",
              created_timestamp: 1,
            },
            {
              entry_id: 5,
              amount: -450,
              currency: "USD",
              description: "Refund to buyer",
              ledger_type: "refund",
              created_timestamp: 1,
            },
          ],
        },
      }),
      "GET /v3/application/shops/777/listings": () => ({ body: { results: [{ listing_id: 9001, num_favorers: 7 }] } }),
    });
    const counts = await syncEtsy(db, { fetch: fetchFn, now: () => NOW });
    expect(counts).toEqual({
      receipts: 1,
      fees: 2,
      refunds: 1,
      listings: 1,
      shop_listings: 1,
      changed_on_etsy: 0,
      windows: 6,
    });
    await syncEtsy(db, { fetch: fetchFn, now: () => NOW + 1000 });
    const rows = db
      .prepare(
        "SELECT source, kind, amount_minor, verified, initiative_id FROM ledger_entries ORDER BY source, amount_minor",
      )
      .all();
    expect(rows).toEqual([
      { source: "etsy_fee", kind: "expense", amount_minor: 20, verified: 1, initiative_id: "o1" },
      { source: "etsy_fee", kind: "expense", amount_minor: 30, verified: 1, initiative_id: null },
      { source: "etsy_receipt", kind: "revenue", amount_minor: 450, verified: 1, initiative_id: "o1" },
      { source: "etsy_refund", kind: "expense", amount_minor: 450, verified: 1, initiative_id: null },
    ]);
    expect(db.prepare("SELECT favorers, sales FROM initiative_metrics WHERE initiative_id='o1'").get()).toEqual({
      favorers: 7,
      sales: 1,
    });
    expect(classifyLedgerEntry({ amount: -5, ledger_type: "payout" })).toBeNull();
  });
});

function publishedEtsyListing(db: DatabaseSync) {
  const listing = approvedEtsyListing(db);
  db.prepare("UPDATE listing_packages SET etsy_listing_id='9001', etsy_state='active' WHERE id=?").run(listing.id);
  return markListingPublished(db, listing.id, "https://www.etsy.com/listing/9001/budget-planner", NOW, {
    recordFee: false,
  });
}

describe("Etsy listings after launch", () => {
  it("sends alt text with images, and falls back to one field per tag when Etsy did not keep the comma list", async () => {
    const db = harness();
    connected(db);
    const listing = approvedEtsyListing(db);
    const { fetchFn, calls } = fakeEtsy({
      "POST /v3/application/shops/777/listings": () => ({
        status: 201,
        body: { listing_id: 9001, tags: ["planner,budget"] },
      }),
      "PATCH /v3/application/shops/777/listings/9001": () => ({
        body: { listing_id: 9001, tags: ["planner", "budget"] },
      }),
      "POST /v3/application/shops/777/listings/9001/images": () => ({ body: { listing_image_id: 1 } }),
      "POST /v3/application/shops/777/listings/9001/files": () => ({ body: { listing_file_id: 2 } }),
    });
    await pushListingDraft(db, listing.id, { fetch: fetchFn, now: () => NOW });
    const retry = calls.find((call) => call.method === "PATCH")!;
    expect(new URLSearchParams(String(retry.init.body)).getAll("tags")).toEqual(["planner", "budget"]);
    const image = calls.find((call) => call.url.pathname.endsWith("/images"))!;
    expect((image.init.body as FormData).get("alt_text")).toBe("Budget planner - image 1 of 1");
    expect(getListing(db, listing.id)).toMatchObject({ etsy_listing_id: "9001", etsy_state: "draft" });
  });

  it("finishes a half-pushed draft by uploading only what is missing", async () => {
    const db = harness();
    connected(db);
    const listing = approvedEtsyListing(db);
    db.prepare("UPDATE listing_packages SET etsy_listing_id='9001' WHERE id=?").run(listing.id);
    const { fetchFn, calls } = fakeEtsy({
      "GET /v3/application/listings/9001/images": () => ({ body: { results: [{ listing_image_id: 1 }] } }),
      "GET /v3/application/shops/777/listings/9001/files": () => ({ body: { results: [] } }),
      "POST /v3/application/shops/777/listings/9001/files": () => ({ body: { listing_file_id: 2 } }),
    });
    await pushListingDraft(db, listing.id, { fetch: fetchFn, now: () => NOW });
    expect(calls.map((call) => `${call.method} ${call.url.pathname.replace("/v3/application", "")}`)).toEqual([
      "GET /listings/9001/images",
      "GET /shops/777/listings/9001/files",
      "POST /shops/777/listings/9001/files",
    ]);
  });

  it("applies an approved revision to the live listing: text by update, price by inventory, new images safely", async () => {
    const db = harness();
    connected(db);
    const live = publishedEtsyListing(db);
    expect(() => createRevision(db, live.id, { business: "tech" })).toThrow("listing_protected_field");
    const unchanged = createRevision(db, live.id, {}, { agentId: "lead-p" }, NOW);
    expect(() => submitListing(db, unchanged.id, NOW)).toThrow("listing_revision_unchanged");
    db.prepare("UPDATE listing_packages SET status='withdrawn' WHERE id=?").run(unchanged.id);

    const big = createRevision(db, live.id, { price_minor: 1500 }, { agentId: "lead-p" }, NOW);
    expect(listingApprover(db, submitListing(db, big.id, NOW), NOW)).toBe("owner");
    expect(() => createRevision(db, live.id, { title: "x" })).toThrow("listing_revision_open");
    db.prepare("UPDATE listing_packages SET status='withdrawn' WHERE id=?").run(big.id);

    const revision = createRevision(
      db,
      live.id,
      { title: "Budget planner 2027", tags: ["planner", "budget", "2027"], price_minor: 500 },
      { agentId: "lead-p", taskId: "t1" },
      NOW,
    );
    expect(revision).toMatchObject({ revision_of: live.id, etsy_listing_id: "9001", fee_minor: 0, status: "draft" });
    const submitted = submitListing(db, revision.id, NOW);
    expect(listingApprover(db, submitted, NOW)).toBe("vp");
    decideListing(db, revision.id, true, "owner", "", NOW);
    startVariant(db, { initiative_id: "o1", variable: "price", value: "5.00", listing_id: revision.id }, {}, NOW);

    const { fetchFn, calls } = fakeEtsy({
      "PATCH /v3/application/shops/777/listings/9001": () => ({
        body: { listing_id: 9001, tags: ["planner", "budget", "2027"] },
      }),
      "GET /v3/application/listings/9001/inventory": () => ({
        body: {
          products: [
            {
              product_id: 1,
              sku: "",
              property_values: [],
              offerings: [
                {
                  offering_id: 5,
                  price: { amount: 450, divisor: 100, currency_code: "USD" },
                  quantity: 999,
                  is_enabled: true,
                },
              ],
            },
          ],
          price_on_property: [],
          quantity_on_property: [],
          sku_on_property: [],
        },
      }),
      "PUT /v3/application/listings/9001/inventory": () => ({ body: {} }),
    });
    const LATER = NOW + 60_000;
    const applied = await applyEtsyRevision(db, revision.id, { fetch: fetchFn, now: () => LATER });
    expect(applied.status).toBe("published");
    const update = new URLSearchParams(String(calls[0].init.body));
    expect(Object.fromEntries(update)).toEqual({ title: "Budget planner 2027", tags: "planner,budget,2027" });
    const put = calls.find((call) => call.method === "PUT")!;
    expect((put.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(put.init.body))).toEqual({
      products: [{ sku: "", property_values: [], offerings: [{ price: 5, quantity: 999, is_enabled: true }] }],
      price_on_property: [],
      quantity_on_property: [],
      sku_on_property: [],
    });
    // Same images as the live listing, so they are left alone.
    expect(calls.some((call) => call.url.pathname.includes("/images"))).toBe(false);
    expect(getListing(db, live.id)).toMatchObject({ title: "Budget planner 2027", price_minor: 500 });
    expect(db.prepare("SELECT started_at FROM initiative_variants WHERE listing_id=?").get(revision.id)).toEqual({
      started_at: LATER,
    });
    expect(db.prepare("SELECT event FROM autonomy_ledger WHERE event='etsy_revised'").get()).toEqual({
      event: "etsy_revised",
    });
  });

  it("replaces images without leaving the listing empty, and refuses to flatten prices that vary by option", async () => {
    const db = harness();
    connected(db);
    const live = publishedEtsyListing(db);
    db.prepare("UPDATE listing_packages SET mockups='[]' WHERE id=?").run(live.id);
    const revision = createRevision(db, live.id, { mockups: ["products/page.png"] }, {}, NOW);
    submitListing(db, revision.id, NOW);
    decideListing(db, revision.id, true, "owner", "", NOW);
    const { fetchFn, calls } = fakeEtsy({
      "GET /v3/application/listings/9001/images": () => ({
        body: { results: [{ listing_image_id: 11 }, { listing_image_id: 12 }] },
      }),
      "DELETE /v3/application/shops/777/listings/9001/images/\\d+": () => ({ body: {} }),
      "POST /v3/application/shops/777/listings/9001/images": () => ({ body: { listing_image_id: 13 } }),
    });
    await applyEtsyRevision(db, revision.id, { fetch: fetchFn, now: () => NOW });
    expect(calls.map((call) => `${call.method} ${call.url.pathname.split("/").slice(-2).join("/")}`)).toEqual([
      "GET 9001/images",
      "DELETE images/12",
      "POST 9001/images",
      "DELETE images/11",
    ]);

    const priced = createRevision(db, live.id, { price_minor: 400 }, {}, NOW);
    submitListing(db, priced.id, NOW);
    decideListing(db, priced.id, true, "owner", "", NOW);
    const varies = fakeEtsy({
      "GET /v3/application/listings/9001/inventory": () => ({
        body: { products: [{ offerings: [] }], price_on_property: [513] },
      }),
    });
    await expect(applyEtsyRevision(db, priced.id, { fetch: varies.fetchFn, now: () => NOW })).rejects.toThrow(
      "etsy_price_varies_by_option",
    );
    expect(getListing(db, priced.id)!.status).toBe("approved");
  });

  it("takes down listings of stopped initiatives, but never one the owner brought in", async () => {
    const db = harness();
    connected(db);
    const live = publishedEtsyListing(db);
    db.prepare("UPDATE initiatives SET status='stopped', stop_reason='no sales in 30 days live' WHERE id='o1'").run();
    db.prepare(
      `INSERT INTO listing_packages (id,business,platform,initiative_id,title,status,etsy_listing_id,etsy_state,etsy_adopted,created_at,updated_at)
       VALUES ('adopted','ventures','etsy','o1','Old planner','published','8000','active',1,1,1)`,
    ).run();
    const { fetchFn, calls } = fakeEtsy({
      "PATCH /v3/application/shops/777/listings/9001": () => ({ body: { listing_id: 9001, state: "inactive" } }),
    });
    expect(await deactivateStoppedListings(db, { fetch: fetchFn, now: () => NOW })).toBe(1);
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toEqual({ state: "inactive" });
    expect(getListing(db, live.id)!.etsy_state).toBe("inactive");
    expect(getListing(db, "adopted")!.etsy_state).toBe("active");
    expect(await deactivateStoppedListings(db, { fetch: fetchFn, now: () => NOW })).toBe(0);
  });

  it("mirrors the whole shop, follows changes made on Etsy, and lets the owner bring a listing in", async () => {
    const db = harness();
    connected(db);
    const live = publishedEtsyListing(db);
    const waiting = createListing(
      db,
      {
        business: "ventures",
        platform: "etsy",
        title: "Habit tracker",
        description: "Printable",
        price_minor: 300,
        files: ["products/planner.pdf"],
        project_id: "p1",
        taxonomy_id: 2078,
      },
      {},
      NOW,
    );
    submitListing(db, waiting.id, NOW);
    decideListing(db, waiting.id, true, "owner", "", NOW);
    db.prepare("UPDATE listing_packages SET etsy_listing_id='9002' WHERE id=?").run(waiting.id);
    const byState: Record<string, unknown[]> = {
      active: [
        {
          listing_id: 9001,
          title: "Budget planner (edited on Etsy)",
          description: "Printable monthly budget planner",
          tags: ["budget", "planner"],
          price: { amount: 600, divisor: 100, currency_code: "USD" },
          num_favorers: 3,
          url: "https://www.etsy.com/listing/9001/budget-planner",
        },
        {
          listing_id: 9002,
          title: "Habit tracker",
          description: "Printable",
          tags: [],
          price: { amount: 300, divisor: 100, currency_code: "USD" },
          url: "https://www.etsy.com/listing/9002/habit-tracker",
        },
      ],
      inactive: [
        { listing_id: 7000, title: "Old calendar", tags: ["calendar"], who_made: "i_did", when_made: "2020_2026" },
      ],
    };
    const { fetchFn } = fakeEtsy({
      "GET /v3/application/shops/777/receipts": () => ({ body: { results: [] } }),
      "GET /v3/application/shops/777/payment-account/ledger-entries": () => ({ body: { results: [] } }),
      "GET /v3/application/shops/777/listings": (_init, url) => ({
        body: { results: byState[url.searchParams.get("state") ?? ""] ?? [] },
        headers: { "x-limit-per-day": "10000", "x-remaining-today": "9000" },
      }),
    });
    const counts = await syncEtsy(db, { fetch: fetchFn, now: () => NOW });
    expect(counts).toMatchObject({ shop_listings: 3, changed_on_etsy: 1, listings: 1 });
    expect(getListing(db, live.id)).toMatchObject({ title: "Budget planner (edited on Etsy)", price_minor: 600 });
    expect(getListing(db, waiting.id)).toMatchObject({ status: "published", etsy_state: "active" });
    expect(etsyQuotaLow(db, NOW)).toBe(false);

    const shop = etsyShopListings(db);
    expect(shop.map((item) => [item.listing_id, item.state, item.package_id !== null])).toEqual([
      ["9001", "active", true],
      ["9002", "active", true],
      ["7000", "inactive", false],
    ]);
    expect(() => adoptEtsyListing(db, "9001", {}, NOW)).toThrow("etsy_listing_already_in_atlas");
    expect(() => adoptEtsyListing(db, "7000", { initiative_id: "nope" }, NOW)).toThrow("invalid_initiative_id");
    const adopted = adoptEtsyListing(db, "7000", { initiative_id: "o1" }, NOW);
    expect(adopted).toMatchObject({
      status: "published",
      etsy_adopted: 1,
      initiative_id: "o1",
      project_id: "p1",
      tags: ["calendar"],
      when_made: "2020_2026",
    });
    // An adopted listing can be revised like any live one.
    expect(createRevision(db, adopted.id, { title: "Old calendar 2027" }, {}, NOW).revision_of).toBe(adopted.id);

    // Gone from Etsy on a complete read: marked removed.
    byState.active = byState.active.slice(1);
    await syncEtsy(db, { fetch: fetchFn, now: () => NOW + 1000 });
    expect(getListing(db, live.id)!.etsy_state).toBe("removed");
  });

  it("tracks Etsy's daily allowance and pauses background work when it is nearly used", async () => {
    const db = harness();
    connected(db);
    approvedEtsyListing(db);
    const { fetchFn, calls } = fakeEtsy({
      "GET /v3/application/users/me": () => ({
        body: { user_id: 42, shop_id: 777 },
        headers: { "x-limit-per-day": "10000", "x-remaining-today": "120" },
      }),
    });
    await etsyRequest(db, "GET", "/users/me", {}, { fetch: fetchFn, now: () => NOW });
    expect(etsyQuotaLow(db, NOW)).toBe(true);
    expect(etsyQuotaLow(db, NOW + 86_400_001)).toBe(false);
    await runEtsyTick(db, { fetch: fetchFn, now: () => NOW });
    expect(calls).toHaveLength(1);
    expect(String(db.prepare("SELECT last_sync_error FROM etsy_connection").get()!.last_sync_error)).toContain(
      "120 left",
    );
  });
});

describe("Etsy sync date windows", () => {
  const NOW_S = Math.floor(NOW / 1000);
  const LIMIT_S = 2_678_400; // Etsy: min_created..max_created at most 31 days

  /** Fake Etsy for receipts, ledger entries and listings. `ledger` and `receipts` answer one page for a window. */
  function windowEtsy(opts: {
    ledger?: (min: number, max: number, offset: number) => unknown[] | { status: number };
    receipts?: (min: number, max: number, offset: number) => unknown[];
  }) {
    return fakeEtsy({
      "GET /v3/application/shops/777/receipts": (_init, url) => {
        const q = url.searchParams;
        return {
          body: {
            results:
              opts.receipts?.(
                Number(q.get("min_last_modified")),
                Number(q.get("max_last_modified")),
                Number(q.get("offset")),
              ) ?? [],
          },
        };
      },
      "GET /v3/application/shops/777/payment-account/ledger-entries": (_init, url) => {
        const q = url.searchParams;
        const result = opts.ledger?.(
          Number(q.get("min_created")),
          Number(q.get("max_created")),
          Number(q.get("offset")),
        );
        if (result && !Array.isArray(result)) return { status: result.status, body: { error: "boom" } };
        return { body: { results: result ?? [] } };
      },
      "GET /v3/application/shops/777/listings": () => ({ body: { results: [] } }),
    });
  }
  const windows = (calls: Array<{ url: URL }>, path: string, min: string, max: string) =>
    calls
      .filter((call) => call.url.pathname.endsWith(path) && call.url.searchParams.get("offset") === "0")
      .map((call) => [Number(call.url.searchParams.get(min)), Number(call.url.searchParams.get(max))]);
  const fee = (id: number, at: number) => ({
    entry_id: id,
    amount: -20,
    currency: "USD",
    description: "listing fee",
    ledger_type: "listing",
    created_timestamp: at,
  });

  it("reads the first 90 days in consecutive windows Etsy accepts, for ledger entries and receipts", async () => {
    const db = harness();
    connected(db);
    const { fetchFn, calls } = windowEtsy({});
    const counts = await syncEtsy(db, { fetch: fetchFn, now: () => NOW });
    for (const [path, min, max] of [
      ["/ledger-entries", "min_created", "max_created"],
      ["/receipts", "min_last_modified", "max_last_modified"],
    ] as const) {
      const spans = windows(calls, path, min, max);
      expect(spans).toHaveLength(3);
      expect(spans[0][0]).toBe(NOW_S - 90 * 86_400);
      expect(spans.at(-1)![1]).toBe(NOW_S);
      for (const [index, [from, to]] of spans.entries()) {
        expect(to - from).toBeGreaterThan(0);
        expect(to - from).toBeLessThanOrEqual(LIMIT_S);
        if (index > 0) expect(from).toBe(spans[index - 1][1]);
      }
    }
    expect(counts.windows).toBe(6);
    expect(db.prepare("SELECT receipts_after, ledger_after FROM etsy_connection").get()).toEqual({
      receipts_after: NOW_S,
      ledger_after: NOW_S,
    });
  });

  it("pages through each window, splits a window too full to page, and writes each Etsy record once", async () => {
    const db = harness();
    connected(db);
    const busyFrom = NOW_S - 20 * 86_400;
    const { fetchFn, calls } = windowEtsy({
      ledger: (min, max, offset) => {
        // A crowded month: more than 2,000 entries when asked for more than 10 days at once.
        if (max > busyFrom && max - min > 10 * 86_400)
          return Array.from({ length: 100 }, (_, i) => fee(50_000 + i, min));
        // Otherwise 150 entries per window (two pages); ids repeat across windows, as at window edges.
        if (offset === 0) return Array.from({ length: 100 }, (_, i) => fee(1 + i, min));
        if (offset === 100) return Array.from({ length: 50 }, (_, i) => fee(101 + i, min));
        return [];
      },
    });
    const counts = await syncEtsy(db, { fetch: fetchFn, now: () => NOW });
    const ledgerCalls = calls.filter((call) => call.url.pathname.endsWith("/ledger-entries"));
    for (const call of ledgerCalls) {
      const q = call.url.searchParams;
      expect(Number(q.get("max_created")) - Number(q.get("min_created"))).toBeLessThanOrEqual(LIMIT_S);
      expect(q.get("limit")).toBe("100");
    }
    // The windows that were finally read cover the whole range with no gap.
    const read = windows(calls, "/ledger-entries", "min_created", "max_created").filter(
      ([min, max]) => !(max > busyFrom && max - min > 10 * 86_400),
    );
    expect(read[0][0]).toBe(NOW_S - 90 * 86_400);
    expect(read.at(-1)![1]).toBe(NOW_S);
    for (let i = 1; i < read.length; i++) expect(read[i][0]).toBe(read[i - 1][1]);
    expect(counts.fees).toBe(150);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE source='etsy_fee'").get()).toEqual({ n: 150 });
  });

  it("starts the next sync from the checkpoint with a one-hour overlap, and repeats without duplicating revenue", async () => {
    const db = harness();
    connected(db);
    const receipt = {
      receipt_id: 555,
      status: "paid",
      is_paid: true,
      subtotal: { amount: 450, divisor: 100, currency_code: "USD" },
      created_timestamp: NOW_S - 600,
      transactions: [],
    };
    const first = windowEtsy({ receipts: () => [receipt], ledger: () => [fee(9, NOW_S - 600)] });
    await syncEtsy(db, { fetch: first.fetchFn, now: () => NOW });
    const LATER = NOW + 30 * 60_000;
    const second = windowEtsy({ receipts: () => [receipt], ledger: () => [fee(9, NOW_S - 600)] });
    await syncEtsy(db, { fetch: second.fetchFn, now: () => LATER });
    expect(windows(second.calls, "/ledger-entries", "min_created", "max_created")).toEqual([
      [NOW_S - 3600, Math.floor(LATER / 1000)],
    ]);
    expect(windows(second.calls, "/receipts", "min_last_modified", "max_last_modified")).toEqual([
      [NOW_S - 3600, Math.floor(LATER / 1000)],
    ]);
    expect(
      db.prepare("SELECT source, COUNT(*) AS n, SUM(amount_minor) AS total FROM ledger_entries GROUP BY source").all(),
    ).toEqual([
      { source: "etsy_fee", n: 1, total: 20 },
      { source: "etsy_receipt", n: 1, total: 450 },
    ]);
  });

  it("keeps the checkpoint at the last completed window when a later window fails, and resumes there", async () => {
    const db = harness();
    connected(db);
    const firstWindowEnd = NOW_S - 90 * 86_400 + 30 * 86_400;
    const failing = windowEtsy({ ledger: (min) => (min >= firstWindowEnd ? { status: 500 } : []) });
    await expect(syncEtsy(db, { fetch: failing.fetchFn, now: () => NOW })).rejects.toThrow("etsy_api_500");
    expect(db.prepare("SELECT ledger_after, last_sync_error FROM etsy_connection").get()).toMatchObject({
      ledger_after: firstWindowEnd,
      last_sync_error: expect.stringContaining("etsy_api_500"),
    });
    const retry = windowEtsy({});
    await syncEtsy(db, { fetch: retry.fetchFn, now: () => NOW });
    const spans = windows(retry.calls, "/ledger-entries", "min_created", "max_created");
    expect(spans[0][0]).toBe(firstWindowEnd - 3600);
    expect(spans.at(-1)![1]).toBe(NOW_S);
  });

  it("re-reads a requested history in windows without moving the checkpoint back", async () => {
    const db = harness();
    connected(db);
    await syncEtsy(db, { fetch: windowEtsy({}).fetchFn, now: () => NOW });
    const { fetchFn, calls } = windowEtsy({});
    await expect(syncEtsy(db, { fetch: fetchFn, now: () => NOW }, { historyDays: 0 })).rejects.toThrow(
      "invalid_history_days",
    );
    await syncEtsy(db, { fetch: fetchFn, now: () => NOW }, { historyDays: 400 });
    const spans = windows(calls, "/ledger-entries", "min_created", "max_created");
    expect(spans).toHaveLength(14);
    expect(spans[0][0]).toBe(NOW_S - 400 * 86_400);
    expect(spans.every(([from, to]) => to - from <= LIMIT_S)).toBe(true);
    expect(db.prepare("SELECT ledger_after FROM etsy_connection").get()).toEqual({ ledger_after: NOW_S });
  });

  it("spaces requests to stay under 10 per second", async () => {
    const db = harness();
    connected(db);
    const previous = process.env.ETSY_MIN_INTERVAL_MS;
    process.env.ETSY_MIN_INTERVAL_MS = "125";
    const waits: number[] = [];
    try {
      const { fetchFn } = fakeEtsy({ "GET /v3/application/users/me": () => ({ body: { user_id: 42 } }) });
      const deps = { fetch: fetchFn, now: () => NOW, sleep: async (ms: number) => void waits.push(ms) };
      await Promise.all([1, 2, 3].map(() => etsyRequest(db, "GET", "/users/me", {}, deps)));
    } finally {
      process.env.ETSY_MIN_INTERVAL_MS = previous;
    }
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(100);
    expect(waits[1]).toBeGreaterThan(waits[0]);
  });
});

describe("research tools and listing checks", () => {
  it("searches live Etsy listings with only the app key and summarizes prices, attention and tags", async () => {
    const db = harness();
    connected(db);
    const listing = (id: number, amount: number, favorers: number, tags: string[], currency = "USD") => ({
      listing_id: id,
      title: `Wedding planner ${id}`,
      price: { amount, divisor: 100, currency_code: currency },
      num_favorers: favorers,
      views: favorers * 10,
      tags,
      listing_type: "download",
      file_data: "1 PDF",
      original_creation_timestamp: Math.floor(NOW / 1000),
      url: `https://www.etsy.com/listing/${id}/x?ref=search`,
    });
    const { fetchFn, calls } = fakeEtsy({
      "GET /v3/application/listings/active": () => ({
        body: {
          count: 1234,
          results: [
            listing(1, 500, 10, ["wedding", "planner"]),
            listing(2, 700, 30, ["wedding", "binder"]),
            listing(3, 1200, 20, ["Wedding"]),
            listing(4, 900, 0, ["mariage"], "EUR"),
          ],
        },
      }),
    });
    const result = await searchEtsyListings(
      db,
      { keywords: "printable wedding planner", sort_on: "price", max_price: 20, limit: 4 },
      { fetch: fetchFn, now: () => NOW },
    );
    const call = calls[0];
    expect((call.init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(Object.fromEntries(call.url.searchParams)).toEqual({
      keywords: "printable wedding planner",
      sort_on: "price",
      sort_order: "desc",
      limit: "4",
      offset: "0",
      max_price: "20",
    });
    expect(result).toMatchObject({
      total_active_listings: 1234,
      returned: 4,
      summary: {
        price_currency: "USD",
        price_min: 5,
        price_median: 7,
        price_max: 12,
        average_favorites: 15,
        average_views: 150,
        digital_share: 1,
      },
    });
    expect(result.summary.common_tags[0]).toEqual({ tag: "wedding", count: 3 });
    expect(result.listings[0].url).toBe("https://www.etsy.com/listing/1/x");
    await expect(searchEtsyListings(db, { keywords: "x" })).rejects.toThrow("invalid_keywords");
    await expect(searchEtsyListings(db, { keywords: "planner", sort_on: "sales" })).rejects.toThrow("invalid_sort_on");
    await expect(searchEtsyListings(db, { keywords: "planner", limit: 500 })).rejects.toThrow("invalid_limit");
  });

  it("refuses Etsy tags longer than 20 characters when the package is written, not when it is pushed", () => {
    const db = harness();
    const base = {
      business: "ventures",
      title: "Planner",
      description: "Printable",
      price_minor: 300,
      files: ["products/planner.pdf"],
      project_id: "p1",
    };
    const longTag = "printable budget planner";
    expect(() => createListing(db, { ...base, platform: "etsy", tags: [longTag] }, {}, NOW)).toThrow(
      "etsy_tag_too_long",
    );
    expect(createListing(db, { ...base, platform: "itch", tags: [longTag] }, {}, NOW).tags).toEqual([longTag]);
    const draft = createListing(db, { ...base, platform: "etsy", tags: ["budget planner"] }, {}, NOW);
    expect(() => updateListing(db, draft.id, { tags: [longTag] }, NOW)).toThrow("etsy_tag_too_long");
    const live = publishedEtsyListing(db);
    expect(() => createRevision(db, live.id, { tags: [longTag] }, {}, NOW)).toThrow("etsy_tag_too_long");
  });

  it("keeps the default playbook current until the owner edits it", () => {
    const db = harness();
    getPlaybook(db, "etsy_digital");
    db.prepare("UPDATE playbooks SET definition=? WHERE key='etsy_digital'").run(
      JSON.stringify({ research: { ...getPlaybook(db, "etsy_digital")!.research, instructions: "old" }, steps: [] }),
    );
    expect(getPlaybook(db, "etsy_digital")!.research.instructions).toContain("etsy.search");
    const edited = getPlaybook(db, "etsy_digital")!;
    savePlaybook(
      db,
      "etsy_digital",
      { research: { ...edited.research, instructions: "Owner's own research notes" } },
      NOW,
    );
    expect(getPlaybook(db, "etsy_digital")!.research.instructions).toBe("Owner's own research notes");
  });
});

describe("Etsy shop setup", () => {
  const shopBody = (overrides: Record<string, unknown> = {}) => ({
    shop_id: 777,
    shop_name: "EduardoCapitalShop",
    title: "",
    announcement: "",
    digital_sale_message: "",
    icon_url_fullxfull: null,
    image_url_760x100: null,
    url: "https://www.etsy.com/shop/EduardoCapitalShop?ref=x",
    listing_active_count: 0,
    transaction_sold_count: 0,
    review_count: 0,
    ...overrides,
  });
  const ctx = () => ({ projectId: "p1", projectPath: projectDir, agentId: "lead-d", taskId: null });
  const goalRow = (db: DatabaseSync) => {
    db.prepare(
      "INSERT INTO business_goals(id,business,project_id,metric,target,period_start,period_end,created_at,updated_at) VALUES ('g1','ventures','p1','verified_revenue',2000,?,?,?,?)",
    ).run(NOW, NOW + 30 * 86_400_000, NOW, NOW);
    return db.prepare("SELECT * FROM business_goals WHERE id='g1'").get() as Record<string, unknown>;
  };

  it("reads the shop and lists what a new shop is missing, including what only the owner can upload", async () => {
    const db = harness();
    connected(db);
    const { fetchFn } = fakeEtsy({
      "GET /v3/application/shops/777": () => ({ body: shopBody() }),
      "GET /v3/application/shops/777/sections": () => ({ body: { results: [] } }),
    });
    await refreshShopProfile(db, { fetch: fetchFn, now: () => NOW });
    const state = shopProfile(db);
    expect(state.profile).toMatchObject({
      shop_name: "EduardoCapitalShop",
      has_logo: false,
      url: "https://www.etsy.com/shop/EduardoCapitalShop",
    });
    expect(state.gaps).toEqual([
      "logo (owner uploads the file agents make)",
      "banner (owner uploads the file agents make)",
      "shop title (headline)",
      "announcement",
      "message sent with digital orders",
      "shop sections",
      "About story (owner pastes the text agents write)",
    ]);
    expect(state.can_change).toBe(false);
    expect(shopNeedsSetup(db)).toBe(true);
  });

  it("queues one shop setup task once the goal has a strategy, and not again while it is open", async () => {
    const db = harness();
    connected(db);
    const { fetchFn } = fakeEtsy({
      "GET /v3/application/shops/777": () => ({ body: shopBody() }),
      "GET /v3/application/shops/777/sections": () => ({ body: { results: [] } }),
    });
    await refreshShopProfile(db, { fetch: fetchFn, now: () => NOW });
    const goal = goalRow(db);
    const taskId = queueShopSetupIfNeeded(db, goal, "Sell event-rental trackers and wedding workbooks.", NOW);
    expect(taskId).toBeTruthy();
    const task = db.prepare("SELECT * FROM tasks WHERE id=?").get(taskId) as Record<string, string>;
    expect(task).toMatchObject({
      department_id: "design",
      playbook_step: "shop_setup",
      goal_id: "g1",
      work_type: "shop_admin",
      status: "planned",
      origin: "autonomy",
    });
    expect(task.description).toContain("etsy.shop_propose");
    expect(task.description).toContain("Sell event-rental trackers");
    expect(queueShopSetupIfNeeded(db, goal, "", NOW + 1000)).toBeNull();
  });

  it("validates a proposed setup, has the VPs approve it, applies text and new sections, and leaves files to the owner", async () => {
    const db = harness();
    connected(db);
    expect(() => proposeShopChange(db, { title: "x".repeat(56) }, ctx(), NOW)).toThrow("invalid_title");
    expect(() => proposeShopChange(db, { sections: ["x".repeat(25)] }, ctx(), NOW)).toThrow("invalid_sections");
    expect(() => proposeShopChange(db, { logo: "../outside.png" }, ctx(), NOW)).toThrow("invalid_logo");
    expect(() => proposeShopChange(db, {}, ctx(), NOW)).toThrow("shop_change_empty");
    const change = proposeShopChange(
      db,
      {
        title: "Practical planners for event pros",
        announcement: "Instant downloads.",
        about: "We make tools for small event businesses.",
        digital_sale_message: "Download your files from Purchases.",
        sections: ["Event rentals", "Weddings"],
        logo: "products/page.png",
        banner: "products/page.png",
      },
      ctx(),
      NOW,
    );
    expect(change.status).toBe("ready");
    expect(() => proposeShopChange(db, { title: "Another" }, ctx(), NOW)).toThrow("shop_change_open");
    expect(listPendingApprovals(db, 100, "all").find((item) => item.kind === "shop_change")).toMatchObject({
      title: "Practical planners for event pros",
      sections: ["Event rentals", "Weddings"],
      logo_path: "products/page.png",
    });
    expect(shopChangeApprover("ventures")).toBe("vp");
    expect(() => decideShopChange(db, change.id, true, "someone", "", NOW)).toThrow("shop_change_decider_forbidden");
    decideShopChange(db, change.id, true, "vp:a,b", "", NOW);

    const { fetchFn, calls } = fakeEtsy({
      "PUT /v3/application/shops/777": () => ({ body: {} }),
      "GET /v3/application/shops/777/sections": () => ({
        body: { results: [{ shop_section_id: 1, title: "Weddings" }] },
      }),
      "POST /v3/application/shops/777/sections": () => ({ body: {} }),
      "GET /v3/application/shops/777": () => ({ body: shopBody({ title: "Practical planners for event pros" }) }),
    });
    // Connected before shops_w was asked for: nothing is sent, and the owner is told to reconnect.
    const waiting = await applyShopChange(db, change.id, { fetch: fetchFn, now: () => NOW });
    expect(waiting).toMatchObject({ status: "approved", error: expect.stringContaining("Reconnect Etsy") });
    expect(calls).toHaveLength(0);
    db.prepare("UPDATE etsy_connection SET granted_scopes=? WHERE id=1").run(
      "listings_r listings_w shops_r shops_w transactions_r",
    );
    const applied = await applyShopChange(db, change.id, { fetch: fetchFn, now: () => NOW });
    expect(applied.status).toBe("applied");
    const put = calls.find((call) => call.method === "PUT")!;
    expect(Object.fromEntries(new URLSearchParams(String(put.init.body)))).toEqual({
      title: "Practical planners for event pros",
      announcement: "Instant downloads.",
      digital_sale_message: "Download your files from Purchases.",
    });
    const created = calls
      .filter((call) => call.method === "POST")
      .map((call) => new URLSearchParams(String(call.init.body)).get("title"));
    expect(created).toEqual(["Event rentals"]);
    expect(markShopChangeOwnerDone(db, change.id, NOW).owner_done_at).toBe(NOW);
  });

  it("records listing views from Etsy and measures them per variant", async () => {
    const db = harness();
    connected(db);
    publishedEtsyListing(db);
    let views = 40;
    const { fetchFn } = fakeEtsy({
      "GET /v3/application/shops/777/receipts": () => ({ body: { results: [] } }),
      "GET /v3/application/shops/777/payment-account/ledger-entries": () => ({ body: { results: [] } }),
      "GET /v3/application/shops/777/listings": (_init, url) => ({
        body: {
          results: url.searchParams.get("state") === "active" ? [{ listing_id: 9001, num_favorers: 2, views }] : [],
        },
      }),
      "GET /v3/application/shops/777": () => ({ body: shopBody() }),
      "GET /v3/application/shops/777/sections": () => ({ body: { results: [] } }),
    });
    startVariant(db, { initiative_id: "o1", variable: "title", value: "New title" }, {}, NOW - 1);
    await syncEtsy(db, { fetch: fetchFn, now: () => NOW });
    views = 100;
    await syncEtsy(db, { fetch: fetchFn, now: () => NOW + 30 * 60_000 });
    expect(etsyShopListings(db)[0]).toMatchObject({ listing_id: "9001", views: 100 });
    expect(variantResults(db, "o1", NOW + 30 * 60_000)[0]).toMatchObject({ variable: "title", views_gained: 60 });
    expect(db.prepare("SELECT views FROM initiative_metrics ORDER BY recorded_at").all()).toEqual([
      { views: 40 },
      { views: 100 },
    ]);
  });

  it("keeps free-time suggestions away from projects that have a goal", () => {
    const prompt = buildProposalPrompt(
      { id: "a1", name: "Iris", role: "team_leader", department_id: "design" } as never,
      {
        department: { name: "Design", description: null, prompt: null },
        projects: [],
        goalProjects: [{ id: "p1", name: "Etsy Shop" }],
        recentTasks: [],
        openDepartmentTasks: [],
        pastProposals: [],
        businesses: [],
      },
    );
    expect(prompt).toContain("Run by the goal planner, not by suggestions: Etsy Shop");
    const parsed = parseProposalReply(
      JSON.stringify({
        proposals: [
          { title: "Design a baby shower bundle", description: "x", reason: "y", project_id: "p1" },
          { title: "Tidy the design system", description: "x", reason: "y", project_id: null, business: "ventures" },
        ],
      }),
      { projectIds: new Set(), existingTitles: [], goalProjectIds: new Set(["p1"]) },
    );
    expect(parsed?.map((item) => item.title)).toEqual(["Tidy the design system"]);
  });
});

describe("costs and profit", () => {
  it("adds recurring costs (shared ones split across businesses) and only measures profit goals once costs are confirmed", () => {
    const db = harness();
    saveRecurringCost(
      db,
      { label: "Claude Max", category: "ai_tools", amount_minor: 30000, business: null },
      undefined,
      NOW,
    );
    saveRecurringCost(
      db,
      { label: "Etsy Plus", category: "software", amount_minor: 1000, business: "ventures" },
      undefined,
      NOW,
    );
    upsertProviderLedgerEntry(db, {
      business: "ventures",
      kind: "revenue",
      amount_minor: 50000,
      currency: "USD",
      source: "etsy_receipt",
      external_id: "r1",
      verified: true,
      description: "order",
      occurred_at: NOW - 86_400_000,
    });
    const month = 365.25 / 12;
    const from = NOW - month * 86_400_000;
    const lines = profitLines(
      db,
      db.prepare("SELECT * FROM ledger_entries").all() as Record<string, unknown>[],
      from,
      NOW,
    );
    const ventures = lines.find((line) => line.business === "ventures")!;
    expect(ventures.recurring_minor).toBe(10000 + 1000);
    expect(ventures.profit_minor).toBe(50000 - 11000);
    expect(lines.find((line) => line.business === "tech")!.profit_minor).toBe(-10000);
    const goal = { business: "ventures", metric: "profit", currency: "USD", period_start: from, period_end: NOW };
    expect(getFinancialGoalProgress(db, goal)).toMatchObject({ progress: null, costs_complete: false });
    setCostsComplete(db, true, NOW);
    expect(getFinancialGoalProgress(db, goal)).toMatchObject({ progress: 390, costs_complete: true });
    expect(financeOverview(db).profit.recurring_costs).toHaveLength(2);
  });
});

describe("image studio", () => {
  it("records an image an agent generated itself, copying it into atlas-media once", () => {
    const db = harness();
    const ctx = {
      business: "ventures" as const,
      projectId: "p1",
      projectPath: projectDir,
      initiativeId: "o1",
      agentId: "lead-d",
    };
    const asset = registerImage(
      db,
      { path: "products/page.png", prompt: "Planner on a desk", tags: ["Lifestyle"] },
      ctx,
      NOW,
    );
    expect(asset).toMatchObject({
      kind: "generated",
      source: "codex image generation",
      path: `atlas-media/page-${NOW}.png`,
      prompt: "Planner on a desk",
      width: 1,
      height: 1,
      cost_minor: 0,
      initiative_id: "o1",
      tags: ["lifestyle"],
    });
    expect(fs.existsSync(path.join(projectDir, asset.path))).toBe(true);
    expect(registerImage(db, { path: asset.path }, ctx, NOW + 1).id).toBe(asset.id);
    expect(() => registerImage(db, { path: "../outside.png" }, ctx, NOW)).toThrow("studio_image_outside_project");
    expect(() => registerImage(db, { path: "products/planner.pdf" }, ctx, NOW)).toThrow(
      "studio_image_type_not_supported",
    );
    expect(() => registerImage(db, { path: "products/missing.png" }, ctx, NOW)).toThrow("studio_image_missing");
  });

  it("renders a mockup into the project's atlas-media folder and the media library", async () => {
    const db = harness();
    const html = mockupHtml(
      "grid",
      { title: "Planner <b>", subtitle: "", background: "#fff", accent: "#000", text: "#111", images: ["data:x"] },
      2000,
      1600,
    );
    expect(html).toContain("Planner &lt;b&gt;");
    const rendered: string[] = [];
    const asset = await renderMockup(
      db,
      { template: "grid", title: "Budget planner", images: ["products/page.png"], tags: ["Planner"] },
      { business: "ventures", projectId: "p1", projectPath: projectDir, initiativeId: "o1" },
      { now: () => NOW, render: async (doc) => (rendered.push(doc), Buffer.from("png")) },
    );
    expect(asset).toMatchObject({ kind: "mockup", project_id: "p1", cost_minor: 0, tags: ["planner"] });
    expect(asset.path).toMatch(/^atlas-media\/budget-planner-grid-\d+\.png$/);
    expect(fs.existsSync(path.join(projectDir, asset.path))).toBe(true);
    expect(rendered[0]).toContain("data:image/png;base64,");
    await expect(
      renderMockup(
        db,
        { template: "grid", title: "x y", images: ["../secret.png"] },
        { business: "ventures", projectId: "p1", projectPath: projectDir },
      ),
    ).rejects.toThrow("studio_image_outside_project");
    expect(searchMedia(db, { query: "planner" })).toHaveLength(1);
  });

  it.skipIf(!findChrome(null))(
    "renders a real PNG with the installed browser",
    async () => {
      const db = harness();
      const asset = await renderMockup(
        db,
        { template: "cover", title: "Real render", subtitle: "Test", width: 800, height: 640 },
        { business: "ventures", projectId: "p1", projectPath: projectDir },
      );
      const bytes = fs.readFileSync(path.join(projectDir, asset.path));
      expect(bytes.subarray(1, 4).toString()).toBe("PNG");
    },
    60_000,
  );

  it("keeps image generation off until configured, and stops at the monthly cap with a recorded cost", async () => {
    const db = harness();
    const ctx = { business: "ventures" as const, projectId: "p1", projectPath: projectDir, initiativeId: "o1" };
    await expect(generateImage(db, { prompt: "a cozy desk" }, ctx)).rejects.toThrow("studio_generation_off");
    saveStudioSettings(
      db,
      {
        provider: "openai_compatible",
        base_url: "https://images.example/v1",
        model: "img-1",
        cost_per_image_minor: 4,
        monthly_cap_minor: 6,
        enabled: true,
      },
      NOW,
    );
    const fetchFn = (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("img").toString("base64") }] }), {
        status: 200,
      })) as typeof fetch;
    const asset = await generateImage(db, { prompt: "a cozy desk" }, ctx, { fetch: fetchFn, now: () => NOW });
    expect(asset).toMatchObject({ kind: "generated", cost_minor: 4, source: "provider:img-1" });
    expect(db.prepare("SELECT source, amount_minor, verified, initiative_id FROM ledger_entries").get()).toEqual({
      source: "tool_usage",
      amount_minor: 4,
      verified: 0,
      initiative_id: "o1",
    });
    await expect(
      generateImage(db, { prompt: "another desk" }, ctx, { fetch: fetchFn, now: () => NOW }),
    ).rejects.toThrow("studio_monthly_cap_reached");
  });
});

describe("experiments and auto-stop", () => {
  it("blocks new work past the budget or task limit, and stops by the owner's rules", () => {
    const db = harness();
    expect(initiativeBudgetBlock(db, "o1")).toBeNull();
    upsertProviderLedgerEntry(db, {
      business: "ventures",
      kind: "expense",
      amount_minor: 500,
      currency: "USD",
      source: "tool_usage",
      external_id: "x",
      verified: false,
      description: "images",
      occurred_at: NOW,
      initiative_id: "o1",
    });
    expect(initiativeBudgetBlock(db, "o1")).toMatch(/budget reached/);
    expect(initiativeStartBlock(db, "o1", NOW)).toMatch(/budget reached/);
    expect(evaluateInitiatives(db, NOW)).toEqual(["o1"]);
    expect(db.prepare("SELECT status, stop_reason FROM initiatives WHERE id='o1'").get()).toEqual({
      status: "stopped",
      stop_reason: "budget of 5.00 USD used with no sales",
    });
    expect(db.prepare("SELECT event FROM autonomy_ledger WHERE event='auto_stopped'").get()).toBeTruthy();
    restartInitiative(db, "o1", NOW + 1);
    expect(db.prepare("SELECT status FROM initiatives WHERE id='o1'").get()).toEqual({ status: "in_progress" });
    saveExperimentRules(db, { enabled: false });
    expect(evaluateInitiatives(db, NOW + 2)).toEqual([]);
  });

  it("stops a launched initiative with no sales after its time limit, but not one that sells", () => {
    const db = harness();
    db.prepare(
      "UPDATE initiatives SET budget=0, status='launched', launched_at=?, time_limit_days=10 WHERE id='o1'",
    ).run(NOW - 11 * 86_400_000);
    db.exec(
      "INSERT INTO initiatives (id,business,project_id,goal_id,title,status,launched_at,time_limit_days,created_at,updated_at) VALUES ('o2','ventures','p1','g0','Seller','launched',1,10,1,1)",
    );
    upsertProviderLedgerEntry(db, {
      business: "ventures",
      kind: "revenue",
      amount_minor: 900,
      currency: "USD",
      source: "etsy_receipt",
      external_id: "s",
      verified: true,
      description: "sale",
      occurred_at: NOW,
      initiative_id: "o2",
    });
    expect(evaluateInitiatives(db, NOW)).toEqual(["o1"]);
  });

  it("measures each variant over its own window", () => {
    const db = harness();
    const first = startVariant(
      db,
      { initiative_id: "o1", variable: "price", value: "4.50" },
      {},
      NOW - 10 * 86_400_000,
    );
    upsertProviderLedgerEntry(db, {
      business: "ventures",
      kind: "revenue",
      amount_minor: 450,
      currency: "USD",
      source: "etsy_receipt",
      external_id: "a",
      verified: true,
      description: "sale",
      occurred_at: NOW - 9 * 86_400_000,
      initiative_id: "o1",
    });
    startVariant(db, { initiative_id: "o1", variable: "price", value: "6.00" }, {}, NOW - 5 * 86_400_000);
    const results = variantResults(db, "o1", NOW);
    expect(results.find((v) => v.id === first.id)).toMatchObject({ sales: 1, revenue_minor: 450 });
    expect(results.find((v) => v.value === "6.00")).toMatchObject({ sales: 0, ended_at: null });
  });
});

describe("Etsy playbook", () => {
  it("records research ideas under the current goal and its business's playbook", () => {
    const db = harness();
    const playbook = getPlaybook(db, "etsy_digital")!;
    expect(playbook.steps.map((s) => [s.key, s.work_type ?? null, s.kind ?? "task"])).toEqual([
      ["build", "product", "task"],
      ["mockups", "design", "task"],
      ["listing", "listing", "task"],
      ["publish", null, "owner_approval"],
    ]);
    expect(playbook.steps[2].wait_for).toBe("shop_setup");
    expect(playbook.caps).toEqual({ task_cap_daily: 3 });
    db.exec(
      "INSERT INTO tasks (id,title,status,created_at,updated_at) VALUES ('t-research','Research','in_progress',1,1)",
    );
    // Every initiative belongs to a goal: with only an expired goal, research ideas are refused.
    expect(() =>
      proposeInitiative(
        db,
        { title: "Orphan idea", description: "No goal to serve" },
        { business: "ventures", projectId: "p1", taskId: "t-research" },
        NOW,
      ),
    ).toThrow("initiative_needs_goal");
    db.exec(
      "INSERT INTO business_goals (id,business,metric,target,period_start,period_end,created_at,updated_at) VALUES ('gcur','ventures','revenue',2000,0,9000000000000000,1,1)",
    );
    const idea = proposeInitiative(
      db,
      { title: "Wedding seating chart template", description: "Evidence...", demand_score: 70, budget: 3 },
      { business: "ventures", taskId: "t-research" },
      NOW,
    );
    expect(idea).toMatchObject({
      status: "proposed",
      goal_id: "gcur",
      playbook: "etsy_digital",
      budget: 3,
      project_id: null,
    });
    expect(() =>
      proposeInitiative(
        db,
        { title: "Wedding seating chart template" },
        { business: "ventures", taskId: "t-research" },
        NOW,
      ),
    ).toThrow("initiative_duplicate");
  });

  it("lets the owner edit the steps but not point them at a missing department", () => {
    const db = harness();
    const playbook = getPlaybook(db, "etsy_digital")!;
    const edited = savePlaybook(
      db,
      "etsy_digital",
      { steps: [{ ...playbook.steps[0], title: "Build {title} carefully" }] },
      NOW,
    );
    expect(edited.steps).toHaveLength(1);
    expect(() =>
      savePlaybook(db, "etsy_digital", { steps: [{ ...playbook.steps[0], department_id: "nope" }] }),
    ).toThrow("department_not_found");
  });
});

describe("ledger sources on an older database", () => {
  it("widens the source check without losing rows", () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    applyBaseSchema(db);
    applyTaskSchemaMigrations(db);
    ensureAutonomySchema(db);
    db.exec(`CREATE TABLE deals (id TEXT PRIMARY KEY,business TEXT NOT NULL,contact_id TEXT REFERENCES business_contacts(id) ON DELETE SET NULL,project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,initiative_id TEXT REFERENCES initiatives(id),title TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'lead',expected_amount_minor INTEGER NOT NULL DEFAULT 0,currency TEXT NOT NULL DEFAULT 'USD',notes TEXT NOT NULL DEFAULT '',generated_at INTEGER,published_at INTEGER,ordered_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE ledger_entries (id TEXT PRIMARY KEY,business TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('revenue','expense')),amount_minor INTEGER NOT NULL,currency TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('manual','square_payment','square_fee')),external_id TEXT,verified INTEGER NOT NULL DEFAULT 0,deal_id TEXT REFERENCES deals(id),initiative_id TEXT REFERENCES initiatives(id),description TEXT NOT NULL DEFAULT '',occurred_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(source,external_id));
      INSERT INTO ledger_entries VALUES ('old','ventures','revenue',100,'USD','square_payment','x',1,NULL,NULL,'',1,1,1);`);
    ensureFinanceSchema(db);
    upsertProviderLedgerEntry(db, {
      business: "ventures",
      kind: "expense",
      amount_minor: 5,
      currency: "USD",
      source: "tool_usage",
      external_id: "t",
      verified: false,
      description: "img",
      occurred_at: 2,
    });
    expect(db.prepare("SELECT id FROM ledger_entries ORDER BY id").all()).toHaveLength(2);
    expect(getListing).toBeTypeOf("function");
  });
});

describe("agent tools through the gateway", () => {
  it.skipIf(!findChrome(null))(
    "renders a real mockup for an agent's task, records ideas and refuses a stranger's token",
    async () => {
      const { default: express } = await import("express");
      const { default: request } = await import("supertest");
      const { registerAgentToolRoutes } = await import("./routes/ops/agent-tools.ts");
      const { createAgentTaskToken } = await import("../security/agent-task-token.ts");
      const db = harness();
      db.exec(
        "INSERT INTO tasks (id,title,status,assigned_agent_id,project_id,created_at,updated_at) VALUES ('t-gw','Mockups','in_progress','lead-d','p1',1,1)",
      );
      db.exec(
        "INSERT INTO business_goals (id,business,metric,target,period_start,period_end,created_at,updated_at) VALUES ('gcur','ventures','revenue',2000,0,9000000000000000,1,1)",
      );
      const app = express();
      app.use(express.json());
      registerAgentToolRoutes(app, db, (() => {}) as never);
      const call = (data: Record<string, unknown>, token = createAgentTaskToken("t-gw", "lead-d")) =>
        request(app).post("/api/agent-tools").set("x-agent-task-token", token).send(data);
      const mockup = await call({
        operation: "studio.mockup",
        template: "printable",
        title: "Gateway planner",
        images: ["products/page.png"],
        width: 800,
        height: 640,
      }).expect(201);
      expect(mockup.body.item).toMatchObject({
        kind: "mockup",
        project_id: "p1",
        business: "ventures",
        task_id: "t-gw",
      });
      const bytes = fs.readFileSync(path.join(projectDir, mockup.body.item.path));
      expect(bytes.subarray(1, 4).toString()).toBe("PNG");
      const found = await call({ operation: "media.search", query: "gateway" }).expect(200);
      expect(found.body.items).toHaveLength(1);
      const idea = await call({ operation: "initiative.propose", title: "Gateway idea", demand_score: 50 }).expect(201);
      expect(idea.body.item).toMatchObject({ status: "proposed", business: "ventures", project_id: "p1" });
      await call({ operation: "studio.generate", prompt: "a desk" }).expect(400);
      await call({ operation: "media.search" }, createAgentTaskToken("t-gw", "someone-else")).expect(403);
    },
    60_000,
  );

  it("gives a goal's strategy task strategy.save and ties the ideas it proposes to the goal and playbook", async () => {
    const { default: express } = await import("express");
    const { default: request } = await import("supertest");
    const { registerAgentToolRoutes } = await import("./routes/ops/agent-tools.ts");
    const { createAgentTaskToken } = await import("../security/agent-task-token.ts");
    const db = harness();
    db.prepare(
      "INSERT INTO business_goals(id,business,project_id,metric,target,period_start,period_end,created_at,updated_at) VALUES ('g1','ventures','p1','verified_revenue',2000,?,?,?,?)",
    ).run(NOW, NOW + 30 * 86_400_000, NOW, NOW);
    // The research phase's synthesis task: it alone may save the goal's strategy.
    db.exec(
      "INSERT INTO tasks (id,title,status,assigned_agent_id,project_id,business,goal_id,playbook_step,origin,created_at,updated_at) VALUES ('t-plan','Strategy','in_progress','lead-p','p1','ventures','g1','strategy','autonomy',1,1)",
    );
    const app = express();
    app.use(express.json());
    registerAgentToolRoutes(app, db, (() => {}) as never);
    const call = (data: Record<string, unknown>, task = "t-plan") =>
      request(app).post("/api/agent-tools").set("x-agent-task-token", createAgentTaskToken(task, "lead-p")).send(data);
    const summary = `Sell printable wedding planners. ${"Median price 7 USD; 290 sales a month needed; start with 30 listings. ".repeat(4)}`;
    const saved = await call({ operation: "strategy.save", summary }).expect(201);
    expect(saved.body.item).toMatchObject({
      goal_id: "g1",
      task_id: "t-plan",
      agent_id: "lead-p",
      status: "proposed",
      version: 1,
    });
    const idea = await call({
      operation: "initiative.propose",
      title: "Printable wedding planner",
      description: "1,200 listings, median 7 USD",
      demand_score: 70,
    }).expect(201);
    expect(idea.body.item).toMatchObject({ goal_id: "g1", playbook: "etsy_digital", status: "proposed" });
    db.exec(
      "INSERT INTO tasks (id,title,status,assigned_agent_id,project_id,created_at,updated_at) VALUES ('t-other','Other','in_progress','lead-p','p1',1,1)",
    );
    await call({ operation: "strategy.save", summary }, "t-other").expect(400);
    await call({ operation: "etsy.search", keywords: "wedding planner" }).expect(400); // no Etsy app in this database
  });

  it("lets an agent read the shop and propose a revision of a live listing, which waits for approval", async () => {
    const { default: express } = await import("express");
    const { default: request } = await import("supertest");
    const { registerAgentToolRoutes } = await import("./routes/ops/agent-tools.ts");
    const { createAgentTaskToken } = await import("../security/agent-task-token.ts");
    const db = harness();
    connected(db);
    const live = publishedEtsyListing(db);
    db.prepare(
      "INSERT INTO etsy_shop_listings (listing_id,state,title,seen_at) VALUES ('9001','active','Budget planner',1),('5','removed','Gone',1)",
    ).run();
    db.exec(
      "INSERT INTO tasks (id,title,status,assigned_agent_id,project_id,created_at,updated_at) VALUES ('t-rev','Better title','in_progress','lead-p','p1',1,1)",
    );
    const app = express();
    app.use(express.json());
    registerAgentToolRoutes(app, db, (() => {}) as never);
    const call = (data: Record<string, unknown>) =>
      request(app)
        .post("/api/agent-tools")
        .set("x-agent-task-token", createAgentTaskToken("t-rev", "lead-p"))
        .send(data);
    const shop = await call({ operation: "etsy.listings" }).expect(200);
    expect(shop.body.items.map((item: { listing_id: string }) => item.listing_id)).toEqual(["9001"]);
    const revised = await call({
      operation: "listings.revise",
      id: live.id,
      payload: { title: "Budget planner 2027" },
    }).expect(201);
    expect(revised.body.item).toMatchObject({ revision_of: live.id, status: "draft", agent_id: "lead-p" });
    const submitted = await call({ operation: "listings.submit", id: revised.body.item.id }).expect(200);
    expect(submitted.body.item.status).toBe("ready");
    expect(getListing(db, live.id)!.title).toBe("Budget planner");
  });
});
