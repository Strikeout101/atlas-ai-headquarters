import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { decideProposal } from "./agent-proposals.ts";
import { ensureModelRoutingSchema } from "./model-routing.ts";
import { ensureControlStateSchema, resetControlStateForTests, setControlMode } from "./control-state.ts";
import {
  admitAutonomyTaskStart,
  autonomyTaskUsageBlockReason,
  autonomyDay,
  autonomyTaskStartBlockReason,
  ensureAutonomyEngineSchema,
  queueAutonomyWork,
  recordAutonomyTaskFailure,
  runAutonomyEngineTick,
  usageHeadroomBlockReason,
  USAGE_MAX_AGE_MS,
} from "./autonomy-engine.ts";

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
  db.exec(`INSERT INTO departments(id,name,name_ko,icon,color) VALUES ('research','Research','Research','','#123');
  INSERT INTO agents(id,name,department_id,role,cli_provider) VALUES ('leader','Research leader','research','team_leader','api'),('worker','Research worker','research','junior','api');
  INSERT INTO projects(id,name,project_path,core_goal) VALUES ('project','Venture research','C:/Projects/ventures','Find evidence-backed opportunities');`);
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
  const startTask = vi.fn<Parameters<typeof runAutonomyEngineTick>[0]["startTask"]>(async (taskId) => {
    db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(taskId);
  });
  const deps = { db, startTask, now: () => NOW, ownerSecurityReady: () => true };
  const queue = (overrides: Partial<Parameters<typeof queueAutonomyWork>[1]> = {}) =>
    queueAutonomyWork(
      db,
      {
        business: "ventures",
        project_id: "project",
        department_id: "research",
        title: "Research unmet demand",
        description: "Collect public evidence and prepare a product brief",
        reason: "Research before implementation",
        ...overrides,
      },
      NOW,
    );
  const approve = (workId: string, by = "vp:codex-vp,claude-vp") => {
    const work = db.prepare("SELECT proposal_id FROM autonomy_work WHERE id=?").get(workId) as { proposal_id: string };
    const result = decideProposal(db, work.proposal_id, true, { decidedBy: by, now: () => NOW });
    if (!result.ok || result.status !== "approved") throw new Error("fixture_approval_failed");
    return result.task_id;
  };
  const schedule = () =>
    db
      .prepare(
        "INSERT INTO schedules(id,business,project_id,department_id,title,description,interval_minutes,next_run_at,enabled,created_at,updated_at) VALUES('routine','ventures','project','research','Research demand','Find evidence',60,?,1,?,?)",
      )
      .run(NOW - 7 * 86400000, NOW, NOW);
  return { db, deps, startTask, setUsage, queue, approve, schedule };
}

