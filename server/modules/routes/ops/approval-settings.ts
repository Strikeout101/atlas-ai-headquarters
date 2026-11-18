import type { Express, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, requireOwnerSession, shouldRequireCsrf } from "../../../security/auth.ts";
import { ensureBusinessPolicySchema, listBusinessPolicies, saveBusinessPolicy } from "../../business-policies.ts";
import { decideRecordChange, ensureRecordChangeSchema, getRecordChange } from "../../record-changes.ts";

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
  for (const base of ["/api/business/policies", "/api/record-changes"]) {
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
