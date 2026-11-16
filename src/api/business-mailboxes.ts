import { patch, post, request } from "./core";

import type { BusinessKind } from "./business";

export interface MailboxConfig {
  id: string;
  is_default: boolean;
  business: BusinessKind;
  email: string;
  username: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  has_password: boolean;
  updated_at: number;
  last_test_at: number | null;
  last_test_ok: boolean | null;
}
export type MailboxInput = Pick<
  MailboxConfig,
  "email" | "username" | "imap_host" | "imap_port" | "smtp_host" | "smtp_port"
> & { password?: string; is_default?: boolean };
export interface MailboxTestResult {
  ok: true;
  imap: { ok: boolean; error?: string };
  smtp: { ok: boolean; error?: string };
  tested_at: number;
}
export const mailboxApi = {
  create: async (business: BusinessKind, input: MailboxInput) =>
    (await post<{ ok: true; item: MailboxConfig }>("/api/business/mailboxes", { business, ...input })).item,
  update: async (id: string, input: Partial<MailboxInput>) =>
    (
      await patch<{ ok: true; item: MailboxConfig }>(
        `/api/business/mailboxes/accounts/${encodeURIComponent(id)}`,
        input,
      )
    ).item,
  list: async () => (await request<{ ok: true; items: MailboxConfig[] }>("/api/business/mailboxes")).items,
  save: async (business: BusinessKind, input: MailboxInput) =>
    (await patch<{ ok: true; item: MailboxConfig }>(`/api/business/mailboxes/${business}`, input)).item,
  test: async (id: string) =>
    post<MailboxTestResult>(`/api/business/mailboxes/accounts/${encodeURIComponent(id)}/test`, {}),
};
