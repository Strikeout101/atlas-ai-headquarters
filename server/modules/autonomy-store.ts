import type { DatabaseSync } from "node:sqlite";
import { BUSINESS_SQL_LIST, type BusinessKey } from "./businesses.ts";
import { getFinancialGoalProgress } from "./finance-store.ts";
import { businessGoalsTableSql, initiativesTableSql } from "./bootstrap/schema/work-model-migration.ts";

export interface AutonomyConfig {
  id: number;
  daily_start_cap: number;
  local_provider_daily_run_cap: number;
  usage_threshold: number;
  failure_limit: number;
  planning_interval_minutes: number;
  think_enabled: number;
  think_interval_minutes: number;
  think_check_interval_minutes: number;
  think_max_pending_per_agent: number;
  think_max_pending_total: number;
  idea_daily_start_cap: number;
}

/** Phase 4 data only. No goal, venture or routine is enabled by installing the schema. */
export function ensureAutonomySchema(db: DatabaseSync): void {
  db.exec(`
    ${businessGoalsTableSql()};
    ${initiativesTableSql()};
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
      project_id TEXT NOT NULL REFERENCES projects(id), department_id TEXT REFERENCES departments(id),
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'research' CHECK(kind IN ('research','lead_research')),
      interval_minutes INTEGER NOT NULL CHECK(interval_minutes>0), next_run_at INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_task_id TEXT REFERENCES tasks(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS autonomy_ledger (
      id INTEGER PRIMARY KEY, event TEXT NOT NULL, business TEXT, source_id TEXT, task_id TEXT,
      message TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS autonomy_config (
      id INTEGER PRIMARY KEY CHECK(id=1), daily_start_cap INTEGER NOT NULL DEFAULT 6 CHECK(daily_start_cap BETWEEN 0 AND 100),
      usage_threshold REAL NOT NULL DEFAULT 0.8 CHECK(usage_threshold BETWEEN 0 AND 1),
      failure_limit INTEGER NOT NULL DEFAULT 3 CHECK(failure_limit BETWEEN 1 AND 20),
      planning_interval_minutes INTEGER NOT NULL DEFAULT 360 CHECK(planning_interval_minutes BETWEEN 1 AND 10080)
    );
    INSERT OR IGNORE INTO autonomy_config(id) VALUES (1);
    CREATE INDEX IF NOT EXISTS idx_autonomy_ledger_created ON autonomy_ledger(created_at);
    CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled,next_run_at);
    CREATE TABLE IF NOT EXISTS autonomy_provider_invocations (
      invocation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, provider_id TEXT NOT NULL,
      day TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_autonomy_provider_invocations_day ON autonomy_provider_invocations(provider_id,day);
  `);
  if (
    !(db.prepare("PRAGMA table_info(business_goals)").all() as Array<{ name: string }>).some(
      (column) => column.name === "currency",
    )
  )
    db.exec("ALTER TABLE business_goals ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
  // Time-of-day schedules (schedule-time.ts): a cron rule in a time zone; interval_minutes is used when cron is empty.
  const scheduleColumns = new Set(
    (db.prepare("PRAGMA table_info(schedules)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!scheduleColumns.has("cron")) db.exec("ALTER TABLE schedules ADD COLUMN cron TEXT");
  if (!scheduleColumns.has("timezone")) db.exec("ALTER TABLE schedules ADD COLUMN timezone TEXT");
  if (
    !(db.prepare("PRAGMA table_info(autonomy_config)").all() as Array<{ name: string }>).some(
      (column) => column.name === "local_provider_daily_run_cap",
    )
  )
    db.exec(
      "ALTER TABLE autonomy_config ADD COLUMN local_provider_daily_run_cap INTEGER NOT NULL DEFAULT 20 CHECK(local_provider_daily_run_cap BETWEEN 0 AND 1000)",
    );
  const configColumns = new Set(
    (db.prepare("PRAGMA table_info(autonomy_config)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  for (const [name, definition] of [
    ["think_enabled", "INTEGER NOT NULL DEFAULT 1 CHECK(think_enabled IN (0,1))"],
    ["think_interval_minutes", "INTEGER NOT NULL DEFAULT 1440 CHECK(think_interval_minutes BETWEEN 60 AND 10080)"],
    [
      "think_check_interval_minutes",
      "INTEGER NOT NULL DEFAULT 30 CHECK(think_check_interval_minutes BETWEEN 1 AND 1440)",
    ],
    ["think_max_pending_per_agent", "INTEGER NOT NULL DEFAULT 2 CHECK(think_max_pending_per_agent BETWEEN 0 AND 20)"],
    ["think_max_pending_total", "INTEGER NOT NULL DEFAULT 12 CHECK(think_max_pending_total BETWEEN 0 AND 200)"],
    ["idea_daily_start_cap", "INTEGER NOT NULL DEFAULT 2 CHECK(idea_daily_start_cap BETWEEN 0 AND 100)"],
  ] as const) {
    if (!configColumns.has(name)) db.exec(`ALTER TABLE autonomy_config ADD COLUMN ${name} ${definition}`);
  }
  // Preserve the old off switch once, then let the new owner control be authoritative.
  if (
    !configColumns.has("think_enabled") &&
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()
  ) {
    const oldSwitch = db.prepare("SELECT value FROM settings WHERE key='autonomyProposalsEnabled'").get() as
      | { value: string }
      | undefined;
    if (oldSwitch?.value.replace(/"/g, "").trim() === "false")
      db.prepare("UPDATE autonomy_config SET think_enabled=0 WHERE id=1").run();
  }
}

export function autonomyConfig(db: DatabaseSync): AutonomyConfig {
  ensureAutonomySchema(db);
  return db.prepare("SELECT * FROM autonomy_config WHERE id=1").get() as unknown as AutonomyConfig;
}

export function appendAutonomyLedger(
  db: DatabaseSync,
  entry: {
    event: string;
    business?: BusinessKey | null;
    sourceId?: string | null;
    taskId?: string | null;
    message: string;
  },
  now = Date.now(),
): void {
  db.prepare(
    "INSERT INTO autonomy_ledger(event,business,source_id,task_id,message,created_at) VALUES (?,?,?,?,?,?)",
  ).run(entry.event, entry.business ?? null, entry.sourceId ?? null, entry.taskId ?? null, entry.message, now);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

/** Counts real records. Financial metrics deliberately remain unavailable until verified payment sync exists. */
function goalProgress(
  db: DatabaseSync,
  goal: Record<string, unknown>,
): { progress: number | null; progress_scope: string | null } {
  if (["revenue", "verified_revenue", "profit"].includes(String(goal.metric)) && tableExists(db, "ledger_entries"))
    return getFinancialGoalProgress(db, goal);
  if (goal.metric === "completed_tasks" && tableExists(db, "tasks")) {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE project_id=? AND status='done' AND completed_at>=? AND completed_at<?",
      )
      .get(String(goal.project_id), Number(goal.period_start), Number(goal.period_end)) as { n: number };
    return { progress: row.n, progress_scope: "project" };
  }
  const table = goal.metric === "contacts" ? "business_contacts" : goal.metric === "drafts" ? "business_drafts" : null;
  if (table && tableExists(db, table)) {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE business=? AND created_at>=? AND created_at<?`)
      .get(String(goal.business), Number(goal.period_start), Number(goal.period_end)) as { n: number };
    return { progress: row.n, progress_scope: "business" };
  }
  return { progress: null, progress_scope: null };
}

export function autonomyOverview(db: DatabaseSync) {
  ensureAutonomySchema(db);
  const hasLedger = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ledger_entries'").get(),
  );
  const spending = new Map(
    (hasLedger
      ? (db
          .prepare(
            "SELECT initiative_id, SUM(amount_minor) AS spent FROM ledger_entries WHERE kind='expense' AND currency='USD' AND initiative_id IS NOT NULL GROUP BY initiative_id",
          )
          .all() as Array<{ initiative_id: string; spent: number }>)
      : []
    ).map((row) => [row.initiative_id, Number(row.spent)]),
  );
  const goals = db
    .prepare("SELECT * FROM business_goals ORDER BY created_at DESC")
    .all()
    .map((goal): Record<string, unknown> & { progress: number | null; progress_scope: string | null } => ({
      ...goal,
      ...goalProgress(db, goal),
    }));
  return {
    goals,
    initiatives: (
      db.prepare("SELECT * FROM initiatives ORDER BY created_at DESC").all() as Array<Record<string, unknown>>
    ).map((initiative) => ({
      ...initiative,
      spent_minor: spending.get(String(initiative.id)) ?? 0,
    })),
    schedules: db.prepare("SELECT * FROM schedules ORDER BY next_run_at ASC").all(),
    config: autonomyConfig(db),
    ledger: db.prepare("SELECT * FROM autonomy_ledger ORDER BY id DESC LIMIT 200").all(),
  };
}
