import type { OAuthAccountInfo } from "../../api";
import type { UiLanguage } from "../../i18n";

export type Locale = UiLanguage;
export type TFunction = (messages: Record<Locale, string>) => string;

export function roleLabel(role: string, t: TFunction) {
  switch (role) {
    case "team_leader":
      return t({ en: "Team Leader" });
    case "senior":
      return t({ en: "Senior" });
    case "junior":
      return t({ en: "Junior" });
    case "intern":
      return t({ en: "Intern" });
    default:
      return role;
  }
}

function hashSubAgentId(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function getSubAgentSpriteNum(subAgentId: string): number {
  return (hashSubAgentId(`${subAgentId}:clone`) % 13) + 1;
}

export const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  idle: { label: "idle", color: "text-green-400", bg: "bg-green-500/20" },
  working: { label: "working", color: "text-blue-400", bg: "bg-blue-500/20" },
  break: { label: "break", color: "text-yellow-400", bg: "bg-yellow-500/20" },
  offline: {
    label: "offline",
    color: "text-slate-400",
    bg: "bg-slate-500/20",
  },
};

export const CLI_LABELS: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex CLI",
  gemini: "Antigravity CLI / Gemini CLI",
  opencode: "OpenCode",
  kimi: "Kimi Code",
  copilot: "GitHub Copilot",
  antigravity: "Antigravity OAuth",
  api: "API Provider",
};

export const SUBTASK_STATUS_ICON: Record<string, string> = {
  pending: "\u23F3",
  in_progress: "\uD83D\uDD28",
  done: "\u2705",
  blocked: "\uD83D\uDEAB",
};

export function oauthAccountLabel(account: OAuthAccountInfo): string {
  return account.label || account.email || account.id.slice(0, 8);
}

export function statusLabel(status: string, t: TFunction) {
  switch (status) {
    case "idle":
      return t({ en: "Idle" });
    case "working":
      return t({ en: "Working" });
    case "break":
      return t({ en: "Break" });
    case "offline":
      return t({ en: "Offline" });
    default:
      return status;
  }
}

export function taskStatusLabel(status: string, t: TFunction) {
  switch (status) {
    case "inbox":
      return t({ en: "Inbox" });
    case "planned":
      return t({ en: "Planned" });
    case "in_progress":
      return t({ en: "In Progress" });
    case "review":
      return t({ en: "Review" });
    case "done":
      return t({ en: "Done" });
    case "pending":
      return t({ en: "Pending" });
    case "cancelled":
      return t({ en: "Cancelled" });
    default:
      return status;
  }
}

export function taskTypeLabel(type: string, t: TFunction) {
  switch (type) {
    case "general":
      return t({ en: "General" });
    case "development":
      return t({ en: "Development" });
    case "design":
      return t({ en: "Design" });
    case "analysis":
      return t({ en: "Analysis" });
    case "presentation":
      return t({ en: "Presentation" });
    case "documentation":
      return t({ en: "Documentation" });
    default:
      return type;
  }
}
