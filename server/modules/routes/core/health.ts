import type { Express } from "express";
import { PKG_VERSION } from "../../../config/runtime.ts";

/**
 * Health checks (public, no session): the service supervisor, the browser test harness and monitoring call these.
 * They used to live in the upstream auto-updater module, which was removed in the work restructure (phase 8).
 */
export function registerHealthRoutes(app: Express, dbPath: string): void {
  const payload = () => ({ ok: true, version: PKG_VERSION, app: "ATLAS", dbPath });
  app.get("/health", (_req, res) => res.json(payload()));
  app.get("/healthz", (_req, res) => res.json(payload()));
  app.get("/api/health", (_req, res) => res.json(payload()));
}
