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
import { ensureBusinessEmailSchema } from "./routes/ops/business-email.ts";
import { ensureAutonomySchema } from "./autonomy-store.ts";
import { createSpendRequest, ensureFinanceSchema } from "./finance-store.ts";
import {
  businessPolicy,
  ensureBusinessPolicySchema,
  resetBusinessPoliciesForTests,
  saveBusinessPolicy,
} from "./business-policies.ts";
import { describeApprovalRules, routeApproval } from "./approval-policy.ts";
import { approvalRoute } from "./approval-review-state.ts";
import { contactFacts } from "./approval-facts.ts";
import { ensureRecordChangeSchema, queueRecordChange, recordChangeNeedsApproval } from "./record-changes.ts";
import { listPendingApprovals } from "./routes/ops/approvals.ts";
import { registerApprovalSettingsRoutes } from "./routes/ops/approval-settings.ts";
import { registerAgentToolRoutes } from "./routes/ops/agent-tools.ts";
import { ensureControlStateSchema, resetControlStateForTests } from "./control-state.ts";
import {
  decideSpendRequestAsVp,
  ensureSpendBudgetSchema,
  listSpendBudgets,
  saveSpendBudget,
  spendFitsBudget,
} from "./spend-budgets.ts";
import { answerTrustOffer, ensureTrustRampSchema, listTrustOffers, recordApprovalDecision } from "./trust-ramp.ts";

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
  ensureBusinessEmailSchema(db);
  ensureAutonomySchema(db);
  ensureFinanceSchema(db);
  ensureBusinessPolicySchema(db);
  ensureRecordChangeSchema(db);
  ensureSpendBudgetSchema(db);
  ensureTrustRampSchema(db);
  db.exec(`INSERT INTO agents (id,name,role,cli_provider) VALUES ('worker','Worker','senior','codex');
    INSERT INTO tasks (id,title,status,assigned_agent_id) VALUES ('task-1','Follow up leads','in_progress','worker');
    INSERT INTO business_contacts (id,business,name,email,tier,created_at,updated_at) VALUES
      ('c-normal','ventures','Norm','norm@example.com','normal',1,1),
      ('c-vip','ventures','Vera','vera@example.com','vip',1,1),
      ('c-important','ventures','Ian','ian@example.com','important',1,1),
      ('c-tech','tech','Dana','dana@example.com','normal',1,1);`);
  return db;
}

function addEmail(db: DatabaseSync, id: string, contactId: string, body: string) {
  db.prepare(
    `INSERT INTO business_drafts (id,business,contact_id,channel,purpose,subject,body,status,created_at,updated_at)
     VALUES (?,?,?,'email','follow_up','Hello',?,'ready',1,1)`,
  ).run(`d-${id}`, "ventures", contactId, body);
  db.prepare(
    `INSERT INTO business_email_approvals (id,draft_id,task_id,agent_id,business,sender,recipient,subject,body,status,
      snapshot_sha256,draft_sha256,contact_sha256,mailbox_sha256,created_at,message_id)
     VALUES (?,?,?,?,?,?,?,?,?,'pending','s','d','c','m',?,?)`,
  ).run(id, `d-${id}`, "task-1", "worker", "ventures", "office@example.com", "x@example.com", "Hello", body, 1, id);
}

describe("client tier and deal size", () => {
  it("sends important clients and big deals to the owner even when the VPs or no one would approve", () => {
    const facts = { clientTier: "normal", amountMinor: 50_000, amountCurrency: "USD" };
    expect(routeApproval("business_email", "ventures", facts)).toBe("vp");
    expect(routeApproval("business_email", "ventures", { ...facts, clientTier: "important" })).toBe("owner");
    expect(routeApproval("business_email", "ventures", { ...facts, clientTier: "vip" })).toBe("owner");
    expect(routeApproval("record_change", "tech", { ...facts, amountMinor: 100_000 })).toBe("owner");
    expect(routeApproval("record_change", "tech", { ...facts, amountMinor: 99_999 })).toBe("vp");
    // An amount in another currency cannot be compared with the limit, so it goes to the owner.
    expect(routeApproval("business_email", "ventures", { ...facts, amountCurrency: "EUR" })).toBe("owner");
    // An unknown tier fails closed.
    expect(routeApproval("business_email", "ventures", { ...facts, clientTier: "gold" })).toBe("owner");
  });

  it("follows the owner's limit and tier settings", () => {
    const db = harness();
    saveBusinessPolicy(db, "ventures", { tier_to_owner: "vip", owner_amount_minor: 0 });
    expect(routeApproval("business_email", "ventures", { clientTier: "important", amountMinor: 9_000_000 })).toBe("vp");
    expect(routeApproval("business_email", "ventures", { clientTier: "vip" })).toBe("owner");
    saveBusinessPolicy(db, "ventures", { tier_to_owner: "off" });
    expect(routeApproval("business_email", "ventures", { clientTier: "vip" })).toBe("vp");
    expect(() => saveBusinessPolicy(db, "ventures", { owner_amount_minor: -1 })).toThrow("invalid_owner_amount");
    expect(() => saveBusinessPolicy(db, "ventures", { tier_to_owner: "all" })).toThrow("invalid_tier_to_owner");
    expect(describeApprovalRules("ventures")).toContain("Client tier does not change who approves");
  });

  it("reads the largest open deal or quote of a contact", () => {
    const db = harness();
    db.exec(`INSERT INTO deals (id,business,contact_id,title,stage,expected_amount_minor,currency,created_at,updated_at) VALUES
      ('d1','ventures','c-normal','Small','lead',20000,'USD',1,1),
      ('d2','ventures','c-normal','Big','proposal',150000,'USD',1,1),
      ('d3','ventures','c-normal','Lost','lost',900000,'USD',1,1)`);
    expect(contactFacts(db, "c-normal")).toEqual({ clientTier: "normal", amountMinor: 150000, amountCurrency: "USD" });
  });
});

