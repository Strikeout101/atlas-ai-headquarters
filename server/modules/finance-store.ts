import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { BUSINESS_SQL_LIST, isBusinessKey, type BusinessKey } from "./businesses.ts";

type Row = Record<string, unknown>;
/** Spending categories for agent spend requests and the owner's budgets (spend-budgets.ts). */
export const SPEND_CATEGORIES = ["ai_tools", "ads", "hosting", "software", "supplies", "other"] as const;
export const DEAL_STAGES = ["lead", "qualified", "proposal", "won", "paid", "lost"] as const;
export function ensureFinanceSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS deals (
    id TEXT PRIMARY KEY,business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
    contact_id TEXT REFERENCES business_contacts(id) ON DELETE SET NULL,project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,opportunity_id TEXT REFERENCES opportunities(id),
    title TEXT NOT NULL,stage TEXT NOT NULL DEFAULT 'lead' CHECK(stage IN ('lead','qualified','proposal','won','paid','lost')),
    expected_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK(typeof(expected_amount_minor)='integer' AND expected_amount_minor BETWEEN 0 AND 9007199254740991),
    currency TEXT NOT NULL DEFAULT 'USD',notes TEXT NOT NULL DEFAULT '',generated_at INTEGER,published_at INTEGER,ordered_at INTEGER,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ledger_entries (
    id TEXT PRIMARY KEY,business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),kind TEXT NOT NULL CHECK(kind IN ('revenue','expense')),
    amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN 0 AND 9007199254740991),currency TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('manual','square_payment','square_fee')),external_id TEXT,verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0,1)),
    deal_id TEXT REFERENCES deals(id),opportunity_id TEXT REFERENCES opportunities(id),description TEXT NOT NULL DEFAULT '',occurred_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(source,external_id)
  );
  CREATE TABLE IF NOT EXISTS spend_requests (
    id TEXT PRIMARY KEY,business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    opportunity_id TEXT REFERENCES opportunities(id),amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN 1 AND 9007199254740991),
    currency TEXT NOT NULL,purpose TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
    decided_by TEXT,created_at INTEGER NOT NULL,decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ledger_business_time ON ledger_entries(business,currency,occurred_at);
  CREATE INDEX IF NOT EXISTS idx_ledger_deal ON ledger_entries(deal_id);
  CREATE INDEX IF NOT EXISTS idx_ledger_opportunity ON ledger_entries(opportunity_id);
  CREATE INDEX IF NOT EXISTS idx_spend_pending ON spend_requests(status,created_at);`);
  migrateNullableFinancialReferences(db);
  if (!(db.prepare("PRAGMA table_info(spend_requests)").all() as { name: string }[]).some((c) => c.name === "category"))
    db.exec("ALTER TABLE spend_requests ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='business_goals'").get()) {
    const columns = db.prepare("PRAGMA table_info(business_goals)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "currency"))
      db.exec("ALTER TABLE business_goals ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
  }
}
/** Preserve the financial audit when existing contact/project/task/agent CRUD deletes its subject. */
function migrateNullableFinancialReferences(db: DatabaseSync): void {
  for (const table of ["deals", "spend_requests"]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string };
    const sql = row.sql.replace(
      /((?:contact_id|project_id|agent_id|task_id)\s+TEXT\s+REFERENCES\s+\w+\s*\(\s*id\s*\))(?!\s+ON DELETE SET NULL)/gi,
      "$1 ON DELETE SET NULL",
    );
    if (sql === row.sql) continue;
    if ((db as DatabaseSync & { isTransaction?: boolean }).isTransaction)
      throw new Error("finance_migration_requires_startup");
    const indexes = db
      .prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL")
      .all(table) as { sql: string }[];
    const foreignKeys = Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys);
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      const rebuilt = sql.replace(
        new RegExp('^CREATE TABLE(?: IF NOT EXISTS)? ["`]?' + table + '["`]?', "i"),
        `CREATE TABLE ${table}__finance_refs`,
      );
      if (rebuilt === sql) throw new Error("finance_migration_unexpected_schema");
      db.exec(rebuilt);
      db.exec(
        `INSERT INTO ${table}__finance_refs SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}__finance_refs RENAME TO ${table}`,
      );
      for (const index of indexes) db.exec(index.sql);
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("finance_migration_foreign_key_check_failed");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec(`PRAGMA foreign_keys=${foreignKeys}`);
    }
  }
}

