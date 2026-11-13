import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCsrfToken } from "../security/auth.ts";
import { registerSshApprovalRoutes } from "./routes/ops/ssh-approvals.ts";
import { consumeSshApproval, createSshApprovalRequest, ensureSshApprovalSchema } from "./ssh-approvals.ts";

vi.mock("../oauth/helpers.ts", () => ({
  encryptSecret: (value: string) => `sealed:${value}`,
  decryptSecret: (value: string) => value.replace(/^sealed:/, ""),
}));

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE homelab_ssh_targets (id TEXT PRIMARY KEY, enabled INTEGER);
    CREATE TABLE homelab_ssh_grants (target_id TEXT, agent_id TEXT);
    INSERT INTO homelab_ssh_targets VALUES ('host-1',1);
    INSERT INTO homelab_ssh_grants VALUES ('host-1','worker');`);
  ensureSshApprovalSchema(db);
  const app = express();
  app.use(express.json());
  registerSshApprovalRoutes(app, db);
  return { app, db };
}

describe("SSH command approvals", () => {
  it("requires an owner decision and consumes permission only for the exact command once", async () => {
    const { app, db } = harness();
    const approval = createSshApprovalRequest(db, "host-1", "task-1", "worker", "uptime");
    expect(consumeSshApproval(db, approval.id, "host-1", "task-1", "worker", "uptime")).toBe(false);
    await request(app).post(`/api/homelab/approvals/${approval.id}/decide`).send({ approve: true }).expect(403);
    const list = await request(app).get("/api/homelab/approvals").expect(200);
    expect(list.body.approvals[0]).toMatchObject({ id: approval.id, command: "uptime", status: "pending" });
    expect(JSON.stringify(list.body)).not.toContain("sealed:");
    await request(app).post(`/api/homelab/approvals/${approval.id}/decide`).set("x-csrf-token", getCsrfToken()).send({ approve: true }).expect(200);
    expect(consumeSshApproval(db, approval.id, "host-1", "task-1", "worker", "rm -rf /tmp/x")).toBe(false);
    expect(consumeSshApproval(db, approval.id, "host-1", "task-1", "worker", "uptime")).toBe(true);
    expect(consumeSshApproval(db, approval.id, "host-1", "task-1", "worker", "uptime")).toBe(false);
  });

  it("rejects a request without a host grant", () => {
    const { db } = harness();
    expect(() => createSshApprovalRequest(db, "host-1", "task-1", "other", "uptime")).toThrow("ssh_agent_not_granted");
  });
});
