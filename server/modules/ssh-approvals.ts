import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { decryptSecret, encryptSecret } from "../oauth/helpers.ts";

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
  db.prepare(
    `INSERT INTO homelab_ssh_approvals
    (id,target_id,task_id,agent_id,command_enc,command_sha256,status,created_at)
    VALUES (?,?,?,?,?,?,'pending',?)`,
  ).run(id, targetId, taskId, agentId, encryptSecret(command), digest(command), now);
  return { id, target_id: targetId, task_id: taskId, agent_id: agentId, status: "pending", created_at: now };
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
      "SELECT id,target_id,task_id,agent_id,status,created_at,decided_at,consumed_at FROM homelab_ssh_approvals WHERE id = ? AND task_id = ? AND agent_id = ?",
    )
    .get(id, taskId, agentId);
}
