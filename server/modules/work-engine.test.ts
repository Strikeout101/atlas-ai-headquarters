import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "./bootstrap/schema/task-schema-migrations.ts";
import { applyWorkModelMigration } from "./bootstrap/schema/work-model-migration.ts";
import { ensureControlStateSchema, resetControlStateForTests } from "./control-state.ts";
import { admitAutonomyTaskStart, autonomyTaskStartBlockReason } from "./autonomy-engine.ts";
import {
  decideStrategy,
  goalNeedsStrategy,
  requestFreshResearchOnce,
  RESEARCH_ANGLES,
  saveStrategy,
  strategyContextForTask,
} from "./goal-strategy.ts";
import { proposeInitiative } from "./playbooks.ts";
import { saveHandoff } from "./work-model.ts";
import {
  approveInitiative,
  ensureWorkEngineSchema,
  MAX_STEP_ATTEMPTS,
  pickStepAgent,
  recordStepFailure,
  resolveEscalation,
  runWorkEngineTick,
  SHOP_SETUP_STEP,
  type StartTask,
} from "./work-engine.ts";

const NOW = Date.parse("2026-11-22T15:00:00Z");
const DAY = 86_400_000;
const dbs: DatabaseSync[] = [];
beforeEach(() => resetControlStateForTests());
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  resetControlStateForTests();
});

type Row = Record<string, any>;

