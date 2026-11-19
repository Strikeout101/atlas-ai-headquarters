import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { BUSINESS_KEYS, isBusinessKey, type BusinessKey } from "./businesses.ts";

/**
 * Costs and profit. Revenue only counts when it is verified (Square or Etsy evidence). Expenses count whether verified
 * or not (an estimate of what we spent is better than ignoring it). Monthly costs such as AI subscriptions are
 * entered by the owner and spread over the days of the period; shared costs are split evenly across the businesses.
 *
 * Profit only becomes a number once the owner confirms their recurring costs are complete. Until then it is shown as
 * an estimate and profit goals stay unmeasured, so missing costs can never make a goal look met.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export const RECURRING_CATEGORIES = ["ai_tools", "software", "hosting", "ads", "other"] as const;
const DAY_MS = 86_400_000;
const AVERAGE_MONTH_DAYS = 365.25 / 12;

export interface RecurringCost {
  id: string;
  label: string;
  business: BusinessKey | null;
  category: string;
  amount_minor: number;
  currency: string;
  active: number;
  created_at: number;
  updated_at: number;
}

export function ensureProfitSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS recurring_costs (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, business TEXT, category TEXT NOT NULL DEFAULT 'other',
    amount_minor INTEGER NOT NULL CHECK(typeof(amount_minor)='integer' AND amount_minor BETWEEN 0 AND 100000000),
    currency TEXT NOT NULL DEFAULT 'USD', active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS profit_settings (
    id INTEGER PRIMARY KEY CHECK(id=1), costs_complete INTEGER NOT NULL DEFAULT 0 CHECK(costs_complete IN (0,1)),
    confirmed_at INTEGER
  );
  INSERT OR IGNORE INTO profit_settings(id) VALUES (1);`);
}

function fail(message: string): never {
  throw new Error(message);
}

function costValues(input: Row, current?: RecurringCost) {
  const label =
    input.label === undefined ? current?.label : typeof input.label === "string" ? input.label.trim() : undefined;
  if (!label || label.length > 120) fail("invalid_recurring_label");
  const business =
    input.business === undefined
      ? (current?.business ?? null)
      : input.business === null || input.business === ""
        ? null
        : isBusinessKey(input.business)
          ? input.business
          : fail("invalid_business");
  const category = input.category === undefined ? (current?.category ?? "other") : input.category;
  if (!(RECURRING_CATEGORIES as readonly unknown[]).includes(category)) fail("invalid_recurring_category");
  const amount = input.amount_minor === undefined ? current?.amount_minor : input.amount_minor;
  if (!Number.isSafeInteger(amount) || (amount as number) < 0 || (amount as number) > 100_000_000)
    fail("invalid_recurring_amount");
  const currency = input.currency === undefined ? (current?.currency ?? "USD") : input.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) fail("invalid_currency");
  const active = input.active === undefined ? (current?.active ?? 1) : input.active ? 1 : 0;
  return { label, business, category: category as string, amount_minor: amount as number, currency, active };
}

export function listRecurringCosts(db: Db): RecurringCost[] {
  ensureProfitSchema(db);
  return db.prepare("SELECT * FROM recurring_costs ORDER BY active DESC, label").all() as unknown as RecurringCost[];
}

export function saveRecurringCost(db: Db, input: Row, id?: string, now = Date.now()): RecurringCost {
  ensureProfitSchema(db);
  const current = id
    ? ((db.prepare("SELECT * FROM recurring_costs WHERE id=?").get(id) as unknown as RecurringCost | undefined) ??
      fail("recurring_cost_not_found"))
    : undefined;
  const v = costValues(input, current);
  if (current) {
    db.prepare(
      "UPDATE recurring_costs SET label=?,business=?,category=?,amount_minor=?,currency=?,active=?,updated_at=? WHERE id=?",
    ).run(v.label, v.business, v.category, v.amount_minor, v.currency, v.active, now, current.id);
    return db.prepare("SELECT * FROM recurring_costs WHERE id=?").get(current.id) as unknown as RecurringCost;
  }
  const newId = randomUUID();
  db.prepare(
    "INSERT INTO recurring_costs(id,label,business,category,amount_minor,currency,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(newId, v.label, v.business, v.category, v.amount_minor, v.currency, v.active, now, now);
  return db.prepare("SELECT * FROM recurring_costs WHERE id=?").get(newId) as unknown as RecurringCost;
}

export function deleteRecurringCost(db: Db, id: string): void {
  ensureProfitSchema(db);
  if (!db.prepare("DELETE FROM recurring_costs WHERE id=?").run(id).changes) fail("recurring_cost_not_found");
}

export function profitSettings(db: Db): { costs_complete: boolean; confirmed_at: number | null } {
  ensureProfitSchema(db);
  const row = db.prepare("SELECT costs_complete, confirmed_at FROM profit_settings WHERE id=1").get() as Row;
  return { costs_complete: Boolean(row.costs_complete), confirmed_at: (row.confirmed_at as number | null) ?? null };
}

export function setCostsComplete(db: Db, complete: unknown, now = Date.now()) {
  ensureProfitSchema(db);
  if (typeof complete !== "boolean") fail("invalid_costs_complete");
  db.prepare("UPDATE profit_settings SET costs_complete=?, confirmed_at=? WHERE id=1").run(
    complete ? 1 : 0,
    complete ? now : null,
  );
  return profitSettings(db);
}

/** A business's share of the active recurring costs over [from, to), in one currency. */
export function recurringShareMinor(db: Db, business: string, currency: string, from: number, to: number): number {
  ensureProfitSchema(db);
  const months = Math.max(0, to - from) / DAY_MS / AVERAGE_MONTH_DAYS;
  let total = 0;
  for (const cost of listRecurringCosts(db)) {
    if (!cost.active || cost.currency !== currency) continue;
    if (cost.business && cost.business !== business) continue;
    const share = cost.business ? 1 : 1 / BUSINESS_KEYS.length;
    total += cost.amount_minor * months * share;
  }
  return Math.round(total);
}

