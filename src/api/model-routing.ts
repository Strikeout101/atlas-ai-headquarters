import { post, put, request } from "./core";

export type ModelDirectorConfig = {
  ok: true;
  directorAgentId: string | null;
  candidates: Record<string, string[]>;
  directors: Array<{ id: string; name: string; cli_provider: "claude" | "codex"; status: string }>;
};

export type TaskModelRoute = {
  task_id: string;
  agent_id: string;
  provider: string;
  model: string;
  reasoning_level: string | null;
  source: "default" | "director" | "manual" | "upgrade";
  reason: string;
  director_agent_id: string | null;
  updated_at: number;
};

export type ModelUpgradeRequest = {
  id: string;
  task_id: string;
  agent_id: string;
  requested_model: string;
  requested_reasoning_level: string | null;
  reason: string;
  status: "pending" | "approved" | "denied";
  decision_reason: string | null;
  created_at: number;
};

export function getModelDirector(): Promise<ModelDirectorConfig> {
  return request("/api/model-director");
}

export function saveModelDirector(input: Pick<ModelDirectorConfig, "directorAgentId" | "candidates">): Promise<ModelDirectorConfig> {
  return put("/api/model-director", input);
}

export function getTaskModelRoute(taskId: string): Promise<{ ok: true; route: TaskModelRoute | null; candidates: string[]; requests: ModelUpgradeRequest[] }> {
  return request(`/api/tasks/${encodeURIComponent(taskId)}/model-route`);
}

export function routeTaskModel(taskId: string, force = false): Promise<{ ok: true; route: TaskModelRoute }> {
  return post(`/api/tasks/${encodeURIComponent(taskId)}/model-route`, { force });
}

export function requestModelUpgrade(taskId: string, reason: string, model?: string): Promise<{ ok: true; request: ModelUpgradeRequest }> {
  return post(`/api/tasks/${encodeURIComponent(taskId)}/model-upgrades`, { reason, model });
}

export function decideModelUpgrade(id: string, approve: boolean, reason: string): Promise<{ ok: true; request: ModelUpgradeRequest }> {
  return post(`/api/model-upgrades/${encodeURIComponent(id)}/decide`, { approve, reason });
}
