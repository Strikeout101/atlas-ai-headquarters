import type { Express, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, requireOwnerSession, shouldRequireCsrf } from "../../../security/auth.ts";
import { ensureBusinessPolicySchema, listBusinessPolicies, saveBusinessPolicy } from "../../business-policies.ts";
import { decideRecordChange, ensureRecordChangeSchema, getRecordChange } from "../../record-changes.ts";
import { answerTrustOffer, ensureTrustRampSchema, listTrustOffers } from "../../trust-ramp.ts";
import { ensureSpendBudgetSchema, listSpendBudgets, saveSpendBudget } from "../../spend-budgets.ts";

function owner(req: Request, res: Response): boolean {
  if (!requireOwnerSession(req, res)) return false;
  if (shouldRequireCsrf(req) && !hasValidCsrfToken(req)) {
    res.status(403).json({ error: "csrf_token_required" });
    return false;
  }
  return true;
}

/** Per-business approval settings and owner decisions on queued record changes. */
export function registerApprovalSettingsRoutes(
  app: Express,
  db: DatabaseSync,
  broadcast: (event: string, value: unknown) => void = () => {},
): void {
  ensureBusinessPolicySchema(db);
  ensureRecordChangeSchema(db);
  ensureTrustRampSchema(db);
  ensureSpendBudgetSchema(db);
  for (const base of [
    "/api/business/policies",
    "/api/record-changes",
    "/api/business/trust-offers",
    "/api/business/spend-budgets",
  ]) {
    app.use(base, (req, res, next) => {
      if (req.header("x-agent-task-token")) return res.status(403).json({ error: "owner_access_required" });
      next();
    });
  }

  app.get("/api/business/policies", (_req, res) => res.json({ ok: true, items: listBusinessPolicies() }));
  app.patch("/api/business/policies/:business", (req, res) => {
    if (!owner(req, res)) return;
    try {
      const item = saveBusinessPolicy(db, req.params.business, req.body);
      broadcast("approvals_changed", {});
      return res.json({ ok: true, item });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "policy_update_failed" });
    }
  });

  // Trust ramp offers: never applied without the owner's answer.
  app.get("/api/business/trust-offers", (_req, res) => res.json({ ok: true, items: listTrustOffers(db) }));
  app.post("/api/business/trust-offers/:business/:kind", (req, res) => {
    if (!owner(req, res)) return;
    try {
      const result = answerTrustOffer(db, req.params.business, req.params.kind, req.body?.accept);
      broadcast("approvals_changed", {});
      return res.json({ ok: true, ...result, items: listTrustOffers(db) });
    } catch (error) {
      const message = error instanceof Error ? error.message : "trust_offer_failed";
      return res.status(message === "trust_offer_not_found" ? 404 : 400).json({ error: message });
    }
  });

  // Spending budgets: within them the two VPs may approve a spend request; nothing else changes (no money moves).
  app.get("/api/business/spend-budgets", (_req, res) => res.json({ ok: true, items: listSpendBudgets(db) }));
  app.put("/api/business/spend-budgets", (req, res) => {
    if (!owner(req, res)) return;
    try {
      const item = saveSpendBudget(db, req.body);
      broadcast("approvals_changed", {});
      return res.json({ ok: true, item });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "spend_budget_failed" });
    }
  });

  app.get("/api/record-changes/:id", (req, res) => {
    const item = getRecordChange(db, String(req.params.id));
    return item ? res.json({ ok: true, item }) : res.status(404).json({ error: "record_change_not_found" });
  });
  app.post("/api/record-changes/:id/decide", async (req, res) => {
    if (!owner(req, res)) return;
    if (typeof req.body?.approve !== "boolean") return res.status(400).json({ error: "approve_boolean_required" });
    try {
      const item = await decideRecordChange(db, String(req.params.id), req.body.approve, "owner");
      broadcast("approvals_changed", {});
      broadcast("business_records_changed", {});
      return res.json({ ok: true, item });
    } catch (error) {
      const message = error instanceof Error ? error.message : "record_change_failed";
      const status =
        message === "record_change_not_found"
          ? 404
          : message.endsWith("already_decided") || message === "record_changed_since_request"
            ? 409
            : 400;
      return res.status(status).json({ error: message });
    }
  });
}