describe("autonomous execution admission", () => {
  it("queues reviewable work and never starts it before attributed approval", async () => {
    const h = harness();
    const id = h.queue();
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).not.toHaveBeenCalled();
    expect(h.db.prepare("SELECT status,task_id FROM autonomy_work WHERE id=?").get(id)).toMatchObject({
      status: "pending",
      task_id: null,
    });
    const taskId = h.approve(id);
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).toHaveBeenCalledWith(taskId, expect.objectContaining({ id: "leader" }), "research", "Research");
    expect(h.db.prepare("SELECT origin FROM tasks WHERE id=?").get(taskId)).toMatchObject({ origin: "autonomy" });
  });
  it("allows an explicit attributed owner approval and never substitutes an ordinary worker for a leader", async () => {
    const h = harness();
    const id = h.queue();
    h.approve(id, "owner");
    h.db.exec("UPDATE agents SET role='senior' WHERE id='leader'");
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).not.toHaveBeenCalled();
    h.db.exec("UPDATE agents SET role='team_leader' WHERE id='leader'");
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).toHaveBeenCalledTimes(1);
  });
  it("reserves the daily cap before launching and counts starts across ticks", async () => {
    const h = harness();
    h.db.exec("UPDATE autonomy_config SET daily_start_cap=1");
    const first = h.queue();
    h.approve(first);
    const second = h.queue({ title: "Second bounded task" });
    h.approve(second);
    h.startTask.mockImplementationOnce(async (taskId) => {
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_start_reservations").get()).toMatchObject({ n: 1 });
      h.db.prepare("UPDATE tasks SET status='in_progress' WHERE id=?").run(taskId);
    });
    await runAutonomyEngineTick(h.deps);
    await runAutonomyEngineTick(h.deps);
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
  it("holds all new work with a zero cap and deduplicates repeated cap explanations", async () => {
    const h = harness();
    h.db.exec("UPDATE autonomy_config SET daily_start_cap=0");
    h.approve(h.queue());
    await runAutonomyEngineTick(h.deps);
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).not.toHaveBeenCalled();
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_ledger WHERE event='blocked'").get()).toMatchObject({
      n: 1,
    });
  });
  it("prevents concurrent ticks and restart-style repeated calls from double admitting a task", async () => {
    const h = harness();
    h.approve(h.queue());
    let done: () => void = () => {};
    h.startTask.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    const first = runAutonomyEngineTick(h.deps);
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).toHaveBeenCalledTimes(1);
    done();
    await first;
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).toHaveBeenCalledTimes(1);
  });
  it.each(["autonomy_paused", "stopped"] as const)("blocks scheduling and launching in %s", async (mode) => {
    const h = harness();
    h.schedule();
    h.approve(h.queue());
    setControlMode(h.db, mode, NOW);
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).not.toHaveBeenCalled();
    expect(h.db.prepare("SELECT next_run_at FROM schedules").get()).toMatchObject({ next_run_at: NOW - 7 * 86400000 });
  });
  it("does not start without configured owner security", async () => {
    const h = harness();
    h.approve(h.queue());
    await runAutonomyEngineTick({ ...h.deps, ownerSecurityReady: () => false });
    expect(h.startTask).not.toHaveBeenCalled();
  });
  it("requires an explicit project path and an existing team leader", () => {
    const h = harness();
    h.db.exec("UPDATE projects SET project_path='relative/project'");
    expect(() => h.queue()).toThrow("autonomy_project_path_required");
    h.db.exec("UPDATE projects SET project_path='C:/Projects/ventures'; UPDATE agents SET role='junior'");
    expect(() => h.queue()).toThrow("autonomy_team_leader_required");
  });
  it("holds changed approval attribution, content, assignment, or project path", async () => {
    const changes = [
      "UPDATE agent_task_proposals SET decided_by=NULL",
      "UPDATE agent_task_proposals SET description='Edited after approval'",
      "UPDATE tasks SET assigned_agent_id='worker'",
      "UPDATE projects SET project_path='C:/Projects/changed'",
    ];
    for (const change of changes) {
      const h = harness();
      h.approve(h.queue());
      h.db.exec(change);
      await runAutonomyEngineTick(h.deps);
      expect(h.startTask).not.toHaveBeenCalled();
    }
  });
  it("records a denied proposal once and never creates an execution reservation", async () => {
    const h = harness();
    const id = h.queue();
    h.db.exec("UPDATE agent_task_proposals SET status='dismissed'");
    await runAutonomyEngineTick(h.deps);
    await runAutonomyEngineTick(h.deps);
    expect(h.db.prepare("SELECT status FROM autonomy_work WHERE id=?").get(id)).toMatchObject({ status: "skipped" });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_ledger WHERE event='declined'").get()).toMatchObject({
      n: 1,
    });
    expect(h.startTask).not.toHaveBeenCalled();
  });
  it("rolls back both admission and cap reservation when persistence refuses the reservation", async () => {
    const h = harness();
    h.approve(h.queue());
    h.db.exec(
      "CREATE TRIGGER refuse_reservation BEFORE INSERT ON autonomy_start_reservations BEGIN SELECT RAISE(ABORT,'storage refused'); END",
    );
    await expect(runAutonomyEngineTick(h.deps)).rejects.toThrow("storage refused");
    expect(h.startTask).not.toHaveBeenCalled();
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_start_reservations").get()).toMatchObject({ n: 0 });
    expect(h.db.prepare("SELECT status FROM autonomy_work").get()).toMatchObject({ status: "planned" });
  });

  it("holds pending recovery instead of automatically replaying possible side effects", async () => {
    const h = harness();
    const task = h.approve(h.queue());
    await runAutonomyEngineTick(h.deps);
    h.db.prepare("UPDATE tasks SET status='pending' WHERE id=?").run(task);
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).toHaveBeenCalledTimes(1);
    expect(h.db.prepare("SELECT message FROM autonomy_ledger WHERE event='waiting'").get()).toMatchObject({
      message: expect.stringContaining("replay is held"),
    });
  });
});

