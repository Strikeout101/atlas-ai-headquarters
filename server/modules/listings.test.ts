import express from "express";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBaseSchema } from "./bootstrap/schema/base-schema.ts";
import { SESSION_COOKIE_NAME } from "../config/runtime.ts";
import { getCsrfToken } from "../security/auth.ts";
import { createAgentTaskToken } from "../security/agent-task-token.ts";
import { createSessionToken } from "../security/login-sessions.ts";
import { approvalRoute } from "./approval-review-state.ts";
import { routeApproval } from "./approval-policy.ts";
import { ensureAutonomySchema } from "./autonomy-store.ts";
import { ensureControlStateSchema, resetControlStateForTests } from "./control-state.ts";
import { ensureFinanceSchema } from "./finance-store.ts";
import {
  createListing,
  decideListing,
  feeBudget,
  feeBudgetMonth,
  listingApprover,
  markListingPublished,
  setFeeBudget,
  submitListing,
  updateListing,
  withdrawListing,
} from "./listings.ts";
import { registerAgentToolRoutes } from "./routes/ops/agent-tools.ts";
import { listPendingApprovals } from "./routes/ops/approvals.ts";
import { ensureBusinessSchema } from "./routes/ops/business.ts";
import { registerListingRoutes } from "./routes/ops/listings.ts";
import { executeVpApproval } from "./vp-execution.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  resetControlStateForTests();
});

const NOW = Date.UTC(2026, 10, 16, 15);
const pack = {
  business: "ventures",
  platform: "etsy",
  title: "Minimal budget planner (printable PDF)",
  description: "A one-page monthly budget planner. Buy once, print as often as you like.",
  tags: ["planner", "budget", "printable"],
  price_minor: 450,
  currency: "USD",
  files: ["products/budget-planner/planner.pdf"],
  mockups: ["products/budget-planner/mockup-1.png"],
  notes: "Original work made in this task.",
  taxonomy_id: 2078,
};

function harness() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  applyBaseSchema(db);
  ensureControlStateSchema(db);
  ensureBusinessSchema(db);
  ensureAutonomySchema(db);
  ensureFinanceSchema(db);
  db.exec(`INSERT INTO agents (id,name,role,cli_provider) VALUES ('maker','Maker','senior','codex'),('other','Other','senior','codex');
    INSERT INTO tasks (id,title,status,assigned_agent_id) VALUES ('task-1','Make planner','in_progress','maker'),
      ('task-2','Other work','in_progress','other');`);
  const ready = (overrides: Record<string, unknown> = {}) =>
    submitListing(
      db,
      createListing(db, { ...pack, ...overrides }, { agentId: "maker", taskId: "task-1" }, NOW).id,
      NOW,
    );
  const pending = () => listPendingApprovals(db, 100, "all").filter((item) => item.kind === "listing_publish");
  return { db, ready, pending };
}

describe("listing packages", () => {
  it("starts as a draft with the platform's fee, and only a complete draft can be submitted", () => {
    const { db } = harness();
    const draft = createListing(db, { business: "ventures", platform: "etsy", title: "Planner" }, {}, NOW);
    expect(draft).toMatchObject({ status: "draft", fee_minor: 20, fee_currency: "USD", tags: [], files: [] });
    expect(() => submitListing(db, draft.id, NOW)).toThrow("listing_incomplete");
    const complete = updateListing(
      db,
      draft.id,
      { description: "A planner", price_minor: 450, files: ["out/planner.pdf"] },
      NOW,
    );
    expect(complete.title).toBe("Planner");
    // Etsy needs a category before it can be submitted.
    expect(() => submitListing(db, draft.id, NOW)).toThrow("listing_taxonomy_required");
    updateListing(db, draft.id, { taxonomy_id: 2078 }, NOW);
    expect(submitListing(db, draft.id, NOW)).toMatchObject({ status: "ready", submitted_at: NOW });
    expect(createListing(db, { ...pack, platform: "itch" }, {}, NOW).fee_minor).toBe(0);
  });

  it("freezes the content once it is submitted", () => {
    const { db, ready } = harness();
    const listing = ready();
    expect(() => updateListing(db, listing.id, { price_minor: 1 }, NOW)).toThrow("listing_not_editable");
    expect(() => submitListing(db, listing.id, NOW)).toThrow("listing_not_editable");
  });

  it("refuses fields a worker must not set, bad platforms, and file paths that leave the project", () => {
    const { db } = harness();
    for (const extra of [{ status: "published" }, { fee_minor: 0 }, { decided_by: "owner" }, { listing_url: "x" }])
      expect(() => createListing(db, { ...pack, ...extra }, {}, NOW)).toThrow("listing_protected_field");
    expect(() => createListing(db, { ...pack, platform: "amazon" }, {}, NOW)).toThrow("invalid_platform");
    expect(() => createListing(db, { ...pack, business: "elsewhere" }, {}, NOW)).toThrow("invalid_business");
    for (const files of [["../secrets.txt"], ["C:/Users/owner/file.pdf"], ["/etc/passwd"], ["a/../../b.pdf"]])
      expect(() => createListing(db, { ...pack, files }, {}, NOW)).toThrow("invalid_files");
    expect(() =>
      createListing(
        db,
        {
          ...pack,
          tags: Array(14)
            .fill("t")
            .map((t, i) => t + i),
        },
        {},
        NOW,
      ),
    ).toThrow("invalid_tags");
    expect(() => createListing(db, { ...pack, price_minor: 4.5 }, {}, NOW)).toThrow("invalid_price_minor");
  });
});

