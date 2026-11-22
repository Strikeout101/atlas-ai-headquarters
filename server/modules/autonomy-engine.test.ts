import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { ensureModelRoutingSchema } from "./model-routing.ts";
import { ensureControlStateSchema, resetControlStateForTests, setControlMode } from "./control-state.ts";
import {
  admitAutonomyTaskStart,
  autonomyTaskUsageBlockReason,
  autonomyDay,
  autonomyTaskStartBlockReason,
  ensureAutonomyEngineSchema,
  isResearchPhaseTask,
  usageHeadroomBlockReason,
  USAGE_MAX_AGE_MS,
} from "./autonomy-engine.ts";
import { ensureWorkEngineSchema, startPlannedWork, type StartTask } from "./work-engine.ts";

const dbs: DatabaseSync[] = [];
const NOW = Date.parse("2026-11-16T15:00:00Z");
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  resetControlStateForTests();
});
function harness() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  db.exec("ALTER TABLE tasks ADD COLUMN source_task_id TEXT");
  ensureControlStateSchema(db);
  ensureAutonomyEngineSchema(db);
  ensureWorkEngineSchema(db);
  db.exec(`INSERT INTO departments(id,name,name_ko,icon,color) VALUES ('research','Research','Research','','#123');
  INSERT INTO agents(id,name,department_id,role,cli_provider) VALUES ('leader','Research leader','research','team_leader','api'),('worker','Research worker','research','junior','api');
  INSERT INTO api_providers(id,name,type,base_url) VALUES ('local-budget','Local test host','ollama','http://localhost:11434/v1');
  UPDATE agents SET api_provider_id='local-budget';
  INSERT INTO projects(id,name,project_path,core_goal) VALUES ('project','Venture research','C:/Projects/ventures','Find evidence-backed initiatives');`);
  const setUsage = (
    provider = "codex",
    windows: unknown = [{ utilization: 0.2 }],
    updated = NOW,
    error: unknown = null,
  ) =>
    db
      .prepare("INSERT OR REPLACE INTO cli_usage_cache(provider,data_json,updated_at) VALUES(?,?,?)")
      .run(provider, JSON.stringify({ windows, error }), updated);
  setUsage();
  setUsage("claude");
  // Like the real start: admission (and the daily-cap reservation) happens inside the start call.
  const startTask = vi.fn<StartTask>(async (taskId) => {
    const blocked = admitAutonomyTaskStart(db, taskId, NOW) || autonomyTaskStartBlockReason(db, taskId, NOW);
    if (blocked) return { ok: false, error: blocked };
    db.prepare("UPDATE tasks SET status='in_progress', started_at=? WHERE id=?").run(NOW, taskId);
    return { ok: true };
  });
  let n = 0;
  /** An autonomous step task, ready to start. */
  const queue = (overrides: Record<string, string | null> = {}) => {
    const id = overrides.id ?? `task-${++n}`;
    db.prepare(
      `INSERT INTO tasks(id,title,description,department_id,assigned_agent_id,project_id,status,origin,business,playbook_step,work_type,created_at,updated_at)
       VALUES (?,?,?,?,?,?,'planned','autonomy','ventures',?,?,?,?)`,
    ).run(
      id,
      overrides.title ?? "Research unmet demand",
      "Collect public evidence and prepare a product brief",
      "research",
      overrides.agent ?? "leader",
      "project",
      overrides.step ?? "vp_action",
      overrides.work_type ?? "research",
      NOW + n,
      NOW + n,
    );
    return id;
  };
  const tick = () => startPlannedWork(db, startTask, NOW);
  return { db, startTask, setUsage, queue, tick };
}

