import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "./bootstrap/schema/task-schema-migrations.ts";
import { applyWorkModelMigration } from "./bootstrap/schema/work-model-migration.ts";
import { ensureControlStateSchema, resetControlStateForTests, setControlMode } from "./control-state.ts";
import {
  initiativePriority,
  parseEscalationReply,
  parsePlanningReply,
  runVpPlanningTick,
  VP_ACTION_STEP,
} from "./autonomy-planner.ts";
import { ensureWorkEngineSchema } from "./work-engine.ts";

const NOW = Date.parse("2026-11-16T16:00:00Z");
const dbs: DatabaseSync[] = [];
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  resetControlStateForTests();
});
type Row = Record<string, any>;

const SCORES = { demand_score: 71, revenue_score: 62, cost_score: 13, difficulty_score: 27, time_to_launch_score: 19 };
function action(overrides: Record<string, unknown> = {}) {
  return {
    initiative_id: "live",
    department_id: "research",
    title: "Try a lower price on the live listing",
    description: "Start a price variant with experiment.start and update the listing",
    reason: "Views but no sales",
    ...overrides,
  };
}
function reply(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ scores: [], actions: [], ...overrides });
}
function harness(opts: { strategy?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  applyWorkModelMigration(db);
  ensureControlStateSchema(db);
  ensureWorkEngineSchema(db);
  db.exec(`INSERT INTO departments(id,name,name_ko,icon,color) VALUES ('research','Research','','','#aaa');
    INSERT INTO agents(id,name,role,cli_provider,department_id) VALUES
      ('leader','Research leader','team_leader','codex','research'),('senior','Research senior','senior','claude','research'),
      ('vp','Claude VP','vp','claude',NULL);`);
  db.prepare(
    "INSERT INTO business_goals(id,business,title,metric,target,period_start,period_end,created_at,updated_at) VALUES ('goal','ventures','Etsy','completed_tasks',3,?,?,?,?)",
  ).run(NOW - 86400000, NOW + 86400000, NOW, NOW);
  for (const provider of ["codex", "claude"])
    db.prepare("INSERT INTO cli_usage_cache(provider,data_json,updated_at) VALUES (?,?,?)").run(
      provider,
      JSON.stringify({ windows: [{ utilization: 0.2 }], error: null }),
      NOW,
    );
  if (opts.strategy !== false)
    db.prepare(
      "INSERT INTO goal_strategies(id,goal_id,business,project_id,summary,created_at,version,status,approved_at) VALUES ('s0','goal','ventures','',?,?,1,'approved',?)",
    ).run("Existing strategy: sell planning templates to small venues.", NOW - 86_400_000, NOW - 86_400_000);
  db.exec(`INSERT INTO initiatives(id,business,goal_id,title,status,created_at,updated_at) VALUES
    ('idea','ventures','goal','Venue template','proposed',1,1),
    ('live','ventures','goal','Live planner','launched',2,2),
    ('building','ventures','goal','Seating chart','in_progress',3,3);`);
  const runAgentOneShot = vi.fn<Parameters<typeof runVpPlanningTick>[0]["runAgentOneShot"]>(async () => ({
    text: reply(),
  }));
  const deps = { db, runAgentOneShot, now: () => NOW, ownerSecurityReady: () => true };
  const initiative = (id: string) => db.prepare("SELECT * FROM initiatives WHERE id=?").get(id) as Row;
  return { db, runAgentOneShot, deps, initiative };
}

describe("VP replies", () => {
  it("accepts only bounded scores and at most two actions", () => {
    expect(parsePlanningReply(reply({ scores: [{ id: "idea", ...SCORES }], actions: [action()] }))).not.toBeNull();
    for (const value of [
      reply({ scores: [null] }),
      reply({ scores: [{ id: "idea", ...SCORES, demand_score: 101 }] }),
      reply({ scores: [{ ...SCORES }] }),
      reply({ actions: [action({ title: "x".repeat(201) })] }),
      reply({ actions: [action({ initiative_id: undefined })] }),
      reply({ actions: Array(3).fill(action()) }),
      "not json",
      JSON.stringify({ scores: [] }),
    ])
      expect(parsePlanningReply(value)).toBeNull();
    expect(parsePlanningReply("```json\n" + reply() + "\n```")).toEqual({ scores: [], actions: [] });
  });

  it("accepts an escalation decision with notes", () => {
    expect(parseEscalationReply('{"action":"skip","notes":"Not essential"}')).toEqual({
      action: "skip",
      notes: "Not essential",
      agent_id: undefined,
    });
    expect(parseEscalationReply('{"action":"retry","notes":"Use PDF/A","agent_id":"senior"}')?.agent_id).toBe("senior");
    expect(parseEscalationReply('{"action":"delete","notes":"x"}')).toBeNull();
    expect(parseEscalationReply('{"action":"skip"}')).toBeNull();
  });

  it("ranks ideas by favorable minus unfavorable scores", () => {
    expect(initiativePriority(SCORES)).toBeCloseTo((71 + 62 + 300 - 13 - 27 - 19) / 5);
  });
});

describe("VP planning beat", () => {
  it("re-scores ideas and queues variant work only for launched initiatives", async () => {
    const h = harness();
    h.runAgentOneShot.mockResolvedValueOnce({
      text: reply({
        scores: [
          { id: "idea", ...SCORES },
          { id: "unknown", ...SCORES },
        ],
        actions: [action(), action({ initiative_id: "building", title: "Build another product" })],
      }),
    });
    await runVpPlanningTick(h.deps);
    expect(h.initiative("idea")).toMatchObject(SCORES);
    const tasks = h.db.prepare("SELECT * FROM tasks").all() as Row[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      initiative_id: "live",
      goal_id: "goal",
      playbook_step: VP_ACTION_STEP,
      status: "planned",
      origin: "autonomy",
      assigned_agent_id: "senior",
      importance: "routine",
    });
    expect(tasks[0].description).toContain("Why: Views but no sales");
    const prompt = h.runAgentOneShot.mock.calls[0][1];
    expect(prompt).toContain("Existing strategy: sell planning templates");
    expect(prompt).toContain("Building new products is the playbooks' job");
  });

  it("does nothing for a goal without an approved strategy and waits for the planning interval", async () => {
    const h = harness({ strategy: false });
    await runVpPlanningTick(h.deps);
    expect(h.runAgentOneShot).not.toHaveBeenCalled();
    const ready = harness();
    await runVpPlanningTick(ready.deps);
    await runVpPlanningTick(ready.deps);
    expect(ready.runAgentOneShot).toHaveBeenCalledTimes(1);
  });

  it("keeps owner edits made while the VP was thinking, and declines duplicate work", async () => {
    const h = harness();
    h.runAgentOneShot.mockImplementationOnce(async () => {
      h.db.exec("UPDATE initiatives SET demand_score=5 WHERE id='idea'");
      return { text: reply({ scores: [{ id: "idea", ...SCORES }], actions: [action(), action()] }) };
    });
    await runVpPlanningTick(h.deps);
    expect(h.initiative("idea").demand_score).toBe(5);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 1 });
  });

  it("holds while paused or without owner security", async () => {
    const h = harness();
    setControlMode(h.db, "autonomy_paused", NOW);
    await runVpPlanningTick(h.deps);
    resetControlStateForTests();
    await runVpPlanningTick({ ...h.deps, ownerSecurityReady: () => false });
    expect(h.runAgentOneShot).not.toHaveBeenCalled();
  });
});