describe("who approves a listing", () => {
  it("sends every fee to the owner until a monthly budget is set", () => {
    const { db, ready } = harness();
    const etsy = ready();
    expect(feeBudget(db, NOW)).toMatchObject({ monthly_cap_minor: 0, used_minor: 0, remaining_minor: 0 });
    expect(listingApprover(db, etsy, NOW)).toBe("owner");
    // itch.io costs nothing, so there is no spend for the owner to approve.
    expect(listingApprover(db, ready({ platform: "itch", title: "Icon pack" }), NOW)).toBe("vp");
  });

  it("lets the VPs approve inside the budget and hands back to the owner once it is used up", () => {
    const { db, ready, pending } = harness();
    setFeeBudget(db, 40, NOW);
    const [first, second, third] = [ready({ title: "One" }), ready({ title: "Two" }), ready({ title: "Three" })];
    expect(pending().every((item) => approvalRoute(item) === "vp")).toBe(true);

    decideListing(db, first.id, true, "vp:a,b", "Original and complete", NOW);
    decideListing(db, second.id, true, "vp:a,b", "", NOW);
    expect(feeBudget(db, NOW)).toMatchObject({ used_minor: 40, remaining_minor: 0 });

    // The third no longer fits: the VPs are refused and it shows up for the owner instead.
    expect(() => decideListing(db, third.id, true, "vp:a,b", "", NOW)).toThrow("owner_approval_required");
    expect(listingApprover(db, third, NOW)).toBe("owner");
    const [item] = pending();
    expect(item).toMatchObject({ id: third.id, fee_over_budget: true });
    expect(approvalRoute(item)).toBe("owner");
    expect(listPendingApprovals(db).map((entry) => entry.id)).toContain(third.id);
    expect(decideListing(db, third.id, true, "owner", "", NOW)).toMatchObject({
      status: "approved",
      decided_by: "owner",
    });
  });

  it("starts a fresh allowance each month", () => {
    const { db, ready } = harness();
    setFeeBudget(db, 20, NOW);
    decideListing(db, ready({ title: "November" }).id, true, "vp:a,b", "", NOW);
    expect(feeBudget(db, NOW).remaining_minor).toBe(0);
    const december = Date.UTC(2026, 11, 2, 15);
    expect(feeBudgetMonth(december)).toBe("2026-12");
    expect(feeBudget(db, december)).toMatchObject({ used_minor: 0, remaining_minor: 20 });
  });

  it("never lets the VPs approve listings for the businesses the owner runs", () => {
    const { db, ready, pending } = harness();
    setFeeBudget(db, 1000, NOW);
    const tech = ready({ business: "tech", platform: "itch", title: "Tech checklist" });
    expect(listingApprover(db, tech, NOW)).toBe("owner");
    expect(approvalRoute(pending()[0])).toBe("owner");
    expect(() => decideListing(db, tech.id, true, "vp:a,b", "", NOW)).toThrow("owner_approval_required");
    expect(routeApproval("listing_publish", "rental", {})).toBe("owner");
    expect(routeApproval("listing_publish", "ventures", { spendsMoney: true })).toBe("owner");
    expect(routeApproval("listing_publish", "ventures", {})).toBe("vp");
  });

  it("does not mistake product copy for a spend, but fails closed without the server's fee check", () => {
    const { db, ready, pending } = harness();
    setFeeBudget(db, 100, NOW);
    ready({ description: "Buy this planner. Instant download after purchase and payment." });
    const [item] = pending();
    expect(item.fee_over_budget).toBe(false);
    expect(approvalRoute(item)).toBe("vp");
    const { fee_over_budget: _dropped, ...withoutFact } = item as Record<string, unknown>;
    expect(approvalRoute(withoutFact as never)).toBe("owner");
  });

  it("only accepts the owner or the VPs as deciders, and one decision per package", () => {
    const { db, ready } = harness();
    setFeeBudget(db, 100, NOW);
    const listing = ready();
    expect(() => decideListing(db, listing.id, true, "agent:maker", "", NOW)).toThrow("listing_decider_forbidden");
    expect(decideListing(db, listing.id, false, "vp:a,b", "Tags are misleading", NOW)).toMatchObject({
      status: "rejected",
      decision_reason: "Tags are misleading",
    });
    expect(() => decideListing(db, listing.id, true, "owner", "", NOW)).toThrow("listing_already_decided");
    expect(feeBudget(db, NOW).used_minor).toBe(0);
  });

  it("runs a VP approval through the same checks as every other VP decision", async () => {
    const { db, ready, pending } = harness();
    setFeeBudget(db, 20, NOW);
    const listing = ready();
    const broadcast = vi.fn();
    await executeVpApproval(db, pending()[0], true, "vp:atlas-vp-codex,atlas-vp-claude", "Original work", {
      broadcast,
    });
    expect(db.prepare("SELECT status, decided_by FROM listing_packages WHERE id=?").get(listing.id)).toEqual({
      status: "approved",
      decided_by: "vp:atlas-vp-codex,atlas-vp-claude",
    });
    expect(broadcast).toHaveBeenCalledWith("listings_changed", {});
    // A second package now exceeds the month's budget, so the VP path refuses it.
    ready({ title: "Second" });
    await expect(executeVpApproval(db, pending()[0], true, "vp:a,b", "", {})).rejects.toThrow("vp_execution_forbidden");
  });
});