function fail(message: string): never {
  throw new Error(message);
}
function string(value: unknown, field: string, max: number, optional = false): string {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string" || value.length > max || (!optional && !value.trim())) return fail(`invalid_${field}`);
  return value.trim();
}
function optionalId(value: unknown, field: string): string | null {
  return value === null || value === undefined || value === "" ? null : string(value, field, 128);
}
export function minorAmount(value: unknown, positive = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    return fail("invalid_amount_minor");
  return value;
}
export function currencyMinorDigits(value: string): number {
  if (!/^[A-Z]{3}$/.test(value) || !(Intl.supportedValuesOf("currency") as string[]).includes(value))
    return fail("invalid_currency");
  return (
    new Intl.NumberFormat("en", { style: "currency", currency: value }).resolvedOptions().maximumFractionDigits ?? 2
  );
}
function currency(value: unknown): string {
  const code = string(value, "currency", 3);
  currencyMinorDigits(code);
  return code;
}
function timestamp(value: unknown, field: string, optional = false): number | null {
  if (optional && (value === null || value === undefined)) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8640000000000000)
    return fail(`invalid_${field}`);
  return value;
}
function business(value: unknown): BusinessKey {
  if (!isBusinessKey(value)) return fail("invalid_business");
  return value;
}
function only(input: Row, fields: readonly string[]): void {
  if (Object.keys(input).some((key) => !fields.includes(key))) fail("unknown_finance_field");
}
function safeTotal(values: Iterable<number>): number {
  let total = 0n;
  for (const value of values) {
    minorAmount(value);
    total += BigInt(value);
  }
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) return fail("finance_total_overflow");
  return Number(total);
}
function atomic<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("SAVEPOINT finance_mutation");
  try {
    const result = fn();
    db.exec("RELEASE finance_mutation");
    return result;
  } catch (error) {
    db.exec("ROLLBACK TO finance_mutation; RELEASE finance_mutation");
    throw error;
  }
}
function opportunity(db: DatabaseSync, id: string | null, businessKey: string): Row | undefined {
  if (!id) return;
  const row = db.prepare("SELECT * FROM opportunities WHERE id=? AND business=?").get(id, businessKey);
  if (!row) return fail("opportunity_business_mismatch");
  return row;
}
const DEAL_FIELDS = [
  "business",
  "contact_id",
  "project_id",
  "opportunity_id",
  "title",
  "stage",
  "expected_amount_minor",
  "currency",
  "notes",
  "generated_at",
  "published_at",
  "ordered_at",
] as const;
function dealValues(db: DatabaseSync, row: Row): Row {
  row.business = business(row.business);
  row.currency = currency(row.currency);
  row.title = string(row.title, "title", 200);
  row.notes = string(row.notes, "notes", 12000, true);
  row.contact_id = optionalId(row.contact_id, "contact_id");
  row.project_id = optionalId(row.project_id, "project_id");
  row.opportunity_id = optionalId(row.opportunity_id, "opportunity_id");
  if (
    row.contact_id &&
    !db
      .prepare("SELECT 1 FROM business_contacts WHERE id=? AND business=?")
      .get(String(row.contact_id), String(row.business))
  )
    fail("contact_business_mismatch");
  if (row.project_id && !db.prepare("SELECT 1 FROM projects WHERE id=?").get(String(row.project_id)))
    fail("project_not_found");
  const linked = opportunity(db, row.opportunity_id as string | null, String(row.business));
  if (linked && row.project_id && row.project_id !== linked.project_id) fail("opportunity_project_mismatch");
  if (linked && !row.project_id) row.project_id = linked.project_id;
  row.expected_amount_minor = minorAmount(row.expected_amount_minor);
  if (!DEAL_STAGES.includes(row.stage as (typeof DEAL_STAGES)[number])) fail("invalid_deal_stage");
  for (const field of ["generated_at", "published_at", "ordered_at"]) row[field] = timestamp(row[field], field, true);
  return row;
}
function verifiedDealReceipt(db: DatabaseSync, deal: Row): number {
  const rows = db
    .prepare(
      "SELECT amount_minor FROM ledger_entries WHERE deal_id=? AND business=? AND currency=? AND verified=1 AND source='square_payment' AND kind='revenue'",
    )
    .all(String(deal.id), String(deal.business), String(deal.currency)) as { amount_minor: number }[];
  return safeTotal(rows.map((row) => row.amount_minor));
}
function receiptCoversDeal(db: DatabaseSync, deal: Row): boolean {
  const amount = verifiedDealReceipt(db, deal);
  return amount > 0 && amount >= minorAmount(deal.expected_amount_minor);
}
/** Payment status is evidence, not a claim made by a worker or a manual ledger note. */
export function reconcilePaidDeals(db: DatabaseSync): void {
  atomic(db, () => {
    const deals = db.prepare("SELECT * FROM deals").all();
    for (const deal of deals) {
      const covered = receiptCoversDeal(db, deal);
      if (covered && deal.stage !== "paid")
        db.prepare("UPDATE deals SET stage='paid',updated_at=? WHERE id=?").run(Date.now(), String(deal.id));
      if (!covered && deal.stage === "paid")
        db.prepare("UPDATE deals SET stage='won',updated_at=? WHERE id=?").run(Date.now(), String(deal.id));
    }
  });
}
export function createDeal(db: DatabaseSync, input: Row): Row {
  ensureFinanceSchema(db);
  only(input, DEAL_FIELDS);
  const now = Date.now(),
    id = randomUUID();
  const row = dealValues(db, {
    contact_id: null,
    project_id: null,
    opportunity_id: null,
    stage: "lead",
    expected_amount_minor: 0,
    currency: "USD",
    notes: "",
    generated_at: null,
    published_at: null,
    ordered_at: null,
    ...input,
    id,
  });
  if (row.stage === "paid") fail("paid_requires_verified_receipt");
  db.prepare(
    `INSERT INTO deals(id,${DEAL_FIELDS.join(",")},created_at,updated_at) VALUES (${Array(DEAL_FIELDS.length + 3)
      .fill("?")
      .join(",")})`,
  ).run(id, ...DEAL_FIELDS.map((field) => row[field] as SQLInputValue), now, now);
  return db.prepare("SELECT * FROM deals WHERE id=?").get(id)!;
}
export function updateDeal(db: DatabaseSync, id: string, input: Row): Row {
  ensureFinanceSchema(db);
  only(input, DEAL_FIELDS);
  const existing = db.prepare("SELECT * FROM deals WHERE id=?").get(id);
  if (!existing) return fail("deal_not_found");
  if (!Object.keys(input).length) fail("no_fields");
  const row = dealValues(db, { ...existing, ...input });
  if (
    ["business", "currency", "opportunity_id"].some((field) => row[field] !== existing[field]) &&
    db.prepare("SELECT 1 FROM ledger_entries WHERE deal_id=? LIMIT 1").get(id)
  )
    fail("deal_has_linked_entries");
  if (input.stage === "paid" && !receiptCoversDeal(db, row)) fail("paid_requires_verified_receipt");
  return atomic(db, () => {
    db.prepare(`UPDATE deals SET ${DEAL_FIELDS.map((field) => `${field}=?`).join(",")},updated_at=? WHERE id=?`).run(
      ...DEAL_FIELDS.map((field) => row[field] as SQLInputValue),
      Date.now(),
      id,
    );
    reconcilePaidDeals(db);
    return db.prepare("SELECT * FROM deals WHERE id=?").get(id)!;
  });
}
function ledgerLinks(db: DatabaseSync, row: Row): void {
  row.deal_id = optionalId(row.deal_id, "deal_id");
  row.opportunity_id = optionalId(row.opportunity_id, "opportunity_id");
  if (row.deal_id) {
    const deal = db.prepare("SELECT * FROM deals WHERE id=?").get(String(row.deal_id));
    if (!deal || deal.business !== row.business || deal.currency !== row.currency)
      fail("deal_business_or_currency_mismatch");
    if (row.opportunity_id && deal.opportunity_id && row.opportunity_id !== deal.opportunity_id)
      fail("deal_opportunity_mismatch");
    if (!row.opportunity_id) row.opportunity_id = deal.opportunity_id;
  }
  opportunity(db, row.opportunity_id as string | null, String(row.business));
}
/** A note typed by a person is useful context, but never verified payment evidence. */
export function createManualLedgerEntry(db: DatabaseSync, input: Row): Row {
  ensureFinanceSchema(db);
  only(input, [
    "business",
    "kind",
    "amount_minor",
    "currency",
    "deal_id",
    "opportunity_id",
    "description",
    "occurred_at",
  ]);
  const now = Date.now(),
    id = randomUUID();
  const row: Row = {
    ...input,
    business: business(input.business),
    amount_minor: minorAmount(input.amount_minor),
    currency: currency(input.currency ?? "USD"),
    description: string(input.description, "description", 4000, true),
    occurred_at: timestamp(input.occurred_at ?? now, "occurred_at"),
  };
  if (!["revenue", "expense"].includes(String(row.kind))) fail("invalid_ledger_kind");
  ledgerLinks(db, row);
  db.prepare(
    "INSERT INTO ledger_entries(id,business,kind,amount_minor,currency,source,external_id,verified,deal_id,opportunity_id,description,occurred_at,created_at,updated_at) VALUES (?,?,?,?,?,'manual',NULL,0,?,?,?,?,?,?)",
  ).run(
    id,
    String(row.business),
    String(row.kind),
    Number(row.amount_minor),
    String(row.currency),
    row.deal_id as SQLInputValue,
    row.opportunity_id as SQLInputValue,
    String(row.description),
    Number(row.occurred_at),
    now,
    now,
  );
  return db.prepare("SELECT * FROM ledger_entries WHERE id=?").get(id)!;
}
export function linkLedgerEntry(db: DatabaseSync, id: string, input: Row): Row {
  ensureFinanceSchema(db);
  only(input, ["deal_id", "opportunity_id"]);
  if (!Object.keys(input).length) fail("no_fields");
  const existing = db.prepare("SELECT * FROM ledger_entries WHERE id=?").get(id);
  if (!existing) return fail("ledger_entry_not_found");
  const row = { ...existing, ...input };
  ledgerLinks(db, row);
  return atomic(db, () => {
    const pairedReceipt =
      ["square_payment", "square_fee"].includes(String(row.source)) && typeof row.external_id === "string"
        ? row.external_id
        : null;
    db.prepare(
      "UPDATE ledger_entries SET deal_id=?,opportunity_id=?,updated_at=? WHERE id=? OR (external_id=? AND business=? AND currency=? AND source IN ('square_payment','square_fee'))",
    ).run(
      row.deal_id as SQLInputValue,
      row.opportunity_id as SQLInputValue,
      Date.now(),
      id,
      pairedReceipt,
      String(row.business),
      String(row.currency),
    );
    reconcilePaidDeals(db);
    return db.prepare("SELECT * FROM ledger_entries WHERE id=?").get(id)!;
  });
}
export function createSpendRequest(db: DatabaseSync, input: Row): Row {
  ensureFinanceSchema(db);
  only(input, ["business", "agent_id", "task_id", "opportunity_id", "amount_minor", "currency", "purpose", "category"]);
  const category = input.category ?? "other";
  if (!(SPEND_CATEGORIES as readonly unknown[]).includes(category)) fail("invalid_category");
  const businessKey = business(input.business),
    amount = minorAmount(input.amount_minor, true),
    code = currency(input.currency ?? "USD"),
    purpose = string(input.purpose, "purpose", 4000);
  const agentId = optionalId(input.agent_id, "agent_id"),
    taskId = optionalId(input.task_id, "task_id"),
    opportunityId = optionalId(input.opportunity_id, "opportunity_id");
  opportunity(db, opportunityId, businessKey);
  if (agentId && !db.prepare("SELECT 1 FROM agents WHERE id=?").get(agentId)) fail("agent_not_found");
  if (taskId) {
    const task = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id=?").get(taskId);
    if (!task || (agentId && task.assigned_agent_id !== agentId)) fail("spend_task_agent_mismatch");
  }
  if (taskId && agentId) {
    const pending = db
      .prepare(
        "SELECT * FROM spend_requests WHERE task_id=? AND agent_id=? AND business=? AND opportunity_id IS ? AND amount_minor=? AND currency=? AND purpose=? AND category=? AND status='pending' ORDER BY created_at,id LIMIT 1",
      )
      .get(taskId, agentId, businessKey, opportunityId, amount, code, purpose, category as string);
    if (pending) return pending;
  }
  const id = randomUUID();
  db.prepare(
    "INSERT INTO spend_requests(id,business,agent_id,task_id,opportunity_id,amount_minor,currency,purpose,category,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?)",
  ).run(id, businessKey, agentId, taskId, opportunityId, amount, code, purpose, category as string, Date.now());
  return db.prepare("SELECT * FROM spend_requests WHERE id=?").get(id)!;
}
/** Records an owner decision only. This module has no charge, transfer, refund or purchase operation. */
export function decideSpendRequest(db: DatabaseSync, id: string, approve: boolean, decidedBy = "owner"): Row {
  if (decidedBy !== "owner") fail("spending_requires_owner");
  if (typeof approve !== "boolean") fail("approve_boolean_required");
  const row = db.prepare("SELECT * FROM spend_requests WHERE id=?").get(id);
  if (!row) return fail("spend_request_not_found");
  if (row.status !== "pending") fail("spend_request_already_decided");
  db.prepare("UPDATE spend_requests SET status=?,decided_by='owner',decided_at=? WHERE id=? AND status='pending'").run(
    approve ? "approved" : "denied",
    Date.now(),
    id,
  );
  return db.prepare("SELECT * FROM spend_requests WHERE id=?").get(id)!;
}

