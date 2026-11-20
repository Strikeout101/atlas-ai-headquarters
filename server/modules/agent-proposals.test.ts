import { SESSION_COOKIE_NAME } from "../config/runtime.ts";
import { createSessionToken } from "../security/login-sessions.ts";
import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCsrfToken } from "../security/auth.ts";
import {
  AUTONOMY_SETTING,
  MAX_PENDING_PER_AGENT,
  PROPOSAL_TTL_MS,
  ensureAgentProposalSchema,
  parseProposalReply,
  pickAgentDueForThinking,
  runAutonomyTick,
} from "./agent-proposals.ts";
import { registerAgentProposalRoutes } from "./routes/ops/agent-proposals.ts";
import { listPendingApprovals } from "./routes/ops/approvals.ts";

vi.mock("../oauth/helpers.ts", () => ({
  encryptSecret: (value: string) => value,
  decryptSecret: (value: string) => value,
}));

const HOUR = 60 * 60 * 1000;
const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE departments (id TEXT PRIMARY KEY, name TEXT, description TEXT, prompt TEXT);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, project_path TEXT, core_goal TEXT,
      default_pack_key TEXT, last_used_at INTEGER, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, name_ko TEXT DEFAULT '', role TEXT, personality TEXT,
      status TEXT, department_id TEXT, current_task_id TEXT, avatar_emoji TEXT DEFAULT '', cli_provider TEXT,
      oauth_account_id TEXT, api_provider_id TEXT, api_model TEXT, cli_model TEXT, cli_reasoning_level TEXT,
      workflow_pack_key TEXT DEFAULT 'development', created_at INTEGER);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, department_id TEXT, assigned_agent_id TEXT,
      project_id TEXT, status TEXT, priority INTEGER, task_type TEXT, workflow_pack_key TEXT, project_path TEXT,
      created_at INTEGER, updated_at INTEGER);
    INSERT INTO departments VALUES ('ops', 'Operations', 'Keeps the homelab running', NULL);
    INSERT INTO projects VALUES ('p1', 'Homelab', '/srv/homelab', 'Reliable self-hosted services', 'development', 5, 1, 1);
    INSERT INTO agents (id, name, role, status, department_id, cli_provider, created_at) VALUES
      ('lead', 'Marcus', 'team_leader', 'idle', 'ops', 'claude', 1),
      ('junior', 'Felix', 'junior', 'idle', 'ops', 'claude', 2),
      ('eager', 'Nova', 'senior', 'idle', 'ops', 'claude', 3);
    INSERT INTO tasks VALUES ('t-old', 'Rotate backup drives', '', 'ops', 'lead', NULL, 'in_progress', 0, 'general',
      'development', NULL, 1, 1);`);
  ensureAgentProposalSchema(db);
  db.prepare("UPDATE agents SET autonomy_enabled = 1 WHERE id = 'eager'").run();
  return db;
}

const reply = (proposals: unknown[]) => ({ text: JSON.stringify({ proposals }) });

describe("agent autonomy: who thinks", () => {
  it("lets team leaders and agents with the toggle on think, never agents with it off", () => {
    const db = harness();
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const agent = pickAgentDueForThinking(db, 10 * HOUR, { intervalMs: 6 * HOUR });
      if (!agent) break;
      seen.push(agent.id);
      db.prepare("INSERT INTO agent_autonomy_state (agent_id, last_thought_at) VALUES (?, ?)").run(agent.id, 10 * HOUR);
    }
    expect(seen).toEqual(["lead", "eager"]);
  });

  it("skips busy agents, agents in a meeting, agents that thought recently, and full suggestion queues", () => {
    const db = harness();
    db.prepare("UPDATE agents SET status = 'working' WHERE id = 'lead'").run();
    expect(pickAgentDueForThinking(db, 10 * HOUR, { isAgentInMeeting: (id) => id === "eager" })).toBeNull();

    db.prepare("UPDATE agents SET status = 'idle'").run();
    db.prepare("INSERT INTO agent_autonomy_state (agent_id, last_thought_at) VALUES ('lead', ?)").run(9 * HOUR);
    expect(pickAgentDueForThinking(db, 10 * HOUR, { intervalMs: 6 * HOUR })?.id).toBe("eager");
    expect(pickAgentDueForThinking(db, 16 * HOUR, { intervalMs: 6 * HOUR })?.id).toBe("eager");

    for (let i = 0; i < MAX_PENDING_PER_AGENT; i += 1) {
      db.prepare(
        "INSERT INTO agent_task_proposals (id, agent_id, title, status, created_at) VALUES (?, 'eager', ?, 'pending', 1)",
      ).run(`x${i}`, `Idea ${i}`);
    }
    expect(pickAgentDueForThinking(db, 16 * HOUR, { intervalMs: 6 * HOUR })?.id).toBe("lead");
  });
});

describe("agent autonomy: thinking", () => {
  it("does not call an unattributed API model from the automatic think loop", async () => {
    const db = harness();
    db.exec("UPDATE agents SET cli_provider='api' WHERE id='lead'");
    const runAgentOneShot = vi.fn();
    const result = await runAutonomyTick({ db, runAgentOneShot, now: () => 10 * HOUR });
    expect(result).toMatchObject({
      agentId: "lead",
      created: 0,
      error: expect.stringContaining("Unattributed API thinking is disabled"),
    });
    expect(runAgentOneShot).not.toHaveBeenCalled();
    expect(db.prepare("SELECT last_error FROM agent_autonomy_state WHERE agent_id='lead'").get()).toMatchObject({
      last_error: expect.stringContaining("invocation budget"),
    });
    expect(
      (await runAutonomyTick({ db, runAgentOneShot: vi.fn().mockResolvedValue(reply([])), now: () => 10 * HOUR }))
        ?.agentId,
    ).toBe("eager");
  });
  it("stores useful suggestions and drops duplicates, board repeats and unknown projects", async () => {
    const db = harness();
    const runAgentOneShot = vi.fn().mockResolvedValue(
      reply([
        { title: "Rotate backup drives", description: "dup of open task", reason: "", project_id: "p1" },
        {
          title: "Audit expiring TLS certificates",
          description: "List certs expiring in 30 days",
          reason: "Avoid outages",
          project_id: "p1",
        },
        { title: "Audit expiring TLS certificates!", description: "same again", reason: "", project_id: null },
        {
          title: "Write a runbook for DNS failover",
          description: "Step-by-step",
          reason: "Faster recovery",
          project_id: "nope",
        },
      ]),
    );
    const result = await runAutonomyTick({ db, runAgentOneShot, now: () => 10 * HOUR });
    expect(result).toEqual({ agentId: "lead", created: 2 });
    expect(runAgentOneShot.mock.calls[0][2]).toMatchObject({ noTools: true });
    const prompt = String(runAgentOneShot.mock.calls[0][1]);
    expect(prompt).toContain("Marcus");
    expect(prompt).toContain("p1: Homelab - Reliable self-hosted services");
    expect(prompt).toContain("Rotate backup drives (in_progress)");
    const rows = db.prepare("SELECT title, project_id, status FROM agent_task_proposals ORDER BY title").all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toEqual([
      { title: "Audit expiring TLS certificates", project_id: "p1", status: "pending" },
      { title: "Write a runbook for DNS failover", project_id: null, status: "pending" },
    ]);
  });

  it("tells the agent about the owner's filled-in businesses", async () => {
    const db = harness();
    db.exec(`CREATE TABLE business_profiles (business TEXT PRIMARY KEY, name TEXT DEFAULT '', service_area TEXT DEFAULT '',
      hours TEXT DEFAULT '', services TEXT DEFAULT '', workflow_notes TEXT DEFAULT '');
      INSERT INTO business_profiles (business, name, services) VALUES ('tech', 'Alba Tech', 'Home network setup'), ('rental', '', '');`);
    const runAgentOneShot = vi.fn().mockResolvedValue(reply([]));
    await runAutonomyTick({ db, runAgentOneShot, now: () => 10 * HOUR });
    const prompt = String(runAgentOneShot.mock.calls[0][1]);
    expect(prompt).toContain('Tech services business "Alba Tech". Services: Home network setup');
    expect(prompt).not.toContain("Events and rentals business");
  });

  it("records a failed think without retrying that agent every tick", async () => {
    const db = harness();
    const runAgentOneShot = vi.fn().mockResolvedValue({ text: "", error: "provider_not_authenticated" });
    expect(await runAutonomyTick({ db, runAgentOneShot, now: () => 10 * HOUR })).toMatchObject({
      agentId: "lead",
      error: "provider_not_authenticated",
    });
    expect(db.prepare("SELECT last_error FROM agent_autonomy_state WHERE agent_id = 'lead'").get()).toEqual({
      last_error: "provider_not_authenticated",
    });
    expect((await runAutonomyTick({ db, runAgentOneShot, now: () => 10 * HOUR }))?.agentId).toBe("eager");
  });

  it("does nothing when the owner turned autonomy off, and expires week-old suggestions", async () => {
    const db = harness();
    db.prepare(
      "INSERT INTO agent_task_proposals (id, agent_id, title, status, created_at) VALUES ('old', 'lead', 'Old idea', 'pending', 0)",
    ).run();
    db.prepare("INSERT INTO settings VALUES (?, 'false')").run(AUTONOMY_SETTING);
    const runAgentOneShot = vi.fn();
    expect(await runAutonomyTick({ db, runAgentOneShot, now: () => PROPOSAL_TTL_MS + 1 })).toBeNull();
    expect(runAgentOneShot).not.toHaveBeenCalled();

    db.prepare("DELETE FROM settings").run();
    runAgentOneShot.mockResolvedValue(reply([]));
    await runAutonomyTick({ db, runAgentOneShot, now: () => PROPOSAL_TTL_MS + 1 });
    expect(db.prepare("SELECT status FROM agent_task_proposals WHERE id = 'old'").get()).toEqual({ status: "expired" });
  });

  it("reads JSON wrapped in prose or code fences and ignores garbage", () => {
    const opts = { projectIds: new Set<string>(), existingTitles: [] };
    expect(parseProposalReply('Sure!\n```json\n{"proposals":[{"title":"Tidy the wiki"}]}\n```', opts)).toEqual([
      { title: "Tidy the wiki", description: "", reason: "", project_id: null },
    ]);
    expect(parseProposalReply('{"proposals":[]}', opts)).toEqual([]);
    expect(parseProposalReply("no json here", opts)).toBeNull();
    expect(parseProposalReply('{"proposals":"nope"}', opts)).toBeNull();
  });

  it("treats a reply it cannot read (like a CLI sign-in error) as a failure, not as having no ideas", async () => {
    const db = harness();
    const runAgentOneShot = vi.fn().mockResolvedValue({ text: "Not logged in · Please run /login" });
    expect(await runAutonomyTick({ db, runAgentOneShot, now: () => 10 * HOUR })).toMatchObject({
      agentId: "lead",
      created: 0,
      error: "unreadable_reply: Not logged in · Please run /login",
    });
    expect(db.prepare("SELECT last_error FROM agent_autonomy_state WHERE agent_id = 'lead'").get()).toEqual({
      last_error: "unreadable_reply: Not logged in · Please run /login",
    });
  });
});

describe("agent autonomy: owner decisions", () => {
  function app(db: DatabaseSync) {
    const server = express();
    server.use(express.json());
    registerAgentProposalRoutes(server, db, { appendTaskLog: vi.fn(), broadcast: vi.fn() });
    return server;
  }
  function seed(db: DatabaseSync) {
    db.prepare(
      `INSERT INTO agent_task_proposals (id, agent_id, department_id, project_id, title, description, reason, status, created_at)
       VALUES ('s1', 'eager', 'ops', 'p1', 'Audit expiring TLS certificates', 'List certs', 'Avoid outages', 'pending', 7)`,
    ).run();
  }

  it("routes pending suggestions to VPs with project context and keeps them off the owner queue", () => {
    const db = harness();
    seed(db);
    expect(listPendingApprovals(db)).toEqual([]);
    expect(listPendingApprovals(db, 100, "all")).toEqual([
      expect.objectContaining({
        kind: "task_proposal",
        id: "s1",
        task_id: null,
        agent_name: "Nova",
        title: "Audit expiring TLS certificates",
        project_name: "Homelab",
        decide_path: "/api/agent-proposals/s1/decide",
      }),
    ]);
  });

  it("turns an approved suggestion into one planned task assigned to the agent, once", async () => {
    const db = harness();
    seed(db);
    const server = app(db);
    await request(server).post("/api/agent-proposals/s1/decide").send({ approve: true }).expect(403);
    const res = await request(server)
      .post("/api/agent-proposals/s1/decide")
      .set("x-csrf-token", getCsrfToken())
      .set("Cookie", `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`)
      .send({ approve: true })
      .expect(200);
    expect(res.body).toMatchObject({ ok: true, status: "approved" });
    expect(db.prepare("SELECT * FROM tasks WHERE id = ?").get(res.body.task_id)).toMatchObject({
      title: "Audit expiring TLS certificates",
      status: "planned",
      assigned_agent_id: "eager",
      department_id: "ops",
      project_id: "p1",
      project_path: "/srv/homelab",
    });
    expect(listPendingApprovals(db)).toEqual([]);
    await request(server)
      .post("/api/agent-proposals/s1/decide")
      .set("x-csrf-token", getCsrfToken())
      .set("Cookie", `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`)
      .send({ approve: true })
      .expect(409);
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(2);
  });

  it("dismisses without creating a task", async () => {
    const db = harness();
    seed(db);
    await request(app(db))
      .post("/api/agent-proposals/s1/decide")
      .set("x-csrf-token", getCsrfToken())
      .set("Cookie", `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`)
      .send({ approve: false })
      .expect(200, { ok: true, status: "dismissed", id: "s1" });
    expect(db.prepare("SELECT status FROM agent_task_proposals WHERE id = 's1'").get()).toEqual({
      status: "dismissed",
    });
    expect((db.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n).toBe(1);
  });
});
