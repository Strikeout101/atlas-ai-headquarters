import type { LangText } from "../../i18n";

export interface StreamingMessage {
  message_id: string;
  agent_id: string;
  agent_name: string;
  agent_avatar: string;
  content: string;
}

export type ChatMode = "chat" | "task" | "announcement" | "report";

export type ProjectMetaPayload = {
  project_id?: string;
  project_path?: string;
  project_context?: string;
};

export type PendingSendAction =
  | { kind: "directive"; content: string }
  | { kind: "announcement"; content: string }
  | { kind: "task"; content: string; receiverId: string }
  | { kind: "report"; content: string; receiverId: string }
  | { kind: "chat"; content: string; receiverId: string }
  | { kind: "broadcast"; content: string };

export const STATUS_COLORS: Record<string, string> = {
  idle: "bg-green-400",
  working: "bg-blue-400",
  break: "bg-yellow-400",
  offline: "bg-gray-500",
};

export const STATUS_LABELS: Record<string, LangText> = {
  idle: { en: "Idle" },
  working: { en: "Working" },
  break: { en: "Break" },
  offline: { en: "Offline" },
};

export const ROLE_LABELS: Record<string, LangText> = {
  vp: { en: "VP" },
  team_leader: { en: "Team Leader" },
  senior: { en: "Senior" },
  junior: { en: "Junior" },
  intern: { en: "Intern" },
};

export function isPromiseLike(value: unknown): value is Promise<void> {
  return !!value && typeof (value as { then?: unknown }).then === "function";
}
