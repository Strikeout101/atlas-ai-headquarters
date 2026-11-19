import { request } from "./core";

import type { BusinessKind } from "./business";

export type DealStage = "lead" | "qualified" | "proposal" | "won" | "paid" | "lost";
export interface Deal {
  id: string;
  business: BusinessKind;
  contact_id: string | null;
  project_id: string | null;
  opportunity_id: string | null;
  title: string;
  stage: DealStage;
  expected_amount_minor: number;
  currency: string;
  notes: string;
  generated_at: number | null;
  published_at: number | null;
  ordered_at: number | null;
  created_at: number;
  updated_at: number;
}
export interface FinanceEntry {
  id: string;
  business: BusinessKind;
  kind: "revenue" | "expense";
  amount_minor: number;
  currency: string;
  description: string;
  source: string;
  external_id: string | null;
  verified: 0 | 1;
  occurred_at: number;
  deal_id: string | null;
  opportunity_id: string | null;
  created_at: number;
  updated_at: number;
}
export interface SpendRequest {
  id: string;
  business: BusinessKind;
  opportunity_id: string | null;
  amount_minor: number;
  currency: string;
  purpose: string;
  status: "pending" | "approved" | "denied";
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
}
export interface CurrencyTotals {
  business: BusinessKind;
  currency: string;
  revenue_minor: number;
  cost_minor: number;
  surplus_minor: number;
  unverified_revenue_minor: number;
  unverified_cost_minor: number;
  costs_complete: false;
}
export interface RevenueGoal {
  id: string;
  business: BusinessKind;
  metric: string;
  currency: string | null;
  target: number;
  period_start: number;
  period_end: number;
  verified_revenue_minor: number;
  cost_minor: number;
  reported_surplus_minor: number;
  progress: number | null;
  costs_complete: false;
}
export interface RevenueOpportunity {
  id: string;
  title: string;
  business: BusinessKind;
  status: string;
  currencies: CurrencyTotals[];
  /** All recorded costs linked to it (verified or not) and its verified sales, in minor units. */
  spent_minor?: number;
  earned_minor?: number;
  budget?: number;
  stop_reason?: string | null;
  playbook_stage?: string | null;
}
export interface RecurringCost {
  id: string;
  label: string;
  business: BusinessKind | null;
  category: "ai_tools" | "software" | "hosting" | "ads" | "other";
  amount_minor: number;
  currency: string;
  active: number;
}
export interface ProfitLine {
  business: string;
  currency: string;
  revenue_minor: number;
  expense_minor: number;
  recurring_minor: number;
  profit_minor: number;
}
export interface ProfitOverview {
  from: number;
  to: number;
  costs_complete: boolean;
  lines: ProfitLine[];
  recurring_costs: RecurringCost[];
}
export interface FinanceOverview {
  deals: Deal[];
  ledger: FinanceEntry[];
  spend_requests: SpendRequest[];
  totals: CurrencyTotals[];
  goals: RevenueGoal[];
  opportunities: RevenueOpportunity[];
  profit?: ProfitOverview;
}
export function getFinance(filters: { business?: BusinessKind; from?: number; to?: number } = {}) {
  const params = new URLSearchParams(
    Object.entries(filters)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
  return request<FinanceOverview>(`/api/finance${params.size ? `?${params}` : ""}`);
}
export const saveDeal = (data: Record<string, unknown>, id?: string) =>
  request(`/api/finance/deals${id ? `/${encodeURIComponent(id)}` : ""}`, {
    method: id ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
export const recordFinanceEntry = (data: Record<string, unknown>) =>
  request("/api/finance/ledger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
export const linkFinanceEntry = (id: string, data: { deal_id: string | null; opportunity_id: string | null }) =>
  request(`/api/finance/ledger/${encodeURIComponent(id)}/link`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
export const createSpendRequest = (data: Record<string, unknown>) =>
  request("/api/finance/spend-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
export const saveRecurringCost = (data: Record<string, unknown>, id?: string) =>
  request(`/api/finance/recurring-costs${id ? `/${encodeURIComponent(id)}` : ""}`, {
    method: id ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
export const deleteRecurringCost = (id: string) =>
  request(`/api/finance/recurring-costs/${encodeURIComponent(id)}/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
export const setCostsComplete = (costs_complete: boolean) =>
  request("/api/finance/profit-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ costs_complete }),
  });
export const decideSpendRequest = (id: string, approve: boolean) =>
  request(`/api/finance/spend-requests/${encodeURIComponent(id)}/decide`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approve }),
  });
