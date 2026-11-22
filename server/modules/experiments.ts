import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { appendAutonomyLedger, ensureAutonomySchema } from "./autonomy-store.ts";
import { isBusinessKey } from "./businesses.ts";
import { initiativeMoney } from "./profit.ts";

/**
 * Experiments and auto-stop. Every initiative has a money budget (`budget`, in USD), a task limit and a time limit.
 * Agents try variants of a listing (title, price, images, tags) and the results are measured from verified sales and
 * Etsy favorites. Rules the owner can edit stop initiatives that use their budget, run out of time or keep taking
 * work without a sale. A stop is recorded in the autonomy ledger with its reason; the owner can restart one.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

export const VARIANT_VARIABLES = ["title", "price", "images", "tags", "other"] as const;
const DAY_MS = 86_400_000;
const LIVE_STATUSES = ["approved", "in_progress", "blocked", "launched", "measuring"];

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
  const have = columns(db, "initiatives");
  const add = (name: string, sql: string) => {
    if (!have.has(name)) db.exec(`ALTER TABLE initiatives ADD COLUMN ${name} ${sql}`);
  };
  add("task_limit", "INTEGER NOT NULL DEFAULT 10");
  add("time_limit_days", "INTEGER NOT NULL DEFAULT 30");
  add("launched_at", "INTEGER");
  add("window_started_at", "INTEGER");
  add("stop_reason", "TEXT");
  add("playbook", "TEXT");
  add("playbook_stage", "TEXT");
  add("source_task_id", "TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS initiative_variants (
    id TEXT PRIMARY KEY, initiative_id TEXT NOT NULL REFERENCES initiatives(id), listing_id TEXT,
    variable TEXT NOT NULL CHECK(variable IN ('title','price','images','tags','other')), value TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '', agent_id TEXT, task_id TEXT, started_at INTEGER NOT NULL, ended_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_variants_initiative ON initiative_variants(initiative_id, started_at);
  CREATE TABLE IF NOT EXISTS initiative_metrics (
    id INTEGER PRIMARY KEY, initiative_id TEXT NOT NULL, listing_id TEXT, favorers INTEGER, sales INTEGER,
    revenue_minor INTEGER, currency TEXT, recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_metrics_initiative ON initiative_metrics(initiative_id, recorded_at);
  CREATE TABLE IF NOT EXISTS experiment_rules (
    id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 1,
    stop_when_budget_spent_without_revenue INTEGER NOT NULL DEFAULT 1,
    no_sale_days_after_launch INTEGER NOT NULL DEFAULT 30 CHECK(no_sale_days_after_launch BETWEEN 1 AND 365),
    max_tasks_without_revenue INTEGER NOT NULL DEFAULT 10 CHECK(max_tasks_without_revenue BETWEEN 1 AND 200),
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO experiment_rules(id) VALUES (1);`);
  // Lifetime views of the listing, read from Etsy with favorites (2026-11-22).
  if (!columns(db, "initiative_metrics").has("views"))
    db.exec("ALTER TABLE initiative_metrics ADD COLUMN views INTEGER");
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

/** Tasks started for an initiative since its window began (a restart opens a new window). Retries count once. */
function taskCount(db: Db, initiative: Row): number {
  return Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM tasks WHERE initiative_id=? AND started_at IS NOT NULL AND created_at>=? AND status<>'cancelled'",
        )
        .get(String(initiative.id), Number(initiative.window_started_at ?? 0)) as { n: number }
    ).n,
  );
}

function budgetMinor(initiative: Row): number {
  return Math.round(Number(initiative.budget ?? 0) * 100);
}

/**
 * Why new work for this initiative must not start, or null. An initiative that earns more than it spent may keep
 * going past its budget; one with no sales stops at its money budget and at its task limit.
 */
