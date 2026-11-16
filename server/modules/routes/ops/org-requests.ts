import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { requireOwnerSession } from "../../../security/auth.ts";
import { decideOrgRequest, ensureOrgRequestSchema } from "../../org-requests.ts";

export function registerOrgRequestRoutes(
  app: Express,
  db: DatabaseSync,
  broadcast: (event: string, value: unknown) => void,
): void {
  ensureOrgRequestSchema(db);
  app.get("/api/org-requests", (_req, res) => {
    res.json({ ok: true, items: db.prepare("SELECT * FROM org_requests ORDER BY created_at DESC LIMIT 200").all() });
  });
  app.post("/api/org-requests/:id/decide", (req, res) => {
    if (!requireOwnerSession(req, res)) return;
    if (typeof req.body?.approve !== "boolean") return res.status(400).json({ error: "approve_boolean_required" });
    try {
      const request = decideOrgRequest(db, String(req.params.id), req.body.approve, "owner");
      broadcast("departments_changed", {});
      broadcast("agents_changed", {});
      res.json({ ok: true, request });
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : "org_decision_failed" });
    }
  });
}
