import type { DatabaseSync } from "node:sqlite";
import { autonomyOverview } from "./autonomy-store.ts";
import { BUSINESS_KEYS, isBusinessKey, type BusinessKey } from "./businesses.ts";
import { ensureExperimentSchema, initiativeSummary } from "./experiments.ts";
import { ensureFinanceSchema } from "./finance-store.ts";
import { listMilestones } from "./goal-milestones.ts";
import { profitLines, profitSettings } from "./profit.ts";

/**
 * One income stream (a business) on one page: its goals against verified results and milestones, every product or
 * service idea with its money and stage, what the engine has queued or is running next, listings, schedules and the
 * month's profit. Read-only; built from the same records the engine uses.
 */
type Db = DatabaseSync;
type Row = Record<string, unknown>;

function table(db: Db, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function streamOverview(db: Db, businessInput: unknown, now = Date.now()) {
  const business = (isBusinessKey(businessInput) ? businessInput : "ventures") as BusinessKey;
  ensureExperimentSchema(db);
  ensureFinanceSchema(db);
  const overview = autonomyOverview(db);
  const goals = (overview.goals as Row[])
    .filter((goal) => goal.business === business)
    .map((goal) => ({ ...goal, milestones: listMilestones(db, String(goal.id)) }));
  const initiatives = (overview.initiatives as Row[])
    .filter((initiative) => initiative.business === business)
    .map((initiative): Row & { results: ReturnType<typeof initiativeSummary> } => ({
      ...initiative,
      results: initiativeSummary(db, initiative, now),
    }));
  const work = db
    .prepare(
      `SELECT id, title, status, initiative_id, playbook_step, created_at
       FROM tasks
       WHERE business=? AND origin='autonomy' AND status IN ('planned','in_progress','review','pending','inbox')
       ORDER BY created_at`,
    )
    .all(business) as Row[];
  const listings = table(db, "listing_packages")
    ? (db
        .prepare("SELECT status, COUNT(*) AS n FROM listing_packages WHERE business=? GROUP BY status")
        .all(business) as Array<{ status: string; n: number }>)
    : [];
  const schedules = (overview.schedules as Row[])
    .filter((schedule) => schedule.business === business)
    .map((schedule) => ({
      id: schedule.id,
      title: schedule.title,
      enabled: Boolean(schedule.enabled),
      next_run_at: schedule.next_run_at,
      cron: schedule.cron ?? null,
      timezone: schedule.timezone ?? null,
      playbook: schedule.playbook ?? null,
    }));
  const date = new Date(now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const ledger = db
    .prepare("SELECT * FROM ledger_entries WHERE business=? AND occurred_at>=? AND occurred_at<?")
    .all(business, monthStart, now) as Row[];
  const events = db
    .prepare("SELECT event, message, created_at FROM autonomy_ledger WHERE business=? ORDER BY id DESC LIMIT 20")
    .all(business);
  const stages = ["proposed", "approved", "in_progress", "blocked", "launched", "measuring", "stopped", "done"];
  return {
    business,
    businesses: [...BUSINESS_KEYS],
    goals,
    pipeline: Object.fromEntries(
      stages.map((stage) => [stage, initiatives.filter((o) => o.status === stage).length]),
    ) as Record<string, number>,
    initiatives,
    next: work,
    listings: Object.fromEntries(listings.map((row) => [row.status, Number(row.n)])),
    schedules,
    month: {
      from: monthStart,
      to: now,
      costs_complete: profitSettings(db).costs_complete,
      lines: profitLines(db, ledger, monthStart, now, business),
    },
    recent: events,
  };
}
