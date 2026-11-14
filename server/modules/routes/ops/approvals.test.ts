import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerApprovalRoutes } from "./approvals.ts";
import { createSshApprovalRequest, ensureSshApprovalSchema } from "../../ssh-approvals.ts";

vi.mock("../../../oauth/helpers.ts", () => ({
  encryptSecret: (value: string) => `sealed:${value}`,
  decryptSecret: (value: string) => {
    if (value === "corrupt") throw new Error("bad");
    return value.replace(/^sealed:/, "");
  },
}));

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE homelab_ssh_targets (id TEXT PRIMARY KEY, name TEXT, host TEXT, enabled INTEGER);
    CREATE TABLE homelab_ssh_grants (target_id TEXT, agent_id TEXT);
    CREATE TABLE model_upgrade_requests (id TEXT PRIMARY KEY, task_id TEXT, agent_id TEXT, requested_model TEXT,
      requested_reasoning_level TEXT, reason TEXT, status TEXT, created_at INTEGER);
    INSERT INTO tasks VALUES ('task-1','Weekly health check'), ('task-2','Site refactor');
    INSERT INTO agents VALUES ('turbo','Turbo'), ('bolt','Bolt');
    INSERT INTO homelab_ssh_targets VALUES ('host-1','pve-dns-01','10.0.0.5',1);
    INSERT INTO homelab_ssh_grants VALUES ('host-1','turbo');`);
  ensureSshApprovalSchema(db);
  const app = express();
  app.use(express.json());
  registerApprovalRoutes(app, db);
  return { app, db };
}

describe("GET /api/approvals", () => {
  it("lists pending SSH commands and model upgrades with context, newest first, and skips decided ones", async () => {
    const { app, db } = harness();
    const ssh = createSshApprovalRequest(db, "host-1", "task-1", "turbo", "systemctl restart pihole-FTL");
    const decided = createSshApprovalRequest(db, "host-1", "task-1", "turbo", "reboot");
    db.prepare("UPDATE homelab_ssh_approvals SET status = 'denied' WHERE id = ?").run(decided.id);
    db.prepare("UPDATE homelab_ssh_approvals SET created_at = 1000 WHERE id = ?").run(ssh.id);
    db.prepare(
      "INSERT INTO model_upgrade_requests VALUES ('up-1','task-2','bolt','gpt-big','high','failed twice','pending',2000), ('up-2','task-2','bolt','x',NULL,'old','approved',3000)",
    ).run();

    const res = await request(app).get("/api/approvals").expect(200);
    expect(res.body.count).toBe(2);
    expect(res.body.items[0]).toMatchObject({
      kind: "model_upgrade",
      id: "up-1",
      task_title: "Site refactor",
      agent_name: "Bolt",
      requested_model: "gpt-big",
      decide_path: "/api/model-upgrades/up-1/decide",
    });
    expect(res.body.items[1]).toMatchObject({
      kind: "ssh_command",
      id: ssh.id,
      command: "systemctl restart pihole-FTL",
      target_name: "pve-dns-01",
      target_host: "10.0.0.5",
      agent_name: "Turbo",
      task_title: "Weekly health check",
      decide_path: `/api/homelab/approvals/${ssh.id}/decide`,
    });
    expect(JSON.stringify(res.body)).not.toContain("sealed:");
  });

  it("returns a null command rather than failing when one cannot be decrypted", async () => {
    const { app, db } = harness();
    const ssh = createSshApprovalRequest(db, "host-1", "task-1", "turbo", "reboot");
    db.prepare("UPDATE homelab_ssh_approvals SET command_enc = 'corrupt' WHERE id = ?").run(ssh.id);
    const res = await request(app).get("/api/approvals").expect(200);
    expect(res.body.items[0]).toMatchObject({ id: ssh.id, command: null });
  });

  it("works before any approval tables exist", async () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const app = express();
    registerApprovalRoutes(app, db);
    const res = await request(app).get("/api/approvals").expect(200);
    expect(res.body).toEqual({ ok: true, count: 0, items: [] });
  });
});
