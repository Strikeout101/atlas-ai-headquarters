import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { ensureBusinessSchema } from "./business.ts";
import { registerAutonomyRoutes } from "./autonomy.ts";
import { SESSION_COOKIE_NAME } from "../../../config/runtime.ts";
import { createSessionToken } from "../../../security/login-sessions.ts";
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
      opportunities: [],
      schedules: [],
      ledger: [],
      config: { daily_start_cap: 6, usage_threshold: 0.8, failure_limit: 3, planning_interval_minutes: 360 },
    });
    expect(db.prepare("SELECT * FROM autonomy_work").all()).toEqual([]);
  });
  it("requires signed owner sessions on all writes, including when agent headers hide behind a cookie", async () => {
    const { app } = harness();
    for (const resource of ["goals", "opportunities", "schedules"]) {
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
  it("requires an explicit existing project with an absolute path and validates goal periods", async () => {
    const { create } = harness();
    for (const project_id of [undefined, "missing", "relative"])
      await create("goals", { ...goal, project_id }).expect(400);
    await create("goals", { ...goal, business: "unknown" }).expect(400);
    await create("goals", { ...goal, period_end: 0 }).expect(400);
    await create("goals", { ...goal, target: -1 }).expect(400);
    await create("goals", goal).expect(201);
  });
  it("validates scores and linked goals and records budget without authorizing a spend", async () => {
    const { create, patch, db } = harness();
    const result = await create("goals", goal).expect(201);
    const opportunity = {
      business: "ventures",
      project_id: "project",
      goal_id: result.body.item.id,
      title: "Research dashboard",
      budget: 150,
    };
    await create("opportunities", { ...opportunity, demand_score: 101 }).expect(400);
    await create("opportunities", { ...opportunity, business: "tech" }).expect(400);
    const created = await create("opportunities", {
      ...opportunity,
      demand_score: 72,
      revenue_score: 61,
      status: "idea",
    }).expect(201);
    expect(created.body.item).toMatchObject({ budget: 150, status: "idea", demand_score: 72 });
    await patch(`goals/${result.body.item.id}`, { business: "tech" }).expect(400);
    const updated = await patch(`opportunities/${created.body.item.id}`, { status: "stopped" }).expect(200);
    expect(updated.body.item.status).toBe("stopped");
    expect(db.prepare("SELECT message FROM autonomy_ledger WHERE event='opportunity_created'").get()).toMatchObject({
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
      { id: 2 },
    ])
      await patch("config", body).expect(400);
    await patch("config", { daily_start_cap: 0, usage_threshold: 0.7, failure_limit: 2 }).expect(200);
    expect(autonomyConfig(db)).toMatchObject({ daily_start_cap: 0, usage_threshold: 0.7, failure_limit: 2 });
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
});