describe("publishing and withdrawing", () => {
  it("records the live address and the fee as an unverified cost, once", () => {
    const { db, ready } = harness();
    const listing = ready({ opportunity_id: null });
    expect(() => markListingPublished(db, listing.id, "https://www.etsy.com/listing/1", NOW)).toThrow(
      "listing_not_approved",
    );
    decideListing(db, listing.id, true, "owner", "", NOW);
    for (const url of ["http://www.etsy.com/listing/1", "javascript:alert(1)", "https://user:pw@etsy.com/x", ""])
      expect(() => markListingPublished(db, listing.id, url, NOW)).toThrow(/invalid_listing_url/);
    expect(markListingPublished(db, listing.id, "https://www.etsy.com/listing/123/planner", NOW)).toMatchObject({
      status: "published",
      listing_url: "https://www.etsy.com/listing/123/planner",
      published_at: NOW,
    });
    expect(db.prepare("SELECT business,kind,amount_minor,currency,source,verified FROM ledger_entries").all()).toEqual([
      { business: "ventures", kind: "expense", amount_minor: 20, currency: "USD", source: "manual", verified: 0 },
    ]);
    expect(() => markListingPublished(db, listing.id, "https://www.etsy.com/listing/123", NOW)).toThrow(
      "listing_not_approved",
    );
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get()).toEqual({ n: 1 });
  });

  it("records no cost for a free platform, and frees the budget when an approval is withdrawn", () => {
    const { db, ready } = harness();
    setFeeBudget(db, 20, NOW);
    const itch = ready({ platform: "itch", title: "Icon pack" });
    decideListing(db, itch.id, true, "vp:a,b", "", NOW);
    markListingPublished(db, itch.id, "https://maker.itch.io/icon-pack", NOW);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get()).toEqual({ n: 0 });

    const etsy = ready();
    decideListing(db, etsy.id, true, "vp:a,b", "", NOW);
    expect(feeBudget(db, NOW).remaining_minor).toBe(0);
    expect(withdrawListing(db, etsy.id, NOW).status).toBe("withdrawn");
    expect(feeBudget(db, NOW).remaining_minor).toBe(20);
    expect(() => withdrawListing(db, itch.id, NOW)).toThrow("listing_not_withdrawable");
  });
});

