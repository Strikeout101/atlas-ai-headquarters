import { bootstrapSession, patch, post, request } from "./core";

import type { BusinessKind } from "./business";

export type MemoryKind = "fact" | "lesson";
export type MemoryScope = "global" | "business" | "project";
export type MemoryStatus = "active" | "archived";

/** A fact or lesson an agent saved for later tasks. */
export interface AgentMemory {
  id: string;
  kind: MemoryKind;
  scope: MemoryScope;
  business: BusinessKind | null;
  project_id: string | null;
  title: string;
  body: string;
  source_agent_id: string | null;
  source_agent_name: string | null;
  source_task_id: string | null;
  source_task_title: string | null;
  status: MemoryStatus;
  reviewed_at: number | null;
  reviewed_by: string | null;
  use_count: number;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryList {
  items: AgentMemory[];
  counts: { active: number; unreviewed: number; archived: number };
}

export interface MemoryFilter {
  status?: MemoryStatus | "";
  business?: BusinessKind | "";
  reviewed?: "yes" | "no" | "";
  q?: string;
}

/** How often finished tasks left lessons over the last `days`. */
export interface LessonCoverage {
  days: number;
  counts: { agent_added: number; captured: number; none_declared: number; missing: number };
  recentMissing: Array<{ task_id: string; title: string; agent_name: string | null; checked_at: number }>;
}

async function owner() {
  await bootstrapSession({ promptOnUnauthorized: false });
}

export const knowledgeApi = {
  lessonChecks: () => request<LessonCoverage & { ok: true }>("/api/knowledge/lesson-checks"),
  document: (topic: "systems" | "checklist") =>
    request<{ ok: true; topic: string; available: boolean; text: string }>(`/api/knowledge/documents/${topic}`),
  memories: (filter: MemoryFilter = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filter)) if (value) params.set(key, String(value));
    const query = params.toString();
    return request<MemoryList & { ok: true }>(`/api/knowledge/memories${query ? `?${query}` : ""}`);
  },
  review: async (id: string) => {
    await owner();
    return (await post<{ ok: true; item: AgentMemory }>(`/api/knowledge/memories/${encodeURIComponent(id)}/review`, {}))
      .item;
  },
  setStatus: async (id: string, status: MemoryStatus) => {
    await owner();
    return (
      await post<{ ok: true; item: AgentMemory }>(`/api/knowledge/memories/${encodeURIComponent(id)}/status`, {
        status,
      })
    ).item;
  },
  update: async (id: string, input: Partial<Pick<AgentMemory, "title" | "body" | "kind">>) => {
    await owner();
    return (await patch<{ ok: true; item: AgentMemory }>(`/api/knowledge/memories/${encodeURIComponent(id)}`, input))
      .item;
  },
  create: async (input: {
    kind: MemoryKind;
    scope: MemoryScope;
    business?: BusinessKind | null;
    title: string;
    body: string;
  }) => {
    await owner();
    return (await post<{ ok: true; item: AgentMemory }>("/api/knowledge/memories", input)).item;
  },
};
