import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { PORT, SESSION_AUTH_TOKEN } from "../../../config/runtime.ts";
import { isDirectLocalRequest } from "../../../security/auth.ts";
import { verifyAgentTaskToken } from "../../../security/agent-task-token.ts";
import { createModelUpgradeRequest, decideModelUpgrade } from "../../model-routing.ts";
import { createSshApprovalRequest, getSshApprovalStatus } from "../../ssh-approvals.ts";

const BUSINESS_RESOURCES = new Set(["contacts", "tickets", "quotes", "drafts"]);
const BUSINESS_ACTIONS = new Set(["list", "get", "create", "update", "delete"]);

type DirectorRun = Parameters<typeof decideModelUpgrade>[4];

async function localApi(method: string, pathname: string, payload?: unknown) {
  const response = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${SESSION_AUTH_TOKEN}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(70_000),
  });
  const result = await response.json().catch(() => ({ error: "invalid_local_response" }));
  return { status: response.status, result };
}

/** Task-scoped local tool gateway. The worker never receives the global API token. */
export function registerAgentToolRoutes(app: Express, db: DatabaseSync, runDirector: DirectorRun): void {
  app.post("/api/agent-tools", async (req, res) => {
    if (!isDirectLocalRequest(req)) return res.status(403).json({ error: "local_only" });
    const token = req.header("x-agent-task-token") ?? "";
    const claims = verifyAgentTaskToken(token);
    if (!claims) return res.status(401).json({ error: "invalid_agent_task_token" });
    const task = db.prepare("SELECT assigned_agent_id, status FROM tasks WHERE id = ?").get(claims.taskId) as
      | { assigned_agent_id: string | null; status: string }
      | undefined;
    if (!task || task.assigned_agent_id !== claims.agentId || task.status !== "in_progress") {
      return res.status(403).json({ error: "agent_task_not_active" });
    }
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
    const operation = body.operation;
    try {
      if (operation === "business") {
        const resource = body.resource;
        const action = body.action;
        if (
          typeof resource !== "string" ||
          !BUSINESS_RESOURCES.has(resource) ||
          typeof action !== "string" ||
          !BUSINESS_ACTIONS.has(action)
        ) {
          return res.status(400).json({ error: "invalid_business_operation" });
        }
        const base = `/api/business/${resource}`;
        const id = typeof body.id === "string" && body.id.length <= 128 ? body.id : null;
        if (["get", "update", "delete"].includes(action) && !id)
          return res.status(400).json({ error: "business_id_required" });
        const query = new URLSearchParams();
        if (action === "list") {
          if (body.business === "tech" || body.business === "rental") query.set("business", body.business);
          if (typeof body.status === "string" && body.status.length <= 40) query.set("status", body.status);
        }
        const path = `${base}${id ? `/${encodeURIComponent(id)}` : ""}${query.size ? `?${query}` : ""}`;
        const method = { list: "GET", get: "GET", create: "POST", update: "PATCH", delete: "DELETE" }[action]!;
        const payload = action === "create" || action === "update" ? body.payload : undefined;
        if (payload !== undefined && JSON.stringify(payload).length > 16_000)
          return res.status(413).json({ error: "business_payload_too_large" });
        const upstream = await localApi(method, path, payload);
        return res.status(upstream.status).json(upstream.result);
      }
      if (operation === "homelab.targets") {
        const targets = db
          .prepare(
            `SELECT t.id, t.name, t.host, t.ssh_user, t.port FROM homelab_ssh_targets t
          JOIN homelab_ssh_grants g ON g.target_id = t.id WHERE g.agent_id = ? AND t.enabled = 1 ORDER BY t.name`,
          )
          .all(claims.agentId);
        return res.json({ ok: true, targets });
      }
      if (operation === "homelab.run") {
        const targetId = typeof body.target_id === "string" && body.target_id.length <= 128 ? body.target_id : null;
        const command = typeof body.command === "string" ? body.command : null;
        const approvalId = typeof body.approval_id === "string" ? body.approval_id : null;
        if (!targetId || !command || !approvalId)
          return res.status(400).json({ error: "target_command_and_approval_required" });
        const upstream = await localApi("POST", `/api/homelab/targets/${encodeURIComponent(targetId)}/run`, {
          command,
          task_id: claims.taskId,
          approval_id: approvalId,
        });
        return res.status(upstream.status).json(upstream.result);
      }
      if (operation === "homelab.request") {
        const targetId = typeof body.target_id === "string" ? body.target_id : "";
        const command = typeof body.command === "string" ? body.command : "";
        const request = createSshApprovalRequest(db, targetId, claims.taskId, claims.agentId, command);
        return res.status(201).json({ ok: true, request });
      }
      if (operation === "homelab.approval_status") {
        const id = typeof body.approval_id === "string" ? body.approval_id : "";
        const request = getSshApprovalStatus(db, id, claims.taskId, claims.agentId);
        return request ? res.json({ ok: true, request }) : res.status(404).json({ error: "approval_not_found" });
      }
      if (operation === "model.request_upgrade") {
        const reason = typeof body.reason === "string" ? body.reason : "";
        const model = typeof body.model === "string" ? body.model : null;
        const request = createModelUpgradeRequest(db, claims.taskId, reason, model);
        const decision = await decideModelUpgrade(db, String(request.id), null, "", runDirector);
        return res.status(201).json({ ok: true, request: decision });
      }
      return res.status(400).json({ error: "unknown_agent_operation" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "agent_tool_failed";
      const expected = new Set([
        "invalid_reason",
        "no_model_upgrade_available",
        "requested_model_not_available",
        "task_or_agent_not_found",
        "invalid_ssh_command",
        "ssh_target_unavailable",
        "ssh_agent_not_granted",
      ]);
      return res
        .status(expected.has(message) ? 400 : 502)
        .json({ error: expected.has(message) ? message : "agent_tool_failed" });
    }
  });
}
