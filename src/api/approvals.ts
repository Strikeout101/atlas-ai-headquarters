import { request } from "./core";
import { decideHomelabSshApproval } from "./homelab";
import { decideModelUpgrade } from "./model-routing";

interface PendingApprovalBase {
  id: string;
  created_at: number;
  task_id: string;
  task_title: string | null;
  agent_id: string;
  agent_name: string | null;
}

export type PendingApproval =
  | (PendingApprovalBase & {
      kind: "ssh_command";
      target_id: string;
      target_name: string | null;
      target_host: string | null;
      /** Null when the server could not decrypt it; such a request must be reviewed in Homelab. */
      command: string | null;
    })
  | (PendingApprovalBase & {
      kind: "model_upgrade";
      requested_model: string | null;
      requested_reasoning_level: string | null;
      reason: string;
    });

/** Everything waiting on the owner's approval: SSH commands that could change a host, and model upgrades. */
export async function getPendingApprovals(): Promise<PendingApproval[]> {
  const result = await request<{ items?: PendingApproval[] }>("/api/approvals");
  return Array.isArray(result.items) ? result.items : [];
}

/** Decides one approval through the same endpoint its own page uses. */
export async function decidePendingApproval(item: PendingApproval, approve: boolean): Promise<void> {
  if (item.kind === "ssh_command") {
    await decideHomelabSshApproval(item.id, approve);
  } else {
    await decideModelUpgrade(item.id, approve, approve ? "Approved by owner from Today" : "Denied by owner from Today");
  }
}
