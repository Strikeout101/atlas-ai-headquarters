import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { ensureBusinessSchema } from "./business.ts";
import { registerAutonomyRoutes } from "./autonomy.ts";
import { SESSION_COOKIE_NAME } from "../../../config/runtime.ts";
import { createSessionToken } from "../../../security/login-sessions.ts";
import { getCsrfToken } from "../../../security/auth.ts";
import { appendAutonomyLedger, autonomyConfig, autonomyOverview } from "../../autonomy-store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  applyBaseSchema(db);
  ensureBusinessSchema(db);
  db.prepare(
    "INSERT INTO projects(id,name,project_path,core_goal) VALUES ('project','Project',?,'Goal'),('relative','Relative','relative/path','Goal')",
  ).run(process.cwd());
  const app = express();
  app.use(express.json());
  registerAutonomyRoutes(app, db);
  const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`;
  const create = (resource: string, body: Record<string, unknown>) =>
    request(app).post(`/api/autonomy/${resource}`).set("Cookie", cookie).send(body);
  const patch = (resource: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/autonomy/${resource}`).set("Cookie", cookie).send(body);
  return { db, app, create, patch };
}
const goal = {
  business: "ventures",
  project_id: "project",
  metric: "completed_tasks",
  target: 5,
  period_start: 0,
  period_end: Date.now() + 86400000,
};

