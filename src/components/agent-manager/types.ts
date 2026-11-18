import type { Agent, Department } from "../../types";

export type Translator = (en: string) => string;

export interface AgentManagerProps {
  agents: Agent[];
  departments: Department[];
  onAgentsChange: () => void;
}

export interface FormData {
  name: string;
  name_ko: string;
  name_ja: string;
  name_zh: string;
  department_id: string;
  role: import("../../types").AgentRole;
  cli_provider: import("../../types").CliProvider;
  cli_fallback_provider?: "codex" | "claude";
  avatar_emoji: string;
  sprite_number: number | null;
  personality: string;
  /** Suggests tasks on its own. Ignored for team leaders, who always do. */
  autonomy_enabled: boolean;
}

export interface DeptForm {
  id: string;
  name: string;
  name_ko: string;
  name_ja: string;
  name_zh: string;
  icon: string;
  color: string;
  description: string;
  prompt: string;
}