describe("structured facts instead of words", () => {
  it("lets the VPs approve a normal customer email that mentions paying, but not one to a VIP", () => {
    const db = harness();
    addEmail(db, "e-normal", "c-normal", "Thanks! You can pay at pickup or buy the add-on later.");
    addEmail(db, "e-vip", "c-vip", "Thanks! You can pay at pickup.");
    const items = listPendingApprovals(db, 100, "all");
    const normal = items.find((item) => item.id === "e-normal")!;
    const vip = items.find((item) => item.id === "e-vip")!;
    expect(normal.client_tier).toBe("normal");
    expect(approvalRoute(normal)).toBe("vp");
    expect(approvalRoute(vip)).toBe("owner");
    expect(listPendingApprovals(db).map((item) => item.id)).toEqual(["e-vip"]);
  });

  it("re-routes an email when its contact becomes VIP", () => {
    const db = harness();
    addEmail(db, "e1", "c-normal", "Hello");
    expect(approvalRoute(listPendingApprovals(db, 100, "all")[0])).toBe("vp");
    db.exec("UPDATE business_contacts SET tier='vip' WHERE id='c-normal'");
    expect(approvalRoute(listPendingApprovals(db, 100, "all")[0])).toBe("owner");
  });
});

describe("record changes with client and amount facts", () => {
  it("holds a change under a no-approval policy when it touches a VIP or a big deal", () => {
    const db = harness();
    const change = (target: string, payload: Record<string, unknown>) =>
      recordChangeNeedsApproval(db, "ventures", { resource: "contacts", target_id: target, payload });
    expect(businessPolicy("ventures").record_changes).toBe("none");
    expect(change("c-normal", { phone: "1" })).toBe(false);
    expect(change("c-vip", { phone: "1" })).toBe(true);
    expect(
      recordChangeNeedsApproval(db, "ventures", {
        resource: "deals",
        target_id: null,
        payload: { business: "ventures", contact_id: "c-normal", expected_amount_minor: 250000, currency: "USD" },
      }),
    ).toBe(true);
  });

  it("always sends a client tier change by an agent to the owner", async () => {
    const db = harness();
    const server = express();
    server.use(express.json());
    registerAgentToolRoutes(server, db, vi.fn());
    const response = await request(server)
      .post("/api/agent-tools")
      .set("x-agent-task-token", createAgentTaskToken("task-1", "worker"))
      .send({ operation: "business", resource: "contacts", action: "update", id: "c-vip", payload: { tier: "normal" } })
      .expect(202);
    expect(response.body.pending).toBe(true);
    const [item] = listPendingApprovals(db, 100, "all");
    expect(item).toMatchObject({ kind: "record_change", changes_client_tier: true });
    expect(approvalRoute(item)).toBe("owner");
    expect(db.prepare("SELECT tier FROM business_contacts WHERE id='c-vip'").get()).toEqual({ tier: "vip" });
  });

  it("queues with the facts attached so the approval row shows them", () => {
    const db = harness();
    queueRecordChange(db, {
      business: "ventures",
      resource: "contacts",
      action: "update",
      targetId: "c-important",
      payload: { notes: "x" },
      agentId: "worker",
      taskId: "task-1",
    });
    const [item] = listPendingApprovals(db, 100, "all");
    expect(item.client_tier).toBe("important");
    expect(approvalRoute(item)).toBe("owner");
  });
});