function harness() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  applyWorkModelMigration(db);
  ensureControlStateSchema(db);
  ensureWorkEngineSchema(db);
  db.exec(`
    INSERT INTO departments (id,name,name_ko,name_ja,name_zh,icon,color,sort_order) VALUES
      ('planning','Planning','','','','','#000',1),('design','Design','','','','','#000',2);
    INSERT INTO agents (id,name,role,department_id,cli_provider,created_at) VALUES
      ('plan-lead','Charlotte','team_leader','planning','codex',1),('plan-senior','Amelia','senior','planning','claude',2),
      ('design-lead','Iris','team_leader','design','codex',3),('design-senior','Bobby','senior','design','claude',4),
      ('vp','Victor','vp',NULL,'claude',5);
    INSERT INTO business_goals (id,business,title,metric,target,period_start,period_end,initiative_slots,created_at,updated_at)
      VALUES ('g1','ventures','Etsy Shop','verified_revenue',2000,0,${NOW + 30 * DAY},3,1,1);
  `);
  for (const provider of ["codex", "claude"])
    db.prepare("INSERT OR REPLACE INTO cli_usage_cache(provider,data_json,updated_at) VALUES(?,?,?)").run(
      provider,
      JSON.stringify({ windows: [{ utilization: 0.1 }] }),
      NOW,
    );
  let clock = NOW;
  const startTask = vi.fn<StartTask>(async (taskId) => {
    const blocked = admitAutonomyTaskStart(db, taskId, clock) || autonomyTaskStartBlockReason(db, taskId, clock);
    if (blocked) return { ok: false, error: blocked };
    const task = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id=?").get(taskId) as Row;
    db.prepare("UPDATE tasks SET status='in_progress', started_at=? WHERE id=?").run(clock, taskId);
    db.prepare("UPDATE agents SET status='working', current_task_id=? WHERE id=?").run(taskId, task.assigned_agent_id);
    return { ok: true };
  });
  const tick = async (advance = 60_000) => {
    clock += advance;
    db.prepare("UPDATE cli_usage_cache SET updated_at=?").run(clock); // usage stays fresh, as the live refresh keeps it
    await runWorkEngineTick({ db, startTask, now: () => clock, ownerSecurityReady: () => true });
  };
  const release = (taskId: string) =>
    db.prepare("UPDATE agents SET status='idle', current_task_id=NULL WHERE current_task_id=?").run(taskId);
  /** The agent finishes: a hand-off, then done (review is phase 4). */
  const finish = (taskId: string, summary = `Finished ${taskId} with real numbers and files.`) => {
    saveHandoff(db, taskId, { summary, files: [`${taskId}.md`], numbers: { sources: 12 } }, clock);
    db.prepare("UPDATE tasks SET status='done', completed_at=? WHERE id=?").run(clock, taskId);
    release(taskId);
  };
  /** The run fails, the way the run handler reports it. */
  const failRun = (taskId: string, reason = "the run failed (exit code 1)") => {
    recordStepFailure(db, taskId, reason, clock);
    db.prepare("UPDATE tasks SET status='inbox' WHERE id=?").run(taskId);
    release(taskId);
  };
  const tasks = (where = "1=1", ...args: string[]) =>
    db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY created_at, rowid`).all(...args) as Row[];
  const initiative = (id: string) => db.prepare("SELECT * FROM initiatives WHERE id=?").get(id) as Row;
  const ledger = (event: string) =>
    (db.prepare("SELECT message FROM autonomy_ledger WHERE event=? ORDER BY id").all(event) as Row[]).map(
      (row) => row.message as string,
    );
  return { db, startTask, tick, finish, failRun, tasks, initiative, ledger, now: () => clock };
}

/** Runs the research phase to an approved strategy with `ideas` proposed initiatives. */
async function researchedGoal(h: ReturnType<typeof harness>, ideas = 6) {
  await h.tick();
  for (const angle of h.tasks("playbook_step LIKE 'research:%'")) h.finish(String(angle.id));
  await h.tick();
  const synthesis = h.tasks("playbook_step='strategy'")[0];
  const strategy = saveStrategy(
    h.db,
    { summary: `Sell printable wedding planners at about $8. ${"Evidence and arithmetic. ".repeat(12)}` },
    { taskId: String(synthesis.id), agentId: String(synthesis.assigned_agent_id) },
    h.now(),
  );
  const ctx = strategyContextForTask(h.db, String(synthesis.id))!;
  const ids = Array.from({ length: ideas }, (_, i) =>
    String(
      proposeInitiative(
        h.db,
        { title: `Idea number ${i + 1}`, description: `Evidence for idea ${i + 1}`, demand_score: 60, budget: 5 },
        { business: "ventures", taskId: String(synthesis.id), goalId: ctx.goalId, playbook: ctx.playbook },
        h.now(),
      ).id,
    ),
  );
  h.finish(String(synthesis.id));
  return { strategy, synthesis, ids };
}

describe("the research phase", () => {
  it("splits a new goal into parallel angles on both models, then one synthesis with every angle's hand-off", async () => {
    const h = harness();
    await h.tick();
    const angles = h.tasks("playbook_step LIKE 'research:%'");
    expect(angles.map((t) => t.playbook_step)).toEqual(RESEARCH_ANGLES.map((a) => `research:${a.key}`));
    expect(angles.every((t) => t.goal_id === "g1" && !t.initiative_id && t.work_type === "research")).toBe(true);
    // Codex and Claude alternate across the angles.
    expect(angles.map((t) => t.assigned_agent_id)).toEqual([
      "plan-lead",
      "plan-senior",
      "plan-lead",
      "plan-senior",
      "plan-lead",
    ]);
    expect(angles[0].description).toContain("at least 10 distinct sources");
    expect(angles[0].description).toContain("research/market.md");
    // One task per agent per tick, and the research phase does not use the daily start cap.
    expect(h.startTask).toHaveBeenCalledTimes(2);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_start_reservations").get()).toEqual({ n: 0 });
    await h.tick();
    expect(h.tasks("playbook_step LIKE 'research:%'")).toHaveLength(5); // no second phase while one is open

    for (const angle of angles.slice(0, 4))
      h.finish(String(angle.id), `Angle ${String(angle.playbook_step)}: 12 sources.`);
    await h.tick();
    expect(h.tasks("playbook_step='strategy'")).toHaveLength(0); // one angle still open
    h.finish(String(angles[4].id), "Angle research:production: 11 sources.");
    await h.tick();
    const [synthesis] = h.tasks("playbook_step='strategy'");
    expect(synthesis).toMatchObject({ importance: "important", assigned_agent_id: "plan-lead", work_type: "research" });
    expect(synthesis.description).toContain("Angle research:market: 12 sources.");
    expect(synthesis.description).toContain("Angle research:production: 11 sources.");
    expect(synthesis.description).toContain("6 to 10 best concrete products");
  });

  it("drops an angle that fails three times and synthesizes from the rest", async () => {
    const h = harness();
    await h.tick();
    const angles = h.tasks("playbook_step LIKE 'research:%'");
    for (const angle of angles.slice(1)) h.finish(String(angle.id));
    const flaky = String(angles[0].id);
    for (let attempt = 1; attempt <= MAX_STEP_ATTEMPTS; attempt++) {
      h.failRun(flaky);
      await h.tick();
    }
    expect(h.tasks("id=?", flaky)[0].status).toBe("cancelled");
    expect(h.ledger("step_dropped")).toHaveLength(1);
    await h.tick();
    expect(h.tasks("playbook_step='strategy'")).toHaveLength(1);
  });

  it("saves the strategy as a proposal and waits for the owner; a redo with a note runs research again", async () => {
    const h = harness();
    const { strategy } = await researchedGoal(h);
    expect(strategy).toMatchObject({ status: "proposed", version: 1 });
    const goal = h.db.prepare("SELECT * FROM business_goals WHERE id='g1'").get() as Row;
    expect(goalNeedsStrategy(h.db, goal, h.now() + 5 * DAY)).toBeNull(); // waiting for the owner, however long
    await h.tick();
    expect(h.tasks("playbook_step LIKE 'research:%'")).toHaveLength(5);
    expect(() => decideStrategy(h.db, String(strategy.id), { decision: "redo", note: "no" })).toThrow(
      "redo_needs_note",
    );
    decideStrategy(
      h.db,
      String(strategy.id),
      { decision: "redo", note: "Look at teacher planners too" },
      "owner",
      h.now(),
    );
    expect(goalNeedsStrategy(h.db, goal, h.now())).toContain("Look at teacher planners too");
    await h.tick();
    const angles = h.tasks("playbook_step LIKE 'research:%'");
    expect(angles).toHaveLength(10);
    expect(angles[9].description).toContain("Look at teacher planners too");
  });

  it("approving a strategy supersedes the old one and stops research", async () => {
    const h = harness();
    const { strategy } = await researchedGoal(h);
    h.db
      .prepare(
        "INSERT INTO goal_strategies(id,goal_id,business,project_id,summary,created_at,version,status) VALUES ('old','g1','ventures','','Old plan',1,0,'approved')",
      )
      .run();
    const approved = decideStrategy(h.db, String(strategy.id), { decision: "approve" }, "owner", h.now());
    expect(approved).toMatchObject({ status: "approved", decided_by: "owner" });
    expect(h.db.prepare("SELECT status FROM goal_strategies WHERE id='old'").get()).toEqual({ status: "superseded" });
    expect(() => decideStrategy(h.db, String(strategy.id), { decision: "approve" })).toThrow("strategy_not_proposed");
  });
});

describe("the fresh research run (work restructure)", () => {
  it("turns each approved strategy into input once, so research starts again with it", async () => {
    const h = harness();
    h.db.exec(`INSERT INTO goal_strategies(id,goal_id,business,project_id,summary,created_at,version,status,approved_at)
      VALUES ('v1','g1','ventures','','Old plan: wedding printables at $8.',${NOW - DAY},1,'approved',${NOW - DAY})`);
    const goal = h.db.prepare("SELECT * FROM business_goals WHERE id='g1'").get() as Row;
    expect(goalNeedsStrategy(h.db, goal, NOW)).toBeNull();
    expect(requestFreshResearchOnce(h.db, NOW)).toBe(1);
    expect(requestFreshResearchOnce(h.db, NOW)).toBe(0);
    expect(goalNeedsStrategy(h.db, goal, NOW)).toContain("Fresh research with the wider research phase");
    await h.tick();
    for (const angle of h.tasks("playbook_step LIKE 'research:%'")) h.finish(String(angle.id));
    await h.tick();
    expect(h.tasks("playbook_step='strategy'")[0].description).toContain("Old plan: wedding printables at $8.");
  });
});

describe("initiatives and playbooks", () => {
  it("runs an approved idea through every step, passing hand-offs on, to awaiting publish", async () => {
    const h = harness();
    const { strategy, ids } = await researchedGoal(h);
    expect(() => approveInitiative(h.db, ids[0])).toThrow("strategy_not_approved");
    decideStrategy(h.db, String(strategy.id), { decision: "approve" }, "owner", h.now());
    const approved = approveInitiative(h.db, ids[0], "owner", h.now());
    expect(approved).toMatchObject({
      status: "approved",
      playbook: "etsy_digital",
      task_cap_daily: 3,
      approved_by: "owner",
    });
    expect(h.ledger("initiative_approved")[0]).toContain("build → mockups → listing → publish");

    await h.tick();
    const [build] = h.tasks("initiative_id=?", ids[0]);
    expect(build).toMatchObject({
      playbook_step: "build",
      work_type: "product",
      importance: "important",
      assigned_agent_id: "design-lead",
    });
    expect(build.description).toContain("STRATEGY (owner-approved v1)");
    expect(build.description).toContain("INITIATIVE BRIEF: Idea number 1");
    expect(h.initiative(ids[0])).toMatchObject({ status: "in_progress", playbook_stage: "build" });
    expect(h.startTask.mock.calls.map((c) => c[0])).toContain(build.id);

    h.finish(String(build.id), "Built the planner: 40 pages, PDF and Canva source.");
    await h.tick();
    const mockups = h.tasks("initiative_id=? AND playbook_step='mockups'", ids[0])[0];
    expect(mockups).toMatchObject({ work_type: "design", importance: "routine", assigned_agent_id: "design-senior" });
    expect(mockups.description).toContain("EARLIER STEPS");
    expect(mockups.description).toContain("Built the planner: 40 pages, PDF and Canva source.");

    h.finish(String(mockups.id), "Made 6 mockups from the real pages.");
    await h.tick();
    const listing = h.tasks("initiative_id=? AND playbook_step='listing'", ids[0])[0];
    expect(listing).toMatchObject({ work_type: "listing", department_id: "planning", assigned_agent_id: "plan-lead" });
    expect(listing.description).toContain("Built the planner");
    expect(listing.description).toContain("Made 6 mockups from the real pages.");

    h.finish(String(listing.id), "Listing package submitted.");
    await h.tick();
    expect(h.initiative(ids[0])).toMatchObject({ status: "in_progress", playbook_stage: "awaiting_publish" });
    expect(h.ledger("awaiting_owner")[0]).toContain("Owner approves publishing: Idea number 1");
    await h.tick();
    expect(h.tasks("initiative_id=?", ids[0])).toHaveLength(3); // nothing more until the owner publishes
  });

  it("keeps to the goal's slots and refuses ideas that are not proposed", async () => {
    const h = harness();
    const { strategy, ids } = await researchedGoal(h);
    decideStrategy(h.db, String(strategy.id), { decision: "approve" }, "owner", h.now());
    for (const id of ids.slice(0, 3)) approveInitiative(h.db, id, "owner", h.now());
    expect(() => approveInitiative(h.db, ids[3])).toThrow("goal_slots_full");
    expect(() => approveInitiative(h.db, ids[0])).toThrow("initiative_not_proposed");
    h.db.prepare("UPDATE initiatives SET status='stopped' WHERE id=?").run(ids[0]);
    expect(approveInitiative(h.db, ids[3]).status).toBe("approved");
  });

  it("waits for the shop setup before the listing step", async () => {
    const h = harness();
    const { strategy, ids } = await researchedGoal(h);
    decideStrategy(h.db, String(strategy.id), { decision: "approve" }, "owner", h.now());
    approveInitiative(h.db, ids[0], "owner", h.now());
    h.db.exec(
      `INSERT INTO tasks(id,title,status,origin,business,playbook_step,created_at) VALUES ('setup','Set up the shop','in_progress','autonomy','ventures','${SHOP_SETUP_STEP}',1)`,
    );
    await h.tick();
    h.finish(String(h.tasks("playbook_step='build'")[0].id));
    await h.tick();
    h.finish(String(h.tasks("playbook_step='mockups'")[0].id));
    await h.tick();
    expect(h.tasks("playbook_step='listing'")).toHaveLength(0);
    expect(h.ledger("waiting").join("\n")).toContain("waits for the shop setup");
    h.finish("setup");
    await h.tick();
    expect(h.tasks("playbook_step='listing'")).toHaveLength(1);
  });

  it("holds an initiative's steps at its daily cap", async () => {
    const h = harness();
    const { strategy, ids } = await researchedGoal(h);
    decideStrategy(h.db, String(strategy.id), { decision: "approve" }, "owner", h.now());
    approveInitiative(h.db, ids[0], "owner", h.now());
    h.db.prepare("UPDATE initiatives SET task_cap_daily=1 WHERE id=?").run(ids[0]);
    await h.tick();
    h.finish(String(h.tasks("playbook_step='build'")[0].id));
    await h.tick();
    const mockups = h.tasks("playbook_step='mockups'")[0];
    expect(mockups.status).toBe("planned");
    expect(h.ledger("waiting").join("\n")).toContain("daily cap reached (1 tasks in 24 hours)");
    await h.tick(DAY);
    expect(h.tasks("id=?", String(mockups.id))[0].status).toBe("in_progress");
  });
});

describe("failed steps", () => {
  async function building(h: ReturnType<typeof harness>) {
    const { strategy, ids } = await researchedGoal(h);
    decideStrategy(h.db, String(strategy.id), { decision: "approve" }, "owner", h.now());
    approveInitiative(h.db, ids[0], "owner", h.now());
    await h.tick();
    return { id: ids[0], build: String(h.tasks("playbook_step='build'")[0].id) };
  }

  it("retries with the same agent, then hands over to the other model, then escalates to the VPs", async () => {
    const h = harness();
    const { id, build } = await building(h);
    h.failRun(build, "the run failed (exit code 1)");
    await h.tick();
    expect(h.tasks("id=?", build)[0]).toMatchObject({
      attempt: 2,
      assigned_agent_id: "design-lead",
      step_failure: null,
    });
    expect(h.tasks("id=?", build)[0].description).toContain(
      "ATTEMPT 2 of 3: the last run failed (the run failed (exit code 1))",
    );
    h.failRun(build);
    await h.tick();
    const third = h.tasks("id=?", build)[0];
    expect(third).toMatchObject({ attempt: 3, assigned_agent_id: "design-senior" });
    expect(third.description).toContain("Bobby takes over from Iris");
    h.failRun(build, "files would not render");
    await h.tick();
    expect(h.initiative(id)).toMatchObject({ status: "blocked", escalation: "vp" });
    expect(h.initiative(id).blocked_reason).toContain("files would not render");
    expect(h.ledger("escalated")[0]).toContain("the VPs are on it");
    await h.tick();
    expect(h.tasks("initiative_id=?", id)).toHaveLength(1); // a blocked initiative starts nothing
  });

  it("lets the VPs retry once, then the owner decides; skipping moves to the next step", async () => {
    const h = harness();
    const { id, build } = await building(h);
    for (let i = 0; i < MAX_STEP_ATTEMPTS; i++) {
      h.failRun(build);
      await h.tick();
    }
    resolveEscalation(
      h.db,
      id,
      { action: "retry", notes: "Export to PDF/A first", agent_id: "design-lead" },
      "vp",
      h.now(),
    );
    expect(h.initiative(id)).toMatchObject({ status: "in_progress", escalation: null, step_attempts: 1 });
    expect(h.tasks("id=?", build)[0]).toMatchObject({
      status: "planned",
      attempt: MAX_STEP_ATTEMPTS,
      assigned_agent_id: "design-lead",
    });
    expect(h.tasks("id=?", build)[0].description).toContain("VPS SAY: try once more. Export to PDF/A first");
    await h.tick();
    h.failRun(build);
    await h.tick();
    expect(h.initiative(id)).toMatchObject({ status: "blocked", escalation: "vp" });
    expect(() => resolveEscalation(h.db, id, { action: "retry" }, "vp")).toThrow("vp_retry_used");
    resolveEscalation(h.db, id, { action: "owner", notes: "Needs a paid font licence" }, "vp", h.now());
    expect(h.initiative(id)).toMatchObject({ escalation: "owner" });
    expect(h.initiative(id).blocked_reason).toContain("VPs recommend: Needs a paid font licence");
    expect(() => resolveEscalation(h.db, id, { action: "skip" }, "vp")).toThrow("escalation_is_with_the_owner");
    resolveEscalation(h.db, id, { action: "skip", notes: "Use the template files" }, "owner", h.now());
    expect(h.tasks("id=?", build)[0].status).toBe("cancelled");
    expect(h.initiative(id)).toMatchObject({ status: "in_progress", playbook_stage: "mockups", escalation: null });
    await h.tick();
    expect(h.tasks("playbook_step='mockups'")).toHaveLength(1);
  });

  it("stopping cancels the initiative's waiting steps", async () => {
    const h = harness();
    const { id, build } = await building(h);
    for (let i = 0; i < MAX_STEP_ATTEMPTS; i++) {
      h.failRun(build);
      await h.tick();
    }
    resolveEscalation(h.db, id, { action: "stop", notes: "Not worth it" }, "owner", h.now());
    expect(h.initiative(id)).toMatchObject({ status: "stopped", stop_reason: "Owner: Not worth it" });
    expect(h.tasks("id=?", build)[0].status).toBe("cancelled");
  });
});

describe("schedules", () => {
  it("creates an Operations task when due and pauses the schedule after repeated failures", async () => {
    const h = harness();
    h.db.exec(`INSERT INTO projects(id,name,project_path,core_goal) VALUES ('p','Shop','C:/shop','Sell');
      INSERT INTO schedules(id,business,project_id,department_id,title,description,interval_minutes,next_run_at,enabled,created_at,updated_at)
      VALUES ('s1','ventures','p','planning','Weekly trend check','Look at trends',60,${NOW - DAY},1,1,1);
      UPDATE autonomy_config SET failure_limit=2;`);
    for (let run = 1; run <= 2; run++) {
      await h.tick(2 * 60 * 60_000);
      const task = h.tasks("playbook_step='schedule:s1'").at(-1)!;
      expect(task).toMatchObject({ business: "ventures", goal_id: null, initiative_id: null, work_type: "research" });
      h.failRun(String(task.id));
      await h.tick(0);
      expect(h.tasks("id=?", String(task.id))[0].status).toBe("cancelled");
    }
    expect(h.db.prepare("SELECT enabled, consecutive_failures FROM schedules").get()).toEqual({
      enabled: 0,
      consecutive_failures: 2,
    });
    expect(h.ledger("schedule_paused")).toHaveLength(1);
  });
});

describe("picking agents", () => {
  it("gives important work to the lead, routine to the senior, and honours a model preference", () => {
    const h = harness();
    expect(pickStepAgent(h.db, "design", { importance: "important" })?.id).toBe("design-lead");
    expect(pickStepAgent(h.db, "design", { importance: "routine" })?.id).toBe("design-senior");
    expect(pickStepAgent(h.db, "design", { importance: "important", provider: "claude" })?.id).toBe("design-senior");
    expect(pickStepAgent(h.db, "design", { importance: "routine", exclude: ["design-senior"] })?.id).toBe(
      "design-lead",
    );
    expect(pickStepAgent(h.db, "nowhere", { importance: "routine" })).toBeNull();
  });
});