describe("autonomous delegation lineage", () => {
  it("inherits autonomy across every inserted child generation and leaves owner trees unchanged", () => {
    const h = harness();
    const root = h.approve(h.queue());
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
    const root = h.approve(h.queue());
    await runAutonomyEngineTick(h.deps);
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
    const root = h.approve(h.queue());
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
    h.approve(h.queue());
    h.db.exec("DELETE FROM cli_usage_cache");
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).not.toHaveBeenCalled();
  });
  it("admits a local worker without unrelated subscription usage", async () => {
    const h = harness();
    h.approve(h.queue());
    h.db.exec("DELETE FROM cli_usage_cache");
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).toHaveBeenCalledOnce();
  });
  it("does not let an unused unauthenticated provider block a healthy worker", async () => {
    const h = harness();
    h.db.exec("UPDATE agents SET cli_provider='codex' WHERE id='leader'");
    h.setUsage("claude", [], NOW, "unauthenticated");
    h.approve(h.queue());
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).toHaveBeenCalledOnce();
  });
  it("uses the actual routed provider and rechecks a later subscription upgrade", async () => {
    const h = harness();
    h.db.exec(
      "UPDATE agents SET cli_provider='codex' WHERE id='leader'; CREATE TABLE task_model_routes(task_id TEXT PRIMARY KEY, provider TEXT)",
    );
    const taskId = h.approve(h.queue());
    h.db.prepare("INSERT INTO task_model_routes VALUES (?,'api')").run(taskId);
    h.setUsage("codex", [], NOW, "unauthenticated");
    await runAutonomyEngineTick(h.deps);
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
    const taskId = h.approve(h.queue());
    h.db.prepare("UPDATE tasks SET task_type='documentation' WHERE id=?").run(taskId);
    h.setUsage("codex", [], NOW, "unauthenticated");
    expect(autonomyTaskUsageBlockReason(h.db, taskId, NOW)).toBeNull();
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).toHaveBeenCalledOnce();
    h.db.exec("UPDATE api_providers SET enabled=0 WHERE id='local'");
    expect(autonomyTaskUsageBlockReason(h.db, taskId, NOW)).toContain("unavailable");
  });
  it("fails closed when an autonomous worker has no configured provider", async () => {
    const h = harness();
    h.db.exec("UPDATE agents SET cli_provider=NULL WHERE id='leader'");
    const taskId = h.approve(h.queue());
    expect(autonomyTaskUsageBlockReason(h.db, taskId, NOW)).toContain("not configured");
    h.db.exec("CREATE TABLE task_model_routes(task_id TEXT PRIMARY KEY,provider TEXT)");
    h.db.prepare("INSERT INTO task_model_routes VALUES (?,'unknown-provider')").run(taskId);
    expect(autonomyTaskUsageBlockReason(h.db, taskId, NOW)).toContain("not supported");
    await runAutonomyEngineTick(h.deps);
    expect(h.startTask).not.toHaveBeenCalled();
  });
});

