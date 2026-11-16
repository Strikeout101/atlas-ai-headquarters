import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { ensureBusinessSchema } from "./routes/ops/business.ts";
import { ensureAutonomySchema } from "./autonomy-store.ts";
import {
  createDeal,
  createManualLedgerEntry,
  createSpendRequest,
  currencyMinorDigits,
  decideSpendRequest,
  ensureFinanceSchema,
  financeOverview,
  getFinancialGoalProgress,
  linkLedgerEntry,
  reconcilePaidDeals,
  updateDeal,
} from "./finance-store.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
const NOW = Date.parse("2026-11-16T17:00:00Z");
function harness() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  applyBaseSchema(db);
  ensureBusinessSchema(db);
  ensureAutonomySchema(db);
  ensureFinanceSchema(db);
  db.exec(
    "INSERT INTO projects(id,name,project_path,core_goal) VALUES ('project','Project','C:/Projects/ventures','Research'); INSERT INTO agents(id,name,role) VALUES ('agent','Research lead','team_leader'); INSERT INTO tasks(id,title,assigned_agent_id,status) VALUES ('task','Research','agent','in_progress'); INSERT INTO business_contacts(id,business,name,created_at,updated_at) VALUES ('techcontact','tech','Tech customer',1,1)",
  );
  db.prepare(
    "INSERT INTO opportunities(id,business,project_id,title,created_at,updated_at) VALUES ('opp','ventures','project','Venture',?,?),('other','tech','project','Tech',?,?)",
  ).run(NOW, NOW, NOW, NOW);
  let sequence = 0;
  const receipt = (amount: number, overrides: Record<string, unknown> = {}) => {
    const row = {
      id: `entry${++sequence}`,
      business: "ventures",
      kind: "revenue",
      amount_minor: amount,
      currency: "USD",
      source: "square_payment",
      verified: 1,
      deal_id: null,
      opportunity_id: null,
      occurred_at: NOW,
      ...overrides,
    };
    db.prepare(
      "INSERT INTO ledger_entries(id,business,kind,amount_minor,currency,source,external_id,verified,deal_id,opportunity_id,description,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'Test receipt',?,?,?)",
    ).run(
      String(row.id),
      String(row.business),
      String(row.kind),
      Number(row.amount_minor),
      String(row.currency),
      String(row.source),
      String(row.id),
      Number(row.verified),
      row.deal_id as string | null,
      row.opportunity_id as string | null,
      Number(row.occurred_at),
      NOW,
      NOW,
    );
    return String(row.id);
  };
  return { db, receipt };
}
describe("financial evidence and pipeline", () => {
  it("preserves records through idempotent schema initialization and keeps stages distinct from milestones", () => {
    const { db } = harness();
    const deal = createDeal(db, {
      business: "ventures",
      title: "Template commission",
      stage: "qualified",
      generated_at: NOW,
      expected_amount_minor: 1575,
    });
    ensureFinanceSchema(db);
    expect(
      db.prepare("SELECT stage,generated_at,published_at,ordered_at FROM deals WHERE id=?").get(String(deal.id)),
    ).toMatchObject({ stage: "qualified", generated_at: NOW, published_at: null, ordered_at: null });
    expect(financeOverview(db).ledger).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("accepts only safe nonnegative minor units and recognized currencies with their real exponents", () => {
    const { db } = harness();
    expect(currencyMinorDigits("USD")).toBe(2);
    expect(currencyMinorDigits("JPY")).toBe(0);
    expect(currencyMinorDigits("KWD")).toBe(3);
    for (const amount of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1, Infinity, "100"])
      expect(() => createDeal(db, { business: "ventures", title: "Deal", expected_amount_minor: amount })).toThrow(
        "invalid_amount_minor",
      );
    expect(() => createDeal(db, { business: "ventures", title: "Deal", currency: "ZZZ" })).toThrow("invalid_currency");
    expect(() => createDeal(db, { business: "ventures", title: "Deal", contact_id: "techcontact" })).toThrow(
      "contact_business_mismatch",
    );
    expect(() => createDeal(db, { business: "ventures", title: "Deal", opportunity_id: "other" })).toThrow(
      "opportunity_business_mismatch",
    );
  });
  it("never treats manual notes or client-supplied verification as proof of payment", () => {
    const { db } = harness();
    const deal = createDeal(db, { business: "ventures", title: "Draft", expected_amount_minor: 1000 });
    const note = createManualLedgerEntry(db, {
      business: "ventures",
      kind: "revenue",
      amount_minor: 1000,
      deal_id: deal.id,
    });
    expect(note).toMatchObject({ source: "manual", verified: 0 });
    reconcilePaidDeals(db);
    expect(() => updateDeal(db, String(deal.id), { stage: "paid" })).toThrow("paid_requires_verified_receipt");
    for (const extra of [{ verified: 1 }, { source: "square_payment" }, { external_id: "fake" }])
      expect(() =>
        createManualLedgerEntry(db, { business: "ventures", kind: "revenue", amount_minor: 1, ...extra }),
      ).toThrow("unknown_finance_field");
    expect(financeOverview(db).totals[0]).toMatchObject({ revenue_minor: 0, unverified_revenue_minor: 1000 });
  });
  it("derives paid only from matching verified net receipts and downgrades it after a refund", () => {
    const { db, receipt } = harness();
    const deal = createDeal(db, {
      business: "ventures",
      title: "Commission",
      opportunity_id: "opp",
      expected_amount_minor: 1000,
      stage: "won",
    });
    const first = receipt(600);
    linkLedgerEntry(db, first, { deal_id: deal.id });
    expect(db.prepare("SELECT stage FROM deals WHERE id=?").get(String(deal.id))).toMatchObject({ stage: "won" });
    const second = receipt(400);
    linkLedgerEntry(db, second, { deal_id: deal.id });
    expect(db.prepare("SELECT stage FROM deals WHERE id=?").get(String(deal.id))).toMatchObject({ stage: "paid" });
    expect(db.prepare("SELECT opportunity_id FROM ledger_entries WHERE id=?").get(first)).toMatchObject({
      opportunity_id: "opp",
    });
    db.prepare("UPDATE ledger_entries SET amount_minor=0 WHERE id=?").run(second);
    reconcilePaidDeals(db);
    expect(db.prepare("SELECT stage FROM deals WHERE id=?").get(String(deal.id))).toMatchObject({ stage: "won" });
    expect(() => updateDeal(db, String(deal.id), { currency: "JPY" })).toThrow("deal_has_linked_entries");
    expect(() => linkLedgerEntry(db, first, { opportunity_id: "other" })).toThrow("deal_opportunity_mismatch");
  });
  it("requires positive receipts for zero-price deals and treats sandbox evidence as unverified", () => {
    const { db, receipt } = harness();
    const deal = createDeal(db, { business: "ventures", title: "Free initial order", stage: "won" });
    const id = receipt(100, { verified: 0 });
    linkLedgerEntry(db, id, { deal_id: deal.id });
    expect(db.prepare("SELECT stage FROM deals WHERE id=?").get(String(deal.id))).toMatchObject({ stage: "won" });
    db.prepare("UPDATE ledger_entries SET verified=1,amount_minor=0 WHERE id=?").run(id);
    reconcilePaidDeals(db);
    expect(db.prepare("SELECT stage FROM deals WHERE id=?").get(String(deal.id))).toMatchObject({ stage: "won" });
    db.prepare("UPDATE ledger_entries SET amount_minor=1 WHERE id=?").run(id);
    reconcilePaidDeals(db);
    expect(db.prepare("SELECT stage FROM deals WHERE id=?").get(String(deal.id))).toMatchObject({ stage: "paid" });
  });
  it("keeps businesses and currencies separate and reports only a surplus from known costs", () => {
    const { db, receipt } = harness();
    receipt(10000, { opportunity_id: "opp" });
    receipt(350, { source: "square_fee", kind: "expense", opportunity_id: "opp" });
    receipt(500, { currency: "JPY" });
    receipt(4500, { business: "tech" });
    createManualLedgerEntry(db, { business: "ventures", kind: "expense", amount_minor: 1000, currency: "USD" });
    const overview = financeOverview(db);
    expect(overview.totals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          business: "ventures",
          currency: "USD",
          revenue_minor: 10000,
          cost_minor: 350,
          surplus_minor: 9650,
          unverified_cost_minor: 1000,
          costs_complete: false,
        }),
        expect.objectContaining({ business: "ventures", currency: "JPY", revenue_minor: 500 }),
        expect.objectContaining({ business: "tech", currency: "USD", revenue_minor: 4500 }),
      ]),
    );
    expect(overview.opportunities.find((row) => row.id === "opp")?.currencies[0]).toMatchObject({
      revenue_minor: 10000,
      cost_minor: 350,
    });
    expect(financeOverview(db, { business: "tech" }).totals).toHaveLength(1);
    expect(financeOverview(db, { from: NOW + 1 }).totals).toEqual([
      expect.objectContaining({ unverified_cost_minor: 1000 }),
    ]);
  });
  it("fails closed when accumulated amounts exceed safe integer precision", () => {
    const { db, receipt } = harness();
    receipt(Number.MAX_SAFE_INTEGER);
    receipt(1);
    expect(() => financeOverview(db)).toThrow("finance_total_overflow");
  });
  it("uses verified revenue in the goal currency and period, without claiming verified profit", () => {
    const { db, receipt } = harness();
    receipt(1250, { currency: "KWD" });
    receipt(400, { currency: "USD" });
    receipt(999, { currency: "KWD", occurred_at: NOW - 1000 });
    const goal = {
      business: "ventures",
      metric: "verified_revenue",
      currency: "KWD",
      period_start: NOW,
      period_end: NOW + 1000,
    };
    expect(getFinancialGoalProgress(db, goal)).toMatchObject({
      verified_revenue_minor: 1250,
      progress: 1.25,
      costs_complete: false,
    });
    expect(getFinancialGoalProgress(db, { ...goal, metric: "profit" })).toMatchObject({
      progress: null,
      profit_verified: false,
    });
  });
});
describe("spending decisions", () => {
  it("always requires the owner and records a decision without creating payments or ledger income", () => {
    const { db } = harness();
    const pending = createSpendRequest(db, {
      business: "ventures",
      agent_id: "agent",
      task_id: "task",
      amount_minor: 4900,
      currency: "USD",
      purpose: "Owner review of proposed tool expense",
    });
    expect(() => decideSpendRequest(db, String(pending.id), true, "vp:codex,claude")).toThrow(
      "spending_requires_owner",
    );
    expect(decideSpendRequest(db, String(pending.id), true)).toMatchObject({ status: "approved", decided_by: "owner" });
    expect(() => decideSpendRequest(db, String(pending.id), true)).toThrow("spend_request_already_decided");
    expect(db.prepare("SELECT * FROM ledger_entries").all()).toEqual([]);
    expect(() => createSpendRequest(db, { business: "ventures", amount_minor: 0, purpose: "No amount" })).toThrow(
      "invalid_amount_minor",
    );
    expect(() =>
      createSpendRequest(db, {
        business: "ventures",
        agent_id: "agent",
        task_id: "missing",
        amount_minor: 1,
        purpose: "Wrong task",
      }),
    ).toThrow("spend_task_agent_mismatch");
  });
});

