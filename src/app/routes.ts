import { useCallback, useEffect, useState } from "react";
import {
  BookOpen,
  Brain,
  CalendarDays,
  Laptop,
  Send,
  Bot,
  Building2,
  Clapperboard,
  Inbox,
  ListChecks,
  Receipt,
  Server,
  Settings,
  Store,
  Target,
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
  autonomy: "/autonomy",
  tech: "/tech",
  events: "/events",
  ventures: "/ventures",
  revenue: "/revenue",
  outreach: "/outreach",
  homelab: "/homelab",
  agents: "/team",
  skills: "/team/library",
  model_director: "/team/models",
  vp_decisions: "/team/vp-decisions",
  knowledge: "/team/knowledge",
  office: "/office",
  settings: "/settings",
};

const PATH_TO_VIEW = new Map<string, View>(Object.entries(VIEW_PATHS).map(([view, path]) => [path, view as View]));
/** Old addresses that still work. The Business page was split into Tech Services, Events and Outreach. */
PATH_TO_VIEW.set("/business", "tech");

/** Desktop-only views. On a phone they are left out of navigation and their addresses open Today. */
export const PHONE_HIDDEN_VIEWS: View[] = ["office"];
/** The phone layout's bottom tabs; everything else is in its Menu. */
export const PHONE_TAB_VIEWS: View[] = ["dashboard", "tasks", "autonomy", "revenue"];

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
      const params = new URLSearchParams(window.location.search);
      // The settings tab only means something on the Settings page.
      if (next !== "settings") params.delete("tab");
      const search = params.toString();
      window.history.pushState({ view: next }, "", `${path}${search ? `?${search}` : ""}`);
    }
  }, []);

  return [view, setView];
}

type Localized = { en: string };

export type NavSection = "primary" | "workspaces" | "system";

export interface NavItem {
  view: View;
  icon: LucideIcon;
  section: NavSection;
  label: Localized;
  /** Extra words the command bar matches on. */
  keywords: string;
  /** False for pages reached through another page's tabs (they stay in the command bar). */
  inSidebar?: boolean;
  /** Other views that highlight this sidebar item, e.g. the Team tabs. */
  activeFor?: View[];
}

/** The Team area: one sidebar item, three tabs. */
export const TEAM_VIEWS: View[] = ["agents", "skills", "model_director", "vp_decisions", "knowledge"];

export const NAV_ITEMS: NavItem[] = [
  {
    view: "dashboard",
    icon: Inbox,
    section: "primary",
    label: { en: "Today" },
    keywords: "home dashboard needs you overview decisions running",
  },
  {
    view: "tasks",
    icon: ListChecks,
    section: "primary",
    label: { en: "Work" },
    keywords: "tasks board projects kanban",
  },
  {
    view: "autonomy",
    icon: Target,
    section: "primary",
    label: { en: "Autonomy" },
    keywords: "goals opportunities schedules research ledger digest limits",
  },
  {
    view: "tech",
    icon: Laptop,
    section: "workspaces",
    label: { en: "Tech Services" },
    keywords: "business tickets clients contacts devices repairs small business",
  },
  {
    view: "events",
    icon: CalendarDays,
    section: "workspaces",
    label: { en: "Events and Rentals" },
    keywords: "business rentals quotes party bounce events calendar primrose",
  },
  {
    view: "ventures",
    icon: Store,
    section: "workspaces",
    label: { en: "Ventures" },
    keywords: "business ai etsy shop digital products game assets itch dashboards online store",
  },
  {
    view: "revenue",
    icon: Receipt,
    section: "workspaces",
    label: { en: "Revenue" },
    keywords: "receipts payments costs finance pipeline deals square spending verified",
  },
  {
    view: "outreach",
    icon: Send,
    section: "workspaces",
    label: { en: "Outreach" },
    keywords: "business drafts email social sms marketing promotion do not contact",
  },
  {
    view: "homelab",
    icon: Server,
    section: "workspaces",
    label: { en: "Homelab" },
    keywords: "ssh hosts servers proxmox approvals",
  },
  {
    view: "agents",
    icon: Bot,
    section: "system",
    label: { en: "Team" },
    keywords: "agents staff employees departments hire",
    activeFor: ["skills", "model_director", "vp_decisions", "knowledge"],
  },
  {
    view: "skills",
    icon: BookOpen,
    section: "system",
    inSidebar: false,
    label: { en: "Library" },
    keywords: "skills knowledge learn",
  },
  {
    view: "model_director",
    icon: Clapperboard,
    section: "system",
    inSidebar: false,
    label: { en: "Model Director" },
    keywords: "models routing upgrades llm",
  },
  {
    view: "office",
    icon: Building2,
    section: "system",
    label: { en: "Office" },
    keywords: "map pixel office rooms",
  },
  {
    view: "vp_decisions",
    icon: Bot,
    section: "system",
    inSidebar: false,
    label: { en: "VP decisions" },
    keywords: "vice president reviews approvals audit denials escalations",
  },
  {
    view: "knowledge",
    icon: Brain,
    section: "system",
    inSidebar: false,
    label: { en: "Knowledge" },
    keywords: "memory memories lessons facts systems registry checklist hosts network agents know",
  },
  {
    view: "settings",
    icon: Settings,
    section: "system",
    label: { en: "Settings" },
    keywords: "preferences providers oauth api security password",
  },
];

export const NAV_SECTION_LABELS: Record<Exclude<NavSection, "primary" | "system">, Localized> = {
  workspaces: { en: "Workspaces" },
};
