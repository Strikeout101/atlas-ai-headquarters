import { bootstrapSession, del, patch, post, request } from "./core";

import type { BusinessKind } from "./business";

export type CustomerSendLevel = "owner" | "vp";
export type GateLevel = "none" | "vp" | "owner";

/** Who approves what for one business. Spending, terms and destructive SSH always need the owner regardless. */
export interface BusinessPolicy {
  business: BusinessKind;
  customer_sends: CustomerSendLevel;
  record_changes: GateLevel;
  code_pushes: GateLevel;
  updated_at: number;
}

export interface GitHubAccount {
  id: string;
  label: string;
  business: BusinessKind | null;
  login: string | null;
  is_default: number;
  has_token: boolean;
  last_test_at: number | null;
  last_test_ok: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

async function owner() {
  await bootstrapSession({ promptOnUnauthorized: false });
}

export const policiesApi = {
  list: async () => (await request<{ ok: true; items: BusinessPolicy[] }>("/api/business/policies")).items,
  update: async (business: BusinessKind, input: Partial<Omit<BusinessPolicy, "business" | "updated_at">>) => {
    await owner();
    return (await patch<{ ok: true; item: BusinessPolicy }>(`/api/business/policies/${business}`, input)).item;
  },
};

export const githubAccountsApi = {
  list: async () => (await request<{ ok: true; items: GitHubAccount[] }>("/api/github-accounts")).items,
  create: async (input: {
    label: string;
    business: BusinessKind | "personal";
    token: string;
    is_default?: boolean;
  }) => {
    await owner();
    return (await post<{ ok: true; item: GitHubAccount }>("/api/github-accounts", input)).item;
  },
  update: async (
    id: string,
    input: Partial<{ label: string; business: BusinessKind | "personal"; token: string; is_default: boolean }>,
  ) => {
    await owner();
    return (await patch<{ ok: true; item: GitHubAccount }>(`/api/github-accounts/${encodeURIComponent(id)}`, input))
      .item;
  },
  test: async (id: string) => {
    await owner();
    return post<{ ok: true; connected: boolean; login: string | null; error: string | null; account: GitHubAccount }>(
      `/api/github-accounts/${encodeURIComponent(id)}/test`,
      {},
    );
  },
  remove: async (id: string) => {
    await owner();
    return del(`/api/github-accounts/${encodeURIComponent(id)}`);
  },
};