describe("autonomous start admission", () => {
  it("reserves the daily cap inside the start and counts starts across ticks", async () => {
    const h = harness();
    h.db.exec("UPDATE autonomy_config SET daily_start_cap=1");
    h.queue();
    h.queue({ title: "Second bounded task", agent: "worker" });
    await h.tick();
    await h.tick();
    expect(h.startTask).toHaveBeenCalledTimes(1);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_start_reservations").get()).toMatchObject({ n: 1 });
    expect(h.db.prepare("SELECT message FROM autonomy_ledger WHERE event='blocked'").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("cap") })]),
    );
  });
  it("uses the owner timezone for daily reservations", () => {
    expect(autonomyDay(Date.parse("2026-11-17T04:59:00Z"))).toBe("2026-11-16");
    expect(autonomyDay(Date.parse("2026-11-17T05:00:00Z"))).toBe("2026-11-17");
  });
  it("holds all new work with a zero cap and explains it once", async () => {
    const h = harness();
    h.db.exec("UPDATE autonomy_config SET daily_start_cap=0");
    h.queue();
    await h.tick();
    await h.tick();
    expect(h.startTask).not.toHaveBeenCalled();
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_ledger WHERE event='blocked'").get()).toMatchObject({
      n: 1,
    });
  });
  it("lets a goal's research phase run past the daily cap, and nothing else", async () => {
    const h = harness();
    h.db.exec("UPDATE autonomy_config SET daily_start_cap=0");
    const angle = h.queue({ step: "research:market" });
    h.db.prepare("UPDATE tasks SET goal_id='g1' WHERE id=?").run(angle);
    const other = h.queue({ step: "build", agent: "worker" });
    await h.tick();
    expect(h.startTask).toHaveBeenCalledTimes(1);
    expect(h.startTask.mock.calls[0][0]).toBe(angle);
    expect(h.db.prepare("SELECT status FROM tasks WHERE id=?").get(other)).toEqual({ status: "planned" });
    expect(isResearchPhaseTask({ goal_id: "g1", playbook_step: "strategy" })).toBe(true);
    expect(isResearchPhaseTask({ goal_id: "g1", initiative_id: "i1", playbook_step: "research:x" })).toBe(false);
    expect(isResearchPhaseTask({ playbook_step: "research:x" })).toBe(false);
  });
  it("starts important work first, one task per agent per tick", async () => {
    const h = harness();
    const routine = h.queue({ title: "Routine" });
    const important = h.queue({ title: "Important" });
    h.queue({ title: "Also for the leader" });
    h.db.prepare("UPDATE tasks SET importance='important' WHERE id=?").run(important);
    await h.tick();
    expect(h.startTask.mock.calls.map((call) => call[0])).toEqual([important]);
    expect(h.db.prepare("SELECT status FROM tasks WHERE id=?").get(routine)).toEqual({ status: "planned" });
  });
  it("skips a busy agent and does not double start across overlapping ticks", async () => {
    const h = harness();
    h.queue();
    h.db.exec("UPDATE agents SET status='working', current_task_id='other' WHERE id='leader'");
    await h.tick();
    expect(h.startTask).not.toHaveBeenCalled();
    h.db.exec("UPDATE agents SET status='idle', current_task_id=NULL WHERE id='leader'");
    await h.tick();
    await h.tick();
    expect(h.startTask).toHaveBeenCalledTimes(1);
  });
  it.each(["autonomy_paused", "stopped"] as const)("refuses autonomous starts in %s", async (mode) => {
    const h = harness();
    const id = h.queue();
    setControlMode(h.db, mode, NOW);
    expect(autonomyTaskStartBlockReason(h.db, id, NOW)).toContain("paused");
    await h.tick();
    expect(h.db.prepare("SELECT status FROM tasks WHERE id=?").get(id)).toEqual({ status: "planned" });
  });
  it("refuses work for an initiative that is not approved or was stopped", () => {
    const h = harness();
    const id = h.queue({ step: "build" });
    h.db.exec(`INSERT INTO business_goals(id,business,metric,target,period_start,period_end,created_at,updated_at)
      VALUES ('g1','ventures','verified_revenue',100,0,9999999999999,1,1);
      INSERT INTO initiatives(id,business,goal_id,title,status,created_at,updated_at) VALUES ('i1','ventures','g1','Idea','proposed',1,1);`);
    h.db.prepare("UPDATE tasks SET initiative_id='i1' WHERE id=?").run(id);
    expect(autonomyTaskStartBlockReason(h.db, id, NOW)).toContain("no longer accepting");
    h.db.exec("UPDATE initiatives SET status='in_progress'");
    expect(autonomyTaskStartBlockReason(h.db, id, NOW)).toBeNull();
    h.db.exec("UPDATE initiatives SET status='stopped'");
    expect(autonomyTaskStartBlockReason(h.db, id, NOW)).toContain("no longer accepting");
  });
  it("leaves owner tasks alone", () => {
    const h = harness();
    h.db.exec("INSERT INTO tasks(id,title) VALUES ('owner','Owner request')");
    setControlMode(h.db, "autonomy_paused", NOW);
    expect(admitAutonomyTaskStart(h.db, "owner", NOW)).toBeNull();
    expect(autonomyTaskStartBlockReason(h.db, "owner", NOW)).toBeNull();
  });
});

