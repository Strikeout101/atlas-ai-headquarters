import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { Client, ConnectConfig } from "ssh2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { getCsrfToken } from "../../../security/auth.ts";
import { ensureHomelabSchema, registerHomelabRoutes } from "./homelab.ts";
import { createSshApprovalRequest } from "../../ssh-approvals.ts";

vi.mock("../../../oauth/helpers.ts", () => ({
  encryptSecret: (value: string) => `sealed:${value}`,
  decryptSecret: (value: string) => value.replace(/^sealed:/, ""),
}));

const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
const input = {
  name: "Lab",
  host: "10.0.50.10",
  ssh_user: "strikeout",
  port: 22,
  enabled: true,
  auth_method: "password",
  credential: "secret-password",
};

function harness() {
  process.env.OAUTH_ENCRYPTION_SECRET = "test-only-encryption-key";
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  ensureHomelabSchema(db);
  const app = express();
  app.use(express.json());
  registerHomelabRoutes(app, db);
  return { db, app };
}

describe("SSH Host Manager", () => {
  it("defaults to shared access and persists a validated per-host restriction", async () => {
    const { app, db } = harness();
    const created = await request(app)
      .post("/api/homelab/targets")
      .set("x-csrf-token", getCsrfToken())
      .send(input)
      .expect(201);
    const id = created.body.target.id;
    expect(created.body.target.restrict_agents).toBe(false);
    await request(app).patch(`/api/homelab/targets/${id}`).send({ restrict_agents: true }).expect(403);
    await request(app)
      .patch(`/api/homelab/targets/${id}`)
      .set("x-csrf-token", getCsrfToken())
      .send({ restrict_agents: "false" })
      .expect(400);
    await request(app)
      .patch(`/api/homelab/targets/${id}`)
      .set("x-csrf-token", getCsrfToken())
      .send({ restrict_agents: true })
      .expect(200)
      .expect((res) => expect(res.body.target.restrict_agents).toBe(true));
    ensureHomelabSchema(db);
    expect(db.prepare("SELECT restrict_agents FROM homelab_ssh_targets WHERE id=?").get(id)).toMatchObject({
      restrict_agents: 1,
    });
    await request(app)
      .patch(`/api/homelab/targets/${id}`)
      .set("x-csrf-token", getCsrfToken())
      .send({ name: "Renamed" })
      .expect(200)
      .expect((res) => expect(res.body.target.restrict_agents).toBe(true));
  });

  it("executes auto-approved ping without a grant and rechecks host access before consuming approval", async () => {
    const { db } = harness();
    const key = Buffer.from("trusted-test-key");
    const pin = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
    const fake = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      connect(config: ConnectConfig) {
        expect((config.hostVerifier as (key: Buffer) => boolean)(key)).toBe(true);
        queueMicrotask(() => fake.emit("ready"));
      },
      exec: vi.fn((_cmd, callback) => {
        const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
        callback(null, stream);
        queueMicrotask(() => {
          stream.emit("data", "4 packets transmitted, 4 received");
          stream.emit("close", 0);
        });
      }),
    });
    const app = express();
    app.use(express.json());
    registerHomelabRoutes(app, db, { clientFactory: () => fake as unknown as Client });
    const created = await request(app)
      .post("/api/homelab/targets")
      .set("x-csrf-token", getCsrfToken())
      .send({ ...input, host_fingerprint: pin })
      .expect(201);
    const id = created.body.target.id;
    db.exec(
      "INSERT INTO agents (id,name,role,cli_provider) VALUES ('worker','Worker','senior','codex'); INSERT INTO tasks (id,title,status,assigned_agent_id) VALUES ('task','Ping','in_progress','worker');",
    );
    const command = "ping -c 4 127.0.0.1";
    const approval = createSshApprovalRequest(db, id, "task", "worker", command);
    const run = () =>
      request(app)
        .post(`/api/homelab/targets/${id}/run`)
        .set("x-csrf-token", getCsrfToken())
        .send({ task_id: "task", command, approval_id: approval.id });
    db.prepare("UPDATE homelab_ssh_targets SET restrict_agents=1 WHERE id=?").run(id);
    await run()
      .expect(403)
      .expect((res) => expect(res.body.error).toBe("ssh_agent_not_granted"));
    expect(fake.exec).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM homelab_ssh_approvals WHERE id=?").get(approval.id)).toMatchObject({
      status: "approved",
    });
    db.prepare("UPDATE homelab_ssh_targets SET restrict_agents=0 WHERE id=?").run(id);
    await run()
      .expect(200)
      .expect((res) =>
        expect(res.body).toMatchObject({ ok: true, exit_code: 0, stdout: "4 packets transmitted, 4 received" }),
      );
    await run().expect(403);
    expect(fake.exec).toHaveBeenCalledTimes(1);
  });

  it("stores credentials encrypted and never returns them to the UI", async () => {
    const { db, app } = harness();
    const created = await request(app)
      .post("/api/homelab/targets")
      .set("x-csrf-token", getCsrfToken())
      .send(input)
      .expect(201);
    const id = created.body.target.id as string;
    expect(created.body.target).toMatchObject({ auth_method: "password", has_credential: true });
    expect(JSON.stringify(created.body)).not.toContain("secret-password");
    const row = db.prepare("SELECT credential_enc FROM homelab_ssh_targets WHERE id = ?").get(id) as {
      credential_enc: string;
    };
    expect(row.credential_enc).toBe("sealed:secret-password");
    const listed = await request(app).get("/api/homelab/targets").expect(200);
    expect(JSON.stringify(listed.body)).not.toContain("secret-password");
    expect(JSON.stringify(listed.body)).not.toContain("sealed:");
  });

  it("requires CSRF and approval for every agent command", async () => {
    const { db, app } = harness();
    await request(app).post("/api/homelab/targets").send(input).expect(403);
    const created = await request(app)
      .post("/api/homelab/targets")
      .set("x-csrf-token", getCsrfToken())
      .send({ ...input, host_fingerprint: `SHA256:${"A".repeat(43)}` })
      .expect(201);
    const id = created.body.target.id as string;
    db.prepare("INSERT INTO agents (id,name,role,cli_provider) VALUES ('worker','Worker','senior','codex')").run();
    db.prepare(
      "INSERT INTO tasks (id,title,status,assigned_agent_id) VALUES ('task-1','Inspect','in_progress','worker')",
    ).run();
    db.prepare("INSERT INTO homelab_ssh_grants (target_id,agent_id,created_at) VALUES (?,?,0)").run(id, "worker");
    const response = await request(app)
      .post(`/api/homelab/targets/${id}/run`)
      .set("x-csrf-token", getCsrfToken())
      .send({ task_id: "task-1", command: "uptime" })
      .expect(403);
    expect(response.body.error).toBe("ssh_command_approval_required");
    expect(db.prepare("SELECT COUNT(*) AS n FROM homelab_ssh_runs").get()).toMatchObject({ n: 0 });
  });

  it("migrates legacy tables without requiring Windows key paths", () => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    db.exec(`CREATE TABLE homelab_ssh_targets (id TEXT PRIMARY KEY,name TEXT,host TEXT,ssh_user TEXT,port INTEGER,key_path TEXT NOT NULL,known_hosts_path TEXT NOT NULL,enabled INTEGER,created_at INTEGER,updated_at INTEGER);
      CREATE TABLE homelab_ssh_grants (target_id TEXT,agent_id TEXT,PRIMARY KEY(target_id,agent_id));
      CREATE TABLE homelab_ssh_runs (id TEXT PRIMARY KEY,target_id TEXT,task_id TEXT,agent_id TEXT,command_sha256 TEXT,command_bytes INTEGER,started_at INTEGER,finished_at INTEGER,status TEXT,exit_code INTEGER,stdout_bytes INTEGER,stderr_bytes INTEGER,stdout_sha256 TEXT,stderr_sha256 TEXT,error_code TEXT);`);
    ensureHomelabSchema(db);
    expect(
      (db.prepare("PRAGMA table_info(homelab_ssh_targets)").all() as Array<{ name: string; dflt_value: string }>).find(
        (row) => row.name === "restrict_agents",
      ),
    ).toMatchObject({ dflt_value: "0" });
    expect(
      (db.prepare("PRAGMA table_info(homelab_ssh_grants)").all() as Array<{ name: string }>).map((row) => row.name),
    ).toContain("created_at");
    expect(
      (db.prepare("PRAGMA table_info(homelab_ssh_runs)").all() as Array<{ name: string }>).map((row) => row.name),
    ).toContain("completed_at");
  });

  it("rejects a changed host key before authentication or command execution", async () => {
    process.env.OAUTH_ENCRYPTION_SECRET = "test-only-encryption-key";
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    applyBaseSchema(db);
    const app = express();
    app.use(express.json());
    const fake = Object.assign(new EventEmitter(), {
      end: vi.fn(),
      exec: vi.fn(),
      connect(config: ConnectConfig) {
        const accepted = (config.hostVerifier as (key: Buffer) => boolean)(Buffer.from("different-host-key"));
        expect(accepted).toBe(false);
        queueMicrotask(() => fake.emit("error", new Error("Host key rejected")));
      },
    });
    registerHomelabRoutes(app, db, { clientFactory: () => fake as unknown as Client });
    const created = await request(app)
      .post("/api/homelab/targets")
      .set("x-csrf-token", getCsrfToken())
      .send({ ...input, host_fingerprint: `SHA256:${"A".repeat(43)}` })
      .expect(201);
    const result = await request(app)
      .post(`/api/homelab/targets/${created.body.target.id}/test`)
      .set("x-csrf-token", getCsrfToken())
      .send({})
      .expect(200);
    expect(result.body).toMatchObject({ ok: false, error_code: "ssh_host_key_mismatch" });
    expect(fake.exec).not.toHaveBeenCalled();
  });
});
