import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { applyBaseSchema } from "../../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../../bootstrap/schema/task-schema-migrations.ts";
import { resetControlStateForTests } from "../../../control-state.ts";
import { registerTaskRunRoute } from "./execution-run.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
  resetControlStateForTests();
});

function app(start: (...args: unknown[]) => Promise<unknown>) {
  resetControlStateForTests();
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  db.exec(`
    INSERT INTO departments (id,name,name_ko,name_ja,name_zh,icon,color,sort_order) VALUES ('planning','Planning','','','','','#000',1);
    INSERT INTO agents (id,name,role,department_id,cli_provider) VALUES ('lead','Charlotte','team_leader','planning','codex');
    INSERT INTO tasks (id,title,status,assigned_agent_id,department_id) VALUES ('t1','Research','inbox','lead','planning');
  `);
  const server = express();
  server.use(express.json());
  const startTaskExecutionForAgent = vi.fn(start);
  registerTaskRunRoute({
    app: server,
    db,
    activeProcesses: new Map(),
    appendTaskLog: () => {},
    nowMs: () => 1,
    startTaskExecutionForAgent,
  } as never);
  return { db, server, startTaskExecutionForAgent };
}

describe("the Run button uses the one start path", () => {
  it("hands the task and agent to the shared start and reports where it runs", async () => {
    const { server, startTaskExecutionForAgent } = app(async () => ({
      ok: true,
      cwd: "C:/shop/operations",
      worktree: false,
      pid: 7,
      logPath: "C:/logs/t1.log",
    }));
    const res = await request(server).post("/api/tasks/t1/run").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      pid: 7,
      logPath: "C:/logs/t1.log",
      cwd: "C:/shop/operations",
      worktree: false,
    });
    const [taskId, agent, deptId, deptName] = startTaskExecutionForAgent.mock.calls[0] as [
      string,
      { id: string },
      string,
      string,
    ];
    expect([taskId, agent.id, deptId, deptName]).toEqual(["t1", "lead", "planning", "Planning"]);
  });

  it("passes on why a start was refused, and fills an owner-given folder for a task without one", async () => {
    const { db, server } = app(async () => ({ ok: false, error: "the owner paused autonomy" }));
    const res = await request(server)
      .post("/api/tasks/t1/run")
      .send({ project_path: "C:/Users/Strikeout/Projects/shop" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "the owner paused autonomy" });
    expect(db.prepare("SELECT project_path FROM tasks WHERE id='t1'").get()).toEqual({
      project_path: "C:/Users/Strikeout/Projects/shop",
    });
  });
});
