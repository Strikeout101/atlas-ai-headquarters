import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { appendAutonomyLedger, ensureAutonomySchema } from "./autonomy-store.ts";
import { isBusinessKey } from "./businesses.ts";
import { opportunityMoney } from "./profit.ts";

/**
 * Experiments and auto-stop. Every opportunity has a money budget (`budget`, in USD), a task limit and a time limit.
 * Agents try variants of a listing (title, price, images, tags) and the results are measured from verified sales and
 * Etsy favorites. Rules the owner can edit stop opportunities that use their budget, run out of time or keep taking
 * work without a sale. A stop is recorded in the autonomy ledger with its reason; the owner can restart one.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export const VARIANT_VARIABLES = ["title", "price", "images", "tags", "other"] as const;
const DAY_MS = 86_400_000;
const LIVE_STATUSES = ["researching", "approved", "building", "launched"];

export interface ExperimentRules {
  enabled: boolean;
  stop_when_budget_spent_without_revenue: boolean;
  no_sale_days_after_launch: number;
  max_tasks_without_revenue: number;
}

function columns(db: Db, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

export function ensureExperimentSchema(db: Db): void {
  ensureAutonomySchema(db);
  const have = columns(db, "opportunities");
  const add = (name: string, sql: string) => {
    if (!have.has(name)) db.exec(`ALTER TABLE opportunities ADD COLUMN ${name} ${sql}`);
  };
  add("task_limit", "INTEGER NOT NULL DEFAULT 10");
  add("time_limit_days", "INTEGER NOT NULL DEFAULT 30");
  add("launched_at", "INTEGER");
  add("window_started_at", "INTEGER");
  add("stop_reason", "TEXT");
  add("playbook", "TEXT");
  add("playbook_stage", "TEXT");
  add("source_task_id", "TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS opportunity_variants (
    id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL REFERENCES opportunities(id), listing_id TEXT,
    variable TEXT NOT NULL CHECK(variable IN ('title','price','images','tags','other')), value TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '', agent_id TEXT, task_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_variants_opportunity ON opportunity_variants(opportunity_id, started_at);
  CREATE TABLE IF NOT EXISTS opportunity_metrics (
    id INTEGER PRIMARY KEY, opportunity_id TEXT NOT NULL, listing_id TEXT, favorers INTEGER, sales INTEGER,
    revenue_minor INTEGER, currency TEXT, recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_metrics_opportunity ON opportunity_metrics(opportunity_id, recorded_at);
  CREATE TABLE IF NOT EXISTS experiment_rules (
    id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 1,
    stop_when_budget_spent_without_revenue INTEGER NOT NULL DEFAULT 1,
    no_sale_days_after_launch INTEGER NOT NULL DEFAULT 30 CHECK(no_sale_days_after_launch BETWEEN 1 AND 365),
    max_tasks_without_revenue INTEGER NOT NULL DEFAULT 10 CHECK(max_tasks_without_revenue BETWEEN 1 AND 200),
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO experiment_rules(id) VALUES (1);`);
}

function fail(message: string): never {
  throw new Error(message);
}

export function experimentRules(db: Db): ExperimentRules {
  ensureExperimentSchema(db);
  const row = db.prepare("SELECT * FROM experiment_rules WHERE id=1").get() as Row;
  return {
    enabled: Boolean(row.enabled),
    stop_when_budget_spent_without_revenue: Boolean(row.stop_when_budget_spent_without_revenue),
    no_sale_days_after_launch: Number(row.no_sale_days_after_launch),
    max_tasks_without_revenue: Number(row.max_tasks_without_revenue),
  };
}

export function saveExperimentRules(db: Db, input: Row, now = Date.now()): ExperimentRules {
  const current = experimentRules(db);
  const next = { ...current };
  for (const key of ["enabled", "stop_when_budget_spent_without_revenue"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") fail(`invalid_${key}`);
    next[key] = input[key] as boolean;
  }
  for (const [key, max] of [
    ["no_sale_days_after_launch", 365],
    ["max_tasks_without_revenue", 200],
  ] as const) {
    if (input[key] === undefined) continue;
    const value = input[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) fail(`invalid_${key}`);
    next[key] = value;
  }
  db.prepare(
    `UPDATE experiment_rules SET enabled=?, stop_when_budget_spent_without_revenue=?, no_sale_days_after_launch=?,
     max_tasks_without_revenue=?, updated_at=? WHERE id=1`,
  ).run(
    next.enabled ? 1 : 0,
    next.stop_when_budget_spent_without_revenue ? 1 : 0,
    next.no_sale_days_after_launch,
    next.max_tasks_without_revenue,
    now,
  );
  return experimentRules(db);
}

/** Tasks the engine has started for an opportunity since its window began (a restart opens a new window). */
function taskCount(db: Db, opportunity: Row): number {
  return Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM autonomy_work WHERE opportunity_id=? AND status IN ('planned','running','done','failed') AND created_at>=?",
        )
        .get(String(opportunity.id), Number(opportunity.window_started_at ?? 0)) as { n: number }
    ).n,
  );
}