describe("financial audit retention and retry safety", () => {
  it("migrates nullable references, preserves indexes and retains financial records after existing CRUD deletions", () => {
    const { db } = harness();
    db.exec(
      "INSERT INTO projects(id,name,project_path,core_goal) VALUES ('dealproject','Deal project','C:/Projects/deals','Prepare quote')",
    );
    const deal = createDeal(db, {
      business: "tech",
      contact_id: "techcontact",
      project_id: "dealproject",
      title: "Existing quote",
    });
    const spend = createSpendRequest(db, {
      business: "ventures",
      agent_id: "agent",
      task_id: "task",
      amount_minor: 2500,
      purpose: "Evaluate owner purchase",
    });
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    for (const table of ["deals", "spend_requests"]) {
      const sql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(table) as { sql: string }
      ).sql;
      db.exec(
        sql
          .replaceAll(" ON DELETE SET NULL", "")
          .replace(new RegExp('^CREATE TABLE ["`]?' + table + '["`]?'), `CREATE TABLE ${table}_legacy`),
      );
      db.exec(
        `INSERT INTO ${table}_legacy SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_legacy RENAME TO ${table}`,
      );
    }
    db.exec("COMMIT; PRAGMA foreign_keys=ON; CREATE INDEX preserve_finance_title ON deals(title)");
    ensureFinanceSchema(db);
    ensureFinanceSchema(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='preserve_finance_title'").get()).toBeTruthy();
    db.exec(
      "DELETE FROM business_contacts WHERE id='techcontact'; DELETE FROM projects WHERE id='dealproject'; DELETE FROM tasks WHERE id='task'; DELETE FROM agents WHERE id='agent'",
    );
    expect(db.prepare("SELECT contact_id,project_id,title FROM deals WHERE id=?").get(String(deal.id))).toMatchObject({
      contact_id: null,
      project_id: null,
      title: "Existing quote",
    });
    expect(
      db.prepare("SELECT agent_id,task_id,amount_minor FROM spend_requests WHERE id=?").get(String(spend.id)),
    ).toMatchObject({ agent_id: null, task_id: null, amount_minor: 2500 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("deduplicates identical pending worker retries while preserving distinct owner requests", () => {
    const { db } = harness();
    const input = {
      business: "ventures",
      agent_id: "agent",
      task_id: "task",
      opportunity_id: "opp",
      amount_minor: 1500,
      currency: "USD",
      purpose: "Review proposed tool subscription",
    };
    const first = createSpendRequest(db, input),
      retry = createSpendRequest(db, input);
    expect(retry.id).toBe(first.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM spend_requests").get()).toMatchObject({ n: 1 });
    expect(createSpendRequest(db, { ...input, amount_minor: 1501 }).id).not.toBe(first.id);
    const ownerInput = {
      business: "ventures",
      amount_minor: 1500,
      currency: "USD",
      purpose: "Review proposed tool subscription",
    };
    expect(createSpendRequest(db, ownerInput).id).not.toBe(createSpendRequest(db, ownerInput).id);
  });
  it("attributes a Square receipt and its matching fee together and re-evaluates paid evidence after amount edits", () => {
    const { db, receipt } = harness();
    const deal = createDeal(db, {
      business: "ventures",
      title: "Commission",
      opportunity_id: "opp",
      expected_amount_minor: 1000,
      stage: "won",
    });
    const payment = receipt(1000),
      fee = receipt(25, { source: "square_fee", kind: "expense" });
    db.prepare("UPDATE ledger_entries SET external_id=? WHERE id=?").run(payment, fee);
    linkLedgerEntry(db, payment, { deal_id: deal.id });
    expect(db.prepare("SELECT deal_id,opportunity_id FROM ledger_entries WHERE id=?").get(fee)).toMatchObject({
      deal_id: deal.id,
      opportunity_id: "opp",
    });
    expect(updateDeal(db, String(deal.id), { expected_amount_minor: 1200 })).toMatchObject({ stage: "won" });
    expect(updateDeal(db, String(deal.id), { expected_amount_minor: 1000 })).toMatchObject({ stage: "paid" });
    expect(financeOverview(db).opportunities.find((row) => row.id === "opp")?.currencies[0]).toMatchObject({
      revenue_minor: 1000,
      cost_minor: 25,
    });
  });
});
