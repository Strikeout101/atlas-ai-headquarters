import { request } from "./core";

import type { BusinessKind } from "./business";

export interface BusinessGoal {
  id: string;
  business: BusinessKind;
  project_id: string | null;
  title?: string;
  metric: string;
  currency?: string;
  target: number;
  /** How many initiatives this goal runs at once (work restructure). */
  initiative_slots?: number;
  period_start: number;
  period_end: number;
  progress: number | null;
  progress_scope?: "business" | "project" | null;
  status?: string;
}
export interface Initiative {
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
  /** Recorded USD expenses in minor units, including unverified entries. */
  spent_minor?: number;
  status: "proposed" | "approved" | "in_progress" | "blocked" | "launched" | "measuring" | "stopped" | "done";
  task_limit?: number;
  time_limit_days?: number;
  launched_at?: number | null;
  stop_reason?: string | null;
  blocked_reason?: string | null;
  playbook?: string | null;
  playbook_stage?: string | null;
}
export interface ExperimentRules {
  enabled: boolean;
  stop_when_budget_spent_without_revenue: boolean;
  no_sale_days_after_launch: number;
  max_tasks_without_revenue: number;
}
export interface PlaybookStep {
  key: string;
  title: string;
  department_id: string;
  instructions: string;
}
export interface Playbook {
  key: string;
  title: string;
  business: BusinessKind;
  research: PlaybookStep;
  steps: PlaybookStep[];
  updated_at: number;
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
  playbook?: string | null;
  /** Time-of-day rule (5-field cron) and its time zone; when set it replaces interval_minutes. */
  cron?: string | null;
  timezone?: string | null;
}
export interface GoalStrategy {
  id?: string;
  goal_id: string;
  summary: string;
  created_at: number;
  task_id: string | null;
  version?: number;
  status?: "draft" | "proposed" | "approved" | "superseded";
  /** The owner's note on a redo (or on approval). */
  owner_note?: string | null;
}
export interface GoalMilestone {
  id: string;
  goal_id: string;
  title: string;
  kind: "progress" | "manual";
  target: number | null;
  status: "open" | "done";
  done_by: "verified" | "owner" | null;
  done_at: number | null;
}
export interface AutonomyConfig {
  daily_start_cap: number;
  local_provider_daily_run_cap?: number;
  usage_threshold: number;
  failure_limit: number;
  planning_interval_minutes: number;
  think_enabled?: number;
  think_interval_minutes?: number;
  think_check_interval_minutes?: number;
  think_max_pending_per_agent?: number;
  think_max_pending_total?: number;
  idea_daily_start_cap?: number;
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
  initiatives: Initiative[];
  schedules: AutonomySchedule[];
  config: AutonomyConfig;
  ledger: LedgerEvent[];
  experiment_rules?: ExperimentRules;
  playbooks?: Playbook[];
  milestones?: GoalMilestone[];
  /** The newest strategy agents researched for each goal. */
  strategies?: GoalStrategy[];
}
export interface AutonomyDigest {
  events: LedgerEvent[];
  counts: Record<string, number>;
  total?: number;
  through?: number;
}
export type AutonomyResource = "goals" | "initiatives" | "schedules";
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

const sendJson = (url: string, method: string, data: unknown) =>
  request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
export const saveExperimentRules = (rules: Partial<ExperimentRules>) =>
  sendJson("/api/autonomy/experiment-rules", "PATCH", rules);
export const restartInitiative = (id: string) =>
  sendJson(`/api/autonomy/initiatives/${encodeURIComponent(id)}/restart`, "POST", {});
/** The owner's calls in the goal flow: the strategy, which ideas to build, and a stuck step. */
export const decideStrategy = (id: string, decision: "approve" | "redo", note?: string) =>
  sendJson(`/api/autonomy/strategies/${encodeURIComponent(id)}/decision`, "POST", { decision, note });
export const approveInitiative = (id: string) =>
  sendJson(`/api/autonomy/initiatives/${encodeURIComponent(id)}/approve`, "POST", {});
export const unblockInitiative = (id: string, action: "retry" | "skip" | "stop", notes?: string, agentId?: string) =>
  sendJson(`/api/autonomy/initiatives/${encodeURIComponent(id)}/unblock`, "POST", { action, notes, agent_id: agentId });
export const savePlaybook = (key: string, data: Partial<Pick<Playbook, "title" | "research" | "steps">>) =>
  sendJson(`/api/autonomy/playbooks/${encodeURIComponent(key)}`, "PUT", data);
export const resetPlaybook = (key: string) =>
  sendJson(`/api/autonomy/playbooks/${encodeURIComponent(key)}/reset`, "POST", {});
export const addPlaybookResearchSchedule = (key: string, projectId: string, intervalMinutes = 10080) =>
  sendJson(`/api/autonomy/playbooks/${encodeURIComponent(key)}/research-schedule`, "POST", {
    project_id: projectId,
    interval_minutes: intervalMinutes,
  });
export const addMilestone = (goalId: string, data: { title: string; kind: "progress" | "manual"; target?: number }) =>
  sendJson(`/api/autonomy/goals/${encodeURIComponent(goalId)}/milestones`, "POST", data);
export const setMilestoneDone = (id: string, done: boolean) =>
  sendJson(`/api/autonomy/milestones/${encodeURIComponent(id)}/done`, "POST", { done });
export const deleteMilestone = (id: string) =>
  sendJson(`/api/autonomy/milestones/${encodeURIComponent(id)}/delete`, "POST", {});

/** One income stream (a business) on one page. */
export interface StreamOverview {
  business: BusinessKind;
  businesses: BusinessKind[];
  goals: Array<BusinessGoal & { milestones: GoalMilestone[] }>;
  pipeline: Record<string, number>;
  initiatives: Array<
    Initiative & {
      results: {
        spent_usd: number;
        earned_usd: number;
        budget_usd: number;
        days_live: number | null;
        tasks_in_window: number;
        task_limit: number;
        playbook_stage: string | null;
        stop_reason: string | null;
        variants: Array<{
          variable: string;
          value: string;
          days: number;
          sales: number;
          revenue_usd: number;
          active: boolean;
        }>;
      };
    }
  >;
  /** Autonomous tasks waiting, running or held (the work engine's step tasks). */
  next: Array<{
    id: string;
    status: string;
    initiative_id: string | null;
    playbook_step: string | null;
    title: string | null;
    created_at: number;
  }>;
  listings: Record<string, number>;
  schedules: Array<{
    id: string;
    title: string;
    enabled: boolean;
    next_run_at: number;
    cron: string | null;
    timezone: string | null;
    playbook: string | null;
  }>;
  month: {
    from: number;
    to: number;
    costs_complete: boolean;
    lines: Array<{
      currency: string;
      revenue_minor: number;
      expense_minor: number;
      recurring_minor: number;
      profit_minor: number;
    }>;
  };
  recent: Array<{ event: string; message: string; created_at: number }>;
}
export const getStream = (business: BusinessKind) =>
  request<StreamOverview>(`/api/streams?business=${encodeURIComponent(business)}`);
