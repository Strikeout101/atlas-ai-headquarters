import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { behindTheScenes, initiativeDetail, workBoard } from "../../work-views.ts";

/** Read-only views for the Work board, an initiative's page and Behind the scenes (work restructure, phase 7). */
export function registerWorkViewRoutes(app: Express, db: DatabaseSync): void {
  app.get("/api/work/board", (_req, res) => {
    res.json({ ok: true, ...workBoard(db) });
  });
  app.get("/api/work/initiatives/:id", (req, res) => {
    const detail = initiativeDetail(db, String(req.params.id));
    if (!detail) return res.status(404).json({ error: "initiative_not_found" });
    res.json({ ok: true, ...detail });
  });
  app.get("/api/work/agents", (_req, res) => {
    res.json({ ok: true, agents: behindTheScenes(db) });
  });
}