describe("scheduled occurrences and settlement", () => {
  it("advances far-overdue schedules before queueing one occurrence without catchup storms", async () => {
    const h = harness();
    h.schedule();
    await runAutonomyEngineTick(h.deps);
    await runAutonomyEngineTick(h.deps);
    expect(h.db.prepare("SELECT next_run_at FROM schedules").get()).toMatchObject({ next_run_at: NOW + 3600000 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_work").get()).toMatchObject({ n: 1 });
    expect(h.startTask).not.toHaveBeenCalled();
  });
  it("keeps the advance when queueing fails and records the skipped occurrence", async () => {
    const h = harness();
    h.schedule();
    h.db.exec("UPDATE agents SET role='junior'");
    await runAutonomyEngineTick(h.deps);
    await runAutonomyEngineTick(h.deps);
    expect(h.db.prepare("SELECT next_run_at FROM schedules").get()).toMatchObject({ next_run_at: NOW + 3600000 });
    expect(h.db.prepare("SELECT * FROM autonomy_work").all()).toHaveLength(0);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_ledger WHERE event='skipped'").get()).toMatchObject({
      n: 1,
    });
  });
  it("does not launch edited or disabled schedules after their request was reviewed", async () => {
    for (const change of ["enabled=0", "description='Edited research scope'"]) {
      const h = harness();
      h.schedule();
      await runAutonomyEngineTick(h.deps);
      const work = h.db.prepare("SELECT id FROM autonomy_work").get() as { id: string };
      h.approve(work.id);
      h.db.exec(`UPDATE schedules SET ${change}`);
      await runAutonomyEngineTick(h.deps);
      expect(h.startTask).not.toHaveBeenCalled();
    }
  });
  it("rechecks controls, schedule authority, and assignment at the final launch boundary", async () => {
    const h = harness();
    h.schedule();
    await runAutonomyEngineTick(h.deps);
    const work = h.db.prepare("SELECT id FROM autonomy_work").get() as { id: string };
    const task = h.approve(work.id);
    await runAutonomyEngineTick(h.deps);
    expect(autonomyTaskStartBlockReason(h.db, task, NOW)).toBeNull();
    h.db.exec("UPDATE schedules SET enabled=0");
    expect(autonomyTaskStartBlockReason(h.db, task, NOW)).toContain("paused");
    h.db.exec("UPDATE schedules SET enabled=1");
    h.db.exec("UPDATE tasks SET assigned_agent_id='worker'");
    expect(autonomyTaskStartBlockReason(h.db, task, NOW)).toContain("assignment");
  });
  it("pauses a schedule after three distinct failed runs and never counts duplicate failure receipts", async () => {
    const h = harness();
    h.schedule();
    h.db.exec("UPDATE schedules SET next_run_at=9999999999999");
    for (let i = 0; i < 3; i++) {
      const id = h.queue({ schedule_id: "routine", title: `Occurrence ${i}` });
      const task = h.approve(id);
      await runAutonomyEngineTick(h.deps);
      recordAutonomyTaskFailure(h.db, task, "Provider failed", NOW + i);
      recordAutonomyTaskFailure(h.db, task, "Duplicate", NOW + i);
    }
    expect(h.db.prepare("SELECT enabled,consecutive_failures FROM schedules").get()).toMatchObject({
      enabled: 0,
      consecutive_failures: 3,
    });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_ledger WHERE event='failed'").get()).toMatchObject({
      n: 3,
    });
  });
  it("resets a failure streak on actual completion and records completion only once", async () => {
    const h = harness();
    h.schedule();
    h.db.exec("UPDATE schedules SET next_run_at=9999999999999,consecutive_failures=2");
    const task = h.approve(h.queue({ schedule_id: "routine" }));
    await runAutonomyEngineTick(h.deps);
    h.db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(task);
    await runAutonomyEngineTick(h.deps);
    await runAutonomyEngineTick(h.deps);
    expect(h.db.prepare("SELECT consecutive_failures FROM schedules").get()).toMatchObject({ consecutive_failures: 0 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM autonomy_ledger WHERE event='completed'").get()).toMatchObject({
      n: 1,
    });
  });
  it("holds a launch refused by a late owner pause without counting a run failure", async () => {
    const h = harness();
    h.schedule();
    h.db.exec("UPDATE schedules SET next_run_at=9999999999999");
    h.approve(h.queue({ schedule_id: "routine" }));
    h.startTask.mockImplementationOnce(async () => {
      setControlMode(h.db, "autonomy_paused", NOW);
    });
    await runAutonomyEngineTick(h.deps);
    expect(h.db.prepare("SELECT consecutive_failures FROM schedules").get()).toMatchObject({ consecutive_failures: 0 });
    expect(h.db.prepare("SELECT status FROM autonomy_work").get()).toMatchObject({ status: "running" });
    expect(h.db.prepare("SELECT message FROM autonomy_ledger WHERE event='waiting'").get()).toMatchObject({
      message: expect.stringContaining("held"),
    });
  });

  it("rechecks approval status and attribution after asynchronous model routing", async () => {
    const h = harness();
    const task = h.approve(h.queue());
    await runAutonomyEngineTick(h.deps);
    h.db.exec("UPDATE agent_task_proposals SET decided_by=NULL");
    expect(autonomyTaskStartBlockReason(h.db, task, NOW)).toContain("approval");
    h.db.exec("UPDATE agent_task_proposals SET decided_by='vp:one,two',status='dismissed'");
    expect(autonomyTaskStartBlockReason(h.db, task, NOW)).toContain("approval");
  });

  it("does not count owner cancellation as a failed run", async () => {
    const h = harness();
    h.schedule();
    h.db.exec("UPDATE schedules SET next_run_at=9999999999999");
    const task = h.approve(h.queue({ schedule_id: "routine" }));
    await runAutonomyEngineTick(h.deps);
    h.db.prepare("UPDATE tasks SET status='cancelled' WHERE id=?").run(task);
    await runAutonomyEngineTick(h.deps);
    expect(h.db.prepare("SELECT consecutive_failures FROM schedules").get()).toMatchObject({ consecutive_failures: 0 });
  });
});
