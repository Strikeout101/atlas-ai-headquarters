import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { SESSION_COOKIE_NAME } from "../config/runtime.ts";
import { getCsrfToken } from "../security/auth.ts";
import { createAgentTaskToken } from "../security/agent-task-token.ts";
import { createSessionToken } from "../security/login-sessions.ts";
import { ensureBusinessSchema } from "./routes/ops/business.ts";
import { ensureAutonomySchema } from "./autonomy-store.ts";
import { ensureFinanceSchema } from "./finance-store.ts";
import {
  businessPolicy,
  ensureBusinessPolicySchema,
  resetBusinessPoliciesForTests,
  saveBusinessPolicy,
} from "./business-policies.ts";
import { routeApproval } from "./approval-policy.ts";
import { approvalRoute } from "./approval-review-state.ts";
import {
  decideRecordChange,
  ensureRecordChangeSchema,
  queueRecordChange,
  recordChangeBusiness,
  recordChangeNeedsApproval,
} from "./record-changes.ts";
import { listPendingApprovals } from "./routes/ops/approvals.ts";
import { registerApprovalSettingsRoutes } from "./routes/ops/approval-settings.ts";
import { registerAgentToolRoutes } from "./routes/ops/agent-tools.ts";
import { listingApprover } from "./listings.ts";
import { executeVpApproval } from "./vp-execution.ts";
import { ensureControlStateSchema, resetControlStateForTests } from "./control-state.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  resetBusinessPoliciesForTests();
  resetControlStateForTests();
});

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  ensureControlStateSchema(db);
  ensureBusinessSchema(db);
  ensureAutonomySchema(db);
  ensureFinanceSchema(db);
  ensureBusinessPolicySchema(db);
  ensureRecordChangeSchema(db);
  db.exec(`INSERT INTO agents (id,name,role,cli_provider) VALUES ('worker','Worker','senior','codex');
    INSERT INTO tasks (id,title,status,assigned_agent_id) VALUES ('task-1','Follow up leads','in_progress','worker');
    INSERT INTO business_contacts (id,business,name,created_at,updated_at) VALUES ('c-rental','rental','Lee',1,1),
      ('c-tech','tech','Dana',1,1);`);
  return db;
}

