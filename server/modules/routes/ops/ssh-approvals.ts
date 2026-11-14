import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, shouldRequireCsrf } from "../../../security/auth.ts";
import {
  ensureSshApprovalSchema,
  isReadOnlyAutoApprovalEnabled,
  listSshApprovals,
  setReadOnlyAutoApproval,
} from "../../ssh-approvals.ts";

export function registerSshApprovalRoutes(app: Express, db: DatabaseSync): void {
  ensureSshApprovalSchema(db);
  app.get("/api/homelab/approvals", (_req, res) => {
    try {
      return res.json({ ok: true, approvals: listSshApprovals(db) });
    } catch {
      return res.status(503).json({ error: "ssh_credential_key_unavailable" });
    }
  });
  app.post("/api/homelab/approvals/:id/decide", (req, res) => {
    if (shouldRequireCsrf(req) && !hasValidCsrfToken(req))
      return res.status(403).json({ error: "csrf_token_required" });
    if (typeof req.body?.approve !== "boolean") return res.status(400).json({ error: "approve_boolean_required" });
    const status = req.body.approve ? "approved" : "denied";
    const result = db
      .prepare(
        "UPDATE homelab_ssh_approvals SET status = ?, decided_at = ?, decided_by = 'owner' WHERE id = ? AND status = 'pending'",
      )
      .run(status, Date.now(), String(req.params.id));
    if (!result.changes) return res.status(409).json({ error: "approval_not_pending" });
    return res.json({ ok: true, id: String(req.params.id), status });
  });
  app.get("/api/homelab/approval-policy", (_req, res) => {
    return res.json({ ok: true, auto_approve_read_only: isReadOnlyAutoApprovalEnabled(db) });
  });
  app.put("/api/homelab/approval-policy", (req, res) => {
    if (shouldRequireCsrf(req) && !hasValidCsrfToken(req))
      return res.status(403).json({ error: "csrf_token_required" });
    if (typeof req.body?.auto_approve_read_only !== "boolean")
      return res.status(400).json({ error: "auto_approve_read_only_boolean_required" });
    setReadOnlyAutoApproval(db, req.body.auto_approve_read_only);
    return res.json({ ok: true, auto_approve_read_only: req.body.auto_approve_read_only });
  });
}
