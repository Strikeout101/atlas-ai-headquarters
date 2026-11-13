import { useState } from "react";
import {
  BookOpen,
  Bot,
  Briefcase,
  Building2,
  Clapperboard,
  LayoutDashboard,
  ListChecks,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { Department, Agent, CompanySettings } from "../types";
import { useI18n, localeName } from "../i18n";

type View =
  | "office"
  | "agents"
  | "dashboard"
  | "tasks"
  | "business"
  | "homelab"
  | "model_director"
  | "skills"
  | "settings";

interface SidebarProps {
  currentView: View;
  onChangeView: (v: View) => void;
  departments: Department[];
  agents: Agent[];
  settings: CompanySettings;
  connected: boolean;
}

const NAV_ITEMS: { view: View; icon: LucideIcon }[] = [
  { view: "office", icon: Building2 },
  { view: "agents", icon: Bot },
  { view: "skills", icon: BookOpen },
  { view: "dashboard", icon: LayoutDashboard },
  { view: "tasks", icon: ListChecks },
  { view: "business", icon: Briefcase },
  { view: "homelab", icon: Server },
  { view: "model_director", icon: Clapperboard },
  { view: "settings", icon: Settings },
];

function monogram(name: string): string {
  const letters = name
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("");
  return (letters || name.slice(0, 1) || "A").slice(0, 2).toUpperCase();
}

export default function Sidebar({ currentView, onChangeView, departments, agents, settings, connected }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { t, locale } = useI18n();
  const workingCount = agents.filter((a) => a.status === "working").length;
  const totalAgents = agents.length;

  const tr = (ko: string, en: string, ja = en, zh = en) => t({ ko, en, ja, zh });

  const navLabels: Record<View, string> = {
    office: tr("오피스", "Office", "オフィス", "办公室"),
    agents: tr("직원관리", "Agents", "社員管理", "员工管理"),
    skills: tr("문서고", "Library", "ライブラリ", "文档库"),
    dashboard: tr("대시보드", "Dashboard", "ダッシュボード", "仪表盘"),
    tasks: tr("업무 관리", "Tasks", "タスク管理", "任务管理"),
    business: tr("비즈니스", "Business", "ビジネス", "业务"),
    homelab: tr("홈랩", "Homelab", "ホームラボ", "家庭实验室"),
    model_director: tr("모델 디렉터", "Model Director", "モデルディレクター", "模型主管"),
    settings: tr("설정", "Settings", "設定", "设置"),
  };

  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <aside
      className={`flex h-full flex-col transition-[width] duration-200 ${collapsed ? "w-[60px]" : "w-56"}`}
      style={{ background: "var(--th-bg-sidebar)", borderRight: "1px solid var(--th-border)" }}
    >
      <div className={`flex h-14 items-center gap-2.5 ${collapsed ? "justify-center px-2" : "px-3"}`}>
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] text-[13px] font-semibold"
          style={{ background: "var(--th-text-heading)", color: "var(--th-bg-primary)" }}
          aria-hidden
        >
          {monogram(settings.companyName)}
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-[13px] font-semibold" style={{ color: "var(--th-text-heading)" }}>
              {settings.companyName}
            </div>
            <div className="truncate text-[11px]" style={{ color: "var(--th-text-muted)" }}>
              {settings.ceoName}
            </div>
          </div>
        )}
        {!collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="theme-toggle-btn !h-7 !w-7"
            aria-label={tr("사이드바 접기", "Collapse sidebar")}
          >
            <CollapseIcon size={15} strokeWidth={1.75} />
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pt-1">
        {collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="sidebar-nav-item justify-center !px-0"
            aria-label={tr("사이드바 펼치기", "Expand sidebar")}
          >
            <CollapseIcon size={16} strokeWidth={1.75} />
          </button>
        )}
        {NAV_ITEMS.map(({ view, icon: Icon }) => (
          <button
            key={view}
            type="button"
            onClick={() => onChangeView(view)}
            className={`sidebar-nav-item ${currentView === view ? "active" : ""} ${collapsed ? "justify-center !px-0" : ""}`}
            aria-current={currentView === view ? "page" : undefined}
            title={collapsed ? navLabels[view] : undefined}
          >
            <Icon size={16} strokeWidth={1.75} />
            {!collapsed && <span className="truncate">{navLabels[view]}</span>}
          </button>
        ))}
      </nav>

      {!collapsed && departments.length > 0 && (
        <div className="px-2 pb-2 pt-3" style={{ borderTop: "1px solid var(--th-border)" }}>
          <div className="mb-1 px-2 text-[11px] font-medium" style={{ color: "var(--th-text-muted)" }}>
            {tr("부서", "Departments", "部門", "部门")}
          </div>
          {departments.map((d) => {
            const deptAgents = agents.filter((a) => a.department_id === d.id);
            const working = deptAgents.filter((a) => a.status === "working").length;
            return (
              <div
                key={d.id}
                className="flex h-7 items-center gap-2 rounded-md px-2 text-[12px]"
                style={{ color: "var(--th-text-secondary)" }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: working > 0 ? "var(--ax-working)" : "var(--ax-idle)" }}
                />
                <span className="flex-1 truncate">{localeName(locale, d)}</span>
                <span
                  className="tabular-nums"
                  style={{ color: working > 0 ? "var(--th-text-primary)" : "var(--th-text-muted)" }}
                >
                  {working}/{deptAgents.length}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div
        className={`flex h-10 items-center gap-2 text-[11px] ${collapsed ? "justify-center" : "px-4"}`}
        style={{ borderTop: "1px solid var(--th-border)", color: "var(--th-text-muted)" }}
        title={connected ? undefined : tr("서버 연결 끊김", "Server disconnected")}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: connected ? "var(--ax-working)" : "var(--ax-danger)" }}
        />
        {!collapsed && (
          <span className="truncate">
            {connected
              ? tr(
                  `${workingCount}/${totalAgents} 근무중`,
                  `${workingCount} of ${totalAgents} agents working`,
                  `${workingCount}/${totalAgents} 稼働中`,
                  `${workingCount}/${totalAgents} 工作中`,
                )
              : tr("연결 끊김", "Disconnected", "接続なし", "已断开")}
          </span>
        )}
      </div>
    </aside>
  );
}
