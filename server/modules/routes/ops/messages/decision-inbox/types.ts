import type { DatabaseSync } from "node:sqlite";
import type { Response } from "express";
import type { AgentRow } from "../../../shared/types.ts";

export type DecisionOption = {
  number: number;
  action: string;
  label: string;
};

/**
 * Decision Inbox items. The old project-review gate and review-round picks are gone (work restructure, phase 4):
 * a task's review is one cross-model reviewer, and the owner only sees a review when the VPs pass it on.
 */
export interface DecisionInboxRouteItem {
  id: string;
  kind: "task_timeout_resume" | "review_owner" | "strategy" | "initiative_approval" | "initiative_blocked";
  created_at: number;
  summary: string;
  agent_id?: string | null;
  agent_name?: string | null;
  agent_name_ko?: string | null;
  agent_avatar?: string | null;
  project_id: string | null;
  project_name: string | null;
  project_path: string | null;
  task_id: string | null;
  task_title: string | null;
  meeting_id?: string | null;
  review_round?: number | null;
  options: DecisionOption[];
}

export type TimeoutResumeDecisionItem = DecisionInboxRouteItem & {
  kind: "task_timeout_resume";
};

export type ReviewOwnerDecisionItem = DecisionInboxRouteItem & {
  kind: "review_owner";
};

export interface TimeoutReplyDeps {
  db: DatabaseSync;
  activeProcesses: Map<string, unknown>;
  getDeptName: (departmentId: string) => string;
  appendTaskLog: (taskId: string, kind: string, message: string) => void;
  startTaskExecutionForAgent: (
    taskId: string,
    agent: AgentRow,
    departmentId: string | null,
    departmentName: string,
  ) => void;
}

export interface TimeoutReplyInput {
  res: Response;
  currentItem: DecisionInboxRouteItem;
  selectedOption: DecisionOption;
  deps: TimeoutReplyDeps;
}