describe("autonomous delegation lineage", () => {
  it("inherits autonomy across every inserted child generation and leaves owner trees unchanged", () => {
    const h = harness();
    const root = h.queue();
    h.db.prepare("INSERT INTO tasks(id,title,source_task_id) VALUES ('child','Delegated work',?)").run(root);
    h.db.exec(
      "INSERT INTO tasks(id,title,source_task_id) VALUES ('grandchild','Design review','child'),('owner-root','Owner request',NULL),('owner-child','Owner followup','owner-root')",
    );
    expect(h.db.prepare("SELECT origin FROM tasks WHERE id IN ('child','grandchild')").all()).toEqual([
      { origin: "autonomy" },
      { origin: "autonomy" },
    ]);
    expect(h.db.prepare("SELECT origin FROM tasks WHERE id='owner-child'").get()).toMatchObject({ origin: "owner" });
    setControlMode(h.db, "autonomy_paused", NOW);
    expect(autonomyTaskUsageBlockReason(h.db, "grandchild", NOW)).toContain("paused");
    expect(autonomyTaskUsageBlockReason(h.db, "owner-child", NOW)).toBeNull();
  });
  it("reserves descendants against the same cap and reuses reservations only for the same task", async () => {
    const h = harness();
    h.db.exec("UPDATE autonomy_config SET daily_start_cap=2");
    const root = h.queue();
    await h.tick();
    h.db.prepare("INSERT INTO tasks(id,title,source_task_id) VALUES ('child','Delegated task',?)").run(root);
    h.db.exec("INSERT INTO tasks(id,title,source_task_id) VALUES ('second-child','Other delegated task','child')");
    h.db.exec(
      "UPDATE agents SET cli_provider='codex' WHERE id='worker'; UPDATE tasks SET assigned_agent_id='worker' WHERE id IN ('child','second-child')",
    );
    expect(admitAutonomyTaskStart(h.db, "child", NOW)).toBeNull();
    expect(admitAutonomyTaskStart(h.db, "child", NOW)).toBeNull();
    expect(admitAutonomyTaskStart(h.db, "second-child", NOW)).toContain("cap");
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_start_reservations").get()).toMatchObject({ n: 2 });
    h.setUsage("codex", [{ utilization: 0.9 }]);
    expect(autonomyTaskStartBlockReason(h.db, "child", NOW)).toContain("threshold");
  });
  it("backfills legacy descendants once when the inheritance trigger is installed", () => {
    const h = harness();
    const root = h.queue();
    h.db.exec("DROP TRIGGER tasks_inherit_autonomy_origin");
    h.db.prepare("INSERT INTO tasks(id,title,source_task_id) VALUES ('legacy','Earlier delegated task',?)").run(root);
    h.db.exec("INSERT INTO tasks(id,title,source_task_id) VALUES ('legacy-review','Earlier review','legacy')");
    ensureControlStateSchema(h.db);
    expect(h.db.prepare("SELECT origin FROM tasks WHERE id='legacy-review'").get()).toMatchObject({
      origin: "autonomy",
    });
  });
});