function budgetMinor(opportunity: Row): number {
  return Math.round(Number(opportunity.budget ?? 0) * 100);
}

/**
 * Why new work for this opportunity must not start, or null. An opportunity that earns more than it spent may keep
 * going past its budget; one with no sales stops at its money budget and at its task limit.
 */
export function opportunityBudgetBlock(db: Db, opportunityId: string): string | null {
  ensureExperimentSchema(db);
  const opportunity = db.prepare("SELECT * FROM opportunities WHERE id=?").get(opportunityId) as Row | undefined;
  if (!opportunity) return null;
  if (opportunity.status === "stopped")
    return `opportunity stopped${opportunity.stop_reason ? `: ${opportunity.stop_reason}` : ""}`;
  const { spent_minor, earned_minor } = opportunityMoney(db, opportunityId);
  const budget = budgetMinor(opportunity);
  if (budget > 0 && spent_minor >= budget && earned_minor < spent_minor)
    return `budget reached (spent ${(spent_minor / 100).toFixed(2)} of ${(budget / 100).toFixed(2)} USD)`;
  if (earned_minor === 0) {
    const limit = Math.min(Number(opportunity.task_limit ?? 10), experimentRules(db).max_tasks_without_revenue);
    if (taskCount(db, opportunity) >= limit) return `task limit reached (${limit} tasks without a sale)`;
  }
  return null;
}

function stop(db: Db, opportunity: Row, reason: string, now: number): void {
  db.prepare("UPDATE opportunities SET status='stopped', stop_reason=?, updated_at=? WHERE id=?").run(
    reason,
    now,
    String(opportunity.id),
  );
  db.prepare(
    "UPDATE autonomy_work SET status='skipped', updated_at=? WHERE opportunity_id=? AND status IN ('pending','planned')",
  ).run(now, String(opportunity.id));
  appendAutonomyLedger(
    db,
    {
      event: "auto_stopped",
      business: isBusinessKey(opportunity.business) ? opportunity.business : null,
      sourceId: String(opportunity.id),
      message: `Stopped "${String(opportunity.title).slice(0, 120)}": ${reason}`,
    },
    now,
  );
}

