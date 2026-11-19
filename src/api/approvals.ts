import { businessEmailApi } from "./business-email";
import { isApiRequestError, post, request } from "./core";
import { decideHomelabSshApproval } from "./homelab";
import { decideModelUpgrade } from "./model-routing";

import type { BusinessKind } from "./business";

interface PendingApprovalBase {
  /** Routing facts read from records: the client's tier and the biggest open deal or quote involved. */
  client_tier?: string | null;
  deal_amount_minor?: number | null;
  deal_currency?: string | null;
  changes_client_tier?: boolean;
  /** The task behind it read outside content that tried to give instructions; the owner decides. */
  untrusted_content?: boolean;
  within_spend_budget?: boolean;
  vp_review?: {
    status: string;
    reason: string;
    reviews: Array<{ vp_agent_id: string; verdict: string; reason: string }>;
  } | null;
  id: string;
  created_at: number;
  /** Null only for agent task suggestions, which have no task until approved. */
  task_id: string | null;
  task_title: string | null;
  agent_id: string;
  agent_name: string | null;
}

export type PendingApproval =
  | (PendingApprovalBase & {
      /** An agent's change to a business record, held because that business requires approval for record changes. */
      kind: "record_change";
      business: BusinessKind;
      resource: string;
      action: string;
      target_id: string | null;
      summary: string;
      payload: Record<string, unknown>;
      current: Record<string, unknown> | null;
    })
  | (PendingApprovalBase & {
      /** Reviewed work merged into dev locally, waiting for approval to push to GitHub. */
      kind: "code_push";
      business: BusinessKind | null;
      project_id: string;
      project_name: string | null;
      github_repo: string;
      branch: string;
      account_label: string | null;
      account_login: string | null;
      title: string;
    })
  | (PendingApprovalBase & {
      /** A storefront listing package an agent prepared. Approving allows it to be published; it publishes nothing. */
      kind: "listing_publish";
      business: BusinessKind;
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
      fee_over_budget: boolean;
    })
  | (PendingApprovalBase & {
      kind: "spend_request";
      business: BusinessKind;
      amount_minor: number;
      currency: string;
      purpose: string;
      opportunity_id: string | null;
      category?: string;
    })
  | (PendingApprovalBase & {
      kind: "org_request";
      org_kind: string;
      payload: Record<string, unknown>;
      reason: string;
    })
  | (PendingApprovalBase & {
      kind: "business_email";
      business: BusinessKind;
      sender: string;
      recipient: string;
      subject: string;
      body: string;
    })
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
      requested_provider?: string | null;
      requested_reasoning_level: string | null;
      reason: string;
    })
  | (PendingApprovalBase & {
      kind: "task_proposal";
      task_id: null;
      title: string;
      description: string;
      reason: string;
      project_id: string | null;
      project_name: string | null;
    });

/** Approve creates a planned task assigned to the agent who suggested it; dismiss is remembered so it is not suggested again. */
export function decideAgentProposal(id: string, approve: boolean): Promise<{ ok: boolean; task_id?: string }> {
  return post(`/api/agent-proposals/${encodeURIComponent(id)}/decide`, { approve });
}

/** Everything waiting on the owner's approval: emails, SSH commands that could change a host, model upgrades and tasks agents suggested. */
export async function getPendingApprovals(): Promise<PendingApproval[]> {
  const result = await request<{ items?: PendingApproval[] }>("/api/approvals");
  return Array.isArray(result.items) ? result.items : [];
}

/** Decides one approval through the same endpoint its own page uses. */
export async function decidePendingApproval(item: PendingApproval, approve: boolean): Promise<void> {
  if (item.kind === "spend_request") {
    await post(`/api/finance/spend-requests/${encodeURIComponent(item.id)}/decide`, { approve });
    return;
  }
  if (item.kind === "record_change") {
    await post(`/api/record-changes/${encodeURIComponent(item.id)}/decide`, { approve });
    return;
  }
  if (item.kind === "code_push") {
    await post(`/api/code-pushes/${encodeURIComponent(item.id)}/decide`, { approve });
    return;
  }
  if (item.kind === "listing_publish") {
    await post(`/api/listings/${encodeURIComponent(item.id)}/decide`, { approve });
    return;
  }
  if (item.kind === "business_email") {
    const result = await businessEmailApi.decide(item.id, approve).catch((cause: unknown) => {
      if (approve && !isApiRequestError(cause)) {
        throw new Error(
          "The connection ended before delivery could be confirmed. Do not create another message; check Email delivery history first.",
        );
      }
      throw cause;
    });
    if (!result.ok || (approve && result.item.status !== "sent")) {
      throw new Error(
        result.item.status === "unknown"
          ? "Email delivery is uncertain. Do not resend; check Email delivery history first."
          : `Email was not sent (${result.item.error_code ?? result.error ?? result.item.status}). Check Email delivery history.`,
      );
    }
  } else if (item.kind === "org_request") {
    await post(`/api/org-requests/${encodeURIComponent(item.id)}/decide`, { approve });
  } else if (item.kind === "task_proposal") {
    await decideAgentProposal(item.id, approve);
  } else if (item.kind === "ssh_command") {
    await decideHomelabSshApproval(item.id, approve);
  } else {
    await decideModelUpgrade(item.id, approve, approve ? "Approved by owner from Today" : "Denied by owner from Today");
  }
}