export function initiativeBudgetBlock(db: Db, initiativeId: string): string | null {
  ensureExperimentSchema(db);
  const initiative = db.prepare("SELECT * FROM initiatives WHERE id=?").get(initiativeId) as Row | undefined;
  if (!initiative) return null;
  if (initiative.status === "stopped")
    return `initiative stopped${initiative.stop_reason ? `: ${initiative.stop_reason}` : ""}`;
  const { spent_minor, earned_minor } = initiativeMoney(db, initiativeId);
  const budget = budgetMinor(initiative);
  if (budget > 0 && spent_minor >= budget && earned_minor < spent_minor)
    return `budget reached (spent ${(spent_minor / 100).toFixed(2)} of ${(budget / 100).toFixed(2)} USD)`;
  if (earned_minor === 0) {
    const limit = Math.min(Number(initiative.task_limit ?? 10), experimentRules(db).max_tasks_without_revenue);
    if (taskCount(db, initiative) >= limit) return `task limit reached (${limit} tasks without a sale)`;
  }
  return null;
}

function stop(db: Db, initiative: Row, reason: string, now: number): void {
  db.prepare("UPDATE initiatives SET status='stopped', stop_reason=?, updated_at=? WHERE id=?").run(
    reason,
    now,
    String(initiative.id),
  );
  // Steps that have not started yet are cancelled; running work finishes.
  db.prepare(
    "UPDATE tasks SET status='cancelled', updated_at=? WHERE initiative_id=? AND origin='autonomy' AND status='planned'",
  ).run(now, String(initiative.id));
  appendAutonomyLedger(
    db,
    {
      event: "auto_stopped",
      business: isBusinessKey(initiative.business) ? initiative.business : null,
      sourceId: String(initiative.id),
      message: `Stopped "${String(initiative.title).slice(0, 120)}": ${reason}`,
    },
    now,
  );
}

/** Applies the owner's stop rules. Returns the ids it stopped. Runs on every engine tick. */
export function evaluateInitiatives(db: Db, now = Date.now()): string[] {
  ensureExperimentSchema(db);
  const rules = experimentRules(db);
  if (!rules.enabled) return [];
  const stopped: string[] = [];
  const rows = db
    .prepare(`SELECT * FROM initiatives WHERE status IN (${LIVE_STATUSES.map(() => "?").join(",")})`)
    .all(...LIVE_STATUSES) as Row[];
  for (const initiative of rows) {
    const { spent_minor, earned_minor } = initiativeMoney(db, String(initiative.id));
    if (earned_minor > 0) continue;
    const budget = budgetMinor(initiative);
    let reason: string | null = null;
    if (rules.stop_when_budget_spent_without_revenue && budget > 0 && spent_minor >= budget)
      reason = `budget of ${(budget / 100).toFixed(2)} USD used with no sales`;
    const days = Math.min(Number(initiative.time_limit_days ?? 30), rules.no_sale_days_after_launch);
    const launchedAt = Number(initiative.launched_at ?? 0);
    const windowStart = Math.max(launchedAt, Number(initiative.window_started_at ?? 0));
    if (!reason && launchedAt > 0 && now - windowStart >= days * DAY_MS) reason = `no sales in ${days} days live`;
    if (!reason && taskCount(db, initiative) >= rules.max_tasks_without_revenue)
      reason = `${rules.max_tasks_without_revenue} tasks with no sale`;
    if (reason) {
      stop(db, initiative, reason, now);
      stopped.push(String(initiative.id));
    }
  }
  return stopped;
}