describe("business approval policy", () => {
  it("starts from today's behaviour, with Primrose record changes needing the owner", () => {
    const db = harness();
    expect(businessPolicy("tech")).toMatchObject({
      customer_sends: "owner",
      record_changes: "none",
      code_pushes: "none",
    });
    expect(businessPolicy("rental")).toMatchObject({
      customer_sends: "owner",
      record_changes: "owner",
      code_pushes: "none",
    });
    expect(businessPolicy("ventures")).toMatchObject({ customer_sends: "vp", record_changes: "none" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM business_policies").get()).toEqual({ n: 3 });
  });

  it("drives routing from settings, so automation can be raised per business", () => {
    const db = harness();
    expect(routeApproval("business_email", "tech")).toBe("owner");
    expect(routeApproval("record_change", "rental")).toBe("owner");
    saveBusinessPolicy(db, "tech", { customer_sends: "vp" });
    saveBusinessPolicy(db, "rental", { record_changes: "vp", code_pushes: "owner" });
    expect(routeApproval("business_email", "tech")).toBe("vp");
    expect(routeApproval("record_change", "rental")).toBe("vp");
    expect(routeApproval("code_push", "rental")).toBe("owner");
    expect(listingApprover(db, { business: "tech", fee_minor: 0, fee_currency: "USD" } as never)).toBe("vp");
    // Survives a restart: the cache is rebuilt from the table.
    resetBusinessPoliciesForTests();
    ensureBusinessPolicySchema(db);
    expect(businessPolicy("tech").customer_sends).toBe("vp");
  });

  it("never lets a setting switch off the hard floors", () => {
    const db = harness();
    saveBusinessPolicy(db, "ventures", { customer_sends: "vp", record_changes: "none", code_pushes: "none" });
    expect(routeApproval("business_email", "ventures", { spendsMoney: true })).toBe("owner");
    expect(routeApproval("spend_request", "ventures")).toBe("owner");
    expect(routeApproval("ssh_command", "ventures")).toBe("owner");
    expect(routeApproval("business_email", "ventures", { agreesToTerms: true })).toBe("owner");
    expect(() => saveBusinessPolicy(db, "tech", { spending: "vp" })).toThrow("invalid_policy_field");
    expect(() => saveBusinessPolicy(db, "tech", { customer_sends: "none" })).toThrow("invalid_customer_sends");
    expect(() => saveBusinessPolicy(db, "tech", { record_changes: "anyone" })).toThrow("invalid_record_changes");
    expect(() => saveBusinessPolicy(db, "nowhere", { record_changes: "none" })).toThrow("invalid_business");
  });
});

describe("record changes", () => {
  it("knows which business a change belongs to and whether it must wait", () => {
    const db = harness();
    expect(recordChangeBusiness(db, "quotes", "create", null, {})).toBe("rental");
    expect(recordChangeBusiness(db, "tickets", "create", null, {})).toBe("tech");
    expect(recordChangeBusiness(db, "contacts", "create", null, { business: "ventures" })).toBe("ventures");
    expect(recordChangeBusiness(db, "contacts", "update", "c-rental", {})).toBe("rental");
    expect(recordChangeNeedsApproval(db, "rental", { resource: "contacts" as const, target_id: null, payload: {} })).toBe(true);
    expect(recordChangeNeedsApproval(db, "tech", { resource: "contacts" as const, target_id: null, payload: {} })).toBe(false);
    expect(recordChangeNeedsApproval(db, null, { resource: "contacts" as const, target_id: null, payload: {} })).toBe(false);
  });

  it("applies an approved change once and records who approved it", async () => {
    const db = harness();
    const apply = vi.fn(async () => "new-contact");
    const queued = queueRecordChange(db, {
      business: "rental",
      resource: "contacts",
      action: "create",
      payload: { business: "rental", name: "Maria" },
      agentId: "worker",
      taskId: "task-1",
    });
    // Asking again with the same change reuses the request.
    expect(
      queueRecordChange(db, {
        business: "rental",
        resource: "contacts",
        action: "create",
        payload: { business: "rental", name: "Maria" },
        agentId: "worker",
        taskId: "task-1",
      }).id,
    ).toBe(queued.id);
    const done = await decideRecordChange(db, queued.id, true, "owner", apply);
    expect(done).toMatchObject({ status: "applied", decided_by: "owner", result_id: "new-contact" });
    expect(apply).toHaveBeenCalledTimes(1);
    await expect(decideRecordChange(db, queued.id, true, "owner", apply)).rejects.toThrow(
      "record_change_already_decided",
    );
  });

  it("refuses to overwrite a record that changed after the request", async () => {
    const db = harness();
    const queued = queueRecordChange(db, {
      business: "rental",
      resource: "contacts",
      action: "update",
      targetId: "c-rental",
      payload: { phone: "555" },
    });
    db.prepare("UPDATE business_contacts SET notes='owner edit', updated_at=2 WHERE id='c-rental'").run();
    const apply = vi.fn(async () => "c-rental");
    await expect(decideRecordChange(db, queued.id, true, "owner", apply)).rejects.toThrow(
      "record_changed_since_request",
    );
    expect(apply).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status, error_code FROM record_change_requests").get()).toEqual({
      status: "failed",
      error_code: "record_changed_since_request",
    });
  });

  it("records a failed apply instead of claiming it worked", async () => {
    const db = harness();
    const queued = queueRecordChange(db, { business: "rental", resource: "quotes", action: "create", payload: {} });
    await expect(
      decideRecordChange(db, queued.id, true, "owner", async () => {
        throw new Error("invalid_items");
      }),
    ).rejects.toThrow("invalid_items");
    expect(db.prepare("SELECT status, error_code FROM record_change_requests").get()).toEqual({
      status: "failed",
      error_code: "invalid_items",
    });
  });

  it("shows pending changes in the queue, routed by policy, and lets the VPs decide when allowed", async () => {
    const db = harness();
    const queued = queueRecordChange(db, {
      business: "rental",
      resource: "contacts",
      action: "update",
      targetId: "c-rental",
      payload: { notes: "Wants a refund-free payment plan" },
      agentId: "worker",
      taskId: "task-1",
    });
    const [item] = listPendingApprovals(db, 100, "all").filter((entry) => entry.kind === "record_change");
    expect(item).toMatchObject({ summary: 'Change contact "c-rental"', business: "rental", agent_name: "Worker" });
    expect((item as { current: Record<string, unknown> }).current).toMatchObject({ name: "Lee" });
    // Owner policy: the owner sees it, the VPs may not decide it, and words like "payment" do not matter.
    expect(approvalRoute(item)).toBe("owner");
    expect(listPendingApprovals(db).map((entry) => entry.id)).toContain(queued.id);
    await expect(executeVpApproval(db, item, true, "vp:a,b", "ok")).rejects.toThrow("vp_execution_forbidden");
    saveBusinessPolicy(db, "rental", { record_changes: "vp" });
    expect(approvalRoute(item)).toBe("vp");
    expect(listPendingApprovals(db).map((entry) => entry.id)).not.toContain(queued.id);
  });
});

