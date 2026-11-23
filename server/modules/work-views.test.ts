import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "./bootstrap/schema/task-schema-migrations.ts";
import { applyWorkModelMigration } from "./bootstrap/schema/work-model-migration.ts";
import { ensureControlStateSchema } from "./control-state.ts";
import { ensureWorkEngineSchema } from "./work-engine.ts";
import { ensureReviewSchema } from "./task-review.ts";
import { saveHandoff } from "./work-model.ts";
import { appendAutonomyLedger } from "./autonomy-store.ts";
import { behindTheScenes, boardColumn, initiativeDetail, workBoard } from "./work-views.ts";

const NOW = Date.parse("2026-11-22T15:00:00Z");
const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));

function harness() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  applyWorkModelMigration(db);
  ensureControlStateSchema(db);
  ensureWorkEngineSchema(db);
  ensureReviewSchema(db);
  db.exec(`
    INSERT INTO departments (id,name,name_ko,name_ja,name_zh,icon,color,sort_order) VALUES ('design','Design','','','','','#000',1),('qa','QA','','','','','#000',2);
    INSERT INTO agents (id,name,role,department_id,cli_provider,created_at) VALUES
      ('lead','Iris','team_leader','design','codex',1),('senior','Bobby','senior','design','claude',2),('qa','Rosa','senior','qa','claude',3),
      ('ghost','Nova','junior','design',NULL,4);
    INSERT INTO business_goals (id,business,title,metric,target,period_start,period_end,created_at,updated_at)
      VALUES ('g1','ventures','Etsy Shop','verified_revenue',2000,0,${NOW + 30 * 86_400_000},1,1);
    INSERT INTO initiatives (id,business,goal_id,title,status,playbook,playbook_stage,created_at,updated_at)
      VALUES ('i1','ventures','g1','Wedding planner','in_progress','etsy_digital','mockups',1,1),
             ('i2','ventures','g1','Seating chart','blocked','etsy_digital','build',1,1),
             ('i3','ventures','g1','Idea only','proposed',NULL,NULL,1,1);
    UPDATE initiatives SET escalation='owner', blocked_reason='build failed 3 times' WHERE id='i2';
    INSERT INTO tasks (id,title,status,assigned_agent_id,department_id,goal_id,initiative_id,business,work_type,importance,playbook_step,created_at,updated_at,completed_at) VALUES
      ('build','Make the product','done','lead','design','g1','i1','ventures','product','important','build',1,${NOW - 1000},${NOW - 1000}),
      ('mock','Mockups','in_progress','senior','design','g1','i1','ventures','design','routine','mockups',2,${NOW},NULL),
      ('stuck','Make the chart','inbox','lead','design','g1','i2','ventures','product','important','build',3,${NOW},NULL),
      ('angle','Research (market)','planned','lead','design','g1',NULL,'ventures','research','routine','research:market',4,${NOW},NULL),
      ('ops','Check backups','review','senior','design',NULL,NULL,'tech','ops','routine','schedule:s1',5,${NOW},NULL),
      ('old','Long done','done','lead','design',NULL,NULL,'tech','ops','routine',NULL,6,1,1);
    UPDATE tasks SET review_state='owner' WHERE id='ops';
    UPDATE agents SET current_task_id='mock', status='working' WHERE id='senior';
    INSERT INTO task_reviews (id,task_id,round,reviewer_agent_id,reviewer_provider,status,summary,items_json,created_at)
      VALUES ('r1','build',1,'qa','claude','approved','Looks right','[]',10),('r2','mock',1,'qa','claude','running','','[]',11);
  `);
  saveHandoff(db, "build", { summary: "Built the planner: 40 pages, PDF and source." });
  appendAutonomyLedger(
    db,
    { event: "vp_model_fix", message: "VPs set Nova to codex (from the department partner); it had no model." },
    NOW - 1000,
  );
  return db;
}

describe("the Work board", () => {
  it("puts owner decisions, and only those, in Needs you", () => {
    expect(boardColumn({ status: "review", review_state: "owner" })).toBe("needs_you");
    expect(boardColumn({ status: "inbox" }, true)).toBe("needs_you");
    expect(boardColumn({ status: "review", review_state: "reviewing" })).toBe("in_review");
    expect(boardColumn({ status: "planned" })).toBe("waiting");
    expect(boardColumn({ status: "cancelled" })).toBeNull();
  });

  it("groups by goal → research and initiatives, then Operations, and counts each column", () => {
    const board = workBoard(harness(), NOW);
    expect(board.goals).toHaveLength(1);
    const [goal] = board.goals;
    expect(goal).toMatchObject({ title: "Etsy Shop", live: true });
    expect(goal.groups.map((g) => [g.kind, g.title])).toEqual([
      ["goal", "Research and strategy"],
      ["initiative", "Wedding planner"],
      ["initiative", "Seating chart"],
    ]); // the idea that isn't approved stays off the board
    const planner = goal.groups[1];
    expect(planner.cards.map((c) => [c.id, c.column, c.agent_name])).toEqual([
      ["mock", "working", "Bobby"],
      ["build", "done", "Iris"],
    ]);
    expect(goal.groups[2]).toMatchObject({ blocked_reason: "build failed 3 times" });
    expect(goal.groups[2].cards[0].column).toBe("needs_you");
    expect(board.operations.cards.map((c) => [c.id, c.column])).toEqual([["ops", "needs_you"]]); // old done work drops off
    expect(board.counts).toEqual({ waiting: 1, working: 1, in_review: 0, needs_you: 2, done: 1 });
  });
});

describe("an initiative's page", () => {
  it("shows the playbook as a timeline with each step's task, hand-off and reviews", () => {
    const detail = initiativeDetail(harness(), "i1")!;
    expect(detail.goal).toMatchObject({ title: "Etsy Shop" });
    expect(detail.steps.map((s) => [s.key, s.state])).toEqual([
      ["build", "done"],
      ["mockups", "current"],
      ["listing", "upcoming"],
      ["publish", "upcoming"],
    ]);
    expect(detail.steps[0].handoff?.summary).toContain("40 pages");
    expect(detail.steps[0].reviews).toEqual([expect.objectContaining({ status: "approved", reviewer_agent_id: "qa" })]);
    expect(detail.steps[3]).toMatchObject({
      kind: "owner_approval",
      title: "Owner approves publishing: Wedding planner",
    });
    expect(initiativeDetail(harness(), "missing")).toBeNull();
  });
});

describe("behind the scenes", () => {
  it("shows each agent's current work, queue, hand-offs, reviews, model and VP fixes, even with no model set", () => {
    const agents = behindTheScenes(harness(), NOW);
    const byId = new Map(agents.map((a) => [a.id, a]));
    expect(byId.get("senior")).toMatchObject({ status: "working", provider: "claude", current: { id: "mock" } });
    expect(byId.get("lead")!.queue.map((t) => t.id)).toEqual(["stuck", "angle"]);
    expect(byId.get("lead")!.recent_handoffs[0].handoff?.summary).toContain("40 pages");
    expect(byId.get("qa")!.reviewing).toEqual([{ task_id: "mock", title: "Mockups", round: 1 }]);
    expect(byId.get("ghost")).toMatchObject({ provider: null, current: null });
    expect(byId.get("ghost")!.model_fixes[0].message).toContain("Nova");
  });
});
