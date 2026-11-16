import type { Express, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { requireOwnerSession, shouldRequireCsrf, hasValidCsrfToken } from "../../../security/auth.ts";
import {
  ensureSquareSchema,
  saveSquareSettings,
  saveSquareMappings,
  squareSettings,
  syncSquarePayments,
  testSquareConnection,
  type SquareDeps,
} from "../../square-sync.ts";
function owner(req: Request, res: Response): boolean {
  if (!requireOwnerSession(req, res)) return false;
  if (shouldRequireCsrf(req) && !hasValidCsrfToken(req)) {
    res.status(403).json({ error: "csrf_token_required" });
    return false;
  }
  return true;
}
function failure(res: Response, error: unknown): void {
  const code =
    error instanceof Error && /^square_[a-z0-9_]+$/.test(error.message) ? error.message : "square_request_failed";
  const status =
    code === "square_configuration_changed" || code === "square_sync_in_progress"
      ? 409
      : code.startsWith("square_http_") || code === "square_pagination_incomplete"
        ? 502
        : 400;
  res.status(status).json({ error: code });
}
export function registerSquareRoutes(app: Express, db: DatabaseSync, deps: SquareDeps = {}): void {
  ensureSquareSchema(db);
  app.get("/api/square", (_req, res) => res.json({ ok: true, connection: squareSettings(db) }));
  app.patch("/api/square", (req, res) => {
    if (!owner(req, res)) return;
    try {
      res.json({ ok: true, connection: saveSquareSettings(db, req.body ?? {}, deps.now?.()) });
    } catch (error) {
      failure(res, error);
    }
  });
  app.put("/api/square/mappings", (req, res) => {
    if (!owner(req, res)) return;
    try {
      res.json({ ok: true, connection: saveSquareMappings(db, req.body?.mappings, deps.now?.()) });
    } catch (error) {
      failure(res, error);
    }
  });
  app.post("/api/square/test", async (req, res) => {
    if (!owner(req, res)) return;
    try {
      res.json({ ok: true, connection: await testSquareConnection(db, deps) });
    } catch (error) {
      failure(res, error);
    }
  });
  app.post("/api/square/sync", async (req, res) => {
    if (!owner(req, res)) return;
    try {
      res.json(await syncSquarePayments(db, deps));
    } catch (error) {
      failure(res, error);
    }
  });
}
