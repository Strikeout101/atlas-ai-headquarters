import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { createAgentTaskToken } from "../../../security/agent-task-token.ts";
import { ensureModelRoutingSchema } from "../../model-routing.ts";
import { ensureHomelabSchema } from "./homelab.ts";
import { registerAgentToolRoutes } from "./agent-tools.ts";
import { ensureBusinessProfilesSchema } from "./business-profiles.ts";
import { ensureBusinessSchema } from "./business.ts";
import { ensureBusinessMailboxSchema } from "./business-mailboxes.ts";
import { ensureBusinessEmailSchema } from "./business-email.ts";
import { ensureBusinessSocialSchema } from "./business-social.ts";

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
  ensureBusinessProfilesSchema(db);
  ensureBusinessSchema(db);
  ensureBusinessMailboxSchema(db);
  ensureBusinessEmailSchema(db);
  ensureBusinessSocialSchema(db);
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
  it("lets leaders request hires for their own department and inspect only their requests", async () => {
    const { app, db, token } = harness();
    db.exec(
      "INSERT INTO departments(id,name,name_ko,icon,color) VALUES ('research','Research','','','#aaa'); UPDATE agents SET role='team_leader',department_id='research' WHERE id='worker'",
    );
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "org.request_hire", payload: { name: "Researcher", department_id: "research" } })
      .expect(400);
    const created = await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({
        operation: "org.request_hire",
        payload: {
          name: "Researcher",
          department_id: "research",
          reason: "Research backlog exceeds available capacity",
        },
      })
      .expect(201);
    expect(created.body.request.status).toBe("pending");
    expect(db.prepare("SELECT 1 FROM agents WHERE name='Researcher'").get()).toBeUndefined();
    const status = await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "org.request_status", request_id: created.body.request.id })
      .expect(200);
    expect(status.body.request.status).toBe("pending");
    db.prepare("UPDATE org_requests SET requested_by='other' WHERE id=?").run(created.body.request.id);
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "org.request_status", request_id: created.body.request.id })
      .expect(404);
  });

  it("queues a cross-provider request for VP review without asking one director to approve it", async () => {
    const { app, db, token } = harness();
    db.exec("UPDATE agents SET cli_provider='api',api_model='qwen-local' WHERE id='worker'");
    db.prepare("INSERT INTO settings (key,value) VALUES ('providerModelConfig',?)").run(
      JSON.stringify({ codex: { model: "strong" } }),
    );
    const response = await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({
        operation: "model.request_upgrade",
        reason: "Local model cannot resolve the type error",
        provider: "codex",
        model: "strong",
      })
      .expect(201);
    expect(response.body.request).toMatchObject({
      status: "pending",
      requested_provider: "codex",
      requested_model: "strong",
    });
    expect(db.prepare("SELECT * FROM task_model_routes").all()).toEqual([]);
  });
  it("lists social planning context without credentials and requires verification for media", async () => {
    const { app, db, token } = harness();
    db.prepare(
      "INSERT INTO business_social_accounts (id,business,platform,username,token_enc,updated_at) VALUES ('social','rental','instagram','primroseevents_','',1)",
    ).run();
    const response = await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.social.accounts" })
      .expect(200);
    expect(response.body.items).toEqual([
      expect.objectContaining({ id: "social", username: "primroseevents_", connection_status: "not_connected" }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain("token_enc");
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.social.media", account_id: "social" })
      .expect(400);
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.social.publish", account_id: "social" })
      .expect(400);
    db.prepare("UPDATE tasks SET status='pending' WHERE id='task-1'").run();
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.social.accounts" })
      .expect(403);
  });
  it("queues exact-content email approval but has no worker send operation", async () => {
    const { app, db, token } = harness();
    db.exec(`INSERT INTO business_contacts (id,business,name,email,created_at,updated_at) VALUES ('contact','tech','Owner','owner@example.net',1,1);
      INSERT INTO business_drafts (id,business,contact_id,channel,purpose,subject,body,status,created_at,updated_at)
        VALUES ('draft','tech','contact','email','general','Test email','Exact message','ready',1,1);
      INSERT INTO business_mailboxes (id,is_default,business,email,username,imap_host,imap_port,smtp_host,smtp_port,password_enc,updated_at)
        VALUES ('tech',1,'tech','info@example.com','info@example.com','mail.example.com',993,'mail.example.com',465,'sealed',1);`);
    const response = await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.email.request", draft_id: "draft" })
      .expect(201);
    expect(response.body.request).toMatchObject({
      status: "pending",
      sender: "info@example.com",
      recipient: "owner@example.net",
      body: "Exact message",
    });
    expect(JSON.stringify(response.body)).not.toContain("sealed");
    const mailboxes = await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.email.mailboxes" })
      .expect(200);
    expect(mailboxes.body.items).toEqual([
      { id: "tech", business: "tech", email: "info@example.com", is_default: true, configured: true },
    ]);
    expect(JSON.stringify(mailboxes.body)).not.toContain("mail.example.com");
    expect(JSON.stringify(mailboxes.body)).not.toContain("sealed");
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.email.request", draft_id: "draft", mailbox_id: "missing" })
      .expect(400);
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.email.request", draft_id: "draft", mailbox_id: { id: "tech" } })
      .expect(400);
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.email.send", approval_id: response.body.request.id })
      .expect(400);
    const status = await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.email.status", approval_id: response.body.request.id })
      .expect(200);
    expect(status.body.request.status).toBe("pending");
    db.prepare("UPDATE tasks SET status='pending' WHERE id='task-1'").run();
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.email.request", draft_id: "draft" })
      .expect(403);
  });
  it("lets active workers read profiles but provides no profile mutation operation", async () => {
    const { app, db, token } = harness();
    db.prepare("UPDATE business_profiles SET name = 'Owner business' WHERE business = 'tech'").run();
    const result = await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.profiles" })
      .expect(200);
    expect(result.body.items).toContainEqual(expect.objectContaining({ business: "tech", name: "Owner business" }));
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business", resource: "profiles", action: "update", id: "tech", payload: { name: "Changed" } })
      .expect(400);
    await request(app).post("/api/agent-tools").send({ operation: "business.profiles" }).expect(401);
    db.prepare("UPDATE tasks SET status = 'done' WHERE id = 'task-1'").run();
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "business.profiles" })
      .expect(403);
  });
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

  it("lists shared hosts and only granted restricted hosts", async () => {
    const { app, db, token } = harness();
    const insert = db.prepare(
      "INSERT INTO homelab_ssh_targets (id,name,host,ssh_user,port,key_path,known_hosts_path,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    insert.run("granted", "Granted", "lab.example", "operator", 22, "C:\\key", "C:\\known_hosts", 1, 1, 1);
    insert.run("ungranted", "Other", "other.example", "operator", 22, "C:\\key", "C:\\known_hosts", 1, 1, 1);
    db.prepare("INSERT INTO homelab_ssh_grants (target_id,agent_id,created_at) VALUES ('granted','worker',0)").run();
    db.exec("UPDATE homelab_ssh_targets SET restrict_agents = 1");
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "homelab.targets" })
      .expect(200)
      .expect((res) => expect(res.body.targets.map((host: { id: string }) => host.id)).toEqual(["granted"]));
    db.exec("UPDATE homelab_ssh_targets SET restrict_agents = 0 WHERE id='ungranted'");
    const response = await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "homelab.targets" })
      .expect(200);
    expect(response.body.targets.map((host: { id: string }) => host.id)).toEqual(["granted", "ungranted"]);
    db.exec("UPDATE homelab_ssh_targets SET enabled = 0 WHERE id='ungranted'");
    await request(app)
      .post("/api/agent-tools")
      .set("x-agent-task-token", token)
      .send({ operation: "homelab.targets" })
      .expect(200)
      .expect((res) => expect(res.body.targets.map((host: { id: string }) => host.id)).toEqual(["granted"]));
  });
});
