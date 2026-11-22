import type { DatabaseSync } from "node:sqlite";
import { BUSINESS_SQL_LIST } from "../../businesses.ts";

type DbLike = Pick<DatabaseSync, "exec" | "prepare">;

/**
 * Work restructure, phase 1 (docs/work-restructure-plan.md, section 12a).
 *
 * Runs on every start, before any module creates its own tables, and is a no-op once applied:
 * - `opportunities` becomes `initiatives` (always under a goal, new statuses, step tracking).
 * - `opportunity_variants` / `opportunity_metrics` become `initiative_variants` / `initiative_metrics`,
 *   and every `opportunity_id` column becomes `initiative_id`.
 * - `business_goals` no longer needs a project and gains a title and initiative slots.
 * - `goal_strategies` gains versions and an approval status.
 * - `tasks` gains business, goal, initiative, work type, importance, playbook step and attempt.
 * - `task_handoffs` holds each task's structured result.
 *
 * Fresh databases skip the renames: the modules create the new tables directly.
 */

export const WORK_TYPES = [
  "research",
  "product",
  "design",
  "listing",
  "shop_admin",
  "outreach",
  "code",
  "ops",
] as const;
export type WorkType = (typeof WORK_TYPES)[number];
export const TASK_IMPORTANCE = ["important", "routine"] as const;
export type TaskImportance = (typeof TASK_IMPORTANCE)[number];
export const INITIATIVE_STATUSES = [
  "proposed",
  "approved",
  "in_progress",
  "blocked",
  "launched",
  "measuring",
  "stopped",
  "done",
] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];
export const STRATEGY_STATUSES = ["draft", "proposed", "approved", "superseded"] as const;

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(",");

/** The one definition of the initiatives table, shared by the migration and `ensureAutonomySchema`. */
export function initiativesTableSql(name = "initiatives"): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT PRIMARY KEY, business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
    goal_id TEXT NOT NULL REFERENCES business_goals(id), project_id TEXT REFERENCES projects(id),
    title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    demand_score REAL NOT NULL DEFAULT 0 CHECK(demand_score BETWEEN 0 AND 100),
    revenue_score REAL NOT NULL DEFAULT 0 CHECK(revenue_score BETWEEN 0 AND 100),
    cost_score REAL NOT NULL DEFAULT 0 CHECK(cost_score BETWEEN 0 AND 100),
    difficulty_score REAL NOT NULL DEFAULT 0 CHECK(difficulty_score BETWEEN 0 AND 100),
    time_to_launch_score REAL NOT NULL DEFAULT 0 CHECK(time_to_launch_score BETWEEN 0 AND 100),
    budget REAL NOT NULL DEFAULT 0 CHECK(budget>=0),
    status TEXT NOT NULL DEFAULT 'proposed' CHECK(status IN (${sqlList(INITIATIVE_STATUSES)})),
    playbook TEXT, playbook_stage TEXT, step_attempts INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT,
    task_limit INTEGER NOT NULL DEFAULT 10, task_cap_daily INTEGER NOT NULL DEFAULT 3,
    time_limit_days INTEGER NOT NULL DEFAULT 30, launched_at INTEGER, window_started_at INTEGER, stop_reason TEXT,
    strategy_id TEXT, source_task_id TEXT, approved_at INTEGER, approved_by TEXT, escalation TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`;
}

export function businessGoalsTableSql(name = "business_goals"): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT PRIMARY KEY, business TEXT NOT NULL CHECK(business IN (${BUSINESS_SQL_LIST})),
    project_id TEXT REFERENCES projects(id), title TEXT NOT NULL DEFAULT '',
    metric TEXT NOT NULL, target REAL NOT NULL CHECK(target>=0), currency TEXT NOT NULL DEFAULT 'USD',
    period_start INTEGER NOT NULL, period_end INTEGER NOT NULL CHECK(period_end>period_start),
    initiative_slots INTEGER NOT NULL DEFAULT 3 CHECK(initiative_slots BETWEEN 1 AND 10),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`;
}

function tableExists(db: DbLike, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function columnInfo(db: DbLike, table: string): Array<{ name: string; notnull: number }> {
  return db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string; notnull: number }>;
}

function hasColumn(db: DbLike, table: string, column: string): boolean {
  return columnInfo(db, table).some((c) => c.name === column);
}

const OLD_STATUS_TO_NEW: Record<string, string> = {
  idea: "proposed",
  researching: "in_progress",
  approved: "approved",
  building: "in_progress",
  launched: "launched",
  stopped: "stopped",
};

