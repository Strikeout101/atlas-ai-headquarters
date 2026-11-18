import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { ensureControlStateSchema, resetControlStateForTests, setControlMode } from "./control-state.ts";
import { ensureAutonomyEngineSchema } from "./autonomy-engine.ts";
import { opportunityPriority, parsePlanningReply, runVpPlanningTick } from "./autonomy-planner.ts";

const NOW = Date.parse("2026-11-16T16:00:00Z");
const dbs: DatabaseSync[] = [];
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  resetControlStateForTests();
});
function action(title = "Research demand", overrides: Record<string, unknown> = {}) {
  return {
    title,
    department_id: "research",
    description: "Collect public evidence and draft a product brief",
    reason: "Confirm demand before implementation",
    ...overrides,
  };
}
function idea(overrides: Record<string, unknown> = {}) {
  return {
    title: "Small venue planning template",
    description: "Hypothesis only; investigate public requests before building",
    demand_score: 71,
    revenue_score: 62,
    cost_score: 13,
    difficulty_score: 27,
    time_to_launch_score: 19,
    ...overrides,
  };
}
function reply(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ opportunities: [], actions: [], ...overrides });
}
function harness() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  ensureControlStateSchema(db);
  ensureAutonomyEngineSchema(db);
  db.exec(`INSERT INTO departments(id,name,name_ko,icon,color) VALUES ('research','Research','','','#aaa');
    INSERT INTO agents(id,name,role,cli_provider,department_id) VALUES ('leader','Research leader','team_leader','api','research'),('vp','Claude VP','vp','claude',NULL);
    INSERT INTO projects(id,name,project_path,core_goal) VALUES ('project','Research project','C:/Projects/research','Collect evidence'),('other','Other project','C:/Projects/other','Other work');`);
  db.prepare(
    "INSERT INTO business_goals(id,business,project_id,metric,target,period_start,period_end,created_at,updated_at) VALUES ('goal','ventures','project','completed_tasks',3,?,?,?,?)",
  ).run(NOW - 86400000, NOW + 86400000, NOW, NOW);
  for (const provider of ["codex", "claude"])
    db.prepare("INSERT INTO cli_usage_cache(provider,data_json,updated_at) VALUES (?,?,?)").run(
      provider,
      JSON.stringify({ windows: [{ utilization: 0.2 }], error: null }),
      NOW,
    );
  const runAgentOneShot = vi.fn<Parameters<typeof runVpPlanningTick>[0]["runAgentOneShot"]>(async () => ({
    text: reply(),
  }));
  const deps = { db, runAgentOneShot, now: () => NOW, ownerSecurityReady: () => true };
  return { db, runAgentOneShot, deps };
}

