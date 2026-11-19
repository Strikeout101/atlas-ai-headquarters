import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret } from "../../../oauth/helpers.ts";
import { isBusinessKey, type BusinessKey } from "../../businesses.ts";
import { getApprovalVpState, isOwnerApproval } from "../../approval-review-state.ts";
import { taskReadFlaggedContent } from "../../content-guard.ts";
import { feeNeedsOwner, getListing } from "../../listings.ts";
import { describeRecordChange, getRecordChange } from "../../record-changes.ts";
import { contactFacts, recordChangeFacts } from "../../approval-facts.ts";
import type { ApprovalFacts } from "../../approval-policy.ts";
import { spendFitsBudget } from "../../spend-budgets.ts";

/**
 * One list of everything waiting on the owner's approval (including tasks agents suggested), for the Today page.
 * Each item is still decided through its own endpoint (listed in `decide_path`), so approval rules stay in one place.
 */
export type PendingApproval = (
  | {
      /** Reviewed work merged into the project's dev branch, waiting for approval to push to GitHub. */
      kind: "code_push";
      id: string;
      created_at: number;
      task_id: string | null;
      task_title: string | null;
      agent_id: string;
      agent_name: string | null;
      business: BusinessKey | null;
      project_id: string;
      project_name: string | null;
      github_repo: string;
      branch: string;
      account_label: string | null;
      account_login: string | null;
      title: string;
      decide_path: string;
    }
  | {
      /** An agent's change to a business record that the business's policy says must be approved first. */
      kind: "record_change";
      id: string;
      created_at: number;
      task_id: string | null;
      task_title: string | null;
      agent_id: string;
      agent_name: string | null;
      business: BusinessKey;
      resource: string;
      action: string;
      target_id: string | null;
      summary: string;
      payload: Record<string, unknown>;
      /** The record as it is now, for an update or delete. */
      current: Record<string, unknown> | null;
      decide_path: string;
    }
  | {
      /** A listing package an agent prepared and wants published on a storefront. */
      kind: "listing_publish";
      id: string;
      created_at: number;
      task_id: string | null;
      task_title: string | null;
      agent_id: string;
      agent_name: string | null;
      business: BusinessKey;
      platform: string;
      title: string;
      description: string;
      tags: string[];
      price_minor: number;
      currency: string;
      files: string[];
      mockups: string[];
      fee_minor: number;
      fee_currency: string;
      /** Worked out by the server: true when this fee does not fit the owner's monthly listing-fee budget. */
      fee_over_budget: boolean;
      decide_path: string;
    }
  | {
      kind: "spend_request";
      id: string;
      created_at: number;
      task_id: string | null;
      task_title: string | null;
      agent_id: string;
      agent_name: string | null;
      business: BusinessKey;
      amount_minor: number;
      currency: string;
      purpose: string;
      opportunity_id: string | null;
      category: string;
      decide_path: string;
    }
  | {
      kind: "business_email";
      id: string;
      created_at: number;
      task_id: string;
      task_title: string | null;
      agent_id: string;
      agent_name: string | null;
      business: BusinessKey;
      sender: string;
      recipient: string;
      subject: string;
      body: string;
      decide_path: string;
    }
  | {
      kind: "ssh_command";
      id: string;
      created_at: number;
      task_id: string;
      task_title: string | null;
      agent_id: string;
      agent_name: string | null;
      target_id: string;
      target_name: string | null;
      target_host: string | null;
      /** The exact command the agent will run. Null when it cannot be decrypted; it must not be approved blind. */
      command: string | null;
      decide_path: string;
    }
  | {
      kind: "model_upgrade";
      id: string;
      created_at: number;
      task_id: string;
      task_title: string | null;
      agent_id: string;
      agent_name: string | null;
      requested_model: string | null;
      requested_provider?: string | null;
      requested_reasoning_level: string | null;
      reason: string;
      decide_path: string;
    }
  | {
      /** A task an agent suggested on its own. There is no task yet; approving creates one. */
      kind: "task_proposal";
      id: string;
      created_at: number;
      task_id: null;
      task_title: null;
      agent_id: string;
      agent_name: string | null;
      title: string;
      description: string;
      reason: string;
      project_id: string | null;
      project_name: string | null;
      decide_path: string;
    }
  | {
      kind: "org_request";
      id: string;
      created_at: number;
      task_id: null;
      task_title: null;
      agent_id: string;
      agent_name: string | null;
      org_kind: string;
      payload: Record<string, unknown>;
      reason: string;
      decide_path: string;
    }
) & {
  /** Routing facts the server reads from records (never from wording); part of the snapshot, so a change re-routes. */
  client_tier?: string | null;
  deal_amount_minor?: number | null;
  deal_currency?: string | null;
  changes_client_tier?: boolean;
  /** Spend requests: true when the request fits the owner's spending budget for its business and category. */
  within_spend_budget?: boolean;
  /** The task behind this request read outside content that tried to give instructions; the owner decides. */
  untrusted_content?: boolean;
  vp_review?: {
    status: string;
    reason: string;
    reviews: Array<{ vp_agent_id: string; verdict: string; reason: string }>;
  } | null;
};

