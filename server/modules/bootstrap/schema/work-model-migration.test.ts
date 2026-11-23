import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "./base-schema.ts";
import { applyTaskSchemaMigrations } from "./task-schema-migrations.ts";
import {
  applyWorkModelMigration,
  archiveLegacyWork,
  dropRetiredWorkTables,
  ensureWorkModelSchema,
} from "./work-model-migration.ts";
import { ensureAutonomySchema } from "../../autonomy-store.ts";
import { ensureExperimentSchema } from "../../experiments.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()?.close();
});

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** A database shaped like the live one before the restructure (2026-11-22). */
function legacyDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    CREATE TABLE business_goals (
      id TEXT PRIMARY KEY, business TEXT NOT NULL CHECK(business IN ('tech','rental','ventures')),
      project_id TEXT NOT NULL REFERENCES projects(id), metric TEXT NOT NULL, target REAL NOT NULL CHECK(target>=0),
      period_start INTEGER NOT NULL, period_end INTEGER NOT NULL CHECK(period_end>period_start),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD'
    );
    CREATE TABLE opportunities (
      id TEXT PRIMARY KEY, business TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
      goal_id TEXT REFERENCES business_goals(id), title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      demand_score REAL NOT NULL DEFAULT 0, revenue_score REAL NOT NULL DEFAULT 0, cost_score REAL NOT NULL DEFAULT 0,
      difficulty_score REAL NOT NULL DEFAULT 0, time_to_launch_score REAL NOT NULL DEFAULT 0,
      budget REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idea' CHECK(status IN ('idea','researching','approved','building','launched','stopped')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, task_limit INTEGER NOT NULL DEFAULT 10,
      time_limit_days INTEGER NOT NULL DEFAULT 30, launched_at INTEGER, window_started_at INTEGER, stop_reason TEXT,
      playbook TEXT, playbook_stage TEXT, source_task_id TEXT
    );
    CREATE TABLE opportunity_variants (
      id TEXT PRIMARY KEY, opportunity_id TEXT NOT NULL REFERENCES opportunities(id), listing_id TEXT,
      variable TEXT NOT NULL, value TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', agent_id TEXT, task_id TEXT,
      started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE INDEX idx_variants_opportunity ON opportunity_variants(opportunity_id, started_at);
    CREATE TABLE opportunity_metrics (
      id INTEGER PRIMARY KEY, opportunity_id TEXT NOT NULL, listing_id TEXT, favorers INTEGER, sales INTEGER,
      revenue_minor INTEGER, currency TEXT, recorded_at INTEGER NOT NULL, views INTEGER
    );
    CREATE TABLE ledger_entries (
      id TEXT PRIMARY KEY, business TEXT NOT NULL, amount_minor INTEGER NOT NULL,
      opportunity_id TEXT REFERENCES opportunities(id), occurred_at INTEGER NOT NULL
    );
    CREATE INDEX idx_ledger_opportunity ON ledger_entries(opportunity_id);
    CREATE TABLE goal_milestones (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL REFERENCES business_goals(id) ON DELETE CASCADE,
      title TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE goal_strategies (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, business TEXT NOT NULL, project_id TEXT NOT NULL,
      summary TEXT NOT NULL, task_id TEXT, agent_id TEXT, created_at INTEGER NOT NULL
    );
    INSERT INTO projects (id,name,project_path,core_goal) VALUES ('p1','Etsy Shop','C:/shop','Reach $2,000');
    INSERT INTO business_goals (id,business,project_id,metric,target,period_start,period_end,created_at,updated_at)
      VALUES ('g1','ventures','p1','verified_revenue',2000,1,100,1,1);
    INSERT INTO goal_milestones (id,goal_id,title,created_at) VALUES ('m1','g1','First sale',1);
    INSERT INTO opportunities (id,business,project_id,goal_id,title,status,playbook,created_at,updated_at) VALUES
      ('o-idea','ventures','p1','g1','Planner','idea','etsy_digital',1,1),
      ('o-build','ventures','p1','g1','Workbook','building','etsy_digital',2,2),
      ('o-research','ventures','p1','g1','Kit','researching',NULL,3,3),
      ('o-nogoal','ventures','p1',NULL,'Loose idea','idea',NULL,4,4),
      ('o-orphan','tech','p1',NULL,'No goal anywhere','idea',NULL,5,5);
    INSERT INTO opportunity_variants (id,opportunity_id,variable,value,started_at) VALUES ('v1','o-build','price','5',1);
    INSERT INTO opportunity_metrics (opportunity_id,sales,recorded_at) VALUES ('o-build',2,1);
    INSERT INTO ledger_entries (id,business,amount_minor,opportunity_id,occurred_at) VALUES ('l1','ventures',500,'o-build',1);
    INSERT INTO goal_strategies (id,goal_id,business,project_id,summary,created_at) VALUES
      ('s-old','g1','ventures','p1','First plan',1),('s-new','g1','ventures','p1','Current plan',2);
  `);
  return db;
}

describe("work model migration", () => {
  it("turns opportunities into initiatives under goals, keeping links, money and milestones", () => {
    const db = legacyDb();
    applyWorkModelMigration(db);

    expect(db.prepare("SELECT title FROM business_goals WHERE id='g1'").get()).toEqual({ title: "Reach $2,000" });

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).map((t) => t.name);
    expect(tables).not.toContain("opportunities");
    expect(tables).not.toContain("opportunity_variants");
    expect(tables).toEqual(expect.arrayContaining(["initiatives", "initiative_variants", "initiative_metrics"]));

    const rows = db.prepare("SELECT id, goal_id, status, playbook FROM initiatives ORDER BY created_at").all();
    expect(rows).toEqual([
      { id: "o-idea", goal_id: "g1", status: "proposed", playbook: "etsy_digital" },
      { id: "o-build", goal_id: "g1", status: "in_progress", playbook: "etsy_digital" },
      { id: "o-research", goal_id: "g1", status: "in_progress", playbook: null },
      // An idea with no goal joins its business's goal.
      { id: "o-nogoal", goal_id: "g1", status: "proposed", playbook: null },
    ]);
    // An idea whose business has no goal at all is not carried over, but its original row is archived.
    expect(db.prepare("SELECT id FROM archive_20261122_opportunities ORDER BY id").all()).toHaveLength(5);

    expect(db.prepare("SELECT initiative_id FROM initiative_variants").get()).toEqual({ initiative_id: "o-build" });
    expect(db.prepare("SELECT initiative_id FROM initiative_metrics").get()).toEqual({ initiative_id: "o-build" });
    expect(db.prepare("SELECT initiative_id, amount_minor FROM ledger_entries").get()).toEqual({
      initiative_id: "o-build",
      amount_minor: 500,
    });
    // Foreign keys follow the rename, so they still hold and still protect the rows.
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() =>
      db
        .prepare(
          "INSERT INTO initiative_variants (id,initiative_id,variable,value,started_at) VALUES ('v2','nope','price','1',1)",
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%opportunity%'").all()).toEqual(
      [],
    );

    // Rebuilding goals did not cascade-delete the milestone.
    expect(db.prepare("SELECT id FROM goal_milestones").all()).toEqual([{ id: "m1" }]);
    expect(columns(db, "business_goals")).toEqual(expect.arrayContaining(["title", "initiative_slots"]));
    expect(db.prepare("SELECT initiative_slots, currency FROM business_goals").get()).toEqual({
      initiative_slots: 3,
      currency: "USD",
    });
    db.prepare(
      "INSERT INTO business_goals (id,business,metric,target,period_start,period_end,created_at,updated_at) VALUES ('g2','tech','contacts',5,1,2,1,1)",
    ).run();

    expect(db.prepare("SELECT id, version, status FROM goal_strategies ORDER BY version").all()).toEqual([
      { id: "s-old", version: 1, status: "superseded" },
      { id: "s-new", version: 2, status: "approved" },
    ]);

    expect(columns(db, "tasks")).toEqual(
      expect.arrayContaining([
        "business",
        "goal_id",
        "initiative_id",
        "work_type",
        "importance",
        "playbook_step",
        "attempt",
      ]),
    );
    expect(columns(db, "task_handoffs")).toEqual(
      expect.arrayContaining(["task_id", "summary", "files_json", "numbers_json", "open_issues", "next_step_notes"]),
    );
    expect(Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys)).toBe(1);
  });

  it("is safe to run on every start and lets the modules use the migrated tables", () => {
    const db = legacyDb();
    applyWorkModelMigration(db);
    applyWorkModelMigration(db);
    ensureAutonomySchema(db);
    ensureExperimentSchema(db);
    expect(db.prepare("SELECT COUNT(*) AS n FROM initiatives").get()).toEqual({ n: 4 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM archive_20261122_opportunities").get()).toEqual({ n: 5 });
  });

  it("rolls back completely when something fails halfway", () => {
    const db = legacyDb();
    // A table already named initiatives makes the rename impossible.
    db.exec("CREATE TABLE initiatives (id TEXT)");
    expect(() => applyWorkModelMigration(db)).toThrow(/both opportunities and initiatives exist/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM opportunities").get()).toEqual({ n: 5 });
    expect(columns(db, "business_goals")).not.toContain("initiative_slots");
    expect(Number((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys)).toBe(1);
  });

  it("leaves a fresh database to the modules and still adds the task columns", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    applyBaseSchema(db);
    applyWorkModelMigration(db);
    ensureWorkModelSchema(db);
    ensureAutonomySchema(db);
    expect(columns(db, "initiatives")).toEqual(expect.arrayContaining(["goal_id", "step_attempts", "blocked_reason"]));
    expect(columns(db, "tasks")).toContain("work_type");
    expect(() => db.prepare("INSERT INTO tasks (id,title,work_type) VALUES ('t','x','painting')").run()).toThrow(
      /CHECK/,
    );
  });
});

describe("archiving old work", () => {
  function withOldWork(): DatabaseSync {
    const db = legacyDb();
    applyWorkModelMigration(db);
    db.exec(`
      INSERT INTO agents (id,name,role,status,current_task_id) VALUES ('a1','Charlotte','team_leader','working','t1');
      INSERT INTO tasks (id,title,status,assigned_agent_id) VALUES ('t1','Strategy','review','a1'),('t2','Test email','done','a1');
      INSERT INTO task_logs (task_id,kind,message) VALUES ('t1','system','started');
      INSERT INTO meeting_minutes (id,task_id,meeting_type,round,title,status,started_at,created_at)
        VALUES ('mm1','t1','review',1,'Review','revision_requested',1,1);
      INSERT INTO meeting_minute_entries (meeting_id,seq,speaker_name,content,created_at) VALUES ('mm1',1,'Victor','Needs a baseline',1);
      INSERT INTO messages (id,sender_type,receiver_type,content,task_id) VALUES ('msg1','agent','all','Done with the strategy','t1');
    `);
    return db;
  }

  it("copies old tasks, logs and meetings aside, clears them, and keeps chat, money and the strategy", () => {
    const db = withOldWork();
    const result = archiveLegacyWork(db, 123);
    expect(result.skipped).toBe(false);
    expect(result.archived).toMatchObject({ tasks: 2, task_logs: 1, meeting_minutes: 1, meeting_minute_entries: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM meeting_minutes").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT id, title FROM archive_20261122_tasks ORDER BY id").all()).toEqual([
      { id: "t1", title: "Strategy" },
      { id: "t2", title: "Test email" },
    ]);
    expect(db.prepare("SELECT content, task_id FROM messages").get()).toEqual({
      content: "Done with the strategy",
      task_id: null,
    });
    expect(db.prepare("SELECT status, current_task_id FROM agents").get()).toEqual({
      status: "idle",
      current_task_id: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM goal_strategies").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM initiatives").get()).toEqual({ n: 4 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("runs only once", () => {
    const db = withOldWork();
    archiveLegacyWork(db, 1);
    db.exec("INSERT INTO tasks (id,title,status) VALUES ('t3','New work','inbox')");
    expect(archiveLegacyWork(db, 2)).toEqual({ archived: {}, skipped: true });
    expect(db.prepare("SELECT id FROM tasks").all()).toEqual([{ id: "t3" }]);
  });

  it("drops the old autonomy queue only after its rows are archived, keeping late rows too", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    applyBaseSchema(db);
    db.exec(`CREATE TABLE autonomy_work (id TEXT PRIMARY KEY, status TEXT);
      CREATE TABLE autonomy_work_snapshots (work_id TEXT PRIMARY KEY);
      INSERT INTO autonomy_work VALUES ('w1','running');`);
    expect(dropRetiredWorkTables(db)).toEqual(["autonomy_work_snapshots"]); // empty table goes; rows wait for the archive
    expect(db.prepare("SELECT COUNT(*) AS n FROM autonomy_work").get()).toEqual({ n: 1 });
    archiveLegacyWork(db, 5);
    db.exec("INSERT INTO autonomy_work VALUES ('w2','pending')"); // made by an older build after the archive
    expect(dropRetiredWorkTables(db)).toEqual(["autonomy_work"]);
    expect(db.prepare("SELECT id FROM archive_20261122_autonomy_work ORDER BY id").all()).toEqual([
      { id: "w1" },
      { id: "w2" },
    ]);
    expect(dropRetiredWorkTables(db)).toEqual([]);
  });
});