describe("VP escalations", () => {
  function blocked(h: ReturnType<typeof harness>, attempts = 0) {
    h.db
      .exec(`UPDATE initiatives SET status='blocked', escalation='vp', playbook='etsy_digital', playbook_stage='build',
        step_attempts=${attempts}, blocked_reason='the build step failed 3 times: exit 1' WHERE id='building';
      INSERT INTO tasks(id,title,status,department_id,assigned_agent_id,initiative_id,goal_id,business,playbook_step,attempt,origin,description)
        VALUES ('step','Make the product','inbox','research','leader','building','goal','ventures','build',3,'autonomy','Make it');`);
  }

  it("handles a blocked step before planning: a retry with notes and another agent", async () => {
    const h = harness();
    blocked(h);
    h.runAgentOneShot.mockResolvedValueOnce({
      text: '{"action":"retry","notes":"Export as PDF/A","agent_id":"senior"}',
    });
    await runVpPlanningTick(h.deps);
    expect(h.runAgentOneShot).toHaveBeenCalledTimes(1); // the escalation took this beat
    expect(h.runAgentOneShot.mock.calls[0][1]).toContain("the build step failed 3 times");
    expect(h.initiative("building")).toMatchObject({ status: "in_progress", escalation: null, step_attempts: 1 });
    expect(h.db.prepare("SELECT status, assigned_agent_id FROM tasks WHERE id='step'").get()).toEqual({
      status: "planned",
      assigned_agent_id: "senior",
    });
  });

  it("passes a second retry, or an unusable answer, to the owner", async () => {
    const h = harness();
    blocked(h, 1);
    h.runAgentOneShot.mockResolvedValueOnce({ text: '{"action":"retry","notes":"Again"}' });
    await runVpPlanningTick(h.deps);
    expect(h.initiative("building")).toMatchObject({ status: "blocked", escalation: "owner" });
    const other = harness();
    blocked(other);
    other.runAgentOneShot.mockResolvedValueOnce({ text: "no idea" });
    await runVpPlanningTick(other.deps);
    expect(other.initiative("building").escalation).toBe("owner");
    expect(other.initiative("building").blocked_reason).toContain("The VPs couldn't settle this one.");
  });
});
