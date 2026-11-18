import { useState } from "react";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import type { Department, Agent, CompanySettings } from "../types";
import { useI18n, localeName } from "../i18n";
import type { View } from "../app/types";
import { NAV_ITEMS, NAV_SECTION_LABELS, type NavItem } from "../app/routes";

interface SidebarProps {
  currentView: View;
  onChangeView: (v: View) => void;
  departments: Department[];
  agents: Agent[];
  settings: CompanySettings;
  connected: boolean;
  /** Items waiting on the owner; shown as a badge on Today. */
  needsYouCount?: number;
  onOpenCommandBar?: () => void;
  /** Views left out of the list, e.g. the Office on a phone. */
  hiddenViews?: View[];
}

function monogram(name: string): string {
  const letters = name
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("");
  return (letters || name.slice(0, 1) || "A").slice(0, 2).toUpperCase();
}

export default function Sidebar({
  currentView,
  onChangeView,
  departments,
  agents,
  settings,
  connected,
  needsYouCount = 0,
  onOpenCommandBar,
  hiddenViews,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { t, locale } = useI18n();
  const workingCount = agents.filter((a) => a.status === "working").length;
  const totalAgents = agents.length;

  const tr = (en: string) => t({ en });

  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  const sidebarItems = NAV_ITEMS.filter(
    (item) => item.inSidebar !== false && !(hiddenViews?.includes(item.view) ?? false),
  );
  const renderItem = ({ view, icon: Icon, label, activeFor }: NavItem) => {
    const text = t(label);
    const isActive = currentView === view || (activeFor?.includes(currentView) ?? false);
    const badge = view === "dashboard" && needsYouCount > 0 ? needsYouCount : 0;
    return (
      <button
        key={view}
        type="button"
        onClick={() => onChangeView(view)}
        className={`sidebar-nav-item ${isActive ? "active" : ""} ${collapsed ? "justify-center !px-0" : ""}`}
        aria-current={isActive ? "page" : undefined}
        title={collapsed ? text : undefined}
      >
        <span className="relative flex">
          <Icon size={16} strokeWidth={1.75} />
          {collapsed && badge > 0 && (
            <span
              className="absolute -right-1 -top-1 h-2 w-2 rounded-full"
              style={{ background: "var(--ax-signal)" }}
              aria-hidden
            />
          )}
        </span>
        {!collapsed && <span className="flex-1 truncate text-left">{text}</span>}
        {!collapsed && badge > 0 && (
          <span
            className="min-w-[20px] rounded-full px-1.5 text-center text-[11px] font-semibold tabular-nums leading-5"
            style={{ background: "var(--ax-signal)", color: "var(--ax-signal-ink)" }}
            aria-label={tr(`${badge} waiting`)}
          >
            {badge}
          </span>
        )}
      </button>
    );
  };

  const sectionHeading = (key: keyof typeof NAV_SECTION_LABELS) =>
    collapsed ? (
      <div className="mx-2 my-2 h-px" style={{ background: "var(--th-border)" }} aria-hidden />
    ) : (
      <div className="mb-1 mt-4 px-2.5 text-[11px] font-medium" style={{ color: "var(--th-text-muted)" }}>
        {t(NAV_SECTION_LABELS[key])}
      </div>
    );

  return (
    <aside
      className={`flex h-full flex-col transition-[width] duration-200 ${collapsed ? "w-[60px]" : "w-60"}`}
      style={{ background: "var(--th-bg-sidebar)", borderRight: "1px solid var(--th-border)" }}
    >
      <div className={`flex h-14 items-center gap-2.5 ${collapsed ? "justify-center px-2" : "px-3"}`}>
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] text-[13px] font-semibold"
          style={{ background: "var(--ax-signal)", color: "var(--ax-signal-ink)" }}
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
            aria-label={tr("Collapse sidebar")}
          >
            <CollapseIcon size={15} strokeWidth={1.75} />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-2 pt-1" aria-label={tr("Main")}>
        {collapsed && (
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            className="sidebar-nav-item justify-center !px-0"
            aria-label={tr("Expand sidebar")}
          >
            <CollapseIcon size={16} strokeWidth={1.75} />
          </button>
        )}
        {onOpenCommandBar && (
          <button
            type="button"
            onClick={onOpenCommandBar}
            className={`sidebar-nav-item mb-2 ${collapsed ? "justify-center !px-0" : ""}`}
            style={{ boxShadow: "inset 0 0 0 1px var(--th-border)" }}
            title={collapsed ? tr("Search and jump") : undefined}
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Search size={15} strokeWidth={1.75} />
            {!collapsed && (
              <>
                <span className="flex-1 truncate text-left" style={{ color: "var(--th-text-muted)" }}>
                  {tr("Search and jump")}
                </span>
                <kbd
                  className="rounded px-1.5 font-mono text-[10.5px]"
                  style={{ border: "1px solid var(--th-border)", color: "var(--th-text-muted)" }}
                >
                  Ctrl K
                </kbd>
              </>
            )}
          </button>
        )}

        <div className="space-y-0.5">{sidebarItems.filter((item) => item.section === "primary").map(renderItem)}</div>
        {sectionHeading("workspaces")}
        <div className="space-y-0.5">
          {sidebarItems.filter((item) => item.section === "workspaces").map(renderItem)}
        </div>
        <div className="mx-2 my-3 h-px" style={{ background: "var(--th-border)" }} aria-hidden />
        <div className="space-y-0.5">{sidebarItems.filter((item) => item.section === "system").map(renderItem)}</div>
      </nav>

      {!collapsed && departments.length > 0 && (
        <div
          className="max-h-[30vh] overflow-y-auto px-2 pb-2 pt-3"
          style={{ borderTop: "1px solid var(--th-border)" }}
        >
          <div className="mb-1 px-2 text-[11px] font-medium" style={{ color: "var(--th-text-muted)" }}>
            {tr("Departments")}
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
        title={connected ? undefined : tr("Server disconnected")}
      >
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: connected ? "var(--ax-working)" : "var(--ax-danger)" }}
        />
        {!collapsed && (
          <span className="truncate">
            {connected ? tr(`${workingCount} of ${totalAgents} agents working`) : tr("Disconnected")}
          </span>
        )}
      </div>
    </aside>
  );
}