/** Owner: bring a stopped initiative back with a fresh window for its time and task limits. */
export function restartInitiative(db: Db, id: string, now = Date.now()): Row {
  ensureExperimentSchema(db);
  const initiative =
    (db.prepare("SELECT * FROM initiatives WHERE id=?").get(id) as Row | undefined) ?? fail("initiative_not_found");
  if (initiative.status !== "stopped") fail("initiative_not_stopped");
  db.prepare("UPDATE initiatives SET status=?, stop_reason=NULL, window_started_at=?, updated_at=? WHERE id=?").run(
    initiative.launched_at ? "launched" : "in_progress",
    now,
    now,
    id,
  );
  appendAutonomyLedger(
    db,
    {
      event: "restarted",
      business: isBusinessKey(initiative.business) ? initiative.business : null,
      sourceId: id,
      message: `Owner restarted "${String(initiative.title).slice(0, 120)}" with a fresh budget window`,
    },
    now,
  );
  return db.prepare("SELECT * FROM initiatives WHERE id=?").get(id) as Row;
}

/** A listing for this initiative went live: the clock for "no sales in N days" starts now. */
export function markInitiativeLaunched(db: Db, initiativeId: string | null | undefined, now = Date.now()): void {
  if (!initiativeId) return;
  ensureExperimentSchema(db);
  db.prepare(
    "UPDATE initiatives SET launched_at=COALESCE(launched_at, ?), status=CASE WHEN status='stopped' THEN status ELSE 'launched' END, updated_at=? WHERE id=?",
  ).run(now, now, initiativeId);
}

