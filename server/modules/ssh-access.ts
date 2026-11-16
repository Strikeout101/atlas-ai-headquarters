import type { DatabaseSync } from "node:sqlite";

/** Shared by discovery, request creation, and execution so restrictions cannot drift. */
export const SSH_AGENT_ACCESS_SQL = `(t.restrict_agents = 0 OR EXISTS (
  SELECT 1 FROM homelab_ssh_grants g WHERE g.target_id = t.id AND g.agent_id = ?
))`;

export function hasSshHostAccess(db: DatabaseSync, targetId: string, agentId: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM homelab_ssh_targets t WHERE t.id = ? AND ${SSH_AGENT_ACCESS_SQL}`).get(targetId, agentId),
  );
}