describe("owner routes", () => {
  function routes() {
    const h = harness();
    const app = express();
    app.use(express.json());
    registerListingRoutes(app, h.db);
    const cookie = `${SESSION_COOKIE_NAME}=${createSessionToken("password")}`;
    const send = (method: "post" | "put" | "patch", path: string, body: Record<string, unknown> = {}) =>
      request(app)[method](`/api/listings${path}`).set("Cookie", cookie).set("x-csrf-token", getCsrfToken()).send(body);
    return { ...h, app, send, cookie };
  }

  it("requires the signed-in owner for every change and refuses agents", async () => {
    const { app, db, ready, cookie } = routes();
    const listing = ready();
    for (const [method, path, body] of [
      ["put", "/budget", { monthly_cap_minor: 5000 }],
      ["post", `/${listing.id}/decide`, { approve: true }],
      ["post", `/${listing.id}/published`, { listing_url: "https://www.etsy.com/listing/1" }],
      ["post", `/${listing.id}/withdraw`, {}],
    ] as const) {
      await request(app)[method](`/api/listings${path}`).send(body).expect(403);
      await request(app)
        [method](`/api/listings${path}`)
        .set("Cookie", cookie)
        .set("x-csrf-token", getCsrfToken())
        .set("x-agent-task-token", "anything")
        .send(body)
        .expect(403);
    }
    expect(feeBudget(db).monthly_cap_minor).toBe(0);
    expect(db.prepare("SELECT status FROM listing_packages WHERE id=?").get(listing.id)).toEqual({ status: "ready" });
  });

  it("sets the budget, approves, publishes and reports it all back", async () => {
    const { app, ready, send } = routes();
    const listing = ready();
    await send("put", "/budget", { monthly_cap_minor: 1000 }).expect(200);
    await send("put", "/budget", { monthly_cap_minor: -1 }).expect(400);
    await send("put", "/budget", { monthly_cap_minor: 10_000_000 }).expect(400);
    await send("post", `/${listing.id}/decide`, { approve: "yes" }).expect(400);
    await send("post", `/${listing.id}/decide`, { approve: true }).expect(200);
    await send("post", `/${listing.id}/decide`, { approve: true }).expect(409);
    await send("post", `/${listing.id}/published`, { listing_url: "https://www.etsy.com/listing/9" }).expect(200);
    await send("post", "/missing/withdraw").expect(404);
    const overview = await request(app).get("/api/listings?business=ventures").expect(200);
    expect(overview.body.items).toHaveLength(1);
    expect(overview.body.items[0]).toMatchObject({ status: "published", decided_by: "owner" });
    expect(overview.body.budget).toMatchObject({ monthly_cap_minor: 1000, used_minor: 20 });
    expect(overview.body.fees.etsy.amount_minor).toBe(20);
    await request(app).get("/api/listings?status=nonsense").expect(400);
  });
});

describe("worker tools", () => {
  function tools() {
    const h = harness();
    const app = express();
    app.use(express.json());
    registerAgentToolRoutes(app, h.db, vi.fn());
    const as = (agent: "maker" | "other") => (data: Record<string, unknown>) =>
      request(app)
        .post("/api/agent-tools")
        .set("x-agent-task-token", createAgentTaskToken(agent === "maker" ? "task-1" : "task-2", agent))
        .send(data);
    return { ...h, maker: as("maker"), other: as("other") };
  }

  it("lets a worker prepare and submit its own package, attributed to its task", async () => {
    const { db, maker } = tools();
    const created = await maker({ operation: "listings.create", payload: pack }).expect(201);
    expect(created.body.item).toMatchObject({ status: "draft", agent_id: "maker", task_id: "task-1", fee_minor: 20 });
    const id = created.body.item.id;
    await maker({ operation: "listings.update", id, payload: { price_minor: 500 } }).expect(200);
    const submitted = await maker({ operation: "listings.submit", id }).expect(200);
    expect(submitted.body.item).toMatchObject({ status: "ready", price_minor: 500 });
    expect((await maker({ operation: "listings.get", id }).expect(200)).body.item.status).toBe("ready");
    expect((await maker({ operation: "listings.list", business: "ventures" }).expect(200)).body.items).toHaveLength(1);
    expect(listPendingApprovals(db, 100, "all").map((item) => item.kind)).toEqual(["listing_publish"]);
  });

  it("cannot approve, publish, change the budget, forge fields or touch another worker's package", async () => {
    const { db, maker, other } = tools();
    const id = (await maker({ operation: "listings.create", payload: pack }).expect(201)).body.item.id;
    await maker({ operation: "listings.create", payload: { ...pack, agent_id: "owner" } }).expect(400);
    await maker({ operation: "listings.update", id, payload: { status: "approved" } }).expect(400);
    await maker({ operation: "listings.update", id, payload: { fee_minor: 0 } }).expect(400);
    for (const operation of ["listings.decide", "listings.published", "listings.budget", "listings.withdraw"])
      await maker({ operation, id, payload: { approve: true, monthly_cap_minor: 99999 } }).expect(403);
    await other({ operation: "listings.update", id, payload: { price_minor: 1 } }).expect(404);
    await other({ operation: "listings.submit", id }).expect(404);
    await other({ operation: "listings.get", id }).expect(404);
    expect(db.prepare("SELECT status, price_minor, fee_minor FROM listing_packages WHERE id=?").get(id)).toEqual({
      status: "draft",
      price_minor: 450,
      fee_minor: 20,
    });
    expect(feeBudget(db).monthly_cap_minor).toBe(0);
  });
});
