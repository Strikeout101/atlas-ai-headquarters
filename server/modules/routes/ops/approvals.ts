import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret } from "../../../oauth/helpers.ts";

/**
 * One list of everything waiting on the owner's approval (including tasks agents suggested), for the Today page.
 * Each item is still decided through its own endpoint (listed in `decide_path`), so approval rules stay in one place.
 */
export type PendingApproval =
  | {
      kind: "business_email";
      id: string;
      created_at: number;
      task_id: string;
      task_title: string | null;
      agent_id: string;
      agent_name: string | null;
      business: "tech" | "rental";
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
    };

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column);
}

export function listPendingApprovals(db: DatabaseSync, limit = 100): PendingApproval[] {
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
        business: row.business as "tech" | "rental",
        sender: String(row.sender),
        recipient: String(row.recipient),
        subject: String(row.subject),
        body: String(row.body),
        decide_path: `/api/business/email-approvals/${encodeURIComponent(id)}/decide`,
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
        `SELECT r.id, r.task_id, r.agent_id, r.requested_model, r.requested_reasoning_level, r.reason, r.created_at,
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

  return items.sort((a, b) => b.created_at - a.created_at).slice(0, limit);
}

export function registerApprovalRoutes(app: Express, db: DatabaseSync): void {
  app.get("/api/approvals", (_req, res) => {
    const items = listPendingApprovals(db);
    res.json({ ok: true, count: items.length, items });
  });
}
