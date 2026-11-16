import { createOrgRequest, ORG_REQUEST_KINDS, type OrgRequestKind } from "../../org-requests.ts";
import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { PORT, SESSION_AUTH_TOKEN } from "../../../config/runtime.ts";
import { isDirectLocalRequest } from "../../../security/auth.ts";
import { verifyAgentTaskToken } from "../../../security/agent-task-token.ts";
import { createModelUpgradeRequest, type decideModelUpgrade } from "../../model-routing.ts";
import { createSshApprovalRequest, getSshApprovalStatus } from "../../ssh-approvals.ts";
import { SSH_AGENT_ACCESS_SQL } from "../../ssh-access.ts";
import { requestEmailApproval, getEmailApprovalStatus } from "./business-email.ts";
import { listAgentMailboxes } from "./business-mailboxes.ts";
import { isBusinessKey } from "../../businesses.ts";
import {
  createListing,
  ensureListingSchema,
  getListing,
  listingsOverview,
  submitListing,
  updateListing,
} from "../../listings.ts";
import { listSocialAccountsForAgent, listInstagramMediaForAgent } from "./business-social.ts";
import {
  createDeal,
  updateDeal,
  createSpendRequest,
  financeOverview,
  ensureFinanceSchema,
} from "../../finance-store.ts";

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
export function registerAgentToolRoutes(app: Express, db: DatabaseSync, _runDirector: DirectorRun): void {
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
      if (typeof operation === "string" && operation.startsWith("finance.")) {
        ensureFinanceSchema(db);
        if (operation === "finance.read") {
          if (body.business !== undefined && !isBusinessKey(body.business))
            return res.status(400).json({ error: "invalid_business" });
          return res.json({
            ok: true,
            ...financeOverview(db, { business: typeof body.business === "string" ? body.business : undefined }),
          });
        }
        const payload =
          body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
            ? (body.payload as Record<string, unknown>)
            : {};
        if (operation === "finance.request_spend") {
          const allowed = ["business", "opportunity_id", "amount_minor", "currency", "purpose"];
          if (Object.keys(payload).some((key) => !allowed.includes(key)))
            return res.status(400).json({ error: "finance_protected_field" });
          const item = createSpendRequest(db, { ...payload, agent_id: claims.agentId, task_id: claims.taskId });
          return res.status(201).json({ ok: true, item });
        }
        if (operation === "finance.deals.create" || operation === "finance.deals.update") {
          const allowed = [
            "business",
            "contact_id",
            "project_id",
            "opportunity_id",
            "title",
            "stage",
            "expected_amount_minor",
            "currency",
            "notes",
            "generated_at",
            "ordered_at",
          ];
          if (payload.stage === "paid" || Object.keys(payload).some((key) => !allowed.includes(key)))
            return res.status(403).json({ error: "finance_protected_field" });
          const item =
            operation === "finance.deals.create"
              ? createDeal(db, payload)
              : updateDeal(db, typeof body.id === "string" ? body.id : "", payload);
          return res.status(operation === "finance.deals.create" ? 201 : 200).json({ ok: true, item });
        }
        return res.status(403).json({ error: "finance_operation_forbidden" });
      }
      if (typeof operation === "string" && operation.startsWith("listings.")) {
        ensureListingSchema(db);
        const payload =
          body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
            ? (body.payload as Record<string, unknown>)
            : {};
        const id = typeof body.id === "string" ? body.id : "";
        // Workers prepare and submit their own packages. Approving, publishing and the fee budget are not theirs.
        const own = () => {
          const listing = getListing(db, id);
          if (!listing || listing.agent_id !== claims.agentId) throw new Error("listing_not_found");
          return listing;
        };
        try {
          if (operation === "listings.list") {
            const all = listingsOverview(db, {
              business: typeof body.business === "string" ? body.business : undefined,
              status: typeof body.status === "string" ? body.status : undefined,
            });
            return res.json({ ok: true, items: all.items, fees: all.fees });
          }
          if (operation === "listings.get") return res.json({ ok: true, item: own() });
          if (operation === "listings.create") {
            const item = createListing(db, payload, { agentId: claims.agentId, taskId: claims.taskId });
            return res.status(201).json({ ok: true, item });
          }
          if (operation === "listings.update") {
            own();
            return res.json({ ok: true, item: updateListing(db, id, payload) });
          }
          if (operation === "listings.submit") {
            own();
            return res.json({ ok: true, item: submitListing(db, id) });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "listing_request_failed";
          return res.status(message === "listing_not_found" ? 404 : 400).json({ error: message });
        }
        return res.status(403).json({ error: "listing_operation_forbidden" });
      }
      if (operation === "org.request_status") {
        const request = db
          .prepare("SELECT * FROM org_requests WHERE id=? AND requested_by=?")
          .get(typeof body.request_id === "string" ? body.request_id : "", claims.agentId);
        return request ? res.json({ ok: true, request }) : res.status(404).json({ error: "org_request_not_found" });
      }
      if (operation === "org.request_hire" || operation === "org.request_department") {
        const kind = operation === "org.request_hire" ? "hire_agent" : body.kind;
        if (!ORG_REQUEST_KINDS.includes(kind as OrgRequestKind))
          return res.status(400).json({ error: "org_invalid_kind" });
        const payload =
          body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
            ? (body.payload as Record<string, unknown>)
            : body;
        try {
          const request = createOrgRequest(db, kind as OrgRequestKind, claims.agentId, payload);
          return res.status(201).json({ ok: true, request });
        } catch (error) {
          return res.status(400).json({ error: error instanceof Error ? error.message : "org_request_failed" });
        }
      }
      if (operation === "business.social.accounts") {
        return res.json({ ok: true, items: listSocialAccountsForAgent(db) });
      }
      if (operation === "business.social.media") {
        const accountId = typeof body.account_id === "string" && body.account_id.length <= 128 ? body.account_id : "";
        if (!accountId) return res.status(400).json({ error: "social_account_id_required" });
        const result = await listInstagramMediaForAgent(db, accountId);
        return res
          .status(
            result.ok
              ? 200
              : result.error === "social_account_not_found"
                ? 404
                : result.error === "social_account_not_verified"
                  ? 400
                  : 502,
          )
          .json(result);
      }
      if (operation === "business.email.mailboxes") return res.json({ ok: true, items: listAgentMailboxes(db) });
      if (operation === "business.email.request") {
        const draftId = typeof body.draft_id === "string" && body.draft_id.length <= 128 ? body.draft_id : "";
        if (!draftId) return res.status(400).json({ error: "email_draft_id_required" });
        if (
          "mailbox_id" in body &&
          (typeof body.mailbox_id !== "string" || !body.mailbox_id || body.mailbox_id.length > 128)
        )
          return res.status(400).json({ error: "invalid_mailbox_id" });
        const request = requestEmailApproval(
          db,
          draftId,
          claims.taskId,
          claims.agentId,
          body.mailbox_id as string | undefined,
        );
        return res.status(201).json({ ok: true, request });
      }
      if (operation === "business.email.status") {
        const approvalId =
          typeof body.approval_id === "string" && body.approval_id.length <= 128 ? body.approval_id : "";
        const request = getEmailApprovalStatus(db, approvalId, claims.taskId, claims.agentId);
        return request ? res.json({ ok: true, request }) : res.status(404).json({ error: "email_approval_not_found" });
      }
      if (operation === "business.profiles") {
        const items = db.prepare("SELECT * FROM business_profiles ORDER BY business").all();
        return res.json({ ok: true, items });
      }
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
          if (isBusinessKey(body.business)) query.set("business", body.business);
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
          WHERE ${SSH_AGENT_ACCESS_SQL} AND t.enabled = 1 ORDER BY t.name`,
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
        const request = createModelUpgradeRequest(
          db,
          claims.taskId,
          reason,
          model,
          typeof body.reasoning_level === "string" ? body.reasoning_level : null,
          typeof body.provider === "string" ? body.provider : null,
        );
        return res.status(201).json({ ok: true, request });
      }
      return res.status(400).json({ error: "unknown_agent_operation" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "agent_tool_failed";
      const expected = new Set([
        "agent_task_not_active",
        "email_draft_not_found",
        "email_draft_not_sendable",
        "email_snapshot_already_requested",
        "email_contact_business_mismatch",
        "invalid_recipient_email",
        "invalid_sender_email",
        "invalid_email_content",
        "contact_do_not_contact",
        "mailbox_not_configured",
        "invalid_reason",
        "no_model_upgrade_available",
        "requested_model_not_available",
        "invalid_upgrade_provider",
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
