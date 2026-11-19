import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "./bootstrap/schema/task-schema-migrations.ts";
import { ensureAutonomySchema } from "./autonomy-store.ts";
import { ensureAgentProposalSchema } from "./agent-proposals.ts";
import {
  ensureFinanceSchema,
  financeOverview,
  upsertProviderLedgerEntry,
  getFinancialGoalProgress,
} from "./finance-store.ts";
import { saveRecurringCost, setCostsComplete, profitLines } from "./profit.ts";
import { createListing, decideListing, getListing, submitListing, setFeeBudget } from "./listings.ts";
import {
  classifyLedgerEntry,
  completeEtsyConnect,
  etsyRequest,
  pkcePair,
  publishEtsyListing,
  pushListingDraft,
  saveEtsySettings,
  startEtsyConnect,
  syncEtsy,
} from "./etsy.ts";
import { generateImage, mockupHtml, renderMockup, saveStudioSettings, findChrome } from "./studio.ts";
import { searchMedia } from "./media-library.ts";
import {
  evaluateOpportunities,
  opportunityBudgetBlock,
  restartOpportunity,
  saveExperimentRules,
  startVariant,
  variantResults,
} from "./experiments.ts";
import { ensureAutonomyEngineSchema, queueAutonomyWork } from "./autonomy-engine.ts";
import { advancePlaybook, getPlaybook, proposeOpportunity, savePlaybook, startPlaybook } from "./playbooks.ts";

let projectDir: string;
beforeAll(() => {
  process.env.OAUTH_ENCRYPTION_SECRET ||= "test-secret-for-etsy-money-loop-0123456789";
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
  ensureAutonomySchema(db);
  ensureAgentProposalSchema(db);
  ensureFinanceSchema(db);
  ensureAutonomyEngineSchema(db);
  db.prepare(
    "INSERT INTO projects (id,name,project_path,core_goal,created_at,updated_at,business) VALUES ('p1','Etsy shop',?,'Sell digital products',1,1,'ventures')",
  ).run(projectDir);
  db.exec(`
    INSERT INTO departments (id,name,name_ko,name_ja,name_zh,icon,color,sort_order) VALUES
      ('planning','Planning','','','','','#000',1),('design','Design','','','','','#000',2);
    INSERT INTO agents (id,name,role,cli_provider,department_id) VALUES
      ('lead-p','Sage','team_leader','codex','planning'),('lead-d','Iris','team_leader','codex','design');
    INSERT INTO opportunities (id,business,project_id,title,description,budget,status,created_at,updated_at)
      VALUES ('o1','ventures','p1','Budget planner','Monthly planner',5,'building',1,1);`);
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
      opportunity_id: "o1",
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
    expect(url.searchParams.get("scope")).toBe("listings_r listings_w shops_r transactions_r");
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
    expect(db.prepare("SELECT status, launched_at FROM opportunities WHERE id='o1'").get()).toEqual({
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
    expect(counts).toEqual({ receipts: 1, fees: 2, refunds: 1, listings: 1 });
    await syncEtsy(db, { fetch: fetchFn, now: () => NOW + 1000 });
    const rows = db
      .prepare(
        "SELECT source, kind, amount_minor, verified, opportunity_id FROM ledger_entries ORDER BY source, amount_minor",
      )
      .all();
    expect(rows).toEqual([
      { source: "etsy_fee", kind: "expense", amount_minor: 20, verified: 1, opportunity_id: "o1" },
      { source: "etsy_fee", kind: "expense", amount_minor: 30, verified: 1, opportunity_id: null },
      { source: "etsy_receipt", kind: "revenue", amount_minor: 450, verified: 1, opportunity_id: "o1" },
      { source: "etsy_refund", kind: "expense", amount_minor: 450, verified: 1, opportunity_id: null },
    ]);
    expect(db.prepare("SELECT favorers, sales FROM opportunity_metrics WHERE opportunity_id='o1'").get()).toEqual({
      favorers: 7,
      sales: 1,
    });
    expect(classifyLedgerEntry({ amount: -5, ledger_type: "payout" })).toBeNull();
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
      { business: "ventures", projectId: "p1", projectPath: projectDir, opportunityId: "o1" },
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
    const ctx = { business: "ventures" as const, projectId: "p1", projectPath: projectDir, opportunityId: "o1" };
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
    expect(db.prepare("SELECT source, amount_minor, verified, opportunity_id FROM ledger_entries").get()).toEqual({
      source: "tool_usage",
      amount_minor: 4,
      verified: 0,
      opportunity_id: "o1",
    });
    await expect(
      generateImage(db, { prompt: "another desk" }, ctx, { fetch: fetchFn, now: () => NOW }),
    ).rejects.toThrow("studio_monthly_cap_reached");
  });
});

