import {
  Building,
  FileText,
  Loader2,
  Megaphone,
  Menu,
  Moon,
  MoreHorizontal,
  Search,
  Signpost,
  Sun,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import type { View } from "./types";
import { EmergencyButtons } from "../components/control/EmergencyControls";

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
  onOpenCommandBar?: () => void;
  commandBarLabel?: string;
  moreLabel?: string;
}

const quietIconButtonStyle = {
  border: "1px solid var(--th-border)",
  background: "var(--th-bg-surface)",
  color: "var(--th-text-secondary)",
};

export default function AppHeaderBar({
  currentView,
  connected,
  viewTitle,
  decisionLabel,
  decisionInboxLoading,
  decisionInboxCount,
  agentStatusLabel,
  reportLabel,
  announcementLabel,
  roomManagerLabel,
  theme,
  mobileHeaderMenuOpen,
  onOpenMobileNav,
  onOpenDecisionInbox,
  onOpenAgentStatus,
  onOpenReportHistory,
  onOpenAnnouncement,
  onOpenRoomManager,
  onToggleTheme,
  onToggleMobileHeaderMenu,
  onCloseMobileHeaderMenu,
  onOpenCommandBar,
  commandBarLabel = "Search and jump",
  moreLabel = "More",
}: AppHeaderBarProps) {
  const menuItem = (icon: ReactNode, label: string, onClick: () => void) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onClick();
        onCloseMobileHeaderMenu();
      }}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] transition hover:bg-[var(--th-bg-surface-hover,var(--th-bg-elevated))]"
      style={{ color: "var(--th-text-primary)" }}
    >
      <span style={{ color: "var(--th-text-muted)" }}>{icon}</span>
      {label}
    </button>
  );

  return (
    <header
      className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 px-3 backdrop-blur-md sm:px-4 lg:px-6"
      style={{ borderBottom: "1px solid var(--th-border)", background: "var(--th-bg-header)" }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onOpenMobileNav}
          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition lg:hidden"
          style={quietIconButtonStyle}
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
      </div>

      <div className="flex items-center gap-1 sm:gap-1.5">
        <EmergencyButtons />
        {onOpenCommandBar && (
          <button
            type="button"
            onClick={onOpenCommandBar}
            className="inline-flex h-8 items-center gap-2 rounded-lg px-2 text-[12.5px] transition hover:opacity-90 sm:px-2.5 lg:hidden"
            style={quietIconButtonStyle}
            aria-label={commandBarLabel}
            aria-keyshortcuts="Control+K Meta+K"
          >
            <Search size={15} strokeWidth={1.75} />
          </button>
        )}
        <button
          type="button"
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
        {currentView === "office" && (
          <button
            type="button"
            onClick={onOpenRoomManager}
            className="header-action-btn header-action-btn-secondary mobile-hidden"
          >
            <Building size={15} strokeWidth={1.75} />
            {roomManagerLabel}
          </button>
        )}
        <button
          type="button"
          onClick={onOpenAnnouncement}
          className="header-action-btn header-action-btn-primary"
          aria-label={announcementLabel}
        >
          <Megaphone size={15} strokeWidth={1.75} />
          <span className="hidden sm:inline">{announcementLabel}</span>
        </button>

        <div className="relative">
          <button
            type="button"
            onClick={onToggleMobileHeaderMenu}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg transition"
            style={quietIconButtonStyle}
            aria-label={moreLabel}
            aria-haspopup="menu"
            aria-expanded={mobileHeaderMenuOpen}
          >
            <MoreHorizontal size={16} strokeWidth={1.75} />
          </button>
          {mobileHeaderMenuOpen && (
            <>
              <button
                type="button"
                className="fixed inset-0 z-40 cursor-default"
                onClick={onCloseMobileHeaderMenu}
                aria-label="Close menu"
              />
              <div
                role="menu"
                className="absolute right-0 top-full z-50 mt-1 min-w-[220px] overflow-hidden rounded-lg py-1 shadow-lg"
                style={{ border: "1px solid var(--th-border)", background: "var(--th-bg-elevated)" }}
              >
                {menuItem(<Wrench size={15} strokeWidth={1.75} />, agentStatusLabel, onOpenAgentStatus)}
                {menuItem(<FileText size={15} strokeWidth={1.75} />, reportLabel, onOpenReportHistory)}
                {menuItem(<Building size={15} strokeWidth={1.75} />, roomManagerLabel, onOpenRoomManager)}
                {menuItem(
                  theme === "dark" ? <Sun size={15} strokeWidth={1.75} /> : <Moon size={15} strokeWidth={1.75} />,
                  theme === "dark" ? "Light mode" : "Dark mode",
                  onToggleTheme,
                )}
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          onClick={onToggleTheme}
          className="theme-toggle-btn mobile-hidden"
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          <span className="theme-toggle-icon">
            {theme === "dark" ? <Moon size={16} strokeWidth={1.75} /> : <Sun size={16} strokeWidth={1.75} />}
          </span>
        </button>
        <div className="flex items-center gap-2 pl-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
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