describe("bounded VP planning replies", () => {
  it("requires valid bounded objects, fields, identifiers, and no more than three ideas or two actions", () => {
    expect(parsePlanningReply(reply({ opportunities: [idea()], actions: [action()] }))).not.toBeNull();
    for (const value of [
      reply({ opportunities: [null] }),
      reply({ actions: [7] }),
      reply({ opportunities: [idea({ demand_score: 101 })] }),
      reply({ opportunities: [idea({ revenue_score: "99" })] }),
      reply({ opportunities: [idea({ id: 17 })] }),
      reply({ actions: [action("x".repeat(201))] }),
      reply({ actions: [action("Action", { reason: "x".repeat(2001) })] }),
      reply({ actions: [action("Action", { opportunity_id: 12 })] }),
      reply({ opportunities: Array(4).fill(idea()) }),
      reply({ actions: Array(3).fill(action()) }),
      "not JSON",
    ])
      expect(parsePlanningReply(value)).toBeNull();
    expect(
      opportunityPriority({
        demand_score: 100,
        revenue_score: 100,
        cost_score: 0,
        difficulty_score: 0,
        time_to_launch_score: 0,
      }),
    ).toBe(100);
    expect(
      opportunityPriority({
        demand_score: 0,
        revenue_score: 0,
        cost_score: 100,
        difficulty_score: 100,
        time_to_launch_score: 100,
      }),
    ).toBe(0);
  });
});
describe("VP planning beat", () => {
  it("does no planning when the observed goal is already met or the period ended", async () => {
    const { db, deps, runAgentOneShot } = harness();
    db.exec("UPDATE business_goals SET target=0");
    await runVpPlanningTick(deps);
    expect(runAgentOneShot).not.toHaveBeenCalled();
    db.prepare("UPDATE business_goals SET target=3,period_end=?").run(NOW - 1);
    await runVpPlanningTick(deps);
    expect(runAgentOneShot).not.toHaveBeenCalled();
  });
  it("blocks model usage when subscription headroom is missing or the owner paused autonomy", async () => {
    const { db, deps, runAgentOneShot } = harness();
    db.exec("DELETE FROM cli_usage_cache WHERE provider='claude'");
    await runVpPlanningTick(deps);
    expect(runAgentOneShot).not.toHaveBeenCalled();
    setControlMode(db, "autonomy_paused", NOW);
    await runVpPlanningTick(deps);
    expect(runAgentOneShot).not.toHaveBeenCalled();
  });
  it("checks the selected planning VP without requiring an unused subscription", async () => {
    const { db, deps, runAgentOneShot } = harness();
    db.exec("DELETE FROM cli_usage_cache WHERE provider='codex'");
    await runVpPlanningTick(deps);
    expect(runAgentOneShot).toHaveBeenCalledOnce();
  });
  it("advances the durable planning interval before calling a no-tools VP and avoids retries after failure", async () => {
    const { db, deps, runAgentOneShot } = harness();
    let observedState: unknown;
    runAgentOneShot.mockImplementationOnce(async () => {
      observedState = db.prepare("SELECT value FROM autonomy_engine_state WHERE key='plan:goal'").get();
      throw new Error("subscription temporarily failed");
    });
    await runVpPlanningTick(deps);
    await runVpPlanningTick(deps);
    expect(runAgentOneShot).toHaveBeenCalledTimes(1);
    expect(runAgentOneShot.mock.calls[0][2]).toMatchObject({ noTools: true, rawOutput: true });
    expect(observedState).toMatchObject({ value: String(NOW) });
    expect(db.prepare("SELECT 1 FROM autonomy_ledger WHERE event='planning_failed'").get()).toBeTruthy();
  });
  it("discards awaited results after a pause, goal edit, or owner-security change", async () => {
    for (const change of ["pause", "goal", "security"]) {
      const { db, deps, runAgentOneShot } = harness();
      let securityReady = true;
      deps.ownerSecurityReady = () => securityReady;
      runAgentOneShot.mockImplementationOnce(async () => {
        if (change === "pause") setControlMode(db, "autonomy_paused", NOW);
        if (change === "goal") db.exec("UPDATE business_goals SET target=4");
        if (change === "security") securityReady = false;
        return { text: reply({ opportunities: [idea()], actions: [action()] }) };
      });
      await runVpPlanningTick(deps);
      expect(db.prepare("SELECT * FROM opportunities").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM autonomy_work").all()).toEqual([]);
      expect(db.prepare("SELECT 1 FROM autonomy_ledger WHERE event='skipped'").get()).toBeTruthy();
      resetControlStateForTests();
    }
  });
  it("scores estimates without financial claims and queues at most two requests pending independent review", async () => {
    const { db, deps, runAgentOneShot } = harness();
    db.exec("UPDATE business_goals SET metric='verified_revenue',target=1500");
    runAgentOneShot.mockResolvedValueOnce({
      text: reply({ opportunities: [idea()], actions: [action(), action("Draft product brief")] }),
    });
    await runVpPlanningTick(deps);
    expect(runAgentOneShot.mock.calls[0][1]).toContain('"progress":null');
    expect(runAgentOneShot.mock.calls[0][1]).toContain(
      "Missing revenue/profit evidence is unknown, never verified income",
    );
    expect(db.prepare("SELECT message FROM autonomy_ledger WHERE event='planning'").get()).toMatchObject({
      message: expect.stringContaining("unavailable (not verified)"),
    });
    expect(db.prepare("SELECT budget,status,revenue_score FROM opportunities").get()).toMatchObject({
      budget: 0,
      status: "idea",
      revenue_score: 62,
    });
    expect(db.prepare("SELECT status,task_id FROM autonomy_work").all()).toEqual([
      { status: "pending", task_id: null },
      { status: "pending", task_id: null },
    ]);
    expect(db.prepare("SELECT status,agent_id FROM agent_task_proposals").all()).toEqual([
      { status: "pending", agent_id: "leader" },
      { status: "pending", agent_id: "leader" },
    ]);
    expect(db.prepare("SELECT * FROM tasks").all()).toEqual([]);
    expect(db.prepare("SELECT event FROM autonomy_ledger WHERE event='scored'").all()).toHaveLength(1);
  });
  it("deduplicates actions in the same reply and across later beats", async () => {
    const { db, deps, runAgentOneShot } = harness();
    runAgentOneShot.mockResolvedValue({ text: reply({ opportunities: [idea()], actions: [action(), action()] }) });
    await runVpPlanningTick(deps);
    const later = NOW + 7 * 3600000;
    db.prepare("UPDATE cli_usage_cache SET updated_at=?").run(later);
    await runVpPlanningTick({ ...deps, now: () => later });
    expect(db.prepare("SELECT * FROM agent_task_proposals").all()).toHaveLength(1);
    expect(db.prepare("SELECT * FROM opportunities").all()).toHaveLength(1);
    expect(
      db.prepare("SELECT 1 FROM autonomy_ledger WHERE event='skipped' AND message LIKE 'Duplicate work%'").get(),
    ).toBeTruthy();
  });
  it("keeps existing opportunity edits and work inside the chosen business, project and listed departments", async () => {
    const { db, deps, runAgentOneShot } = harness();
    db.prepare(
      "INSERT INTO opportunities(id,business,project_id,title,description,created_at,updated_at) VALUES ('foreign','tech','other','Other idea','Other scope',?,?)",
    ).run(NOW, NOW);
    runAgentOneShot.mockResolvedValueOnce({
      text: reply({
        opportunities: [idea({ id: "foreign" })],
        actions: [
          action("Wrong scope", { opportunity_id: "foreign" }),
          action("Wrong department", { department_id: "missing" }),
        ],
      }),
    });
    await runVpPlanningTick(deps);
    expect(db.prepare("SELECT title,demand_score FROM opportunities WHERE id='foreign'").get()).toMatchObject({
      title: "Other idea",
      demand_score: 0,
    });
    expect(db.prepare("SELECT * FROM autonomy_work").all()).toEqual([]);
  });
  it("does not accept concurrent planning while one model call is in flight", async () => {
    const { db, deps, runAgentOneShot } = harness();
    let finish!: (value: { text: string }) => void;
    runAgentOneShot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = runVpPlanningTick(deps);
    await runVpPlanningTick(deps);
    expect(runAgentOneShot).toHaveBeenCalledTimes(1);
    finish({ text: reply() });
    await first;
    expect(db.prepare("SELECT * FROM autonomy_work").all()).toEqual([]);
  });
  it("preserves owner opportunity edits made during planning and discards only actions tied to the stale snapshot", async () => {
    for (const edit of ["scores", "description"]) {
      const { db, deps, runAgentOneShot } = harness();
      db.prepare(
        "INSERT INTO opportunities(id,business,project_id,goal_id,title,description,demand_score,created_at,updated_at) VALUES ('idea','ventures','project','goal','Reviewed idea','Original evidence',30,?,?)",
      ).run(NOW, NOW);
      runAgentOneShot.mockImplementationOnce(async () => {
        if (edit === "scores")
          db.prepare("UPDATE opportunities SET demand_score=91,updated_at=? WHERE id='idea'").run(NOW + 1);
        else db.exec("UPDATE opportunities SET description='Owner revised evidence' WHERE id='idea'");
        return {
          text: reply({
            opportunities: [idea({ id: "idea", demand_score: 3 })],
            actions: [action("Stale source task", { opportunity_id: "idea" }), action("Independent research")],
          }),
        };
      });
      await runVpPlanningTick(deps);
      expect(db.prepare("SELECT demand_score,description FROM opportunities WHERE id='idea'").get()).toMatchObject(
        edit === "scores"
          ? { demand_score: 91, description: "Original evidence" }
          : { demand_score: 30, description: "Owner revised evidence" },
      );
      expect(db.prepare("SELECT title FROM agent_task_proposals").all()).toEqual([{ title: "Independent research" }]);
      expect(db.prepare("SELECT 1 FROM autonomy_work WHERE opportunity_id='idea'").get()).toBeUndefined();
      expect(
        db
          .prepare(
            "SELECT 1 FROM autonomy_ledger WHERE event='skipped' AND source_id='idea' AND message LIKE 'Opportunity planning result discarded%'",
          )
          .get(),
      ).toBeTruthy();
    }
  });
  it("allows a score update and its related pending action when the opportunity snapshot remains unchanged", async () => {
    const { db, deps, runAgentOneShot } = harness();
    db.prepare(
      "INSERT INTO opportunities(id,business,project_id,goal_id,title,description,created_at,updated_at) VALUES ('idea','ventures','project','goal','Reviewed idea','Original evidence',?,?)",
    ).run(NOW, NOW);
    runAgentOneShot.mockResolvedValueOnce({
      text: reply({
        opportunities: [idea({ id: "idea", demand_score: 77 })],
        actions: [action("Investigate reviewed idea", { opportunity_id: "idea" })],
      }),
    });
    await runVpPlanningTick(deps);
    expect(db.prepare("SELECT demand_score FROM opportunities WHERE id='idea'").get()).toMatchObject({
      demand_score: 77,
    });
    expect(db.prepare("SELECT opportunity_id,status FROM autonomy_work").all()).toEqual([
      { opportunity_id: "idea", status: "pending" },
    ]);
  });
});
