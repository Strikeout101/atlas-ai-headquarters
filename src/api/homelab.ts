import { del, patch, post, put, request } from "./core";

export type HomelabSshTarget = {
  id: string;
  name: string;
  host: string;
  ssh_user: string;
  port: number;
  enabled: boolean;
  restrict_agents: boolean;
  auth_method: "password" | "private_key" | "legacy_key_path";
  has_credential: boolean;
  has_passphrase: boolean;
  host_fingerprint: string | null;
  agent_ids: string[];
  created_at: number;
  updated_at: number;
};

export type HomelabSshTargetInput = {
  name: string;
  host: string;
  ssh_user: string;
  port: number;
  enabled: boolean;
  restrict_agents?: boolean;
  auth_method: "password" | "private_key";
  credential?: string;
  passphrase?: string;
  host_fingerprint?: string | null;
};

export type HomelabSshProbe = { ok: true; fingerprint: string; matches_pin: boolean };
export type HomelabSshTest = { ok: boolean; status: string; fingerprint?: string; error_code?: string };

export type HomelabSshRun = {
  id: string;
  target_id: string;
  task_id: string | null;
  agent_id: string | null;
  command_sha256: string;
  command_bytes: number;
  started_at: number;
  finished_at: number | null;
  status: "running" | "completed" | "failed" | "timeout" | "output_limit" | "spawn_error";
  exit_code: number | null;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_sha256: string | null;
  stderr_sha256: string | null;
  error_code: string | null;
};

export type HomelabSshApproval = {
  id: string;
  target_id: string;
  task_id: string | null;
  agent_id: string;
  command: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired" | string;
  created_at: number;
  decided_at?: number | null;
  /** "owner" or "auto_read_only" when ATLAS approved a read-only check by itself. */
  decided_by?: string | null;
  expires_at?: number | null;
};

export function getHomelabSshTargets(): Promise<{ ok: true; targets: HomelabSshTarget[] }> {
  return request("/api/homelab/targets");
}

export function createHomelabSshTarget(input: HomelabSshTargetInput): Promise<{ ok: true; target: HomelabSshTarget }> {
  return post("/api/homelab/targets", input);
}

export function updateHomelabSshTarget(
  id: string,
  input: Partial<HomelabSshTargetInput>,
): Promise<{ ok: true; target: HomelabSshTarget }> {
  return patch(`/api/homelab/targets/${encodeURIComponent(id)}`, input);
}

export function deleteHomelabSshTarget(id: string): Promise<{ ok: true }> {
  return del(`/api/homelab/targets/${encodeURIComponent(id)}`);
}

export function probeHomelabSshTarget(id: string): Promise<HomelabSshProbe> {
  return post(`/api/homelab/targets/${encodeURIComponent(id)}/probe`, {});
}

export function testHomelabSshTarget(id: string): Promise<HomelabSshTest> {
  return post(`/api/homelab/targets/${encodeURIComponent(id)}/test`, {});
}

export function setHomelabSshGrants(id: string, agentIds: string[]): Promise<{ ok: true; agent_ids: string[] }> {
  return put(`/api/homelab/targets/${encodeURIComponent(id)}/grants`, { agent_ids: agentIds });
}

export function getHomelabSshRuns(targetId?: string): Promise<{ ok: true; runs: HomelabSshRun[] }> {
  const query = targetId ? `?target_id=${encodeURIComponent(targetId)}` : "";
  return request(`/api/homelab/runs${query}`);
}

export function getHomelabSshApprovals(): Promise<{ approvals: HomelabSshApproval[] }> {
  return request("/api/homelab/approvals");
}

export function getHomelabApprovalPolicy(): Promise<{ ok: true; auto_approve_read_only: boolean }> {
  return request("/api/homelab/approval-policy");
}

export function setHomelabApprovalPolicy(
  autoApproveReadOnly: boolean,
): Promise<{ ok: true; auto_approve_read_only: boolean }> {
  return put("/api/homelab/approval-policy", { auto_approve_read_only: autoApproveReadOnly });
}

export function decideHomelabSshApproval(id: string, approve: boolean): Promise<{ approval: HomelabSshApproval }> {
  return post(`/api/homelab/approvals/${encodeURIComponent(id)}/decide`, { approve });
}

export function runHomelabSshCommand(
  id: string,
  command: string,
): Promise<{
  ok: boolean;
  run_id: string;
  status: HomelabSshRun["status"];
  exit_code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}> {
  return post(`/api/homelab/targets/${encodeURIComponent(id)}/run`, { command });
}