export interface ProfitLine {
  business: string;
  currency: string;
  revenue_minor: number;
  expense_minor: number;
  recurring_minor: number;
  profit_minor: number;
}

/**
 * Profit per business and currency over [from, to). `ledger` rows must already be filtered to the period.
 * Businesses with recurring costs but no ledger rows still appear, so a quiet month shows its loss.
 */
export function profitLines(db: Db, ledger: Row[], from: number, to: number, onlyBusiness?: string): ProfitLine[] {
  const keys = new Set<string>();
  for (const row of ledger) keys.add(`${row.business}:${row.currency}`);
  for (const cost of listRecurringCosts(db)) {
    if (!cost.active) continue;
    const targets = cost.business ? [cost.business] : [...BUSINESS_KEYS];
    for (const business of targets) keys.add(`${business}:${cost.currency}`);
  }
  const lines: ProfitLine[] = [];
  for (const key of keys) {
    const [business, currency] = key.split(":");
    if (onlyBusiness && business !== onlyBusiness) continue;
    const rows = ledger.filter((row) => row.business === business && row.currency === currency);
    const revenue = rows
      .filter((row) => row.kind === "revenue" && Number(row.verified) === 1)
      .reduce((sum, row) => sum + Number(row.amount_minor), 0);
    const expense = rows
      .filter((row) => row.kind === "expense")
      .reduce((sum, row) => sum + Number(row.amount_minor), 0);
    const recurring = recurringShareMinor(db, business, currency, from, to);
    lines.push({
      business,
      currency,
      revenue_minor: revenue,
      expense_minor: expense,
      recurring_minor: recurring,
      profit_minor: revenue - expense - recurring,
    });
  }
  return lines.sort((a, b) => a.business.localeCompare(b.business) || a.currency.localeCompare(b.currency));
}

/** Revenue minus linked expenses for one opportunity (recurring costs are not assigned to opportunities). */
export function opportunityMoney(db: Db, opportunityId: string): { spent_minor: number; earned_minor: number } {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_entries'").get();
  if (!exists) return { spent_minor: 0, earned_minor: 0 };
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN kind='expense' THEN amount_minor END),0) AS spent,
              COALESCE(SUM(CASE WHEN kind='revenue' AND verified=1 THEN amount_minor END),0) AS earned
       FROM ledger_entries WHERE opportunity_id=?`,
    )
    .get(opportunityId) as { spent: number; earned: number };
  return { spent_minor: Number(row.spent), earned_minor: Number(row.earned) };
}
