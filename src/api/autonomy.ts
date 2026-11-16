import { request } from "./core";

import type { BusinessKind } from "./business";

export interface BusinessGoal {
  id: string;
  business: BusinessKind;
  project_id: string;
  metric: string;
  currency?: string;
  target: number;
  period_start: number;
  period_end: number;
  progress: number | null;
  progress_scope?: "business" | "project" | null;
  status?: string;
}
export interface Opportunity {
  id: string;
  business: BusinessKind;
  project_id: string;
  goal_id: string | null;
  title: string;
  description: string;
  demand_score: number;
  revenue_score: number;
  cost_score: number;
  difficulty_score: number;
  time_to_launch_score: number;
  budget: number;
  status: "idea" | "researching" | "approved" | "building" | "launched" | "stopped";
}
export interface AutonomySchedule {
  id: string;
  business: BusinessKind;
  project_id: string;
  department_id: string | null;
  title: string;
  description: string;
  kind: "research" | "lead_research";
  interval_minutes: number;
  next_run_at: number;
  enabled: number | boolean;
  consecutive_failures: number;
  last_task_id: string | null;
}
export interface AutonomyConfig {
  daily_start_cap: number;
  usage_threshold: number;
  failure_limit: number;
  planning_interval_minutes: number;
}
export interface LedgerEvent {
  id: string | number;
  event: string;
  message: string;
  created_at: number;
  task_id?: string | null;
  business?: BusinessKind | null;
  source_id?: string | null;
}
export interface AutonomyOverview {
  goals: BusinessGoal[];
  opportunities: Opportunity[];
  schedules: AutonomySchedule[];
  config: AutonomyConfig;
  ledger: LedgerEvent[];
}
export interface AutonomyDigest {
  events: LedgerEvent[];
  counts: Record<string, number>;
  total?: number;
  through?: number;
}
export type AutonomyResource = "goals" | "opportunities" | "schedules";
export const getAutonomy = () => request<AutonomyOverview>("/api/autonomy");
export const getAutonomyDigest = (after: number) =>
  request<AutonomyDigest>(`/api/autonomy/digest?after=${encodeURIComponent(after)}`);
export function saveAutonomy(resource: AutonomyResource, data: Record<string, unknown>, id?: string) {
  return request(`/api/autonomy/${resource}${id ? `/${encodeURIComponent(id)}` : ""}`, {
    method: id ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
export const saveAutonomyConfig = (config: AutonomyConfig) =>
  request("/api/autonomy/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
