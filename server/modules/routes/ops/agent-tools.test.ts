import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { createAgentTaskToken } from "../../../security/agent-task-token.ts";
import { ensureModelRoutingSchema } from "../../model-routing.ts";
import { ensureHomelabSchema } from "./homelab.ts";
import { registerAgentToolRoutes } from "./agent-tools.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  applyBaseSchema(db);
  ensureHomelabSchema(db);
  ensureModelRoutingSchema(db);
  db.prepare("INSERT INTO agents (id, name, role, cli_provider) VALUES ('worker', 'Worker', 'senior', 'codex')").run();
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_agent_id) VALUES ('task-1', 'Inspect lab', 'in_progress', 'worker')",
  ).run();
  const app = express();
  app.use(express.json());
  registerAgentToolRoutes(app, db, vi.fn());
  return { app, db, token: createAgentTaskToken("task-1", "worker") };
}

describe("task-scoped agent tools", () => {
  it("rejects missing, forged, and inactive task credentials", async () => {
    const { app, db, token } = harness();
    await request(app).post("/api/agent-tools").send({ operation: "homelab.targets" }).expect(401);
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", `${token}x`)
      .send({ operation: "homelab.targets" })
      .expect(401);
    const wrongAgent = createAgentTaskToken("task-1", "other");
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", wrongAgent)
      .send({ operation: "homelab.targets" })
      .expect(403);
    db.prepare("UPDATE tasks SET status = 'pending' WHERE id = 'task-1'").run();
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "homelab.targets" })
      .expect(403);
  });

  it("lists only SSH targets granted to the assigned agent", async () => {
    const { app, db, token } = harness();
    const insert = db.prepare(
      "INSERT INTO homelab_ssh_targets (id,name,host,ssh_user,port,key_path,known_hosts_path,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    insert.run("granted", "Granted", "lab.example", "operator", 22, "C:\\key", "C:\\known_hosts", 1, 1, 1);
    insert.run("ungranted", "Other", "other.example", "operator", 22, "C:\\key", "C:\\known_hosts", 1, 1, 1);
    db.prepare("INSERT INTO homelab_ssh_grants (target_id,agent_id,created_at) VALUES ('granted','worker',0)").run();
    const response = await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "homelab.targets" })
      .expect(200);
    expect(response.body.targets).toEqual([expect.objectContaining({ id: "granted", host: "lab.example" })]);
  });
});
