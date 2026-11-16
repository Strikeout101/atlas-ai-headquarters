import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, shouldRequireCsrf, requireOwnerSession } from "../../../security/auth.ts";
import { decideProposal, ensureAgentProposalSchema, type DecideDeps } from "../../agent-proposals.ts";

/** Owner decisions on tasks agents suggested on their own. Listing happens through /api/approvals. */
export function registerAgentProposalRoutes(app: Express, db: DatabaseSync, deps: DecideDeps = {}): void {
  ensureAgentProposalSchema(db);
  app.post("/api/agent-proposals/:id/decide", (req, res) => {
    if (shouldRequireCsrf(req) && !hasValidCsrfToken(req))
      return res.status(403).json({ error: "csrf_token_required" });
    if (!requireOwnerSession(req, res)) return;
    if (typeof req.body?.approve !== "boolean") return res.status(400).json({ error: "approve_boolean_required" });
    const result = decideProposal(db, String(req.params.id), req.body.approve, deps);
    if (!result.ok) return res.status(409).json(result);
    return res.json({ ...result, id: String(req.params.id) });
  });
}