/** Applies the owner's stop rules. Returns the ids it stopped. Runs on every engine tick. */
export function evaluateOpportunities(db: Db, now = Date.now()): string[] {
  ensureExperimentSchema(db);
  const rules = experimentRules(db);
  if (!rules.enabled) return [];
  const stopped: string[] = [];
  const rows = db
    .prepare(`SELECT * FROM opportunities WHERE status IN (${LIVE_STATUSES.map(() => "?").join(",")})`)
    .all(...LIVE_STATUSES) as Row[];
  for (const opportunity of rows) {
    const { spent_minor, earned_minor } = opportunityMoney(db, String(opportunity.id));
    if (earned_minor > 0) continue;
    const budget = budgetMinor(opportunity);
    let reason: string | null = null;
    if (rules.stop_when_budget_spent_without_revenue && budget > 0 && spent_minor >= budget)
      reason = `budget of ${(budget / 100).toFixed(2)} USD used with no sales`;
    const days = Math.min(Number(opportunity.time_limit_days ?? 30), rules.no_sale_days_after_launch);
    const launchedAt = Number(opportunity.launched_at ?? 0);
    const windowStart = Math.max(launchedAt, Number(opportunity.window_started_at ?? 0));
    if (!reason && launchedAt > 0 && now - windowStart >= days * DAY_MS) reason = `no sales in ${days} days live`;
    if (!reason && taskCount(db, opportunity) >= rules.max_tasks_without_revenue)
      reason = `${rules.max_tasks_without_revenue} tasks with no sale`;
    if (reason) {
      stop(db, opportunity, reason, now);
      stopped.push(String(opportunity.id));
    }
  }
  return stopped;
}

/** Owner: bring a stopped opportunity back with a fresh window for its time and task limits. */
export function restartOpportunity(db: Db, id: string, now = Date.now()): Row {
  ensureExperimentSchema(db);
  const opportunity =
    (db.prepare("SELECT * FROM opportunities WHERE id=?").get(id) as Row | undefined) ?? fail("opportunity_not_found");
  if (opportunity.status !== "stopped") fail("opportunity_not_stopped");
  db.prepare("UPDATE opportunities SET status=?, stop_reason=NULL, window_started_at=?, updated_at=? WHERE id=?").run(
    opportunity.launched_at ? "launched" : "building",
    now,
    now,
    id,
  );
  appendAutonomyLedger(
    db,
    {
      event: "restarted",
      business: isBusinessKey(opportunity.business) ? opportunity.business : null,
      sourceId: id,
      message: `Owner restarted "${String(opportunity.title).slice(0, 120)}" with a fresh budget window`,
    },
    now,
  );
  return db.prepare("SELECT * FROM opportunities WHERE id=?").get(id) as Row;
}

/** A listing for this opportunity went live: the clock for "no sales in N days" starts now. */
export function markOpportunityLaunched(db: Db, opportunityId: string | null | undefined, now = Date.now()): void {
  if (!opportunityId) return;
  ensureExperimentSchema(db);
  db.prepare(
    "UPDATE opportunities SET launched_at=COALESCE(launched_at, ?), status=CASE WHEN status='stopped' THEN status ELSE 'launched' END, updated_at=? WHERE id=?",
  ).run(now, now, opportunityId);
}