describe("agent gateway and owner routes", () => {
  function app() {
    const db = harness();
    const server = express();
    server.use(express.json());
    registerAgentToolRoutes(server, db, vi.fn());
    registerApprovalSettingsRoutes(server, db);
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`;
    const agent = (data: Record<string, unknown>) =>
      request(server)
        .post("/api/agent-tools")
        .set("x-agent-task-token", createAgentTaskToken("task-1", "worker"))
        .send(data);
    const owner = (method: "post" | "patch", url: string, body: Record<string, unknown>) =>
      request(server)[method](url).set("Cookie", cookie).set("x-csrf-token", getCsrfToken()).send(body);
    return { db, server, agent, owner, cookie };
  }

  it("queues an agent's Primrose contact edit and deal instead of applying them", async () => {
    const { db, agent } = app();
    const contact = await agent({
      operation: "business",
      resource: "contacts",
      action: "update",
      id: "c-rental",
      payload: { phone: "555-0100" },
    }).expect(202);
    expect(contact.body).toMatchObject({ ok: true, pending: true });
    expect(contact.body.message).toMatch(/NOT been applied/);
    expect(db.prepare("SELECT phone FROM business_contacts WHERE id='c-rental'").get()).toEqual({ phone: null });

    const deal = await agent({
      operation: "finance.deals.create",
      payload: { business: "rental", title: "Wedding flower wall", stage: "lead", currency: "USD" },
    }).expect(202);
    expect(deal.body.pending).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM deals").get()).toEqual({ n: 0 });

    const status = await agent({ operation: "business.change_status", request_id: deal.body.request_id }).expect(200);
    expect(status.body.request).toMatchObject({ status: "pending", resource: "deals", action: "create" });
  });

  it("applies directly where the business allows it, and drafts are never held", async () => {
    const { db, agent } = app();
    const deal = await agent({
      operation: "finance.deals.create",
      payload: { business: "tech", title: "Website for a pool company", stage: "lead", currency: "USD" },
    }).expect(201);
    expect(deal.body.item.business).toBe("tech");
    expect(db.prepare("SELECT COUNT(*) AS n FROM record_change_requests").get()).toEqual({ n: 0 });
  });

  it("lets only the signed-in owner change policies and decide changes", async () => {
    const { db, server, owner, cookie } = app();
    await request(server).patch("/api/business/policies/rental").send({ record_changes: "vp" }).expect(403);
    await request(server)
      .patch("/api/business/policies/rental")
      .set("Cookie", cookie)
      .set("x-csrf-token", getCsrfToken())
      .set("x-agent-task-token", "x")
      .send({ record_changes: "vp" })
      .expect(403);
    expect((await request(server).get("/api/business/policies").expect(200)).body.items).toHaveLength(3);
    const saved = await owner("patch", "/api/business/policies/tech", { code_pushes: "owner" }).expect(200);
    expect(saved.body.item).toMatchObject({ business: "tech", code_pushes: "owner" });
    await owner("patch", "/api/business/policies/tech", { code_pushes: "maybe" }).expect(400);

    const queued = queueRecordChange(db, {
      business: "rental",
      resource: "contacts",
      action: "delete",
      targetId: "c-rental",
    });
    await request(server).post(`/api/record-changes/${queued.id}/decide`).send({ approve: false }).expect(403);
    const denied = await owner("post", `/api/record-changes/${queued.id}/decide`, { approve: false }).expect(200);
    expect(denied.body.item).toMatchObject({ status: "denied", decided_by: "owner" });
    await owner("post", `/api/record-changes/${queued.id}/decide`, { approve: true }).expect(409);
    await owner("post", "/api/record-changes/missing/decide", { approve: true }).expect(404);
  });
});