/** Columns that held an opportunity id and now hold an initiative id. */
const ID_COLUMN_TABLES = [
  "initiative_variants",
  "initiative_metrics",
  "deals",
  "spend_requests",
  "listing_packages",
  "ledger_entries",
  "media_assets",
  "autonomy_work",
];

const OLD_INDEXES = [
  "idx_variants_opportunity",
  "idx_metrics_opportunity",
  "idx_ledger_opportunity",
  "idx_media_opportunity",
];

function renameOpportunities(db: DbLike): void {
  if (!tableExists(db, "opportunities")) return;
  if (tableExists(db, "initiatives")) throw new Error("work_model_migration: both opportunities and initiatives exist");
  // Renaming first makes SQLite rewrite every foreign key that points at the table.
  db.exec("ALTER TABLE opportunities RENAME TO initiatives");
  // Rebuild in place: goal_id becomes required, project_id optional, statuses change, new columns arrive.
  const old = new Set(columnInfo(db, "initiatives").map((c) => c.name));
  const pick = (name: string, fallback: string) => (old.has(name) ? name : fallback);
  db.exec(initiativesTableSql("initiatives_rebuild"));
  const latestGoal = (business: string) =>
    db
      .prepare("SELECT id FROM business_goals WHERE business=? ORDER BY period_end DESC, created_at DESC LIMIT 1")
      .get(business) as { id: string } | undefined;
  const rows = db.prepare("SELECT * FROM initiatives").all() as Array<Record<string, unknown>>;
  const insert = db.prepare(
    `INSERT INTO initiatives_rebuild (id,business,goal_id,project_id,title,description,demand_score,revenue_score,cost_score,
      difficulty_score,time_to_launch_score,budget,status,playbook,playbook_stage,task_limit,time_limit_days,launched_at,
      window_started_at,stop_reason,source_task_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const row of rows) {
    const goalId = (row.goal_id as string | null) ?? latestGoal(String(row.business))?.id ?? null;
    if (!goalId) continue; // An idea with no goal anywhere has nothing to belong to; it stays in the archive copy.
    insert.run(
      String(row.id),
      String(row.business),
      goalId,
      (row.project_id as string | null) ?? null,
      String(row.title),
      String(row.description ?? ""),
      Number(row.demand_score ?? 0),
      Number(row.revenue_score ?? 0),
      Number(row.cost_score ?? 0),
      Number(row.difficulty_score ?? 0),
      Number(row.time_to_launch_score ?? 0),
      Number(row.budget ?? 0),
      OLD_STATUS_TO_NEW[String(row.status)] ?? "proposed",
      (row[pick("playbook", "")] as string | null) ?? null,
      (row[pick("playbook_stage", "")] as string | null) ?? null,
      Number(row.task_limit ?? 10),
      Number(row.time_limit_days ?? 30),
      (row.launched_at as number | null) ?? null,
      (row.window_started_at as number | null) ?? null,
      (row.stop_reason as string | null) ?? null,
      (row.source_task_id as string | null) ?? null,
      Number(row.created_at),
      Number(row.updated_at),
    );
  }
  if (rows.length) {
    // Keep the untouched originals next to the other archived work (section 11 of the plan).
    db.exec("CREATE TABLE IF NOT EXISTS archive_20261122_opportunities AS SELECT * FROM initiatives WHERE 0");
    db.exec("INSERT INTO archive_20261122_opportunities SELECT * FROM initiatives");
  }
  db.exec("DROP TABLE initiatives");
  db.exec("ALTER TABLE initiatives_rebuild RENAME TO initiatives");

  if (tableExists(db, "opportunity_variants"))
    db.exec("ALTER TABLE opportunity_variants RENAME TO initiative_variants");
  if (tableExists(db, "opportunity_metrics")) db.exec("ALTER TABLE opportunity_metrics RENAME TO initiative_metrics");
  for (const table of ID_COLUMN_TABLES) {
    if (tableExists(db, table) && hasColumn(db, table, "opportunity_id") && !hasColumn(db, table, "initiative_id"))
      db.exec(`ALTER TABLE "${table}" RENAME COLUMN opportunity_id TO initiative_id`);
  }
  for (const index of OLD_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index}`);
}

