import { Building, FileText, ListChecks, Loader2, Megaphone, Menu, Moon, Signpost, Sun, Wrench } from "lucide-react";
import type { WorkflowPackKey } from "../types";
import type { View } from "./types";

type OfficePackOption = {
  key: WorkflowPackKey;
  label: string;
  summary: string;
  slug: string;
  accent: number;
};

interface AppHeaderBarProps {
  currentView: View;
  connected: boolean;
  viewTitle: string;
  tasksPrimaryLabel: string;
  decisionLabel: string;
  decisionInboxLoading: boolean;
  decisionInboxCount: number;
  agentStatusLabel: string;
  reportLabel: string;
  announcementLabel: string;
  roomManagerLabel: string;
  officePackControl?: {
    label: string;
    value: WorkflowPackKey;
    options: OfficePackOption[];
    onChange: (packKey: WorkflowPackKey) => void;
  } | null;
  theme: "light" | "dark";
  mobileHeaderMenuOpen: boolean;
  onOpenMobileNav: () => void;
  onOpenTasks: () => void;
  onOpenDecisionInbox: () => void;
  onOpenAgentStatus: () => void;
  onOpenReportHistory: () => void;
  onOpenAnnouncement: () => void;
  onOpenRoomManager: () => void;
  onToggleTheme: () => void;
  onToggleMobileHeaderMenu: () => void;
  onCloseMobileHeaderMenu: () => void;
}

