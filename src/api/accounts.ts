import { bootstrapSession, del, patch, post, put, request } from "./core";

import type { BusinessKind } from "./business";

export type CustomerSendLevel = "owner" | "vp";
export type GateLevel = "none" | "vp" | "owner";
export type TierRule = "important" | "vip" | "off";

/** Who approves what for one business. Spending, terms and destructive SSH always need the owner regardless. */
export interface BusinessPolicy {
  business: BusinessKind;
  customer_sends: CustomerSendLevel;
  record_changes: GateLevel;
  code_pushes: GateLevel;
  /** Deals and quotes at or above this (cents) go to the owner; 0 turns the limit off. */
  owner_amount_minor: number;
  amount_currency: string;
  tier_to_owner: TierRule;
  /** Owner approvals in a row before the app offers to hand that kind to the VPs; 0 = never. */
  trust_ramp_after: number;
  updated_at: number;
}

export type RampKind = "customer_sends" | "record_changes" | "code_pushes";
export interface TrustOffer {
  business: BusinessKind;
  kind: RampKind;
  streak: number;
  approved: number;
  denied: number;
  agents: Array<{ agent_id: string; approved: number; denied: number }>;
}

export type SpendCategory = "ai_tools" | "ads" | "hosting" | "software" | "supplies" | "other";
export interface SpendBudget {
  business: BusinessKind;
  category: SpendCategory;
  currency: string;
  monthly_cap_minor: number;
  per_item_cap_minor: number;
  used_minor: number;
  remaining_minor: number;
  month: string;
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

export const trustOffersApi = {
  list: async () => (await request<{ ok: true; items: TrustOffer[] }>("/api/business/trust-offers")).items,
  answer: async (business: BusinessKind, kind: RampKind, accept: boolean) => {
    await owner();
    return post<{ ok: true; policy: BusinessPolicy; items: TrustOffer[] }>(
      `/api/business/trust-offers/${business}/${kind}`,
      { accept },
    );
  },
};

export const spendBudgetsApi = {
  list: async () => (await request<{ ok: true; items: SpendBudget[] }>("/api/business/spend-budgets")).items,
  save: async (input: {
    business: BusinessKind;
    category: SpendCategory;
    monthly_cap_minor: number;
    per_item_cap_minor: number;
    currency?: string;
  }) => {
    await owner();
    return (await put<{ ok: true; item: SpendBudget }>("/api/business/spend-budgets", input)).item;
  },
};