describe("spending budgets", () => {
  it("start at zero, so every spend request still goes to the owner", () => {
    const db = harness();
    createSpendRequest(db, {
      business: "ventures",
      amount_minor: 500,
      currency: "USD",
      purpose: "Font",
      category: "software",
    });
    const [item] = listPendingApprovals(db, 100, "all");
    expect(item).toMatchObject({ kind: "spend_request", category: "software", within_spend_budget: false });
    expect(approvalRoute(item)).toBe("owner");
    expect(listSpendBudgets(db).every((budget) => budget.monthly_cap_minor === 0)).toBe(true);
  });

  it("lets the VPs approve within the per-item limit and the month's budget, then stops", () => {
    const db = harness();
    const now = Date.UTC(2026, 10, 18, 15);
    saveSpendBudget(
      db,
      { business: "ventures", category: "software", monthly_cap_minor: 1000, per_item_cap_minor: 600 },
      now,
    );
    const ask = (amount: number) =>
      createSpendRequest(db, {
        business: "ventures",
        amount_minor: amount,
        currency: "USD",
        purpose: `P${amount}`,
        category: "software",
      });
    const big = ask(700);
    expect(spendFitsBudget(db, big, now)).toBe(false);
    const first = ask(600);
    expect(spendFitsBudget(db, first, now)).toBe(true);
    decideSpendRequestAsVp(db, String(first.id), true, "vp:codex", now);
    const second = ask(500);
    expect(spendFitsBudget(db, second, now)).toBe(false);
    expect(() => decideSpendRequestAsVp(db, String(second.id), true, "vp:codex", now)).toThrow(
      "spend_over_budget_owner_required",
    );
    expect(() => decideSpendRequestAsVp(db, String(second.id), true, "owner", now)).toThrow("vp_decision_required");
    expect(spendFitsBudget(db, { ...ask(100), currency: "EUR" }, now)).toBe(false);
    expect(() =>
      saveSpendBudget(db, {
        business: "ventures",
        category: "software",
        monthly_cap_minor: 100,
        per_item_cap_minor: 200,
      }),
    ).toThrow("per_item_cap_above_monthly_cap");
    expect(routeApproval("spend_request", "ventures", { withinSpendBudget: true, agreesToTerms: true })).toBe("owner");
  });
});

describe("trust ramp", () => {
  it("offers to hand a kind to the VPs after enough owner approvals in a row, and never applies it alone", () => {
    const db = harness();
    saveBusinessPolicy(db, "rental", { trust_ramp_after: 3 });
    const decide = (approve: boolean, decidedBy = "owner") =>
      recordApprovalDecision(db, {
        approvalKind: "record_change",
        business: "rental",
        agentId: "worker",
        approve,
        decidedBy,
      });
    decide(true);
    decide(true);
    decide(false);
    decide(true);
    decide(true);
    decide(true, "vp:codex");
    expect(listTrustOffers(db)).toEqual([]);
    decide(true);
    const [offer] = listTrustOffers(db);
    expect(offer).toMatchObject({ business: "rental", kind: "record_changes", streak: 3, approved: 6, denied: 1 });
    expect(offer.agents[0]).toMatchObject({ agent_id: "worker", approved: 6 });
    expect(businessPolicy("rental").record_changes).toBe("owner");

    answerTrustOffer(db, "rental", "record_changes", false);
    expect(listTrustOffers(db)).toEqual([]);
    for (let i = 0; i < 3; i += 1) decide(true);
    expect(listTrustOffers(db)).toHaveLength(1);
    answerTrustOffer(db, "rental", "record_changes", true);
    expect(businessPolicy("rental").record_changes).toBe("vp");
    expect(listTrustOffers(db)).toEqual([]);
  });

  it("does not track hard-floor kinds and respects 0 as off", () => {
    const db = harness();
    saveBusinessPolicy(db, "tech", { trust_ramp_after: 0 });
    for (let i = 0; i < 30; i += 1) {
      recordApprovalDecision(db, {
        approvalKind: "spend_request",
        business: "tech",
        approve: true,
        decidedBy: "owner",
      });
      recordApprovalDecision(db, {
        approvalKind: "business_email",
        business: "tech",
        approve: true,
        decidedBy: "owner",
      });
    }
    expect(db.prepare("SELECT DISTINCT kind FROM approval_track_record").all()).toEqual([{ kind: "customer_sends" }]);
    expect(listTrustOffers(db)).toEqual([]);
  });

  it("serves offers and budgets to the owner only", async () => {
    const db = harness();
    const server = express();
    server.use(express.json());
    registerApprovalSettingsRoutes(server, db);
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`;
    await request(server).put("/api/business/spend-budgets").send({}).expect(403);
    await request(server)
      .get("/api/business/trust-offers")
      .set("x-agent-task-token", createAgentTaskToken("task-1", "worker"))
      .expect(403);
    const saved = await request(server)
      .put("/api/business/spend-budgets")
      .set("Cookie", cookie)
      .set("x-csrf-token", getCsrfToken())
      .send({ business: "tech", category: "hosting", monthly_cap_minor: 2000, per_item_cap_minor: 1000 })
      .expect(200);
    expect(saved.body.item).toMatchObject({ business: "tech", category: "hosting", monthly_cap_minor: 2000 });
    await request(server)
      .post("/api/business/trust-offers/tech/customer_sends")
      .set("Cookie", cookie)
      .set("x-csrf-token", getCsrfToken())
      .send({ accept: true })
      .expect(404);
  });
});
