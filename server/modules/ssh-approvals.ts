import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret } from "../oauth/helpers.ts";
import { classifySshCommand } from "./ssh-command-policy.ts";

const digest = (command: string) => createHash("sha256").update(command).digest("hex");

export function ensureSshApprovalSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS homelab_ssh_approvals (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    command_enc TEXT NOT NULL,
    command_sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','consumed')),
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    consumed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_homelab_ssh_approvals_status ON homelab_ssh_approvals(status, created_at DESC);`);
  const columns = db.prepare("PRAGMA table_info(homelab_ssh_approvals)").all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === "decided_by")) {
    db.exec("ALTER TABLE homelab_ssh_approvals ADD COLUMN decided_by TEXT");
  }
}

export const AUTO_APPROVE_READ_ONLY_SETTING = "homelabAutoApproveReadOnly";

/** Whether read-only SSH commands run without asking. On unless the owner turned it off. */
export function isReadOnlyAutoApprovalEnabled(db: DatabaseSync): boolean {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(AUTO_APPROVE_READ_ONLY_SETTING) as
      | { value: string }
      | undefined;
    if (!row) return true;
    return JSON.parse(row.value) !== false;
  } catch {
    return true;
  }
}

export function setReadOnlyAutoApproval(db: DatabaseSync, enabled: boolean): void {
  db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(
    AUTO_APPROVE_READ_ONLY_SETTING,
    JSON.stringify(enabled),
  );
}

export function createSshApprovalRequest(
  db: DatabaseSync,
  targetId: string,
  taskId: string,
  agentId: string,
  command: string,
) {
  if (!command.trim() || command.length > 8000 || command.includes("\0")) throw new Error("invalid_ssh_command");
  const target = db.prepare("SELECT enabled FROM homelab_ssh_targets WHERE id = ?").get(targetId) as
    | { enabled: number }
    | undefined;
  if (!target?.enabled) throw new Error("ssh_target_unavailable");
  const grant = db
    .prepare("SELECT 1 FROM homelab_ssh_grants WHERE target_id = ? AND agent_id = ?")
    .get(targetId, agentId);
  if (!grant) throw new Error("ssh_agent_not_granted");
  const id = randomUUID();
  const now = Date.now();
  // Read-only commands are approved on the spot; everything else waits for the owner.
  const autoApprove = isReadOnlyAutoApprovalEnabled(db) && classifySshCommand(command).readOnly;
  const status = autoApprove ? "approved" : "pending";
  db.prepare(
    `INSERT INTO homelab_ssh_approvals
    (id,target_id,task_id,agent_id,command_enc,command_sha256,status,created_at,decided_at,decided_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    targetId,
    taskId,
    agentId,
    encryptSecret(command),
    digest(command),
    status,
    now,
    autoApprove ? now : null,
    autoApprove ? "auto_read_only" : null,
  );
  return {
    id,
    target_id: targetId,
    task_id: taskId,
    agent_id: agentId,
    status,
    auto_approved: autoApprove,
    created_at: now,
  };
}

export function consumeSshApproval(
  db: DatabaseSync,
  approvalId: string,
  targetId: string,
  taskId: string,
  agentId: string,
  command: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE homelab_ssh_approvals SET status = 'consumed', consumed_at = ?
    WHERE id = ? AND target_id = ? AND task_id = ? AND agent_id = ? AND command_sha256 = ? AND status = 'approved'`,
    )
    .run(Date.now(), approvalId, targetId, taskId, agentId, digest(command));
  return result.changes === 1;
}

export function listSshApprovals(db: DatabaseSync) {
  const rows = db.prepare("SELECT * FROM homelab_ssh_approvals ORDER BY created_at DESC LIMIT 100").all() as Array<
    Record<string, unknown>
  >;
  return rows.map(({ command_enc, ...row }) => ({ ...row, command: decryptSecret(String(command_enc)) }));
}

export function getSshApprovalStatus(db: DatabaseSync, id: string, taskId: string, agentId: string) {
  return db
    .prepare(
      "SELECT id,target_id,task_id,agent_id,status,created_at,decided_at,decided_by,consumed_at FROM homelab_ssh_approvals WHERE id = ? AND task_id = ? AND agent_id = ?",
    )
    .get(id, taskId, agentId);
}
