import type { DatabaseSync } from "node:sqlite";
import { BUSINESS_SQL_LIST, type BusinessKey } from "./businesses.ts";
import { getFinancialGoalProgress } from "./finance-store.ts";

export interface AutonomyConfig {
  id: number;
  daily_start_cap: number;
  usage_threshold: number;
  failure_limit: number;
  planning_interval_minutes: number;
}

/** Phase 4 data only. No goal, venture or routine is enabled by installing the schema. */
export function ensureAutonomySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_goals (
      id TEXT PRIMARY KEY, business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
      project_id TEXT NOT NULL REFERENCES projects(id), metric TEXT NOT NULL, target REAL NOT NULL CHECK(target>=0),
      currency TEXT NOT NULL DEFAULT 'USD',
      period_start INTEGER NOT NULL, period_end INTEGER NOT NULL CHECK(period_end>period_start),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opportunities (
      id TEXT PRIMARY KEY, business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
      project_id TEXT NOT NULL REFERENCES projects(id), goal_id TEXT REFERENCES business_goals(id),
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      demand_score REAL NOT NULL DEFAULT 0 CHECK(demand_score BETWEEN 0 AND 100),
      revenue_score REAL NOT NULL DEFAULT 0 CHECK(revenue_score BETWEEN 0 AND 100),
      cost_score REAL NOT NULL DEFAULT 0 CHECK(cost_score BETWEEN 0 AND 100),
      difficulty_score REAL NOT NULL DEFAULT 0 CHECK(difficulty_score BETWEEN 0 AND 100),
      time_to_launch_score REAL NOT NULL DEFAULT 0 CHECK(time_to_launch_score BETWEEN 0 AND 100),
      budget REAL NOT NULL DEFAULT 0 CHECK(budget>=0),
      status TEXT NOT NULL DEFAULT 'idea' CHECK(status IN ('idea','researching','approved','building','launched','stopped')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY, business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
      project_id TEXT NOT NULL REFERENCES projects(id), department_id TEXT REFERENCES departments(id),
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'research' CHECK(kind IN ('research','lead_research')),
      interval_minutes INTEGER NOT NULL CHECK(interval_minutes>0), next_run_at INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_task_id TEXT REFERENCES tasks(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS autonomy_work (
      id TEXT PRIMARY KEY, business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
      project_id TEXT NOT NULL REFERENCES projects(id), opportunity_id TEXT REFERENCES opportunities(id),
      schedule_id TEXT REFERENCES schedules(id), proposal_id TEXT, task_id TEXT REFERENCES tasks(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','planned','running','done','failed','skipped')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_autonomy_work_status ON autonomy_work(status,created_at);
    CREATE INDEX IF NOT EXISTS idx_autonomy_work_task ON autonomy_work(task_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled,next_run_at);
  `);
  if (
    !(db.prepare("PRAGMA table_info(business_goals)").all() as Array<{ name: string }>).some(
      (column) => column.name === "currency",
    )
  )
    db.exec("ALTER TABLE business_goals ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
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
  const goals = db
    .prepare("SELECT * FROM business_goals ORDER BY created_at DESC")
    .all()
    .map((goal): Record<string, unknown> & { progress: number | null; progress_scope: string | null } => ({
      ...goal,
      ...goalProgress(db, goal),
    }));
  return {
    goals,
    opportunities: db.prepare("SELECT * FROM opportunities ORDER BY created_at DESC").all(),
    schedules: db.prepare("SELECT * FROM schedules ORDER BY next_run_at ASC").all(),
    config: autonomyConfig(db),
    ledger: db.prepare("SELECT * FROM autonomy_ledger ORDER BY id DESC LIMIT 200").all(),
  };
}
