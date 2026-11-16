import { post, request } from "./core";

import type { BusinessKind } from "./business";

export interface EmailApproval {
  id: string;
  draft_id: string;
  task_id: string;
  agent_id: string;
  business: BusinessKind;
  sender: string;
  recipient: string;
  subject: string;
  body: string;
  status: "pending" | "sending" | "sent" | "denied" | "failed" | "unknown";
  created_at: number;
  decided_at: number | null;
  sent_at: number | null;
  message_id: string | null;
  error_code: string | null;
}

export const businessEmailApi = {
  list: async () => (await request<{ ok: true; items: EmailApproval[] }>("/api/business/email-approvals")).items,
  decide: async (id: string, approve: boolean) =>
    post<{ ok: boolean; item: EmailApproval; error?: string }>(
      `/api/business/email-approvals/${encodeURIComponent(id)}/decide`,
      { approve },
    ),
};