export default function AppHeaderBar({
  currentView,
  connected,
  viewTitle,
  tasksPrimaryLabel,
  decisionLabel,
  decisionInboxLoading,
  decisionInboxCount,
  agentStatusLabel,
  reportLabel,
  announcementLabel,
  roomManagerLabel,
  officePackControl,
  theme,
  mobileHeaderMenuOpen,
  onOpenMobileNav,
  onOpenTasks,
  onOpenDecisionInbox,
  onOpenAgentStatus,
  onOpenReportHistory,
  onOpenAnnouncement,
  onOpenRoomManager,
  onToggleTheme,
  onToggleMobileHeaderMenu,
  onCloseMobileHeaderMenu,
}: AppHeaderBarProps) {
  return (
    <header
      className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 px-3 backdrop-blur-md sm:px-4 lg:px-6"
      style={{ borderBottom: "1px solid var(--th-border)", background: "var(--th-bg-header)" }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={onOpenMobileNav}
          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition lg:hidden"
          style={{
            border: "1px solid var(--th-border)",
            background: "var(--th-bg-surface)",
            color: "var(--th-text-secondary)",
          }}
          aria-label="Open navigation"
        >
          <Menu size={16} strokeWidth={1.75} />
        </button>
        <h1
          className="flex items-center gap-2 truncate text-[15px] font-semibold"
          style={{ color: "var(--th-text-heading)" }}
        >
          <span className="truncate">{viewTitle}</span>
        </h1>
        {officePackControl && (
          <label
            className="hidden xl:flex items-center gap-2 rounded-lg px-2 py-1"
            style={{ border: "1px solid var(--th-border)", background: "var(--th-bg-surface)" }}
          >
            <span className="text-[11.5px] font-medium" style={{ color: "var(--th-text-muted)" }}>
              {officePackControl.label}
            </span>
            <select
              value={officePackControl.value}
              onChange={(e) => officePackControl.onChange(e.target.value as WorkflowPackKey)}
              className="min-w-[170px] bg-transparent text-xs font-medium focus:outline-none"
              style={{ color: "var(--th-text-primary)" }}
            >
              {officePackControl.options.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.slug} · {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="flex items-center gap-1 sm:gap-1.5">
        <button
          onClick={onOpenTasks}
          className="header-action-btn header-action-btn-primary"
          aria-label={tasksPrimaryLabel}
        >
          <ListChecks size={15} strokeWidth={2} />
          <span className="hidden sm:inline">{tasksPrimaryLabel}</span>
        </button>
        <button
          onClick={onOpenDecisionInbox}
          disabled={decisionInboxLoading}
          className={`header-action-btn header-action-btn-secondary disabled:cursor-wait disabled:opacity-60${
            decisionInboxCount > 0 ? " decision-has-pending" : ""
          }`}
          aria-label={decisionLabel}
        >
          {decisionInboxLoading ? (
            <Loader2 size={15} strokeWidth={1.75} className="animate-spin" />
          ) : (
            <Signpost size={15} strokeWidth={1.75} />
          )}
          <span className="hidden sm:inline">{decisionLabel}</span>
          {decisionInboxCount > 0 && <span className="header-decision-badge">{decisionInboxCount}</span>}
        </button>
        <button onClick={onOpenAgentStatus} className="header-action-btn header-action-btn-secondary mobile-hidden">
          <Wrench size={15} strokeWidth={1.75} />
          {agentStatusLabel}
        </button>
        <button onClick={onOpenReportHistory} className="header-action-btn header-action-btn-secondary mobile-hidden">
          <FileText size={15} strokeWidth={1.75} />
          {reportLabel}
        </button>
        <button onClick={onOpenAnnouncement} className="header-action-btn header-action-btn-secondary">
          <Megaphone size={15} strokeWidth={1.75} />
          <span className="hidden sm:inline">{announcementLabel}</span>
        </button>
        <button onClick={onOpenRoomManager} className="header-action-btn header-action-btn-secondary mobile-hidden">
          <Building size={15} strokeWidth={1.75} />
          {roomManagerLabel}
        </button>
        <button
          onClick={onToggleTheme}
          className="theme-toggle-btn"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          title={theme === "dark" ? "라이트 모드" : "다크 모드"}
        >
          <span className="theme-toggle-icon">
            {theme === "dark" ? <Moon size={16} strokeWidth={1.75} /> : <Sun size={16} strokeWidth={1.75} />}
          </span>
        </button>
        <div className="relative sm:hidden">
          <button
            onClick={onToggleMobileHeaderMenu}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg transition"
            style={{
              border: "1px solid var(--th-border)",
              background: "var(--th-bg-surface)",
              color: "var(--th-text-secondary)",
            }}
            aria-label="더보기 메뉴"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="5" r="1" />
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="19" r="1" />
            </svg>
          </button>
          {mobileHeaderMenuOpen && (
            <>
              <button className="fixed inset-0 z-40" onClick={onCloseMobileHeaderMenu} aria-label="Close menu" />
              <div
                className="absolute right-0 top-full z-50 mt-1 min-w-[180px] rounded-lg py-1 shadow-lg"
                style={{ border: "1px solid var(--th-border)", background: "var(--th-bg-surface)" }}
              >
                {officePackControl && (
                  <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--th-border)" }}>
                    <label
                      htmlFor="mobile-office-pack-selector"
                      className="mb-1 block text-[11.5px] font-medium"
                      style={{ color: "var(--th-text-muted)" }}
                    >
                      {officePackControl.label}
                    </label>
                    <select
                      id="mobile-office-pack-selector"
                      value={officePackControl.value}
                      onChange={(e) => {
                        officePackControl.onChange(e.target.value as WorkflowPackKey);
                        onCloseMobileHeaderMenu();
                      }}
                      className="w-full rounded-md px-2 py-1.5 text-xs focus:outline-none"
                      style={{
                        border: "1px solid var(--th-border)",
                        background: "var(--th-bg-elevated)",
                        color: "var(--th-text-primary)",
                      }}
                    >
                      {officePackControl.options.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.slug} · {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                <button
                  onClick={() => {
                    onOpenAgentStatus();
                    onCloseMobileHeaderMenu();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:opacity-80"
                  style={{ color: "var(--th-text-primary)" }}
                >
                  <Wrench size={15} strokeWidth={1.75} />
                  {agentStatusLabel}
                </button>
                <button
                  onClick={() => {
                    onOpenReportHistory();
                    onCloseMobileHeaderMenu();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:opacity-80"
                  style={{ color: "var(--th-text-primary)" }}
                >
                  {reportLabel}
                </button>
                <button
                  onClick={() => {
                    onOpenRoomManager();
                    onCloseMobileHeaderMenu();
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:opacity-80"
                  style={{ color: "var(--th-text-primary)" }}
                >
                  {roomManagerLabel}
                </button>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: connected ? "var(--ax-working)" : "var(--ax-danger)" }}
          />
          <span className="hidden sm:inline">{connected ? "Live" : "Offline"}</span>
        </div>
      </div>
    </header>
  );
}
