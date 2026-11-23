import { request } from "./core";

/** Read models for the Work board, an initiative's page and Behind the scenes (work restructure, phase 7). */
export type BoardColumn = "waiting" | "working" | "in_review" | "needs_you" | "done";

export interface BoardCard {
  id: string;
  title: string;
  column: BoardColumn;
  status: string;
  work_type: string | null;
  importance: string | null;
  playbook_step: string | null;
  attempt: number;
  review_state: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_provider: string | null;
  updated_at: number;
}

export interface BoardGroup {
  kind: "initiative" | "goal" | "operations";
  id: string;
  title: string;
  status?: string | null;
  playbook_stage?: string | null;
  blocked_reason?: string | null;
  business?: string | null;
  cards: BoardCard[];
}

export interface WorkBoardData {
  columns: BoardColumn[];
  counts: Record<BoardColumn, number>;
  goals: Array<{
    id: string;
    title: string;
    business: string;
    metric: string;
    target: number;
    period_end: number;
    live: boolean;
    groups: BoardGroup[];
  }>;
  operations: BoardGroup;
}

export interface Handoff {
  summary: string;
  files: Array<{ path: string; note: string }>;
  numbers: Record<string, string | number>;
  open_issues: string;
  next_step_notes: string;
  generated: boolean;
}

export interface ReviewEntry {
  round: number;
  status: string;
  reviewer_agent_id: string | null;
  reviewer_provider: string | null;
  same_model: boolean;
  summary: string;
  items: string[];
  created_at: number;
}

export interface InitiativeStep {
  key: string;
  title: string;
  kind: "task" | "owner_approval";
  work_type: string | null;
  department_id: string;
  state: "done" | "current" | "upcoming" | "skipped" | "waiting_owner";
  task: BoardCard | null;
  handoff: Handoff | null;
  reviews: ReviewEntry[];
}

export interface InitiativeDetail {
  initiative: {
    id: string;
    title: string;
    description: string;
    status: string;
    playbook: string | null;
    playbook_stage: string | null;
    blocked_reason: string | null;
    escalation: string | null;
    budget: number;
    task_cap_daily: number;
    business: string;
  };
  goal: { id: string; title: string; business: string } | null;
  steps: InitiativeStep[];
  other_tasks: BoardCard[];
}

export interface AgentScene {
  id: string;
  name: string;
  role: string;
  department_id: string | null;
  department_name: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  current: BoardCard | null;
  queue: BoardCard[];
  recent_handoffs: Array<{ task_id: string; title: string; handoff: Handoff | null }>;
  reviewing: Array<{ task_id: string; title: string; round: number }>;
  model_fixes: Array<{ message: string; at: number }>;
}

export const getWorkBoard = () => request<WorkBoardData & { ok: boolean }>("/api/work/board");
export const getInitiativeDetail = (id: string) =>
  request<InitiativeDetail & { ok: boolean }>(`/api/work/initiatives/${encodeURIComponent(id)}`);
export const getBehindTheScenes = () => request<{ ok: boolean; agents: AgentScene[] }>("/api/work/agents");