export function startVariant(
  db: Db,
  input: Row,
  author: { agentId?: string | null; taskId?: string | null } = {},
  now = Date.now(),
): Row {
  ensureExperimentSchema(db);
  const initiativeId = typeof input.initiative_id === "string" ? input.initiative_id : fail("invalid_initiative_id");
  const initiative = db.prepare("SELECT * FROM initiatives WHERE id=?").get(initiativeId) as Row | undefined;
  if (!initiative) fail("initiative_not_found");
  if (initiative.status === "stopped") fail("initiative_stopped");
  const variable = input.variable;
  if (!(VARIANT_VARIABLES as readonly unknown[]).includes(variable)) fail("invalid_variable");
  const value = typeof input.value === "string" ? input.value.trim() : "";
  if (!value || value.length > 2000) fail("invalid_value");
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 1000) : "";
  const listingId = typeof input.listing_id === "string" && input.listing_id ? input.listing_id.slice(0, 128) : null;
  db.prepare("UPDATE initiative_variants SET ended_at=? WHERE initiative_id=? AND variable=? AND ended_at IS NULL").run(
    now,
    initiativeId,
    String(variable),
  );
  const id = randomUUID();
  db.prepare(
    `INSERT INTO initiative_variants(id,initiative_id,listing_id,variable,value,reason,agent_id,task_id,started_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    initiativeId,
    listingId,
    String(variable),
    value,
    reason,
    author.agentId ?? null,
    author.taskId ?? null,
    now,
  );
  return db.prepare("SELECT * FROM initiative_variants WHERE id=?").get(id) as Row;
}

export function recordInitiativeMetric(
  db: Db,
  input: {
    initiative_id: string;
    listing_id?: string | null;
    favorers?: number | null;
    views?: number | null;
    sales?: number | null;
    revenue_minor?: number | null;
    currency?: string | null;
  },
  now = Date.now(),
): void {
  ensureExperimentSchema(db);
  db.prepare(
    "INSERT INTO initiative_metrics(initiative_id,listing_id,favorers,views,sales,revenue_minor,currency,recorded_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    input.initiative_id,
    input.listing_id ?? null,
    input.favorers ?? null,
    input.views ?? null,
    input.sales ?? null,
    input.revenue_minor ?? null,
    input.currency ?? null,
    now,
  );
}

/** Sales and revenue (verified ledger rows), and favorites and views gained, during each variant's window. */
export function variantResults(db: Db, initiativeId: string, now = Date.now()) {
  ensureExperimentSchema(db);
  const variants = db
    .prepare("SELECT * FROM initiative_variants WHERE initiative_id=? ORDER BY started_at DESC LIMIT 20")
    .all(initiativeId) as Row[];
  const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_entries'").get();
  return variants.map(
    (
      variant,
    ): Row & {
      days: number;
      sales: number;
      revenue_minor: number;
      favorers_gained: number | null;
      views_gained: number | null;
    } => {
      const from = Number(variant.started_at);
      const to = Number(variant.ended_at ?? now);
      const money = hasLedger
        ? (db
            .prepare(
              `SELECT COUNT(*) AS sales, COALESCE(SUM(amount_minor),0) AS revenue FROM ledger_entries
             WHERE initiative_id=? AND kind='revenue' AND verified=1 AND occurred_at>=? AND occurred_at<?`,
            )
            .get(initiativeId, from, to) as { sales: number; revenue: number })
        : { sales: 0, revenue: 0 };
      const favorers = (at: number, dir: "first" | "last") =>
        db
          .prepare(
            `SELECT favorers FROM initiative_metrics WHERE initiative_id=? AND favorers IS NOT NULL AND recorded_at${
              dir === "first" ? ">=" : "<="
            }? ORDER BY recorded_at ${dir === "first" ? "ASC" : "DESC"} LIMIT 1`,
          )
          .get(initiativeId, at) as { favorers: number } | undefined;
      const startFav = favorers(from, "first")?.favorers;
      const endFav = favorers(to, "last")?.favorers;
      const views = (at: number, dir: "first" | "last") =>
        db
          .prepare(
            `SELECT views FROM initiative_metrics WHERE initiative_id=? AND views IS NOT NULL AND recorded_at${
              dir === "first" ? ">=" : "<="
            }? ORDER BY recorded_at ${dir === "first" ? "ASC" : "DESC"} LIMIT 1`,
          )
          .get(initiativeId, at) as { views: number } | undefined;
      const startViews = views(from, "first")?.views;
      const endViews = views(to, "last")?.views;
      return {
        ...variant,
        days: Math.max(0, (to - from) / DAY_MS),
        sales: Number(money.sales),
        revenue_minor: Number(money.revenue),
        favorers_gained: startFav !== undefined && endFav !== undefined ? endFav - startFav : null,
        views_gained: startViews !== undefined && endViews !== undefined ? endViews - startViews : null,
      };
    },
  );
}

/** What the planner sees for one initiative: money, age, limits and experiment results. */
export function initiativeSummary(db: Db, initiative: Row, now = Date.now()) {
  const money = initiativeMoney(db, String(initiative.id));
  return {
    spent_usd: money.spent_minor / 100,
    earned_usd: money.earned_minor / 100,
    budget_usd: Number(initiative.budget ?? 0),
    days_live: initiative.launched_at ? Math.floor((now - Number(initiative.launched_at)) / DAY_MS) : null,
    tasks_in_window: taskCount(db, initiative),
    task_limit: Number(initiative.task_limit ?? 10),
    playbook_stage: initiative.playbook_stage ?? null,
    stop_reason: initiative.stop_reason ?? null,
    // Latest lifetime views and favorites across the initiative's listings, as Etsy last reported them.
    views:
      (
        db
          .prepare(
            `SELECT SUM(views) AS n FROM (SELECT listing_id, views FROM initiative_metrics m WHERE initiative_id=? AND views IS NOT NULL
             AND recorded_at=(SELECT MAX(recorded_at) FROM initiative_metrics x WHERE x.initiative_id=m.initiative_id AND x.listing_id IS m.listing_id))`,
          )
          .get(String(initiative.id)) as { n: number | null }
      ).n ?? null,
    variants: variantResults(db, String(initiative.id), now).map((v) => ({
      variable: v.variable,
      value: String(v.value).slice(0, 200),
      days: Math.round(v.days),
      sales: v.sales,
      revenue_usd: v.revenue_minor / 100,
      favorers_gained: v.favorers_gained,
      views_gained: v.views_gained,
      active: v.ended_at === null || v.ended_at === undefined,
    })),
  };
}
