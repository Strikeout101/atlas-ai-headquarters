import type { Express, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, requireOwnerSession, shouldRequireCsrf } from "../../../security/auth.ts";
import {
  backupOverview,
  ensureBackupSchema,
  runBackup,
  saveBackupSettings,
  testBackupFolder,
} from "../../db-backups.ts";
import { requestServiceAction, serviceOverview } from "../../service-status.ts";

function owner(req: Request, res: Response): boolean {
  if (!requireOwnerSession(req, res)) return false;
  if (shouldRequireCsrf(req) && !hasValidCsrfToken(req)) {
    res.status(403).json({ error: "csrf_token_required" });
    return false;
  }
  return true;
}

/** Owner-only: the ATLAS service (stable build, updates, restarts) and automatic database backups. */
export function registerSystemRoutes(
  app: Express,
  db: DatabaseSync,
  dbPath: string,
  options: { repoDir?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  ensureBackupSchema(db);
  const repoDir = options.repoDir ?? process.cwd();
  const env = options.env ?? process.env;
  for (const base of ["/api/system", "/api/backups"]) {
    app.use(base, (req, res, next) => {
      if (req.header("x-agent-task-token")) return res.status(403).json({ error: "owner_access_required" });
      // Reads also need the owner: they show file paths and the state of this PC.
      if (!requireOwnerSession(req, res)) return;
      next();
    });
  }

  app.get("/api/system/service", (_req, res) => res.json({ ok: true, ...serviceOverview(repoDir, env) }));
  app.post("/api/system/service/:action", (req, res) => {
    if (!owner(req, res)) return;
    try {
      const request = requestServiceAction(req.params.action, env);
      return res.status(202).json({ ok: true, request });
    } catch (error) {
      const message = error instanceof Error ? error.message : "service_request_failed";
      return res.status(message === "service_not_running" ? 409 : 400).json({ error: message });
    }
  });

  app.get("/api/backups", (_req, res) => res.json({ ok: true, ...backupOverview(db, dbPath) }));
  app.patch("/api/backups/settings", (req, res) => {
    if (!owner(req, res)) return;
    try {
      return res.json({ ok: true, settings: saveBackupSettings(db, req.body) });
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : "backup_settings_failed" });
    }
  });
  app.post("/api/backups/run", (req, res) => {
    if (!owner(req, res)) return;
    const run = runBackup(db, { dbPath, trigger: "manual" });
    return res.status(run.status === "ok" ? 200 : 500).json({ ok: run.status === "ok", run });
  });
  app.post("/api/backups/test-folder", (req, res) => {
    if (!owner(req, res)) return;
    return res.json(testBackupFolder(req.body?.copy_dir));
  });
}