describe("experiments and auto-stop", () => {
  it("blocks new work past the budget or task limit, and stops by the owner's rules", () => {
    const db = harness();
    expect(opportunityBudgetBlock(db, "o1")).toBeNull();
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
      opportunity_id: "o1",
    });
    expect(opportunityBudgetBlock(db, "o1")).toMatch(/budget reached/);
    expect(() =>
      queueAutonomyWork(
        db,
        {
          business: "ventures",
          project_id: "p1",
          department_id: "design",
          title: "More images",
          description: "x",
          reason: "y",
          opportunity_id: "o1",
        },
        NOW,
      ),
    ).toThrow("opportunity_budget_reached");
    expect(evaluateOpportunities(db, NOW)).toEqual(["o1"]);
    expect(db.prepare("SELECT status, stop_reason FROM opportunities WHERE id='o1'").get()).toEqual({
      status: "stopped",
      stop_reason: "budget of 5.00 USD used with no sales",
    });
    expect(db.prepare("SELECT event FROM autonomy_ledger WHERE event='auto_stopped'").get()).toBeTruthy();
    restartOpportunity(db, "o1", NOW + 1);
    expect(db.prepare("SELECT status FROM opportunities WHERE id='o1'").get()).toEqual({ status: "building" });
    saveExperimentRules(db, { enabled: false });
    expect(evaluateOpportunities(db, NOW + 2)).toEqual([]);
  });

  it("stops a launched opportunity with no sales after its time limit, but not one that sells", () => {
    const db = harness();
    db.prepare(
      "UPDATE opportunities SET budget=0, status='launched', launched_at=?, time_limit_days=10 WHERE id='o1'",
    ).run(NOW - 11 * 86_400_000);
    db.exec(
      "INSERT INTO opportunities (id,business,project_id,title,status,launched_at,time_limit_days,created_at,updated_at) VALUES ('o2','ventures','p1','Seller','launched',1,10,1,1)",
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
      opportunity_id: "o2",
    });
    expect(evaluateOpportunities(db, NOW)).toEqual(["o1"]);
  });

  it("measures each variant over its own window", () => {
    const db = harness();
    const first = startVariant(
      db,
      { opportunity_id: "o1", variable: "price", value: "4.50" },
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
      opportunity_id: "o1",
    });
    startVariant(db, { opportunity_id: "o1", variable: "price", value: "6.00" }, {}, NOW - 5 * 86_400_000);
    const results = variantResults(db, "o1", NOW);
    expect(results.find((v) => v.id === first.id)).toMatchObject({ sales: 1, revenue_minor: 450 });
    expect(results.find((v) => v.value === "6.00")).toMatchObject({ sales: 0, ended_at: null });
  });
});

describe("Etsy playbook", () => {
  it("records research ideas, starts the playbook and queues each next step through the normal gates", () => {
    const db = harness();
    const playbook = getPlaybook(db, "etsy_digital")!;
    expect(playbook.steps.map((s) => s.key)).toEqual(["build", "mockups", "listing"]);
    db.exec(
      "INSERT INTO tasks (id,title,status,created_at,updated_at) VALUES ('t-research','Research','in_progress',1,1)",
    );
    const idea = proposeOpportunity(
      db,
      { title: "Wedding seating chart template", description: "Evidence...", demand_score: 70, budget: 3 },
      { business: "ventures", projectId: "p1", taskId: "t-research", playbook: "etsy_digital" },
      NOW,
    );
    expect(idea).toMatchObject({ status: "idea", playbook: "etsy_digital", budget: 3 });
    const workId = startPlaybook(db, String(idea.id), queueAutonomyWork, NOW);
    const work = db.prepare("SELECT * FROM autonomy_work WHERE id=?").get(workId) as Record<string, unknown>;
    expect(work).toMatchObject({ playbook_step: "build", status: "pending", opportunity_id: idea.id });
    const proposal = db
      .prepare("SELECT title, department_id, description FROM agent_task_proposals WHERE id=?")
      .get(String(work.proposal_id)) as Record<string, string>;
    expect(proposal.title).toBe("Make the product: Wedding seating chart template");
    expect(proposal.department_id).toBe("design");
    expect(proposal.description).toContain(`Opportunity ${idea.id}`);
    const next = advancePlaybook(db, work, queueAutonomyWork, NOW + 1);
    expect(db.prepare("SELECT playbook_step FROM autonomy_work WHERE id=?").get(next)).toEqual({
      playbook_step: "mockups",
    });
    const last = advancePlaybook(
      db,
      db.prepare("SELECT * FROM autonomy_work WHERE id=?").get(next) as Record<string, unknown>,
      queueAutonomyWork,
      NOW + 2,
    );
    advancePlaybook(
      db,
      db.prepare("SELECT * FROM autonomy_work WHERE id=?").get(last) as Record<string, unknown>,
      queueAutonomyWork,
      NOW + 3,
    );
    expect(db.prepare("SELECT playbook_stage FROM opportunities WHERE id=?").get(String(idea.id))).toEqual({
      playbook_stage: "awaiting_listing",
    });
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
    db.exec(`CREATE TABLE deals (id TEXT PRIMARY KEY,business TEXT NOT NULL,contact_id TEXT REFERENCES business_contacts(id) ON DELETE SET NULL,project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,opportunity_id TEXT REFERENCES opportunities(id),title TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'lead',expected_amount_minor INTEGER NOT NULL DEFAULT 0,currency TEXT NOT NULL DEFAULT 'USD',notes TEXT NOT NULL DEFAULT '',generated_at INTEGER,published_at INTEGER,ordered_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE ledger_entries (id TEXT PRIMARY KEY,business TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('revenue','expense')),amount_minor INTEGER NOT NULL,currency TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN ('manual','square_payment','square_fee')),external_id TEXT,verified INTEGER NOT NULL DEFAULT 0,deal_id TEXT REFERENCES deals(id),opportunity_id TEXT REFERENCES opportunities(id),description TEXT NOT NULL DEFAULT '',occurred_at INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(source,external_id));
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
      const idea = await call({ operation: "opportunity.propose", title: "Gateway idea", demand_score: 50 }).expect(
        201,
      );
      expect(idea.body.item).toMatchObject({ status: "idea", business: "ventures", project_id: "p1" });
      await call({ operation: "studio.generate", prompt: "a desk" }).expect(400);
      await call({ operation: "media.search" }, createAgentTaskToken("t-gw", "someone-else")).expect(403);
    },
    60_000,
  );
});
