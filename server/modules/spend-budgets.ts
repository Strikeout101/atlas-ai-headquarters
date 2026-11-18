import type { DatabaseSync } from "node:sqlite";
import { BUSINESS_KEYS, BUSINESS_SQL_LIST, isBusinessKey, type BusinessKey } from "./businesses.ts";
import { currencyMinorDigits, SPEND_CATEGORIES } from "./finance-store.ts";
import { feeBudgetMonth } from "./listings.ts";

/**
 * Owner spending budgets for agent spend requests, per business and category. A request that fits both the per-item
 * limit and what is left of the month's budget can be approved by the two VPs; anything else goes to the owner.
 * Every budget starts at 0, so nothing changes until the owner raises one. Approving a spend request records
 * permission only: no money moves from ATLAS. Listing fees have their own budget on the Listings page.
 */
export { SPEND_CATEGORIES };
export type SpendCategory = (typeof SPEND_CATEGORIES)[number];
export const MAX_SPEND_BUDGET_MINOR = 10_000_000_00;

export interface SpendBudget {
  business: BusinessKey;
  category: SpendCategory;
  currency: string;
  monthly_cap_minor: number;
  per_item_cap_minor: number;
  used_minor: number;
  remaining_minor: number;
  month: string;
  updated_at: number;
}

type Row = Record<string, unknown>;

export function isSpendCategory(value: unknown): value is SpendCategory {
  return typeof value === "string" && (SPEND_CATEGORIES as readonly string[]).includes(value);
}

export function ensureSpendBudgetSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS spend_budgets (
    business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
    category TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    monthly_cap_minor INTEGER NOT NULL DEFAULT 0 CHECK(typeof(monthly_cap_minor)='integer' AND monthly_cap_minor BETWEEN 0 AND ${MAX_SPEND_BUDGET_MINOR}),
    per_item_cap_minor INTEGER NOT NULL DEFAULT 0 CHECK(typeof(per_item_cap_minor)='integer' AND per_item_cap_minor BETWEEN 0 AND ${MAX_SPEND_BUDGET_MINOR}),
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(business, category)
  )`);
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spend_requests'").get()) {
    const columns = db.prepare("PRAGMA table_info(spend_requests)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "category"))
      db.exec("ALTER TABLE spend_requests ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
  }
}

/** Approved spend this month for one business, category and currency. */
function usedThisMonth(db: DatabaseSync, business: string, category: string, currency: string, now: number): number {
  const month = feeBudgetMonth(now);
  const rows = db
    .prepare(
      `SELECT amount_minor, decided_at FROM spend_requests
       WHERE business=? AND category=? AND currency=? AND status='approved' AND decided_at >= ?`,
    )
    .all(business, category, currency, now - 32 * 86_400_000) as Array<{ amount_minor: number; decided_at: number }>;
  return rows
    .filter((row) => feeBudgetMonth(Number(row.decided_at)) === month)
    .reduce((sum, row) => sum + Number(row.amount_minor), 0);
}

export function listSpendBudgets(db: DatabaseSync, now = Date.now()): SpendBudget[] {
  ensureSpendBudgetSchema(db);
  const saved = new Map(
    (db.prepare("SELECT * FROM spend_budgets").all() as Row[]).map((row) => [`${row.business}:${row.category}`, row]),
  );
  const month = feeBudgetMonth(now);
  return BUSINESS_KEYS.flatMap((business) =>
    SPEND_CATEGORIES.map((category) => {
      const row = saved.get(`${business}:${category}`);
      const currency = String(row?.currency ?? "USD");
      const monthly = Number(row?.monthly_cap_minor ?? 0);
      const used = usedThisMonth(db, business, category, currency, now);
      return {
        business,
        category,
        currency,
        monthly_cap_minor: monthly,
        per_item_cap_minor: Number(row?.per_item_cap_minor ?? 0),
        used_minor: used,
        remaining_minor: Math.max(0, monthly - used),
        month,
        updated_at: Number(row?.updated_at ?? 0),
      };
    }),
  );
}

function cap(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_SPEND_BUDGET_MINOR)
    throw new Error(`invalid_${field}`);
  return value;
}

export function saveSpendBudget(db: DatabaseSync, input: unknown, now = Date.now()): SpendBudget {
  ensureSpendBudgetSchema(db);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_payload");
  const body = input as Row;
  if (!isBusinessKey(body.business)) throw new Error("invalid_business");
  if (!isSpendCategory(body.category)) throw new Error("invalid_category");
  const currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "USD";
  currencyMinorDigits(currency);
  const monthly = cap(body.monthly_cap_minor, "monthly_cap_minor");
  const perItem = cap(body.per_item_cap_minor, "per_item_cap_minor");
  if (perItem > monthly) throw new Error("per_item_cap_above_monthly_cap");
  db.prepare(
    `INSERT INTO spend_budgets (business,category,currency,monthly_cap_minor,per_item_cap_minor,updated_at)
     VALUES (?,?,?,?,?,?) ON CONFLICT(business,category) DO UPDATE SET currency=excluded.currency,
     monthly_cap_minor=excluded.monthly_cap_minor, per_item_cap_minor=excluded.per_item_cap_minor, updated_at=excluded.updated_at`,
  ).run(body.business, body.category, currency, monthly, perItem, now);
  return listSpendBudgets(db, now).find((b) => b.business === body.business && b.category === body.category)!;
}

/**
 * True when a pending spend request fits its budget: same currency, at most the per-item limit, and within what is
 * left of this month's budget. Requests that would need a paid account or accepting terms never fit (routing).
 */
export function spendFitsBudget(
  db: DatabaseSync,
  request: { business?: unknown; category?: unknown; currency?: unknown; amount_minor?: unknown },
  now = Date.now(),
): boolean {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='spend_budgets'").get()) return false;
  const category = isSpendCategory(request.category) ? request.category : "other";
  if (!isBusinessKey(request.business)) return false;
  const budget = db
    .prepare("SELECT * FROM spend_budgets WHERE business=? AND category=?")
    .get(request.business, category) as Row | undefined;
  const amount = Number(request.amount_minor);
  if (!budget || !Number.isSafeInteger(amount) || amount <= 0) return false;
  if (String(request.currency) !== String(budget.currency)) return false;
  if (amount > Number(budget.per_item_cap_minor)) return false;
  const used = usedThisMonth(db, request.business, category, String(budget.currency), now);
  return used + amount <= Number(budget.monthly_cap_minor);
}

/**
 * A VP decision on a spend request. Only allowed while the request still fits its budget; the check and the update
 * run together, so two approvals cannot both use the last of a month's budget. Records permission only.
 */
export function decideSpendRequestAsVp(
  db: DatabaseSync,
  id: string,
  approve: boolean,
  decidedBy: string,
  now = Date.now(),
) {
  if (!decidedBy.startsWith("vp:")) throw new Error("vp_decision_required");
  const row = db.prepare("SELECT * FROM spend_requests WHERE id=?").get(id) as Row | undefined;
  if (!row) throw new Error("spend_request_not_found");
  if (row.status !== "pending") throw new Error("spend_request_already_decided");
  if (approve && !spendFitsBudget(db, row, now)) throw new Error("spend_over_budget_owner_required");
  db.prepare("UPDATE spend_requests SET status=?,decided_by=?,decided_at=? WHERE id=? AND status='pending'").run(
    approve ? "approved" : "denied",
    decidedBy,
    now,
    id,
  );
  return db.prepare("SELECT * FROM spend_requests WHERE id=?").get(id) as Row;
}