export function startVariant(
  db: Db,
  input: Row,
  author: { agentId?: string | null; taskId?: string | null } = {},
  now = Date.now(),
): Row {
  ensureExperimentSchema(db);
  const opportunityId =
    typeof input.opportunity_id === "string" ? input.opportunity_id : fail("invalid_opportunity_id");
  const opportunity = db.prepare("SELECT * FROM opportunities WHERE id=?").get(opportunityId) as Row | undefined;
  if (!opportunity) fail("opportunity_not_found");
  if (opportunity.status === "stopped") fail("opportunity_stopped");
  const variable = input.variable;
  if (!(VARIANT_VARIABLES as readonly unknown[]).includes(variable)) fail("invalid_variable");
  const value = typeof input.value === "string" ? input.value.trim() : "";
  if (!value || value.length > 2000) fail("invalid_value");
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 1000) : "";
  const listingId = typeof input.listing_id === "string" && input.listing_id ? input.listing_id.slice(0, 128) : null;
  db.prepare(
    "UPDATE opportunity_variants SET ended_at=? WHERE opportunity_id=? AND variable=? AND ended_at IS NULL",
  ).run(now, opportunityId, String(variable));
  const id = randomUUID();
  db.prepare(
    `INSERT INTO opportunity_variants(id,opportunity_id,listing_id,variable,value,reason,agent_id,task_id,started_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    opportunityId,
    listingId,
    String(variable),
    value,
    reason,
    author.agentId ?? null,
    author.taskId ?? null,
    now,
  );
  return db.prepare("SELECT * FROM opportunity_variants WHERE id=?").get(id) as Row;
}

export function recordOpportunityMetric(
  db: Db,
  input: {
    opportunity_id: string;
    listing_id?: string | null;
    favorers?: number | null;
    sales?: number | null;
    revenue_minor?: number | null;
    currency?: string | null;
  },
  now = Date.now(),
): void {
  ensureExperimentSchema(db);
  db.prepare(
    "INSERT INTO opportunity_metrics(opportunity_id,listing_id,favorers,sales,revenue_minor,currency,recorded_at) VALUES (?,?,?,?,?,?,?)",
  ).run(
    input.opportunity_id,
    input.listing_id ?? null,
    input.favorers ?? null,
    input.sales ?? null,
    input.revenue_minor ?? null,
    input.currency ?? null,
    now,
  );
}

/** Sales and revenue (verified ledger rows) and favorites gained during each variant's window. */
export function variantResults(db: Db, opportunityId: string, now = Date.now()) {
  ensureExperimentSchema(db);
  const variants = db
    .prepare("SELECT * FROM opportunity_variants WHERE opportunity_id=? ORDER BY started_at DESC LIMIT 20")
    .all(opportunityId) as Row[];
  const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_entries'").get();
  return variants.map(
    (variant): Row & { days: number; sales: number; revenue_minor: number; favorers_gained: number | null } => {
      const from = Number(variant.started_at);
      const to = Number(variant.ended_at ?? now);
      const money = hasLedger
        ? (db
            .prepare(
              `SELECT COUNT(*) AS sales, COALESCE(SUM(amount_minor),0) AS revenue FROM ledger_entries
             WHERE opportunity_id=? AND kind='revenue' AND verified=1 AND occurred_at>=? AND occurred_at<?`,
            )
            .get(opportunityId, from, to) as { sales: number; revenue: number })
        : { sales: 0, revenue: 0 };
      const favorers = (at: number, dir: "first" | "last") =>
        db
          .prepare(
            `SELECT favorers FROM opportunity_metrics WHERE opportunity_id=? AND favorers IS NOT NULL AND recorded_at${
              dir === "first" ? ">=" : "<="
            }? ORDER BY recorded_at ${dir === "first" ? "ASC" : "DESC"} LIMIT 1`,
          )
          .get(opportunityId, at) as { favorers: number } | undefined;
      const startFav = favorers(from, "first")?.favorers;
      const endFav = favorers(to, "last")?.favorers;
      return {
        ...variant,
        days: Math.max(0, (to - from) / DAY_MS),
        sales: Number(money.sales),
        revenue_minor: Number(money.revenue),
        favorers_gained: startFav !== undefined && endFav !== undefined ? endFav - startFav : null,
      };
    },
  );
}

/** What the planner sees for one opportunity: money, age, limits and experiment results. */
export function opportunitySummary(db: Db, opportunity: Row, now = Date.now()) {
  const money = opportunityMoney(db, String(opportunity.id));
  return {
    spent_usd: money.spent_minor / 100,
    earned_usd: money.earned_minor / 100,
    budget_usd: Number(opportunity.budget ?? 0),
    days_live: opportunity.launched_at ? Math.floor((now - Number(opportunity.launched_at)) / DAY_MS) : null,
    tasks_in_window: taskCount(db, opportunity),
    task_limit: Number(opportunity.task_limit ?? 10),
    playbook_stage: opportunity.playbook_stage ?? null,
    stop_reason: opportunity.stop_reason ?? null,
    variants: variantResults(db, String(opportunity.id), now).map((v) => ({
      variable: v.variable,
      value: String(v.value).slice(0, 200),
      days: Math.round(v.days),
      sales: v.sales,
      revenue_usd: v.revenue_minor / 100,
      favorers_gained: v.favorers_gained,
      active: v.ended_at === null || v.ended_at === undefined,
    })),
  };
}