describe("autonomy owner API", () => {
  it("installs inert schema and conservative default limits", async () => {
    const { app, db } = harness();
    const result = await request(app).get("/api/autonomy").expect(200);
    expect(result.body).toMatchObject({
      ok: true,
      goals: [],
      initiatives: [],
      schedules: [],
      ledger: [],
      config: { daily_start_cap: 6, usage_threshold: 0.8, failure_limit: 3, planning_interval_minutes: 360 },
    });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='autonomy_work'").get()).toBeUndefined();
  });
  it("requires signed owner sessions on all writes, including when agent headers hide behind a cookie", async () => {
    const { app } = harness();
    for (const resource of ["goals", "initiatives", "schedules"]) {
      await request(app).post(`/api/autonomy/${resource}`).send(goal).expect(403);
      await request(app)
        .patch(`/api/autonomy/${resource}/missing`)
        .set("Cookie", `${SESSION_COOKIE_NAME}=${createSessionToken("local")}`)
        .send(goal)
        .expect(403);
    }
    await request(app)
      .patch("/api/autonomy/config")
      .set("Cookie", `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`)
      .set("x-agent-task-token", "worker-token")
      .send({ daily_start_cap: 99 })
      .expect(403);
  });
  it("takes a goal without a project, refuses a bad one, and validates goal periods", async () => {
    const { create } = harness();
    // Goals belong to a business; a project (code workspace) is optional but must be real when given.
    for (const project_id of ["missing", "relative"]) await create("goals", { ...goal, project_id }).expect(400);
    const noProject = await create("goals", { ...goal, project_id: undefined }).expect(201);
    expect(noProject.body.item.project_id).toBeNull();
    await create("schedules", {
      business: "ventures",
      title: "Needs a folder",
      kind: "research",
      interval_minutes: 60,
      next_run_at: 1,
      enabled: 0,
      department_id: null,
    }).expect(400);
    await create("goals", { ...goal, business: "unknown" }).expect(400);
    await create("goals", { ...goal, period_end: 0 }).expect(400);
    await create("goals", { ...goal, target: -1 }).expect(400);
    await create("goals", goal).expect(201);
  });
  it("keeps a goal title and shows only recorded USD expenses against an initiative's USD budget", async () => {
    const { create, patch, db } = harness();
    const created = await create("goals", { ...goal, title: "Reach Etsy sales", project_id: null }).expect(201);
    const goalId = created.body.item.id as string;
    expect(created.body.item.title).toBe("Reach Etsy sales");
    expect((await patch(`goals/${goalId}`, { title: "Reach Etsy sales monthly" }).expect(200)).body.item.title).toBe(
      "Reach Etsy sales monthly",
    );
    const initiative = await create("initiatives", {
      business: "ventures",
      project_id: null,
      goal_id: goalId,
      title: "Budget workbook",
      description: "",
      budget: 30,
    }).expect(201);
    db.exec("CREATE TABLE ledger_entries (initiative_id TEXT, kind TEXT, currency TEXT, amount_minor INTEGER)");
    const insert = db.prepare("INSERT INTO ledger_entries VALUES (?, 'expense', ?, ?)");
    insert.run(initiative.body.item.id, "USD", 1250);
    insert.run(initiative.body.item.id, "EUR", 900);
    const listed = autonomyOverview(db).initiatives as Array<{ id: string; spent_minor: number }>;
    expect(listed.find((item) => item.id === initiative.body.item.id)?.spent_minor).toBe(1250);
  });
  it("validates scores and linked goals and records budget without authorizing a spend", async () => {
    const { create, patch, db } = harness();
    const result = await create("goals", goal).expect(201);
    const initiative = {
      business: "ventures",
      project_id: "project",
      goal_id: result.body.item.id,
      title: "Research dashboard",
      budget: 150,
    };
    await create("initiatives", { ...initiative, demand_score: 101 }).expect(400);
    await create("initiatives", { ...initiative, business: "tech" }).expect(400);
    const created = await create("initiatives", {
      ...initiative,
      demand_score: 72,
      revenue_score: 61,
      status: "proposed",
    }).expect(201);
    expect(created.body.item).toMatchObject({ budget: 150, status: "proposed", demand_score: 72 });
    await patch(`goals/${result.body.item.id}`, { business: "tech" }).expect(400);
    const updated = await patch(`initiatives/${created.body.item.id}`, { status: "stopped" }).expect(200);
    expect(updated.body.item.status).toBe("stopped");
    expect(db.prepare("SELECT message FROM autonomy_ledger WHERE event='initiative_created'").get()).toMatchObject({
      message: expect.stringContaining("not spending authorization"),
    });
  });
  it("leaves new routines disabled unless explicitly enabled and validates interval and department", async () => {
    const { create, patch, db } = harness();
    const schedule = {
      business: "tech",
      project_id: "project",
      title: "Research local leads",
      kind: "lead_research",
      interval_minutes: 30,
    };
    await create("schedules", { ...schedule, interval_minutes: 0 }).expect(400);
    await create("schedules", { ...schedule, department_id: "missing" }).expect(400);
    const start = Date.now();
    const created = await create("schedules", schedule).expect(201);
    expect(created.body.item).toMatchObject({ enabled: 0, consecutive_failures: 0, kind: "lead_research" });
    expect(created.body.item.next_run_at).toBeGreaterThanOrEqual(start + 30 * 60000);
    const enabled = await patch(`schedules/${created.body.item.id}`, { enabled: true }).expect(200);
    expect(enabled.body.item.enabled).toBe(1);
    await patch(`schedules/${created.body.item.id}`, { consecutive_failures: 0 }).expect(400);
    db.prepare("UPDATE schedules SET enabled=0,consecutive_failures=3 WHERE id=?").run(created.body.item.id);
    const resumed = await patch(`schedules/${created.body.item.id}`, { enabled: true }).expect(200);
    expect(resumed.body.item).toMatchObject({ enabled: 1, consecutive_failures: 0 });
    expect(
      db
        .prepare("SELECT 1 FROM autonomy_ledger WHERE event='schedule_resumed' AND source_id=?")
        .get(created.body.item.id),
    ).toBeTruthy();
  });
  it("persists bounded owner controls and refuses malformed payloads", async () => {
    const { patch, db } = harness();
    for (const body of [
      { usage_threshold: 1.01 },
      { daily_start_cap: 1.1 },
      { failure_limit: 0 },
      { planning_interval_minutes: 0 },
      { think_enabled: 2 },
      { think_interval_minutes: 59 },
      { think_check_interval_minutes: 0 },
      { think_max_pending_per_agent: -1 },
      { idea_daily_start_cap: 101 },
      { id: 2 },
    ])
      await patch("config", body).expect(400);
    await patch("config", { local_provider_daily_run_cap: -1 }).expect(400);
    await patch("config", { local_provider_daily_run_cap: 1.5 }).expect(400);
    await patch("config", {
      daily_start_cap: 0,
      usage_threshold: 0.7,
      failure_limit: 2,
      local_provider_daily_run_cap: 7,
      think_enabled: 0,
      think_interval_minutes: 2880,
      think_check_interval_minutes: 60,
      think_max_pending_per_agent: 3,
      think_max_pending_total: 15,
      idea_daily_start_cap: 1,
    }).expect(200);
    expect(autonomyConfig(db)).toMatchObject({
      daily_start_cap: 0,
      usage_threshold: 0.7,
      failure_limit: 2,
      local_provider_daily_run_cap: 7,
      think_enabled: 0,
      think_interval_minutes: 2880,
      think_check_interval_minutes: 60,
      think_max_pending_per_agent: 3,
      think_max_pending_total: 15,
      idea_daily_start_cap: 1,
    });
  });
  it("builds an honest digest with full counts when recent-event display is capped", async () => {
    const { app, db } = harness();
    const time = Date.now() - 10000;
    for (let i = 0; i < 205; i++)
      appendAutonomyLedger(db, { event: i % 2 ? "skipped" : "declined", message: `Entry ${i}` }, time + i);
    const result = await request(app)
      .get(`/api/autonomy/digest?after=${time - 1}`)
      .expect(200);
    expect(result.body.events).toHaveLength(200);
    expect(result.body).toMatchObject({ total: 205, counts: { skipped: 102, declined: 103 } });
    await request(app).get("/api/autonomy/digest?after=invalid").expect(400);
    const empty = await request(app).get(`/api/autonomy/digest?after=${result.body.through}`).expect(200);
    expect(empty.body.events).toEqual([]);
  });
  it("derives progress from real tasks and business records without inventing revenue", async () => {
    const { create, db } = harness();
    await create("goals", goal).expect(201);
    await create("goals", { ...goal, metric: "contacts" }).expect(201);
    await create("goals", { ...goal, metric: "verified_revenue" }).expect(201);
    const now = Date.now();
    db.prepare(
      "INSERT INTO tasks(id,title,project_id,status,completed_at) VALUES ('done','Delivered','project','done',?),('working','Working','project','in_progress',NULL)",
    ).run(now);
    db.prepare(
      "INSERT INTO business_contacts(id,business,name,created_at,updated_at) VALUES ('contact','ventures','Prospect',?,?)",
    ).run(now, now);
    const overview = autonomyOverview(db);
    expect(overview.goals.find((row) => row.metric === "completed_tasks")).toMatchObject({
      progress: 1,
      progress_scope: "project",
    });
    expect(overview.goals.find((row) => row.metric === "contacts")).toMatchObject({
      progress: 1,
      progress_scope: "business",
    });
    expect(overview.goals.find((row) => row.metric === "verified_revenue")).toMatchObject({
      progress: null,
      progress_scope: null,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("lets the owner approve a strategy, approve an idea through the VPs' plan check, and unblock a step", async () => {
    const { app, db, create, patch } = harness();
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`;
    db.exec(`INSERT INTO departments(id,name,name_ko,icon,color) VALUES ('planning','Planning','','','#1'),('design','Design','','','#2');
      INSERT INTO agents(id,name,role,department_id,cli_provider) VALUES ('p','Charlotte','team_leader','planning','codex'),('d','Iris','team_leader','design','codex');`);
    const goalId = (await create("goals", goal).expect(201)).body.item.id;
    db.prepare(
      "INSERT INTO goal_strategies(id,goal_id,business,project_id,summary,created_at,version,status) VALUES ('s1',?,'ventures','project','Plan',1,1,'proposed')",
    ).run(goalId);
    const idea = (
      await create("initiatives", {
        business: "ventures",
        project_id: "project",
        goal_id: goalId,
        title: "Wedding planner",
      }).expect(201)
    ).body.item;
    const post = (path: string, body: Record<string, unknown> = {}) =>
      request(app).post(`/api/autonomy/${path}`).set("Cookie", cookie).set("x-csrf-token", getCsrfToken()).send(body);
    await request(app).post(`/api/autonomy/initiatives/${idea.id}/approve`).expect(403);
    expect((await post(`initiatives/${idea.id}/approve`).expect(400)).body.error).toBe("strategy_not_approved");
    expect((await post("strategies/s1/decision", { decision: "maybe" }).expect(400)).body.error).toBe(
      "invalid_decision",
    );
    await post("strategies/missing/decision", { decision: "approve" }).expect(404);
    expect((await post("strategies/s1/decision", { decision: "approve" }).expect(200)).body.item.status).toBe(
      "approved",
    );
    // Setting the status to approved goes through the same plan check.
    const approved = (await patch(`initiatives/${idea.id}`, { status: "approved" }).expect(200)).body.item;
    expect(approved).toMatchObject({ status: "approved", playbook: "etsy_digital", approved_by: "owner" });
    expect((await post(`initiatives/${idea.id}/approve`).expect(400)).body.error).toBe("initiative_not_proposed");
    db.prepare("UPDATE initiatives SET status='blocked', escalation='owner', playbook_stage='build' WHERE id=?").run(
      idea.id,
    );
    const resumed = (
      await post(`initiatives/${idea.id}/unblock`, { action: "skip", notes: "Use the template" }).expect(200)
    ).body.item;
    expect(resumed).toMatchObject({ status: "in_progress", playbook_stage: "mockups", escalation: null });
    expect((await post(`initiatives/${idea.id}/unblock`, { action: "skip" }).expect(400)).body.error).toBe(
      "initiative_not_blocked",
    );
  });
});
