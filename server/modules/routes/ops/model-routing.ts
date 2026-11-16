import type { Express, Request, Response } from "express";
import type { DatabaseSync } from "node:sqlite";
import { hasValidCsrfToken, shouldRequireCsrf, requireOwnerSession } from "../../../security/auth.ts";
import {
  availableModels,
  createModelUpgradeRequest,
  decideModelUpgrade,
  getTaskModelRoute,
  modelDirectorConfig,
  routeTaskModel,
} from "../../model-routing.ts";

type Db = Pick<DatabaseSync, "exec" | "prepare">;
type DirectorRun = Parameters<typeof routeTaskModel>[2];

function csrf(req: Request, res: Response): boolean {
  if (shouldRequireCsrf(req) && !hasValidCsrfToken(req)) {
    res.status(403).json({ error: "csrf_token_required" });
    return false;
  }
  return true;
}

function failure(res: Response, error: unknown): void {
  const code = error instanceof Error ? error.message : "model_routing_failed";
  const status = code.endsWith("not_found")
    ? 404
    : code === "request_already_decided" || code === "task_assignment_changed"
      ? 409
      : 400;
  res.status(status).json({ error: code });
}

export function registerModelRoutingRoutes(app: Express, db: Db, runDirector: DirectorRun): void {
  app.get("/api/model-director", (_req, res) => {
    const config = modelDirectorConfig(db);
    const directors = db
      .prepare(
        "SELECT id, name, cli_provider, status FROM agents WHERE cli_provider IN ('claude','codex') ORDER BY name",
      )
      .all();
    res.json({ ok: true, ...config, directors });
  });

  app.put("/api/model-director", (req, res) => {
    if (!csrf(req, res)) return;
    const id = req.body?.directorAgentId;
    if (id !== null && (typeof id !== "string" || !id.trim()))
      return res.status(400).json({ error: "invalid_director_agent_id" });
    if (id) {
      const row = db.prepare("SELECT id FROM agents WHERE id = ? AND cli_provider IN ('claude','codex')").get(id);
      if (!row) return res.status(400).json({ error: "director_must_use_claude_or_codex" });
    }
    const raw = req.body?.candidates;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return res.status(400).json({ error: "invalid_model_candidates" });
    const candidates: Record<string, string[]> = {};
    const providers = new Set(["claude", "codex", "gemini", "opencode", "kimi", "copilot", "antigravity", "api"]);
    for (const [provider, models] of Object.entries(raw)) {
      if (
        !providers.has(provider) ||
        !Array.isArray(models) ||
        models.length > 30 ||
        models.some((m) => typeof m !== "string" || !m.trim() || m.length > 120)
      ) {
        return res.status(400).json({ error: "invalid_model_candidates" });
      }
      candidates[provider] = [...new Set(models.map((m) => (m as string).trim()))];
    }
    db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
      "modelDirectorAgentId",
      JSON.stringify(id ?? null),
    );
    db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
      "modelRoutingCandidates",
      JSON.stringify(candidates),
    );
    res.json({ ok: true, directorAgentId: id ?? null, candidates });
  });

  app.get("/api/tasks/:id/model-route", (req, res) => {
    const id = String(req.params.id);
    const task = db.prepare("SELECT id, assigned_agent_id FROM tasks WHERE id = ?").get(id) as
      | { id: string; assigned_agent_id: string | null }
      | undefined;
    if (!task) return res.status(404).json({ error: "task_not_found" });
    const agent = task.assigned_agent_id
      ? (db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as
          | Parameters<typeof availableModels>[1]
          | undefined)
      : undefined;
    const requests = db
      .prepare("SELECT * FROM model_upgrade_requests WHERE task_id = ? ORDER BY created_at DESC")
      .all(id);
    res.json({
      ok: true,
      route: getTaskModelRoute(db, id, task.assigned_agent_id ?? undefined),
      candidates: agent ? availableModels(db, agent) : [],
      requests,
    });
  });

  app.post("/api/tasks/:id/model-route", async (req, res) => {
    if (!csrf(req, res)) return;
    const id = String(req.params.id);
    try {
      const route = await routeTaskModel(db, id, runDirector, req.body?.force === true);
      if (!route) return res.status(409).json({ error: "task_has_no_configured_worker_model" });
      res.json({ ok: true, route });
    } catch (err) {
      failure(res, err);
    }
  });

  app.post("/api/tasks/:id/model-upgrades", async (req, res) => {
    if (!csrf(req, res)) return;
    try {
      const request = createModelUpgradeRequest(
        db,
        String(req.params.id),
        String(req.body?.reason ?? ""),
        req.body?.model,
        req.body?.reasoning_level,
        req.body?.provider,
      );
      res.status(201).json({ ok: true, request });
    } catch (err) {
      failure(res, err);
    }
  });

  app.post("/api/model-upgrades/:id/decide", async (req, res) => {
    if (!requireOwnerSession(req, res)) return;
    if (!csrf(req, res)) return;
    if (typeof req.body?.approve !== "boolean") return res.status(400).json({ error: "approve_boolean_required" });
    try {
      const request = await decideModelUpgrade(
        db,
        String(req.params.id),
        req.body.approve,
        String(req.body?.reason ?? "User decision"),
      );
      res.json({ ok: true, request });
    } catch (err) {
      failure(res, err);
    }
  });
}
