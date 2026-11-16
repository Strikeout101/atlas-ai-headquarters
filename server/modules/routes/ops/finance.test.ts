import { getCsrfToken } from "../../../security/auth.ts";
import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyBaseSchema } from "../../bootstrap/schema/base-schema.ts";
import { ensureBusinessSchema } from "./business.ts";
import { ensureAutonomySchema } from "../../autonomy-store.ts";
import { registerFinanceRoutes } from "./finance.ts";
import { SESSION_COOKIE_NAME } from "../../../config/runtime.ts";
import { createSessionToken } from "../../../security/login-sessions.ts";

const dbs: DatabaseSync[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
function harness() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  applyBaseSchema(db);
  ensureBusinessSchema(db);
  ensureAutonomySchema(db);
  const app = express();
  app.use(express.json());
  registerFinanceRoutes(app, db);
  const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`;
  const post = (path: string, body: Record<string, unknown>) =>
    request(app).post(`/api/finance/${path}`).set("Cookie", cookie).set("x-csrf-token", getCsrfToken()).send(body);
  const patch = (path: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/finance/${path}`).set("Cookie", cookie).set("x-csrf-token", getCsrfToken()).send(body);
  return { app, db, cookie, post, patch };
}
describe("finance owner API", () => {
  it("starts empty with no connector calls or invented money", async () => {
    const { app } = harness();
    const response = await request(app).get("/api/finance").expect(200);
    expect(response.body).toMatchObject({
      ok: true,
      deals: [],
      ledger: [],
      spend_requests: [],
      totals: [],
      goals: [],
      opportunities: [],
    });
  });
  it("requires a real owner session for every mutation and refuses agents even with a signed cookie", async () => {
    const { app, cookie } = harness();
    for (const [method, path] of [
      ["post", "deals"],
      ["patch", "deals/id"],
      ["post", "ledger"],
      ["patch", "ledger/id/link"],
      ["post", "spend-requests"],
      ["post", "spend-requests/id/decide"],
    ] as const) {
      await request(app)[method](`/api/finance/${path}`).send({}).expect(403);
      await request(app)
        [method](`/api/finance/${path}`)
        .set("Cookie", cookie)
        .set("x-agent-task-token", "agent")
        .send({})
        .expect(403);
      await request(app)
        [method](`/api/finance/${path}`)
        .set("Cookie", `${SESSION_COOKIE_NAME}=${createSessionToken("local")}`)
        .send({})
        .expect(403);
    }
  });
  it("persists deal preparation stages while refusing a fabricated paid state", async () => {
    const { post, patch } = harness();
    const created = await post("deals", {
      business: "ventures",
      title: "Asset pack",
      expected_amount_minor: 750,
      currency: "USD",
      generated_at: 1000,
    }).expect(201);
    expect(created.body.item).toMatchObject({
      stage: "lead",
      generated_at: 1000,
      published_at: null,
      ordered_at: null,
    });
    await patch(`deals/${created.body.item.id}`, { stage: "proposal", published_at: 2000 }).expect(200);
    await patch(`deals/${created.body.item.id}`, { stage: "paid" }).expect(400);
    await post("deals", { business: "ventures", title: "False income", stage: "paid" }).expect(400);
  });
  it("accepts only unverified manual entries and only link fields on a receipt patch", async () => {
    const { post, patch, app } = harness();
    const row = {
      business: "tech",
      kind: "revenue",
      amount_minor: 4950,
      currency: "USD",
      description: "Owner-entered historical note",
    };
    await post("ledger", { ...row, verified: 1 }).expect(400);
    await post("ledger", { ...row, source: "square_payment" }).expect(400);
    const created = await post("ledger", row).expect(201);
    expect(created.body.item).toMatchObject({ verified: 0, source: "manual" });
    await patch(`ledger/${created.body.item.id}/link`, { verified: 1 }).expect(400);
    const overview = await request(app).get("/api/finance?business=tech").expect(200);
    expect(overview.body.totals[0]).toMatchObject({
      revenue_minor: 0,
      unverified_revenue_minor: 4950,
      costs_complete: false,
    });
  });
  it("records owner spending attribution and rejects override fields or duplicate decisions", async () => {
    const { post, db } = harness();
    const created = await post("spend-requests", {
      business: "ventures",
      amount_minor: 2500,
      currency: "USD",
      purpose: "Proposed advertising budget",
    }).expect(201);
    await post(`spend-requests/${created.body.item.id}/decide`, { approve: true, decided_by: "vp" }).expect(400);
    const approved = await post(`spend-requests/${created.body.item.id}/decide`, { approve: true }).expect(200);
    expect(approved.body.item).toMatchObject({ status: "approved", decided_by: "owner" });
    await post(`spend-requests/${created.body.item.id}/decide`, { approve: false }).expect(409);
    expect(db.prepare("SELECT * FROM ledger_entries").all()).toEqual([]);
  });
  it("validates reporting ranges, currencies and integer money", async () => {
    const { app, post } = harness();
    for (const query of ["business=unknown", "from=NaN", "from=-1", "from=100&to=99", "from="])
      await request(app).get(`/api/finance?${query}`).expect(400);
    await post("ledger", { business: "tech", kind: "revenue", amount_minor: 1.25 }).expect(400);
    await post("deals", { business: "tech", title: "Quote", currency: "ZZZ" }).expect(400);
  });
});

it("rejects a signed owner-cookie mutation without its CSRF token", async () => {
  const { app, cookie } = harness();
  const response = await request(app)
    .post("/api/finance/deals")
    .set("Cookie", cookie)
    .send({ business: "tech", title: "Untrusted form submission" })
    .expect(403);
  expect(response.body.error).toBe("csrf_token_required");
});
