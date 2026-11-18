import type { Express, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { requireOwnerSession, shouldRequireCsrf, hasValidCsrfToken } from "../../../security/auth.ts";
import {
  ensureSquareSchema,
  saveSquareSettings,
  saveSquareMappings,
  squareSettings,
  listSquareConnections,
  createSquareConnection,
  deleteSquareConnection,
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
        : code === "square_connection_not_found"
          ? 404
          : code === "square_connection_has_receipts" || code === "square_business_mapped_in_other_account"
            ? 409
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

  // Several Square accounts (Primrose has its own). The routes above keep working for the first account.
  const connectionId = (req: Request): number => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("square_connection_not_found");
    return id;
  };
  const handle = (res: Response, work: () => unknown | Promise<unknown>) =>
    Promise.resolve()
      .then(work)
      .then((connection) => res.json({ ok: true, connection }))
      .catch((error) => failure(res, error));
  app.get("/api/square/connections", (_req, res) => res.json({ ok: true, connections: listSquareConnections(db) }));
  app.post("/api/square/connections", (req, res) => {
    if (!owner(req, res)) return;
    try {
      res.status(201).json({ ok: true, connection: createSquareConnection(db, req.body ?? {}, deps.now?.()) });
    } catch (error) {
      failure(res, error);
    }
  });
  app.patch("/api/square/connections/:id", (req, res) => {
    if (!owner(req, res)) return;
    void handle(res, () => saveSquareSettings(db, req.body ?? {}, deps.now?.(), connectionId(req)));
  });
  app.put("/api/square/connections/:id/mappings", (req, res) => {
    if (!owner(req, res)) return;
    void handle(res, () => saveSquareMappings(db, req.body?.mappings, deps.now?.(), connectionId(req)));
  });
  app.post("/api/square/connections/:id/test", (req, res) => {
    if (!owner(req, res)) return;
    void handle(res, () => testSquareConnection(db, deps, connectionId(req)));
  });
  app.post("/api/square/connections/:id/sync", async (req, res) => {
    if (!owner(req, res)) return;
    try {
      res.json(await syncSquarePayments(db, deps, connectionId(req)));
    } catch (error) {
      failure(res, error);
    }
  });
  app.delete("/api/square/connections/:id", (req, res) => {
    if (!owner(req, res)) return;
    try {
      deleteSquareConnection(db, connectionId(req));
      res.json({ ok: true });
    } catch (error) {
      failure(res, error);
    }
  });
}
