import { useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  Bot,
  Briefcase,
  Building2,
  Clapperboard,
  Inbox,
  ListChecks,
  Server,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { View } from "./types";

/**
 * Each view has its own address so the browser's back button, bookmarks and reloads land where you were.
 * The server already falls back to index.html for non-API paths.
 */
export const VIEW_PATHS: Record<View, string> = {
  dashboard: "/",
  tasks: "/work",
  business: "/business",
  homelab: "/homelab",
  agents: "/team",
  skills: "/team/library",
  model_director: "/team/models",
  office: "/office",
  settings: "/settings",
};

const PATH_TO_VIEW = new Map<string, View>(Object.entries(VIEW_PATHS).map(([view, path]) => [path, view as View]));

export function viewFromPath(pathname: string): View {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return PATH_TO_VIEW.get(normalized.toLowerCase()) ?? "dashboard";
}

/** Keeps the current view in the address bar. Back and forward move between views. */
export function useViewRoute(): [View, (next: View) => void] {
  const [view, setViewState] = useState<View>(() =>
    typeof window === "undefined" ? "dashboard" : viewFromPath(window.location.pathname),
  );

  useEffect(() => {
    const onPopState = () => setViewState(viewFromPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const setView = useCallback((next: View) => {
    setViewState(next);
    const path = VIEW_PATHS[next];
    if (window.location.pathname !== path) {
      window.history.pushState({ view: next }, "", `${path}${window.location.search}`);
    }
  }, []);

  return [view, setView];
}

type Localized = { ko: string; en: string; ja: string; zh: string };

export type NavSection = "primary" | "workspaces" | "team" | "system";

export interface NavItem {
  view: View;
  icon: LucideIcon;
  section: NavSection;
  label: Localized;
  /** Extra words the command bar matches on. */
  keywords: string;
}

export const NAV_ITEMS: NavItem[] = [
  {
    view: "dashboard",
    icon: Inbox,
    section: "primary",
    label: { ko: "오늘", en: "Today", ja: "今日", zh: "今日" },
    keywords: "home dashboard needs you overview decisions running",
  },
  {
    view: "tasks",
    icon: ListChecks,
    section: "primary",
    label: { ko: "업무", en: "Work", ja: "業務", zh: "工作" },
    keywords: "tasks board projects kanban",
  },
  {
    view: "business",
    icon: Briefcase,
    section: "workspaces",
    label: { ko: "비즈니스", en: "Business", ja: "ビジネス", zh: "业务" },
    keywords: "tech services events rentals outreach clients contacts quotes",
  },
  {
    view: "homelab",
    icon: Server,
    section: "workspaces",
    label: { ko: "홈랩", en: "Homelab", ja: "ホームラボ", zh: "家庭实验室" },
    keywords: "ssh hosts servers proxmox approvals",
  },
  {
    view: "agents",
    icon: Bot,
    section: "team",
    label: { ko: "에이전트", en: "Agents", ja: "エージェント", zh: "代理" },
    keywords: "team staff employees departments",
  },
  {
    view: "skills",
    icon: BookOpen,
    section: "team",
    label: { ko: "문서고", en: "Library", ja: "ライブラリ", zh: "文档库" },
    keywords: "skills knowledge learn",
  },
  {
    view: "model_director",
    icon: Clapperboard,
    section: "team",
    label: { ko: "모델 디렉터", en: "Model Director", ja: "モデルディレクター", zh: "模型主管" },
    keywords: "models routing upgrades llm",
  },
  {
    view: "office",
    icon: Building2,
    section: "system",
    label: { ko: "오피스", en: "Office", ja: "オフィス", zh: "办公室" },
    keywords: "map pixel office rooms",
  },
  {
    view: "settings",
    icon: Settings,
    section: "system",
    label: { ko: "설정", en: "Settings", ja: "設定", zh: "设置" },
    keywords: "preferences providers oauth api security password",
  },
];

export const NAV_SECTION_LABELS: Record<Exclude<NavSection, "primary" | "system">, Localized> = {
  workspaces: { ko: "워크스페이스", en: "Workspaces", ja: "ワークスペース", zh: "工作区" },
  team: { ko: "팀", en: "Team", ja: "チーム", zh: "团队" },
};