interface Totals {
  business: string;
  currency: string;
  revenue_minor: number;
  cost_minor: number;
  surplus_minor: number;
  unverified_revenue_minor: number;
  unverified_cost_minor: number;
  costs_complete: false;
}
function totalsFor(rows: Row[]): Totals[] {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = `${row.business}:${row.currency}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const sum = (kind: string, verified: boolean) =>
      safeTotal(
        group
          .filter((row) => row.kind === kind && Boolean(row.verified) === verified)
          .map((row) => Number(row.amount_minor)),
      );
    const revenue = sum("revenue", true),
      cost = sum("expense", true);
    return {
      business: String(group[0].business),
      currency: String(group[0].currency),
      revenue_minor: revenue,
      cost_minor: cost,
      surplus_minor: revenue - cost,
      unverified_revenue_minor: sum("revenue", false),
      unverified_cost_minor: sum("expense", false),
      costs_complete: false,
    };
  });
}
export function getFinancialGoalProgress(db: DatabaseSync, goal: Row) {
  const code = currency(goal.currency ?? "USD"),
    digits = currencyMinorDigits(code);
  const rows = db
    .prepare("SELECT * FROM ledger_entries WHERE business=? AND currency=? AND occurred_at>=? AND occurred_at<?")
    .all(String(goal.business), code, Number(goal.period_start), Number(goal.period_end));
  const total = totalsFor(rows)[0];
  const revenue = total?.revenue_minor ?? 0,
    cost = total?.cost_minor ?? 0;
  const revenueMetric = ["revenue", "verified_revenue"].includes(String(goal.metric));
  return {
    currency: code,
    verified_revenue_minor: revenue,
    cost_minor: cost,
    reported_surplus_minor: revenue - cost,
    progress: revenueMetric ? revenue / 10 ** digits : null,
    progress_scope: "business",
    costs_complete: false,
    profit_verified: false,
  };
}
export function financeOverview(db: DatabaseSync, filters: { business?: string; from?: number; to?: number } = {}) {
  ensureFinanceSchema(db);
  const conditions: string[] = [],
    params: SQLInputValue[] = [];
  if (filters.business !== undefined) {
    conditions.push("business=?");
    params.push(business(filters.business));
  }
  if (filters.from !== undefined) {
    conditions.push("occurred_at>=?");
    params.push(timestamp(filters.from, "from")!);
  }
  if (filters.to !== undefined) {
    conditions.push("occurred_at<?");
    params.push(timestamp(filters.to, "to")!);
  }
  if (filters.from !== undefined && filters.to !== undefined && filters.to <= filters.from)
    fail("invalid_finance_period");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM ledger_entries ${where} ORDER BY occurred_at DESC,id DESC`).all(...params);
  const scope = filters.business ? "WHERE business=?" : "",
    scopeParams = filters.business ? [filters.business] : [];
  const deals = db.prepare(`SELECT * FROM deals ${scope} ORDER BY updated_at DESC`).all(...scopeParams);
  const spendRequests = db
    .prepare(`SELECT * FROM spend_requests ${scope} ORDER BY created_at DESC`)
    .all(...scopeParams);
  const goals = db
    .prepare(`SELECT * FROM business_goals ${scope} ORDER BY created_at DESC`)
    .all(...scopeParams)
    .filter((goal) => ["revenue", "profit", "verified_revenue", "verified_profit"].includes(String(goal.metric)))
    .map((goal) => ({ ...goal, ...getFinancialGoalProgress(db, goal) }));
  const opportunities = db
    .prepare(`SELECT * FROM opportunities ${scope} ORDER BY updated_at DESC`)
    .all(...scopeParams)
    .map((opportunity): Row & { currencies: Totals[] } => ({
      ...opportunity,
      currencies: totalsFor(rows.filter((row) => row.opportunity_id === opportunity.id)),
    }));
  return { deals, ledger: rows, spend_requests: spendRequests, totals: totalsFor(rows), goals, opportunities };
}