describe("subscription headroom", () => {
  it.each(["codex", "claude"])("requires valid fresh usage for %s and guards every window", (provider) => {
    const h = harness();
    expect(usageHeadroomBlockReason(h.db, NOW)).toBeNull();
    h.setUsage(provider, [{ utilization: 0.2 }, { utilization: 0.81 }]);
    expect(usageHeadroomBlockReason(h.db, NOW)).toContain("threshold");
    h.setUsage(provider, [{ utilization: 0.2 }], NOW - USAGE_MAX_AGE_MS - 1);
    expect(usageHeadroomBlockReason(h.db, NOW)).toContain("refreshing");
    h.setUsage(provider, [{ utilization: 0.2 }], NOW + 60001);
    expect(usageHeadroomBlockReason(h.db, NOW)).toContain("refreshing");
    h.setUsage(provider, []);
    expect(usageHeadroomBlockReason(h.db, NOW)).toContain("unavailable");
    h.setUsage(provider, [{ utilization: null }]);
    expect(usageHeadroomBlockReason(h.db, NOW)).toContain("invalid");
    h.setUsage(provider, [{ utilization: 0.2 }], NOW, "unavailable");
    expect(usageHeadroomBlockReason(h.db, NOW)).toContain("unavailable");
  });
  it("blocks an actually used subscription when its usage is unknown", async () => {
    const h = harness();
    h.db.exec("UPDATE agents SET cli_provider='codex' WHERE id='leader'");
    h.queue();
    h.db.exec("DELETE FROM cli_usage_cache");
    await h.tick();
    expect(h.startTask).not.toHaveBeenCalled();
  });
  it("admits a local worker without unrelated subscription usage", async () => {
    const h = harness();
    h.queue();
    h.db.exec("DELETE FROM cli_usage_cache");
    await h.tick();
    expect(h.startTask).toHaveBeenCalledOnce();
  });
  it("does not let an unused unauthenticated provider block a healthy worker", async () => {
    const h = harness();
    h.db.exec("UPDATE agents SET cli_provider='codex' WHERE id='leader'");
    h.setUsage("claude", [], NOW, "unauthenticated");
    h.queue();
    await h.tick();
    expect(h.startTask).toHaveBeenCalledOnce();
  });
  it("uses the actual routed provider and rechecks a later subscription upgrade", async () => {
    const h = harness();
    h.db.exec(
      "UPDATE agents SET cli_provider='codex' WHERE id='leader'; CREATE TABLE task_model_routes(task_id TEXT PRIMARY KEY, agent_id TEXT, provider TEXT, api_provider_id TEXT)",
    );
    const taskId = h.queue();
    h.db.prepare("INSERT INTO task_model_routes VALUES (?,'leader','api','local-budget')").run(taskId);
    h.setUsage("codex", [], NOW, "unauthenticated");
    await h.tick();
    expect(h.startTask).toHaveBeenCalledOnce();
    expect(autonomyTaskStartBlockReason(h.db, taskId, NOW)).toBeNull();
    h.db.prepare("UPDATE task_model_routes SET provider='codex' WHERE task_id=?").run(taskId);
    expect(autonomyTaskStartBlockReason(h.db, taskId, NOW)).toContain("unavailable");
  });
  it("admits an eligible configured local route before the first route has been saved", async () => {
    const h = harness();
    ensureModelRoutingSchema(h.db);
    h.db.exec(
      "UPDATE agents SET cli_provider='codex' WHERE id='leader'; INSERT INTO api_providers(id,name,type,base_url,models_cache) VALUES ('local','Local host','ollama','http://localhost:11434/v1','[\"small\"]')",
    );
    h.db
      .prepare("INSERT INTO settings(key,value) VALUES ('localModelRouting',?)")
      .run(JSON.stringify({ enabled: true, apiProviderId: "local", model: "small", taskTypes: ["documentation"] }));
    const taskId = h.queue();
    h.db.prepare("UPDATE tasks SET task_type='documentation' WHERE id=?").run(taskId);
    h.setUsage("codex", [], NOW, "unauthenticated");
    expect(autonomyTaskUsageBlockReason(h.db, taskId, NOW)).toBeNull();
    expect(autonomyTaskUsageBlockReason(h.db, taskId, NOW, "codex")).toContain("unavailable");
    expect(autonomyTaskUsageBlockReason(h.db, taskId, NOW, "api")).toBeNull();
    h.db.exec("UPDATE autonomy_config SET local_provider_daily_run_cap=0");
    expect(autonomyTaskUsageBlockReason(h.db, taskId, NOW, "api")).toContain("cap reached");
    h.db.exec("UPDATE autonomy_config SET local_provider_daily_run_cap=20");
    await h.tick();
    expect(h.startTask).toHaveBeenCalledOnce();
    h.db.exec("UPDATE api_providers SET enabled=0 WHERE id='local'");
    expect(autonomyTaskUsageBlockReason(h.db, taskId, NOW)).toContain("unavailable");
  });
  it("fails closed when an autonomous worker has no configured provider", async () => {
    const h = harness();
    h.db.exec("UPDATE agents SET cli_provider=NULL WHERE id='leader'");
    const taskId = h.queue();
    expect(autonomyTaskUsageBlockReason(h.db, taskId, NOW)).toContain("not configured");
    h.db.exec(
      "CREATE TABLE task_model_routes(task_id TEXT PRIMARY KEY,agent_id TEXT,provider TEXT,api_provider_id TEXT)",
    );
    h.db.prepare("INSERT INTO task_model_routes VALUES (?,'leader','unknown-provider',NULL)").run(taskId);
    expect(autonomyTaskUsageBlockReason(h.db, taskId, NOW)).toContain("not supported");
    await h.tick();
    expect(h.startTask).not.toHaveBeenCalled();
  });
  it("ignores a former assignee's API route when the current Codex worker is unauthenticated", () => {
    const h = harness();
    ensureModelRoutingSchema(h.db);
    const taskId = h.queue();
    h.db
      .prepare(
        `INSERT INTO task_model_routes(task_id,agent_id,provider,model,source,reason,updated_at,api_provider_id)
      VALUES (?,'worker','api','local','default','old assignment',?,'local-budget')`,
      )
      .run(taskId, NOW);
    h.db.exec("UPDATE agents SET cli_provider='codex' WHERE id='leader'");
    h.setUsage("codex", [], NOW, "unauthenticated");
    expect(autonomyTaskUsageBlockReason(h.db, taskId, NOW)).toContain("unavailable");
  });
});
