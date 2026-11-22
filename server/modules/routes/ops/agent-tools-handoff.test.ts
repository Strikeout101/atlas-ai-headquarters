import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { applyTaskSchemaMigrations } from "../../bootstrap/schema/task-schema-migrations.ts";
import { applyWorkModelMigration } from "../../bootstrap/schema/work-model-migration.ts";
import { createAgentTaskToken } from "../../../security/agent-task-token.ts";
import { registerAgentToolRoutes } from "./agent-tools.ts";
import { getHandoff } from "../../work-model.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => {
  dbs.splice(0).forEach((db) => db.close());
});

function app() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  applyTaskSchemaMigrations(db);
  applyWorkModelMigration(db);
  db.exec(`
    INSERT INTO agents (id,name,role,cli_provider) VALUES ('a1','Amelia','senior','claude'),('a2','Mark','senior','claude');
    INSERT INTO tasks (id,title,status,assigned_agent_id) VALUES ('t1','Research','in_progress','a1'),('t2','Done','done','a1');
  `);
  const server = express();
  server.use(express.json());
  registerAgentToolRoutes(server, db, (() => {}) as never);
  const call = (data: Record<string, unknown>, token = createAgentTaskToken("t1", "a1")) =>
    request(server).post("/api/agent-tools").set("x-agent-task-token", token).send(data);
  return { db, call };
}

describe("task.handoff through the agent gateway", () => {
  it("saves the hand-off for the agent's own active task", async () => {
    const { db, call } = app();
    const saved = await call({
      operation: "task.handoff",
      summary: "Found 8 product ideas with prices and demand evidence.",
      files: [{ path: "research/notes.md", note: "sources" }],
      numbers: { ideas: 8 },
      // The gateway binds the task from the token; a task_id in the payload changes nothing.
      task_id: "t2",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.item).toMatchObject({ task_id: "t1", numbers: { ideas: 8 }, generated: false });
    expect(getHandoff(db, "t2")).toBeNull();
  });

  it("refuses a hand-off that says nothing, and any token that is not the task's", async () => {
    const { call } = app();
    expect((await call({ operation: "task.handoff", summary: "done" })).body).toEqual({
      error: "handoff_summary_too_short",
    });
    expect(
      (await call({ operation: "task.handoff", summary: "x".repeat(40) }, createAgentTaskToken("t1", "a2"))).status,
    ).toBe(403);
    expect(
      (await call({ operation: "task.handoff", summary: "x".repeat(40) }, createAgentTaskToken("t2", "a1"))).status,
    ).toBe(403);
  });
});