function rebuildBusinessGoals(db: DbLike): void {
  if (!tableExists(db, "business_goals")) return;
  const cols = columnInfo(db, "business_goals");
  if (cols.some((c) => c.name === "initiative_slots")) return;
  const hasCurrency = cols.some((c) => c.name === "currency");
  db.exec(businessGoalsTableSql("business_goals_rebuild"));
  db.exec(`INSERT INTO business_goals_rebuild (id,business,project_id,title,metric,target,currency,period_start,period_end,
      created_at,updated_at)
    SELECT id,business,project_id,'',metric,target,${hasCurrency ? "currency" : "'USD'"},period_start,period_end,created_at,updated_at
    FROM business_goals`);
  db.exec("DROP TABLE business_goals");
  db.exec("ALTER TABLE business_goals_rebuild RENAME TO business_goals");
}

function upgradeStrategies(db: DbLike): void {
  if (!tableExists(db, "goal_strategies")) return;
  if (!hasColumn(db, "goal_strategies", "version")) {
    db.exec("ALTER TABLE goal_strategies ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    db.exec(
      `ALTER TABLE goal_strategies ADD COLUMN status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN (${sqlList(STRATEGY_STATUSES)}))`,
    );
    db.exec("ALTER TABLE goal_strategies ADD COLUMN approved_at INTEGER");
    // Number existing strategies per goal, oldest first; only the newest stays approved.
    const rows = db.prepare("SELECT id, goal_id FROM goal_strategies ORDER BY goal_id, created_at").all() as Array<{
      id: string;
      goal_id: string;
    }>;
    const seen = new Map<string, number>();
    for (const row of rows) {
      const version = (seen.get(row.goal_id) ?? 0) + 1;
      seen.set(row.goal_id, version);
      db.prepare("UPDATE goal_strategies SET version=?, status='superseded' WHERE id=?").run(version, row.id);
    }
    db.exec(`UPDATE goal_strategies SET status='approved', approved_at=created_at WHERE id IN (
      SELECT id FROM goal_strategies g WHERE created_at = (SELECT MAX(created_at) FROM goal_strategies WHERE goal_id=g.goal_id))`);
  }
}

