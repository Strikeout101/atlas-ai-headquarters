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
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE homelab_ssh_targets (id TEXT PRIMARY KEY, enabled INTEGER);
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
  it("requires an owner decision for a state-changing command and consumes it only for that exact command once", async () => {
    const { app, db } = harness();
    const cmd = "systemctl restart pihole-FTL";
    const approval = createSshApprovalRequest(db, "host-1", "task-1", "worker", cmd);
    expect(approval).toMatchObject({ status: "pending", auto_approved: false });
    expect(consumeSshApproval(db, approval.id, "host-1", "task-1", "worker", cmd)).toBe(false);
    await request(app).post(`/api/homelab/approvals/${approval.id}/decide`).send({ approve: true }).expect(403);
    const list = await request(app).get("/api/homelab/approvals").expect(200);
    expect(list.body.approvals[0]).toMatchObject({ id: approval.id, command: cmd, status: "pending" });
    expect(JSON.stringify(list.body)).not.toContain("sealed:");
    await request(app)
      .post(`/api/homelab/approvals/${approval.id}/decide`)
      .set("x-csrf-token", getCsrfToken())
      .send({ approve: true })
      .expect(200);
    expect(consumeSshApproval(db, approval.id, "host-1", "task-1", "worker", "rm -rf /tmp/x")).toBe(false);
    expect(consumeSshApproval(db, approval.id, "host-1", "task-1", "worker", cmd)).toBe(true);
    expect(consumeSshApproval(db, approval.id, "host-1", "task-1", "worker", cmd)).toBe(false);
  });

  it("approves read-only checks on the spot, and asks for everything once the owner turns that off", async () => {
    const { app, db } = harness();
    const quick = createSshApprovalRequest(db, "host-1", "task-1", "worker", "systemctl status pihole-FTL --no-pager");
    expect(quick).toMatchObject({ status: "approved", auto_approved: true });
    expect(db.prepare("SELECT decided_by FROM homelab_ssh_approvals WHERE id = ?").get(quick.id)).toEqual({
      decided_by: "auto_read_only",
    });
    expect(
      consumeSshApproval(db, quick.id, "host-1", "task-1", "worker", "systemctl status pihole-FTL --no-pager"),
    ).toBe(true);

    await request(app).get("/api/homelab/approval-policy").expect(200, { ok: true, auto_approve_read_only: true });
    await request(app).put("/api/homelab/approval-policy").send({ auto_approve_read_only: false }).expect(403);
    await request(app)
      .put("/api/homelab/approval-policy")
      .set("x-csrf-token", getCsrfToken())
      .send({ auto_approve_read_only: false })
      .expect(200);
    expect(createSshApprovalRequest(db, "host-1", "task-1", "worker", "uptime")).toMatchObject({ status: "pending" });
  });

  it("rejects a request without a host grant", () => {
    const { db } = harness();
    expect(() => createSshApprovalRequest(db, "host-1", "task-1", "other", "uptime")).toThrow("ssh_agent_not_granted");
  });
});