function factFields(facts: ApprovalFacts) {
  return {
    client_tier: facts.clientTier ?? null,
    deal_amount_minor: facts.amountMinor ?? null,
    deal_currency: facts.amountCurrency ?? null,
    ...(facts.changesClientTier ? { changes_client_tier: true } : {}),
  };
}

function emailContactFacts(db: DatabaseSync, draftId: unknown): ApprovalFacts {
  if (typeof draftId !== "string" || !tableExists(db, "business_drafts")) return {};
  const draft = db.prepare("SELECT contact_id FROM business_drafts WHERE id=?").get(draftId) as
    | { contact_id: string | null }
    | undefined;
  return contactFacts(db, draft?.contact_id);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

export function listPendingApprovals(
  db: DatabaseSync,
  limit = 100,
  audience: "owner" | "all" = "owner",
): PendingApproval[] {
  const items: PendingApproval[] = [];
  const hasTasks = tableExists(db, "tasks");
  const hasAgents = tableExists(db, "agents");
  const taskJoin = hasTasks ? "LEFT JOIN tasks t ON t.id = r.task_id" : "";
  const agentJoin = hasAgents ? "LEFT JOIN agents a ON a.id = r.agent_id" : "";
  const taskTitle = hasTasks ? "t.title" : "NULL";
  const agentName = hasAgents ? "a.name" : "NULL";

  if (tableExists(db, "business_email_approvals")) {
    const rows = db
      .prepare(
        `SELECT r.id,r.created_at,r.task_id,r.agent_id,r.business,r.sender,r.recipient,r.subject,r.body,
      ${columnExists(db, "business_email_approvals", "draft_id") ? "r.draft_id" : "NULL AS draft_id"},
      ${taskTitle} AS task_title, ${agentName} AS agent_name FROM business_email_approvals r ${taskJoin} ${agentJoin}
      WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = String(row.id);
      items.push({
        kind: "business_email",
        id,
        created_at: Number(row.created_at),
        task_id: String(row.task_id),
        task_title: (row.task_title as string | null) ?? null,
        agent_id: String(row.agent_id),
        agent_name: (row.agent_name as string | null) ?? null,
        business: row.business as BusinessKey,
        sender: String(row.sender),
        recipient: String(row.recipient),
        subject: String(row.subject),
        body: String(row.body),
        decide_path: `/api/business/email-approvals/${encodeURIComponent(id)}/decide`,
        ...factFields(emailContactFacts(db, row.draft_id)),
      });
    }
  }

  if (tableExists(db, "homelab_ssh_approvals")) {
    const hasTargets = tableExists(db, "homelab_ssh_targets");
    const targetName = hasTargets && columnExists(db, "homelab_ssh_targets", "name") ? "h.name" : "NULL";
    const targetHost = hasTargets && columnExists(db, "homelab_ssh_targets", "host") ? "h.host" : "NULL";
    const rows = db
      .prepare(
        `SELECT r.id, r.task_id, r.agent_id, r.target_id, r.command_enc, r.created_at,
          ${taskTitle} AS task_title, ${agentName} AS agent_name, ${targetName} AS target_name, ${targetHost} AS target_host
        FROM homelab_ssh_approvals r ${taskJoin} ${agentJoin}
        ${hasTargets ? "LEFT JOIN homelab_ssh_targets h ON h.id = r.target_id" : ""}
        WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    for (const row of rows) {
      let command: string | null = null;
      try {
        command = decryptSecret(String(row.command_enc));
      } catch {
        command = null;
      }
      const id = String(row.id);
      items.push({
        kind: "ssh_command",
        id,
        created_at: Number(row.created_at),
        task_id: String(row.task_id),
        task_title: (row.task_title as string | null) ?? null,
        agent_id: String(row.agent_id),
        agent_name: (row.agent_name as string | null) ?? null,
        target_id: String(row.target_id),
        target_name: (row.target_name as string | null) ?? null,
        target_host: (row.target_host as string | null) ?? null,
        command,
        decide_path: `/api/homelab/approvals/${encodeURIComponent(id)}/decide`,
      });
    }
  }

  if (tableExists(db, "model_upgrade_requests")) {
    const rows = db
      .prepare(
        `SELECT r.id, r.task_id, r.agent_id, r.requested_model, ${columnExists(db, "model_upgrade_requests", "requested_provider") ? "r.requested_provider" : "NULL"} AS requested_provider, r.requested_reasoning_level, r.reason, r.created_at,
          ${taskTitle} AS task_title, ${agentName} AS agent_name
        FROM model_upgrade_requests r ${taskJoin} ${agentJoin}
        WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = String(row.id);
      items.push({
        kind: "model_upgrade",
        id,
        created_at: Number(row.created_at),
        task_id: String(row.task_id),
        task_title: (row.task_title as string | null) ?? null,
        agent_id: String(row.agent_id),
        agent_name: (row.agent_name as string | null) ?? null,
        requested_model: (row.requested_model as string | null) ?? null,
        requested_provider: (row.requested_provider as string | null) ?? null,
        requested_reasoning_level: (row.requested_reasoning_level as string | null) ?? null,
        reason: String(row.reason ?? ""),
        decide_path: `/api/model-upgrades/${encodeURIComponent(id)}/decide`,
      });
    }
  }

  if (tableExists(db, "agent_task_proposals")) {
    const hasProjects = tableExists(db, "projects");
    const rows = db
      .prepare(
        `SELECT r.id, r.agent_id, r.project_id, r.title, r.description, r.reason, r.created_at,
          ${agentName} AS agent_name, ${hasProjects ? "p.name" : "NULL"} AS project_name
        FROM agent_task_proposals r ${agentJoin}
        ${hasProjects ? "LEFT JOIN projects p ON p.id = r.project_id" : ""}
        WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = String(row.id);
      items.push({
        kind: "task_proposal",
        id,
        created_at: Number(row.created_at),
        task_id: null,
        task_title: null,
        agent_id: String(row.agent_id),
        agent_name: (row.agent_name as string | null) ?? null,
        title: String(row.title),
        description: String(row.description ?? ""),
        reason: String(row.reason ?? ""),
        project_id: (row.project_id as string | null) ?? null,
        project_name: (row.project_name as string | null) ?? null,
        decide_path: `/api/agent-proposals/${encodeURIComponent(id)}/decide`,
      });
    }
  }

  if (tableExists(db, "org_requests")) {
    const rows = db
      .prepare(
        `SELECT r.*, ${hasAgents ? "a.name" : "NULL"} AS agent_name FROM org_requests r
      ${hasAgents ? "LEFT JOIN agents a ON a.id=r.requested_by" : ""}
      WHERE r.status='pending' ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    for (const row of rows) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(String(row.payload));
      } catch {
        /* corrupt requests stay owner-visible */
      }
      items.push({
        kind: "org_request",
        id: String(row.id),
        created_at: Number(row.created_at),
        task_id: null,
        task_title: null,
        agent_id: String(row.requested_by),
        agent_name: row.agent_name as string | null,
        org_kind: String(row.kind),
        payload,
        reason: String(row.reason ?? payload.reason ?? ""),
        decide_path: `/api/org-requests/${encodeURIComponent(String(row.id))}/decide`,
      });
    }
  }
  if (tableExists(db, "spend_requests")) {
    const rows = db
      .prepare(
        `SELECT r.*,${taskTitle} AS task_title,${agentName} AS agent_name
      FROM spend_requests r ${taskJoin} ${agentJoin} WHERE r.status='pending' ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    for (const row of rows)
      items.push({
        kind: "spend_request",
        id: String(row.id),
        created_at: Number(row.created_at),
        task_id: row.task_id as string | null,
        task_title: row.task_title as string | null,
        agent_id: String(row.agent_id ?? "owner"),
        agent_name: row.agent_name as string | null,
        business: row.business as BusinessKey,
        amount_minor: Number(row.amount_minor),
        currency: String(row.currency),
        purpose: String(row.purpose),
        opportunity_id: row.opportunity_id as string | null,
        category: String(row.category ?? "other"),
        decide_path: `/api/finance/spend-requests/${encodeURIComponent(String(row.id))}/decide`,
        within_spend_budget: spendFitsBudget(db, row),
      });
  }
  if (tableExists(db, "code_push_requests")) {
    const hasProjects = tableExists(db, "projects");
    const hasAccounts = tableExists(db, "github_accounts");
    const rows = db
      .prepare(
        `SELECT r.*, ${taskTitle} AS task_title, ${hasProjects ? "p.name" : "NULL"} AS project_name,
         ${hasAccounts ? "g.label" : "NULL"} AS account_label, ${hasAccounts ? "g.login" : "NULL"} AS account_login,
         ${hasTasks ? "t.assigned_agent_id" : "NULL"} AS agent_id
       FROM code_push_requests r ${taskJoin}
       ${hasProjects ? "LEFT JOIN projects p ON p.id = r.project_id" : ""}
       ${hasAccounts ? "LEFT JOIN github_accounts g ON g.id = r.account_id" : ""}
       WHERE r.status='pending' ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    for (const row of rows)
      items.push({
        kind: "code_push",
        id: String(row.id),
        created_at: Number(row.created_at),
        task_id: (row.task_id as string | null) ?? null,
        task_title: (row.task_title as string | null) ?? null,
        agent_id: String(row.agent_id ?? "owner"),
        agent_name: null,
        business: isBusinessKey(row.business) ? row.business : null,
        project_id: String(row.project_id),
        project_name: (row.project_name as string | null) ?? null,
        github_repo: String(row.github_repo),
        branch: String(row.branch),
        account_label: (row.account_label as string | null) ?? null,
        account_login: (row.account_login as string | null) ?? null,
        title: String(row.title),
        decide_path: `/api/code-pushes/${encodeURIComponent(String(row.id))}/decide`,
      });
  }
  if (tableExists(db, "record_change_requests")) {
    const rows = db
      .prepare(
        `SELECT r.*,${taskTitle} AS task_title,${agentName} AS agent_name
      FROM record_change_requests r ${taskJoin} ${agentJoin} WHERE r.status='pending' ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const request = getRecordChange(db, String(row.id));
      if (!request) continue;
      const table = {
        contacts: "business_contacts",
        tickets: "business_tickets",
        quotes: "business_quotes",
        deals: "deals",
      }[request.resource];
      const current =
        request.target_id && tableExists(db, table)
          ? ((db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(request.target_id) as Record<string, unknown>) ??
            null)
          : null;
      items.push({
        kind: "record_change",
        id: request.id,
        created_at: request.created_at,
        task_id: request.task_id,
        task_title: row.task_title as string | null,
        agent_id: String(request.agent_id ?? "owner"),
        agent_name: row.agent_name as string | null,
        business: request.business,
        resource: request.resource,
        action: request.action,
        target_id: request.target_id,
        summary: describeRecordChange(request),
        payload: request.payload,
        current,
        decide_path: `/api/record-changes/${encodeURIComponent(request.id)}/decide`,
        ...factFields(recordChangeFacts(db, request)),
      });
    }
  }
  if (tableExists(db, "listing_packages")) {
    const rows = db
      .prepare(
        `SELECT r.*,${taskTitle} AS task_title,${agentName} AS agent_name
      FROM listing_packages r ${taskJoin} ${agentJoin} WHERE r.status='ready' ORDER BY r.submitted_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const listing = getListing(db, String(row.id));
      if (!listing) continue;
      items.push({
        kind: "listing_publish",
        id: listing.id,
        created_at: Number(listing.submitted_at ?? listing.updated_at),
        task_id: listing.task_id,
        task_title: row.task_title as string | null,
        agent_id: String(listing.agent_id ?? "owner"),
        agent_name: row.agent_name as string | null,
        business: listing.business,
        platform: listing.platform,
        title: listing.title,
        description: listing.description,
        tags: listing.tags,
        price_minor: listing.price_minor,
        currency: listing.currency,
        files: listing.files,
        mockups: listing.mockups,
        fee_minor: listing.fee_minor,
        fee_currency: listing.fee_currency,
        fee_over_budget: feeNeedsOwner(db, listing),
        decide_path: `/api/listings/${encodeURIComponent(listing.id)}/decide`,
      });
    }
  }
  return items
    .map((item) => (taskReadFlaggedContent(db, item.task_id) ? { ...item, untrusted_content: true } : item))
    .sort((a, b) => b.created_at - a.created_at)
    .filter((item) => audience === "all" || isOwnerApproval(db, item))
    .slice(0, limit)
    .map((item) =>
      audience === "all" ? item : { ...item, vp_review: getApprovalVpState(db, item) as PendingApproval["vp_review"] },
    );
}

export function registerApprovalRoutes(app: Express, db: DatabaseSync): void {
  app.get("/api/approvals", (_req, res) => {
    const items = listPendingApprovals(db);
    res.json({ ok: true, count: items.length, items });
  });
}