/** Task columns and the hand-off table. Safe to call from any module or test. */
export function ensureWorkModelSchema(db: DbLike): void {
  if (tableExists(db, "tasks")) {
    const add = (name: string, sql: string) => {
      if (!hasColumn(db, "tasks", name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${sql}`);
    };
    add("business", "TEXT");
    add("goal_id", "TEXT");
    add("initiative_id", "TEXT");
    add("work_type", `TEXT CHECK(work_type IS NULL OR work_type IN (${sqlList(WORK_TYPES)}))`);
    add("importance", `TEXT NOT NULL DEFAULT 'routine' CHECK(importance IN (${sqlList(TASK_IMPORTANCE)}))`);
    add("playbook_step", "TEXT");
    add("attempt", "INTEGER NOT NULL DEFAULT 1");
    // The plain folder a non-code task runs in (code tasks use a git worktree instead).
    add("work_folder", "TEXT");
    // Why the last run of a playbook step failed; the work engine reads it to retry or escalate (phase 3).
    add("step_failure", "TEXT");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_initiative ON tasks(initiative_id, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id, status)");
  }
  // A blocked initiative's escalation level: 'vp' while the VPs decide, 'owner' when it needs the owner.
  if (tableExists(db, "initiatives") && !hasColumn(db, "initiatives", "escalation"))
    db.exec("ALTER TABLE initiatives ADD COLUMN escalation TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS task_handoffs (
    task_id TEXT PRIMARY KEY, summary TEXT NOT NULL, files_json TEXT NOT NULL DEFAULT '[]',
    numbers_json TEXT NOT NULL DEFAULT '{}', open_issues TEXT NOT NULL DEFAULT '', next_step_notes TEXT NOT NULL DEFAULT '',
    generated INTEGER NOT NULL DEFAULT 0 CHECK(generated IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
}

/**
 * Old work made under the previous flow (plan section 11). Copied to `archive_20261122_<table>` and then cleared,
 * children before parents. Money, memories, approvals history, the ledger and goal strategies are not touched.
 */
export const LEGACY_WORK_TABLES = [
  "meeting_minute_entries",
  "review_round_decision_states",
  "project_review_decision_events",
  "project_review_decision_states",
  "meeting_minutes",
  "review_revision_history",
  "task_report_archives",
  "task_model_routes",
  "task_interrupt_injections",
  "task_context_rollover_events",
  "task_context_rollovers",
  "model_upgrade_requests",
  "task_lesson_checks",
  "task_creation_audits",
  "subtasks",
  "task_logs",
  "autonomy_work_snapshots",
  "autonomy_work",
  "agent_task_proposals",
  "tasks",
];
export const LEGACY_ARCHIVE_SETTING = "workRestructureArchivedAt";

export type LegacyArchiveResult = { archived: Record<string, number>; skipped: boolean };

/** Runs once (guarded by a setting). Safe on a fresh database: it just records that there was nothing to move. */
export function archiveLegacyWork(db: DbLike, now = Date.now()): LegacyArchiveResult {
  if (db.prepare("SELECT 1 FROM settings WHERE key=?").get(LEGACY_ARCHIVE_SETTING))
    return { archived: {}, skipped: true };
  const archived: Record<string, number> = {};
  const foreignKeys = Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys);
  db.exec("PRAGMA foreign_keys=OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Chat history stays; it just stops pointing at tasks that are gone.
    if (tableExists(db, "messages") && hasColumn(db, "messages", "task_id"))
      db.exec("UPDATE messages SET task_id=NULL WHERE task_id IS NOT NULL");
    if (tableExists(db, "agents") && hasColumn(db, "agents", "current_task_id"))
      db.exec("UPDATE agents SET current_task_id=NULL, status=CASE WHEN status='working' THEN 'idle' ELSE status END");
    if (tableExists(db, "schedules")) db.exec("UPDATE schedules SET last_task_id=NULL");
    for (const table of LEGACY_WORK_TABLES) {
      if (!tableExists(db, table)) continue;
      const count = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n);
      if (count === 0) continue;
      const archive = `archive_20261122_${table}`;
      db.exec(`CREATE TABLE IF NOT EXISTS "${archive}" AS SELECT * FROM "${table}" WHERE 0`);
      db.exec(`INSERT INTO "${archive}" SELECT * FROM "${table}"`);
      db.exec(`DELETE FROM "${table}"`);
      archived[table] = count;
    }
    db.prepare("INSERT INTO settings(key,value) VALUES (?,?)").run(
      LEGACY_ARCHIVE_SETTING,
      JSON.stringify({ at: now, archived }),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec(`PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`);
  }
  return { archived, skipped: false };
}

/**
 * Phase 3: the work engine creates step tasks directly, so the old per-task queue is gone. Its rows were copied to
 * `archive_20261122_*` by `archiveLegacyWork`; the tables are dropped only after that ran (or when they are empty).
 */
export const RETIRED_WORK_TABLES = ["autonomy_work_snapshots", "autonomy_work"] as const;

export function dropRetiredWorkTables(db: DbLike): string[] {
  const archived = Boolean(db.prepare("SELECT 1 FROM settings WHERE key=?").get(LEGACY_ARCHIVE_SETTING));
  const dropped: string[] = [];
  for (const table of RETIRED_WORK_TABLES) {
    if (!tableExists(db, table)) continue;
    const rows = Number((db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n);
    if (rows > 0 && !archived) continue;
    if (rows > 0) {
      // Rows made after the archive ran (an older build kept running) are kept too.
      const archive = `archive_20261122_${table}`;
      db.exec(`CREATE TABLE IF NOT EXISTS "${archive}" AS SELECT * FROM "${table}" WHERE 0`);
      db.exec(`INSERT INTO "${archive}" SELECT * FROM "${table}"`);
    }
    db.exec(`DROP TABLE "${table}"`);
    dropped.push(table);
  }
  return dropped;
}

function needsMigration(db: DbLike): boolean {
  return (
    tableExists(db, "opportunities") ||
    (tableExists(db, "business_goals") && !hasColumn(db, "business_goals", "initiative_slots")) ||
    (tableExists(db, "goal_strategies") && !hasColumn(db, "goal_strategies", "version"))
  );
}

export function applyWorkModelMigration(db: DbLike): void {
  if (needsMigration(db)) {
    // Foreign keys must be off: dropping a rebuilt parent table would otherwise cascade-delete milestones.
    const foreignKeys = Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys);
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      rebuildBusinessGoals(db);
      renameOpportunities(db);
      upgradeStrategies(db);
      const broken = db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string }>;
      const relevant = broken.filter((row) =>
        ["initiatives", "initiative_variants", "business_goals", "goal_milestones"].includes(row.table),
      );
      if (relevant.length) throw new Error(`work_model_migration: foreign key check failed (${relevant[0].table})`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.exec(`PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`);
    }
  }
  ensureWorkModelSchema(db);
}
