import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerControlRoutes, type ControlRouteDeps } from "./control.ts";
import { getCsrfToken } from "../../../security/auth.ts";
import {
  abortAllOneShots,
  areRunsAllowed,
  assertRunsAllowed,
  automaticStartBlockReason,
  ensureControlStateSchema,
  getControlMode,
  isAutonomyAllowed,
  readControlState,
  registerOneShotAbort,
  resetControlStateForTests,
  RUNS_HALTED_ERROR,
} from "../../control-state.ts";
import { ensureAgentProposalSchema, runAutonomyTick } from "../../agent-proposals.ts";
import { readYoloModeEnabled } from "./messages/decision-inbox/yolo-mode.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  resetControlStateForTests();
});

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, status TEXT, assigned_agent_id TEXT, updated_at INTEGER);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT, current_task_id TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings VALUES ('yoloMode','true');`);
  ensureControlStateSchema(db);
  db.exec(`INSERT INTO agents VALUES ('a-owner','Marcus','working','t-owner'), ('a-auto','Iris','working','t-auto'),
      ('a-meet','Adrian','working','t-meeting');
    INSERT INTO tasks (id,title,status,assigned_agent_id,updated_at,origin) VALUES
      ('t-owner','Owner task','in_progress','a-owner',1,'owner'),
      ('t-auto','Agent idea','in_progress','a-auto',1,'autonomy'),
      ('t-meeting','In a meeting, no process','in_progress','a-meet',1,'owner'),
      ('t-review','Waiting for review','review',NULL,1,'owner'),
      ('t-planned','Not started','planned',NULL,1,'autonomy');`);

  const kill = vi.fn();
  const deps: ControlRouteDeps = {
    nowMs: () => 5000,
    broadcast: vi.fn(),
    activeProcesses: new Map<string, any>([
      ["t-owner", { pid: 111 }],
      ["t-auto", { pid: 222 }],
      ["t-http", { pid: -7, kill }],
    ]),
    stopRequestedTasks: new Set<string>(),
    stopRequestModeByTask: new Map(),
    interruptPidTree: vi.fn(),
    stopProgressTimer: vi.fn(),
    appendTaskLog: vi.fn(),
    onRunsAllowedAgain: vi.fn(),
  };
  const app = express();
  app.use(express.json());
  registerControlRoutes(app, db, deps);
  const status = (id: string) => (db.prepare("SELECT status FROM tasks WHERE id = ?").get(id) as any).status;
  const agent = (id: string) => db.prepare("SELECT status, current_task_id FROM agents WHERE id = ?").get(id) as any;
  return { app, db, deps, kill, status, agent };
}

describe("emergency controls", () => {
  it("starts in running mode and reports it", async () => {
    const { app } = harness();
    const res = await request(app).get("/api/control");
    expect(res.status).toBe(200);
    expect(res.body.state.mode).toBe("running");
    expect(areRunsAllowed()).toBe(true);
    expect(isAutonomyAllowed()).toBe(true);
  });

  it("rejects unknown modes and requests carrying an agent token", async () => {
    const { app } = harness();
    expect(
      (await request(app).post("/api/control").set("x-csrf-token", getCsrfToken()).send({ mode: "sleep" })).status,
    ).toBe(400);
    const asAgent = await request(app)
      .post("/api/control")
      .set("x-csrf-token", getCsrfToken())
      .set("x-agent-task-token", "x")
      .send({ mode: "running" });
    expect(asAgent.status).toBe(403);
    expect((await request(app).get("/api/control").set("x-agent-task-token", "x")).status).toBe(403);
    const noCsrf = await request(app)
      .post("/api/control")
      .set("origin", "http://evil.example")
      .send({ mode: "stopped" });
    expect(noCsrf.status).toBe(403);
    expect(getControlMode()).toBe("running");
  });

  it("pause autonomy stops only work the agents started themselves", async () => {
    const { app, deps, status, agent } = harness();
    const res = await request(app)
      .post("/api/control")
      .set("x-csrf-token", getCsrfToken())
      .send({ mode: "autonomy_paused", reason: "checking in" });
    expect(res.body).toMatchObject({ ok: true, paused_tasks: 1, aborted_calls: 0 });
    expect(res.body.state).toMatchObject({ mode: "autonomy_paused", reason: "checking in", changed_at: 5000 });

    expect(status("t-auto")).toBe("pending");
    expect(agent("a-auto")).toEqual({ status: "idle", current_task_id: null });
    expect(deps.interruptPidTree).toHaveBeenCalledTimes(1);
    expect(deps.interruptPidTree).toHaveBeenCalledWith(222);
    expect(deps.stopRequestModeByTask.get("t-auto")).toBe("pause");

    // The owner's own work is untouched and may keep going.
    expect(status("t-owner")).toBe("in_progress");
    expect(agent("a-owner").status).toBe("working");
    expect(areRunsAllowed()).toBe(true);
    expect(isAutonomyAllowed()).toBe(false);
    expect(deps.broadcast).toHaveBeenCalledWith("control_state", expect.objectContaining({ mode: "autonomy_paused" }));
  });

  it("pause autonomy blocks automatic starts of agent-originated tasks only", async () => {
    const { app, db } = harness();
    await request(app).post("/api/control").set("x-csrf-token", getCsrfToken()).send({ mode: "autonomy_paused" });
    expect(automaticStartBlockReason(db, "t-planned")).toMatch(/paused autonomy/);
    expect(automaticStartBlockReason(db, "t-owner")).toBeNull();
    expect(readYoloModeEnabled(db)).toBe(false);
  });

  it("pause autonomy stops the think loop before any model call", async () => {
    const { app, db } = harness();
    db.exec("DROP TABLE agents");
    db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, role TEXT, status TEXT, cli_provider TEXT,
      department_id TEXT, personality TEXT, current_task_id TEXT, created_at INTEGER);
      INSERT INTO agents VALUES ('lead','Marcus','team_leader','idle','claude',NULL,NULL,NULL,1);`);
    ensureAgentProposalSchema(db);
    await request(app).post("/api/control").set("x-csrf-token", getCsrfToken()).send({ mode: "autonomy_paused" });
    const runAgentOneShot = vi.fn();
    expect(await runAutonomyTick({ db, runAgentOneShot, now: () => 10 ** 12 })).toBeNull();
    expect(runAgentOneShot).not.toHaveBeenCalled();
  });

  it("stop everything pauses every run, keeps the work, and ends in-flight model calls", async () => {
    const { app, deps, kill, status, agent } = harness();
    const abort = vi.fn();
    registerOneShotAbort(abort);

    const res = await request(app).post("/api/control").set("x-csrf-token", getCsrfToken()).send({ mode: "stopped" });
    expect(res.body).toMatchObject({ ok: true, paused_tasks: 4, aborted_calls: 1 });

    // Paused, never cancelled: cancelling would roll back the worktree.
    for (const id of ["t-owner", "t-auto", "t-meeting"]) expect(status(id)).toBe("pending");
    expect(status("t-review")).toBe("review");
    expect(status("t-planned")).toBe("planned");
    for (const id of ["a-owner", "a-auto", "a-meet"]) expect(agent(id).status).toBe("idle");

    expect(deps.interruptPidTree).toHaveBeenCalledWith(111);
    expect(deps.interruptPidTree).toHaveBeenCalledWith(222);
    expect(kill).toHaveBeenCalledTimes(1); // HTTP/API runs have no real pid
    expect([...deps.stopRequestModeByTask.values()].every((mode) => mode === "pause")).toBe(true);
    expect(abort).toHaveBeenCalledWith(RUNS_HALTED_ERROR);

    expect(areRunsAllowed()).toBe(false);
    expect(() => assertRunsAllowed()).toThrow(RUNS_HALTED_ERROR);
  });

  it("stop everything blocks every automatic start, whoever began the task", async () => {
    const { app, db } = harness();
    await request(app).post("/api/control").set("x-csrf-token", getCsrfToken()).send({ mode: "stopped" });
    expect(automaticStartBlockReason(db, "t-owner")).toMatch(/stopped everything/);
    expect(automaticStartBlockReason(db, "t-planned")).toMatch(/stopped everything/);
  });

  it("resuming restarts nothing by itself but lets waiting reviews continue", async () => {
    const { app, deps, status } = harness();
    await request(app).post("/api/control").set("x-csrf-token", getCsrfToken()).send({ mode: "stopped" });
    expect(deps.onRunsAllowedAgain).not.toHaveBeenCalled();

    const res = await request(app).post("/api/control").set("x-csrf-token", getCsrfToken()).send({ mode: "running" });
    expect(res.body).toMatchObject({ ok: true, paused_tasks: 0, aborted_calls: 0 });
    expect(deps.onRunsAllowedAgain).toHaveBeenCalledTimes(1);
    expect(status("t-owner")).toBe("pending"); // the owner resumes tasks one by one
    expect(areRunsAllowed()).toBe(true);
    expect(isAutonomyAllowed()).toBe(true);
  });

  it("survives a restart: the stored mode is loaded back", async () => {
    const { app, db } = harness();
    await request(app).post("/api/control").set("x-csrf-token", getCsrfToken()).send({ mode: "stopped" });
    resetControlStateForTests();
    expect(getControlMode()).toBe("running");
    ensureControlStateSchema(db);
    expect(getControlMode()).toBe("stopped");
    expect(readControlState(db).mode).toBe("stopped");
  });

  it("a failing abort does not keep other model calls alive", () => {
    const second = vi.fn();
    registerOneShotAbort(() => {
      throw new Error("boom");
    });
    const unregister = registerOneShotAbort(vi.fn());
    registerOneShotAbort(second);
    unregister();
    expect(abortAllOneShots()).toBe(2);
    expect(second).toHaveBeenCalled();
    expect(abortAllOneShots()).toBe(0);
  });
});
