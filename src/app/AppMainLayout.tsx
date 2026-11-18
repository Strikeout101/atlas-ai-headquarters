import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  Building,
  FileText,
  ListChecks,
  Megaphone,
  MessageSquare,
  Moon,
  Settings,
  Signpost,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import Sidebar from "../components/Sidebar";
import OfficeView from "../components/OfficeView";
import ReferenceOfficeView from "../components/ReferenceOfficeView";
import Dashboard from "../components/Dashboard";
import TaskBoard from "../components/TaskBoard";
import AgentManager from "../components/AgentManager";
import SkillsLibrary from "../components/SkillsLibrary";
import SettingsPanel from "../components/SettingsPanel";
import { I18nProvider, localeName, pickLang } from "../i18n";
import CommandPalette, { type CommandItem } from "../components/command/CommandPalette";
import TodayView from "../components/today/TodayView";
import TaskDrawer from "../components/work/TaskDrawer";
import TeamTabs from "../components/team/TeamTabs";
import RevenueWorkspace from "../components/revenue/RevenueWorkspace";
import AutonomyWorkspace from "../components/autonomy/AutonomyWorkspace";
import VpDecisions from "../components/team/VpDecisions";
import KnowledgeTab from "../components/team/KnowledgeTab";
import { SETTINGS_TAB_EVENT, type SettingsTab } from "../components/settings/types";
import type { DecisionInboxItem } from "../components/chat/decision-inbox";
import { NAV_ITEMS, PHONE_HIDDEN_VIEWS, TEAM_VIEWS, VIEW_PATHS } from "./routes";
import { usePhoneLayout } from "./usePhoneLayout";
import PhoneTabBar from "./PhoneTabBar";
import NavigationDrawer from "./NavigationDrawer";
import { usePendingApprovals } from "./usePendingApprovals";
import { useReadyDrafts } from "./useReadyDrafts";
import { decidePendingApproval, type PendingApproval, type UpdateStatus } from "../api";
import type {
  Agent,
  CeoOfficeCall,
  CliStatusMap,
  CompanyStats,
  CompanySettings,
  CrossDeptDelivery,
  Department,
  MeetingPresence,
  SubAgent,
  SubTask,
  Task,
} from "../types";
import type { OAuthCallbackResult, RoomThemeMap, View } from "./types";
import AppHeaderBar from "./AppHeaderBar";
import { DEFAULT_OFFICE_POSE } from "../components/atlas-office/layout";
import BusinessWorkspace from "../components/BusinessWorkspace";
import HomelabWorkspace from "../components/HomelabWorkspace";
import { EmergencyBanner } from "../components/control/EmergencyControls";
import ListingsPanel from "../components/listings/ListingsPanel";
import ModelDirectorWorkspace from "../components/ModelDirectorWorkspace";

const AtlasOffice = lazy(() => import("../components/atlas-office/AtlasOffice"));

type OfficeRenderer = "reference" | "original" | "atlas";
const OFFICE_RENDERER_STORAGE_KEY = "atlas.officeRenderer";

function readStoredOfficeRenderer(): OfficeRenderer {
  try {
    const stored = window.localStorage.getItem(OFFICE_RENDERER_STORAGE_KEY);
    if (stored === "reference" || stored === "original" || stored === "atlas") return stored;
  } catch {
    // Fall through to the default view.
  }
  return "reference";
}

interface AppMainLayoutLabels {
  uiLanguage: string;
  viewTitle: string;
  announcementLabel: string;
  roomManagerLabel: string;
  roomManagerDepartments: { id: string; name: string }[];
  reportLabel: string;
  tasksPrimaryLabel: string;
  agentStatusLabel: string;
  decisionLabel: string;
  autoUpdateNoticeVisible: boolean;
  autoUpdateNoticeTitle: string;
  autoUpdateNoticeHint: string;
  autoUpdateNoticeActionLabel: string;
  autoUpdateNoticeContainerClass: string;
  autoUpdateNoticeTextClass: string;
  autoUpdateNoticeHintClass: string;
  autoUpdateNoticeButtonClass: string;
  effectiveUpdateStatus: UpdateStatus | null;
  updateBannerVisible: boolean;
  updateReleaseUrl: string;
  updateTitle: string;
  updateHint: string;
  updateReleaseLabel: string;
  updateDismissLabel: string;
  updateTestModeHint: string;
}

interface AppMainLayoutProps {
  connected: boolean;
  view: View;
  setView: (view: View) => void;
  departments: Department[];
  agents: Agent[];
  stats: CompanyStats | null;
  tasks: Task[];
  subtasks: SubTask[];
  subAgents: SubAgent[];
  meetingPresence: MeetingPresence[];
  settings: CompanySettings;
  cliStatus: CliStatusMap | null;
  oauthResult: OAuthCallbackResult | null;
  labels: AppMainLayoutLabels;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
  mobileHeaderMenuOpen: boolean;
  setMobileHeaderMenuOpen: (open: boolean) => void;
  theme: "light" | "dark";
  toggleTheme: () => void;
  decisionInboxLoading: boolean;
  decisionInboxCount: number;
  decisionInboxItems?: DecisionInboxItem[];
  onOpenChat?: (agent: Agent) => void;
  activeMeetingTaskId: string | null;
  unreadAgentIds: Set<string>;
  crossDeptDeliveries: CrossDeptDelivery[];
  ceoOfficeCalls: CeoOfficeCall[];
  customRoomThemes: RoomThemeMap;
  activeRoomThemeTargetId: string | null;
  onCrossDeptDeliveryProcessed: (id: string) => void;
  onCeoOfficeCallProcessed: (id: string) => void;
  onOpenActiveMeetingMinutes: (taskId: string) => void;
  onSelectAgent: (agent: Agent) => void;
  onSelectDepartment: (department: Department) => void;
  onCreateTask: (input: {
    title: string;
    description?: string;
    department_id?: string;
    task_type?: string;
    priority?: number;
    project_id?: string;
    project_path?: string;
    assigned_agent_id?: string;
  }) => Promise<void>;
  onUpdateTask: (id: string, data: Partial<Task>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  onAssignTask: (taskId: string, agentId: string) => Promise<void>;
  onRunTask: (id: string) => Promise<void>;
  onStopTask: (id: string) => Promise<void>;
  onPauseTask: (id: string) => Promise<void>;
  onResumeTask: (id: string) => Promise<void>;
  onOpenTerminal: (taskId: string) => void;
  onOpenMeetingMinutes: (taskId: string) => void;
  onOpenTaskReport?: (taskId: string) => void;
  onAgentsChange: () => void;
  onSaveSettings: (settings: CompanySettings) => Promise<void>;
  onRefreshCli: () => Promise<void>;
  onOauthResultClear: () => void;
  onOpenDecisionInbox: () => void;
  onOpenAgentStatus: () => void;
  onOpenReportHistory: () => void;
  onOpenAnnouncement: () => void;
  onOpenRoomManager: () => void;
  onDismissAutoUpdateNotice: () => Promise<void>;
  onDismissUpdate: () => void;
  children?: ReactNode;
}

export default function AppMainLayout({
  connected,
  view,
  setView,
  departments,
  agents,
  stats,
  tasks,
  subtasks,
  subAgents,
  meetingPresence,
  settings,
  cliStatus,
  oauthResult,
  labels,
  mobileNavOpen,
  setMobileNavOpen,
  mobileHeaderMenuOpen,
  setMobileHeaderMenuOpen,
  theme,
  toggleTheme,
  decisionInboxLoading,
  decisionInboxCount,
  decisionInboxItems = [],
  onOpenChat,
  activeMeetingTaskId,
  unreadAgentIds,
  crossDeptDeliveries,
  ceoOfficeCalls,
  customRoomThemes,
  activeRoomThemeTargetId,
  onCrossDeptDeliveryProcessed,
  onCeoOfficeCallProcessed,
  onOpenActiveMeetingMinutes,
  onSelectAgent,
  onSelectDepartment,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onAssignTask,
  onRunTask,
  onStopTask,
  onPauseTask,
  onResumeTask,
  onOpenTerminal,
  onOpenMeetingMinutes,
  onOpenTaskReport,
  onAgentsChange,
  onSaveSettings,
  onRefreshCli,
  onOauthResultClear,
  onOpenDecisionInbox,
  onOpenAgentStatus,
  onOpenReportHistory,
  onOpenAnnouncement,
  onOpenRoomManager,
  onDismissAutoUpdateNotice,
  onDismissUpdate,
  children,
}: AppMainLayoutProps) {
  const [officeRenderer, setOfficeRendererState] = useState<OfficeRenderer>(readStoredOfficeRenderer);
  const setOfficeRenderer = useCallback((next: OfficeRenderer) => {
    setOfficeRendererState(next);
    try {
      window.localStorage.setItem(OFFICE_RENDERER_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice then lasts for this session only.
    }
  }, []);
  const [executiveDesktopOpen, setExecutiveDesktopOpen] = useState(false);
  // Phones get the dashboard only: no Office in navigation, and its address opens Today instead.
  const phone = usePhoneLayout();
  const hiddenViews = phone ? PHONE_HIDDEN_VIEWS : undefined;
  const viewUnavailable = phone && PHONE_HIDDEN_VIEWS.includes(view);
  useEffect(() => {
    if (!viewUnavailable) return;
    // Replace the address so the back button does not land on the hidden page again.
    window.history.replaceState(window.history.state, "", `${VIEW_PATHS.dashboard}${window.location.search}`);
    setExecutiveDesktopOpen(false);
    setView("dashboard");
  }, [viewUnavailable, setView]);
  const officePose = useMemo(() => ({ ...DEFAULT_OFFICE_POSE }), []);
  const handleViewChange = useCallback(
    (nextView: View) => {
      if (nextView === "office") setExecutiveDesktopOpen(false);
      setView(nextView);
    },
    [setView],
  );
  useEffect(() => {
    if (!executiveDesktopOpen || view === "office") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector('[role="dialog"]')) return;
      setExecutiveDesktopOpen(false);
      setView("office");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [executiveDesktopOpen, setView, view]);
  const uiLanguage = "en";
  const officePresentation = useMemo(
    () => ({ departments, agents, roomThemes: customRoomThemes }),
    [departments, agents, customRoomThemes],
  );

  const [commandBarOpen, setCommandBarOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandBarOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const reviewCount = useMemo(() => tasks.filter((task) => task.status === "review").length, [tasks]);
  const pendingApprovals = usePendingApprovals(true);
  const { refresh: refreshApprovals, setItems: setApprovalItems } = pendingApprovals;
  useEffect(() => {
    if (view === "dashboard") void refreshApprovals();
  }, [view, refreshApprovals]);
  const handleDecideApproval = useCallback(
    async (item: PendingApproval, approve: boolean) => {
      await decidePendingApproval(item, approve);
      setApprovalItems((prev) => prev.filter((p) => !(p.kind === item.kind && p.id === item.id)));
      void refreshApprovals();
    },
    [setApprovalItems, refreshApprovals],
  );

  // The task drawer. Its task id lives in the address (?task=...) so a link or reload reopens it.
  const [openTaskId, setOpenTaskId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("task"),
  );
  const openTask = useCallback((taskId: string | null) => {
    setOpenTaskId(taskId);
    const url = new URL(window.location.href);
    if (taskId) url.searchParams.set("task", taskId);
    else url.searchParams.delete("task");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  useEffect(() => {
    const onPopState = () => setOpenTaskId(new URLSearchParams(window.location.search).get("task"));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const openTaskRecord = useMemo(
    () => (openTaskId ? (tasks.find((task) => task.id === openTaskId) ?? null) : null),
    [openTaskId, tasks],
  );
  const openTaskSubtasks = useMemo(
    () => (openTaskId ? subtasks.filter((subtask) => subtask.task_id === openTaskId) : []),
    [openTaskId, subtasks],
  );
  const openTaskApprovals = useMemo(
    () => (openTaskId ? pendingApprovals.items.filter((item) => item.task_id === openTaskId) : []),
    [openTaskId, pendingApprovals.items],
  );
  const readyDrafts = useReadyDrafts(true);
  const refreshReadyDrafts = readyDrafts.refresh;
  useEffect(() => {
    if (view === "dashboard") void refreshReadyDrafts();
  }, [view, refreshReadyDrafts]);
  const needsYouCount = pendingApprovals.items.length + decisionInboxCount + reviewCount + readyDrafts.items.length;
  const tr = useCallback((text: { en: string }) => pickLang(uiLanguage, text), [uiLanguage]);

  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = NAV_ITEMS.filter((item) => !(hiddenViews?.includes(item.view) ?? false)).map(
      ({ view: target, icon: Icon, label, keywords }) => ({
        id: `nav:${target}`,
        group: "navigate" as const,
        label: tr(label),
        icon: <Icon size={15} strokeWidth={1.75} />,
        keywords: `${keywords} ${label.en}`,
        run: () => handleViewChange(target),
      }),
    );
    const settingsTabs: Array<[SettingsTab, { en: string }, string]> = [
      ["general", { en: "General" }, "company name language preferences"],
      ["security", { en: "Security" }, "password login trusted networks sign out"],
      ["cli", { en: "CLI tools" }, "claude codex gemini opencode"],
      ["oauth", { en: "OAuth" }, "accounts sign in providers"],
      ["api", { en: "API" }, "providers ollama models keys"],
      ["gateway", { en: "Channels" }, "telegram discord messenger"],
    ];
    for (const [tab, label, keywords] of settingsTabs) {
      items.push({
        id: `settings:${tab}`,
        group: "navigate",
        label: `${tr({ en: "Settings" })} › ${tr(label)}`,
        icon: <Settings size={15} strokeWidth={1.75} />,
        keywords: `settings ${keywords}`,
        run: () => {
          const url = new URL(window.location.href);
          url.searchParams.set("tab", tab);
          window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}`);
          handleViewChange("settings");
          window.dispatchEvent(new CustomEvent(SETTINGS_TAB_EVENT, { detail: tab }));
        },
      });
    }
    const action = (id: string, label: string, icon: ReactNode, run: () => void, keywords = "") =>
      items.push({ id: `action:${id}`, group: "actions", label, icon, run, keywords });
    action(
      "decisions",
      labels.decisionLabel,
      <Signpost size={15} strokeWidth={1.75} />,
      onOpenDecisionInbox,
      "decision inbox approve needs you",
    );
    action(
      "announcement",
      labels.announcementLabel,
      <Megaphone size={15} strokeWidth={1.75} />,
      onOpenAnnouncement,
      "directive announce message broadcast",
    );
    action(
      "agent-status",
      labels.agentStatusLabel,
      <Wrench size={15} strokeWidth={1.75} />,
      onOpenAgentStatus,
      "agent status cli",
    );
    action(
      "reports",
      labels.reportLabel,
      <FileText size={15} strokeWidth={1.75} />,
      onOpenReportHistory,
      "reports history",
    );
    if (!phone)
      action(
        "room-manager",
        labels.roomManagerLabel,
        <Building size={15} strokeWidth={1.75} />,
        onOpenRoomManager,
        "office rooms themes",
      );
    action(
      "new-task",
      tr({ en: "New task" }),
      <ListChecks size={15} strokeWidth={1.75} />,
      () => handleViewChange("tasks"),
      "create add task work",
    );
    action(
      "theme",
      theme === "dark" ? tr({ en: "Switch to light mode" }) : tr({ en: "Switch to dark mode" }),
      <Moon size={15} strokeWidth={1.75} />,
      toggleTheme,
      "theme dark light appearance",
    );

    for (const agent of agents) {
      const name = localeName(uiLanguage, agent);
      const dept = agent.department ? localeName(uiLanguage, agent.department) : "";
      items.push({
        id: `agent:${agent.id}`,
        group: "agents",
        label: name,
        hint: dept,
        icon: <Bot size={15} strokeWidth={1.75} />,
        keywords: `${agent.name} ${agent.role} profile`,
        run: () => onSelectAgent(agent),
      });
      if (onOpenChat) {
        items.push({
          id: `chat:${agent.id}`,
          group: "agents",
          label: tr({ en: `Chat with ${name}` }),
          hint: dept,
          icon: <MessageSquare size={15} strokeWidth={1.75} />,
          keywords: `${agent.name} message talk`,
          run: () => onOpenChat(agent),
        });
      }
    }

    const recentTasks = [...tasks].sort((a, b) => b.updated_at - a.updated_at).slice(0, 200);
    for (const task of recentTasks) {
      items.push({
        id: `task:${task.id}`,
        group: "tasks",
        label: task.title,
        hint: task.status.replace(/_/g, " "),
        icon: <SquareTerminal size={15} strokeWidth={1.75} />,
        keywords: `${task.agent_name ?? ""} ${task.status} log terminal details`,
        run: () => openTask(task.id),
      });
    }
    return items;
  }, [
    agents,
    handleViewChange,
    hiddenViews,
    phone,
    labels.agentStatusLabel,
    labels.announcementLabel,
    labels.decisionLabel,
    labels.reportLabel,
    labels.roomManagerLabel,
    onOpenAgentStatus,
    onOpenAnnouncement,
    onOpenChat,
    onOpenDecisionInbox,
    onOpenReportHistory,
    onOpenRoomManager,
    openTask,
    onSelectAgent,
    tasks,
    theme,
    toggleTheme,
    tr,
    uiLanguage,
  ]);

  return (
    <I18nProvider language={labels.uiLanguage}>
      <div className="app-shell flex h-[100dvh] min-h-[100dvh] overflow-hidden">
        <div className={phone ? "hidden" : "hidden lg:flex lg:flex-shrink-0"}>
          <Sidebar
            currentView={view}
            onChangeView={handleViewChange}
            departments={officePresentation.departments}
            agents={officePresentation.agents}
            settings={settings}
            connected={connected}
            needsYouCount={needsYouCount}
            hiddenViews={hiddenViews}
            onOpenCommandBar={() => setCommandBarOpen(true)}
          />
        </div>

        {mobileNavOpen && (
          <NavigationDrawer onClose={() => setMobileNavOpen(false)}>
            <Sidebar
              currentView={view}
              onChangeView={(nextView) => {
                handleViewChange(nextView);
                setMobileNavOpen(false);
              }}
              departments={officePresentation.departments}
              agents={officePresentation.agents}
              settings={settings}
              connected={connected}
              needsYouCount={needsYouCount}
              hiddenViews={hiddenViews}
              onOpenCommandBar={() => {
                setMobileNavOpen(false);
                setCommandBarOpen(true);
              }}
            />
          </NavigationDrawer>
        )}

        <main className="flex-1 overflow-y-auto overflow-x-hidden min-w-0">
          <AppHeaderBar
            currentView={view}
            connected={connected}
            viewTitle={labels.viewTitle}
            tasksPrimaryLabel={labels.tasksPrimaryLabel}
            decisionLabel={labels.decisionLabel}
            decisionInboxLoading={decisionInboxLoading}
            decisionInboxCount={decisionInboxCount}
            agentStatusLabel={labels.agentStatusLabel}
            reportLabel={labels.reportLabel}
            announcementLabel={labels.announcementLabel}
            roomManagerLabel={labels.roomManagerLabel}
            theme={theme}
            mobileHeaderMenuOpen={mobileHeaderMenuOpen}
            onOpenMobileNav={() => setMobileNavOpen(true)}
            onOpenTasks={() => setView("tasks")}
            onOpenDecisionInbox={onOpenDecisionInbox}
            onOpenAgentStatus={onOpenAgentStatus}
            onOpenReportHistory={onOpenReportHistory}
            onOpenAnnouncement={onOpenAnnouncement}
            onOpenRoomManager={onOpenRoomManager}
            onToggleTheme={toggleTheme}
            onToggleMobileHeaderMenu={() => setMobileHeaderMenuOpen(!mobileHeaderMenuOpen)}
            onCloseMobileHeaderMenu={() => setMobileHeaderMenuOpen(false)}
            onOpenCommandBar={() => setCommandBarOpen(true)}
            commandBarLabel={tr({ en: "Search and jump" })}
            moreLabel={tr({ en: "More" })}
            phone={phone}
          />

          <EmergencyBanner />

          {executiveDesktopOpen && view !== "office" && !phone && (
            <div className="flex items-center justify-between border-b border-slate-500/30 bg-slate-800 px-4 py-2 text-sm text-white">
              <span>Executive desktop</span>
              <button
                type="button"
                onClick={() => {
                  setExecutiveDesktopOpen(false);
                  setView("office");
                }}
                className="rounded border border-slate-400 px-3 py-1.5 transition hover:bg-slate-700 active:scale-[0.98]"
              >
                Return to office
              </button>
            </div>
          )}

          {labels.autoUpdateNoticeVisible && (
            <div className={labels.autoUpdateNoticeContainerClass}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className={labels.autoUpdateNoticeTextClass}>
                  <div className="font-medium">{labels.autoUpdateNoticeTitle}</div>
                  <div className={labels.autoUpdateNoticeHintClass}>{labels.autoUpdateNoticeHint}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void onDismissAutoUpdateNotice();
                    }}
                    className={labels.autoUpdateNoticeButtonClass}
                  >
                    {labels.autoUpdateNoticeActionLabel}
                  </button>
                </div>
              </div>
            </div>
          )}

          {labels.updateBannerVisible && labels.effectiveUpdateStatus && (
            <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2.5 sm:px-4 lg:px-6">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-xs text-amber-100">
                  <div className="font-medium">{labels.updateTitle}</div>
                  <div className="mt-0.5 text-[11px] text-amber-200/90">{labels.updateHint}</div>
                  {labels.updateTestModeHint && (
                    <div className="mt-0.5 text-[11px] text-amber-300/90">{labels.updateTestModeHint}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <a
                    href={labels.updateReleaseUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-amber-300/40 bg-amber-200/10 px-2.5 py-1 text-[11px] text-amber-100 transition hover:bg-amber-200/20"
                  >
                    {labels.updateReleaseLabel}
                  </a>
                  <button
                    type="button"
                    onClick={onDismissUpdate}
                    className="rounded-md border border-slate-500/40 bg-slate-700/30 px-2.5 py-1 text-[11px] text-slate-100 transition hover:bg-slate-700/50"
                  >
                    {labels.updateDismissLabel}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className={phone ? "px-3 pt-3 pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))]" : "p-3 sm:p-4 lg:p-6"}>
            {view === "office" && !phone && (
              <div className={officeRenderer === "atlas" ? "fixed inset-0 z-[45] bg-slate-900" : ""}>
                <div
                  className={
                    officeRenderer === "atlas"
                      ? "absolute left-4 top-4 z-10 flex flex-wrap items-center gap-2 rounded-lg bg-slate-900/85 p-2"
                      : "mb-3 flex flex-wrap items-center gap-2"
                  }
                  role="group"
                  aria-label="Office renderer"
                >
                  <button
                    type="button"
                    aria-pressed={officeRenderer === "reference"}
                    onClick={() => setOfficeRenderer("reference")}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition active:scale-[0.98] ${officeRenderer === "reference" ? "border-slate-400 bg-slate-700 text-white" : "border-slate-500/40 text-[var(--th-text-secondary)] hover:bg-slate-500/10"}`}
                  >
                    AI Office Map
                  </button>
                  <button
                    type="button"
                    aria-pressed={officeRenderer === "original"}
                    onClick={() => setOfficeRenderer("original")}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition active:scale-[0.98] ${officeRenderer === "original" ? "border-slate-400 bg-slate-700 text-white" : "border-slate-500/40 text-white hover:bg-slate-500/10"}`}
                  >
                    Original Office
                  </button>
                  <button
                    type="button"
                    aria-pressed={officeRenderer === "atlas"}
                    onClick={() => setOfficeRenderer("atlas")}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition active:scale-[0.98] ${officeRenderer === "atlas" ? "border-slate-400 bg-slate-700 text-white" : "border-slate-500/40 text-[var(--th-text-secondary)] hover:bg-slate-500/10"}`}
                  >
                    ATLAS Office
                  </button>
                  {officeRenderer === "atlas" && (
                    <button
                      type="button"
                      onClick={() => {
                        setExecutiveDesktopOpen(true);
                        setView("dashboard");
                      }}
                      className="rounded-md border border-slate-400 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-700 active:scale-[0.98]"
                    >
                      Open desktop
                    </button>
                  )}
                </div>
                {officeRenderer === "atlas" ? (
                  <Suspense fallback={<div className="min-h-[400px] rounded-lg bg-slate-900" />}>
                    <AtlasOffice
                      agents={officePresentation.agents}
                      departments={officePresentation.departments}
                      tasks={tasks}
                      subAgents={subAgents}
                      meetingPresence={meetingPresence}
                      activeMeetingTaskId={activeMeetingTaskId}
                      unreadAgentIds={unreadAgentIds}
                      crossDeptDeliveries={crossDeptDeliveries}
                      onCrossDeptDeliveryProcessed={onCrossDeptDeliveryProcessed}
                      ceoOfficeCalls={ceoOfficeCalls}
                      onCeoOfficeCallProcessed={onCeoOfficeCallProcessed}
                      onOpenActiveMeetingMinutes={onOpenActiveMeetingMinutes}
                      language={uiLanguage}
                      pose={officePose}
                      onSelectAgent={onSelectAgent}
                      onSelectDepartment={onSelectDepartment}
                      onReturnToOriginal={() => setOfficeRenderer("original")}
                      onEnterDesktop={() => {
                        setExecutiveDesktopOpen(true);
                        setView("dashboard");
                      }}
                    />
                  </Suspense>
                ) : officeRenderer === "reference" ? (
                  <ReferenceOfficeView
                    departments={officePresentation.departments}
                    agents={officePresentation.agents}
                    tasks={tasks}
                    subAgents={subAgents}
                    meetingPresence={meetingPresence}
                    activeMeetingTaskId={activeMeetingTaskId}
                    unreadAgentIds={unreadAgentIds}
                    crossDeptDeliveries={crossDeptDeliveries}
                    onCrossDeptDeliveryProcessed={onCrossDeptDeliveryProcessed}
                    ceoOfficeCalls={ceoOfficeCalls}
                    onCeoOfficeCallProcessed={onCeoOfficeCallProcessed}
                    onOpenActiveMeetingMinutes={onOpenActiveMeetingMinutes}
                    customDeptThemes={officePresentation.roomThemes}
                    themeHighlightTargetId={activeRoomThemeTargetId}
                    onSelectAgent={onSelectAgent}
                    onSelectDepartment={onSelectDepartment}
                  />
                ) : (
                  <OfficeView
                    departments={officePresentation.departments}
                    agents={officePresentation.agents}
                    tasks={tasks}
                    subAgents={subAgents}
                    meetingPresence={meetingPresence}
                    activeMeetingTaskId={activeMeetingTaskId}
                    unreadAgentIds={unreadAgentIds}
                    crossDeptDeliveries={crossDeptDeliveries}
                    onCrossDeptDeliveryProcessed={onCrossDeptDeliveryProcessed}
                    ceoOfficeCalls={ceoOfficeCalls}
                    onCeoOfficeCallProcessed={onCeoOfficeCallProcessed}
                    onOpenActiveMeetingMinutes={onOpenActiveMeetingMinutes}
                    customDeptThemes={officePresentation.roomThemes}
                    themeHighlightTargetId={activeRoomThemeTargetId}
                    onSelectAgent={onSelectAgent}
                    onSelectDepartment={onSelectDepartment}
                  />
                )}
              </div>
            )}

            {view === "dashboard" && (
              <TodayView
                agents={agents}
                tasks={tasks}
                decisionItems={decisionInboxItems}
                decisionInboxLoading={decisionInboxLoading}
                onOpenDecisionInbox={onOpenDecisionInbox}
                onOpenTerminal={onOpenTerminal}
                onOpenWork={() => setView("tasks")}
                approvals={pendingApprovals.items}
                onDecideApproval={handleDecideApproval}
                onOpenHomelab={() => setView("homelab")}
                onOpenTask={openTask}
                readyDrafts={readyDrafts.items}
                onOpenOutreach={() => setView("outreach")}
              >
                <Dashboard
                  stats={stats}
                  agents={agents}
                  tasks={tasks}
                  departments={departments}
                  companyName={settings.companyName}
                  onPrimaryCtaClick={() => setView("tasks")}
                />
              </TodayView>
            )}

            {view === "revenue" && <RevenueWorkspace />}
            {view === "autonomy" && <AutonomyWorkspace departments={departments} />}

            {view === "tasks" && (
              <TaskBoard
                tasks={tasks}
                agents={agents}
                departments={departments}
                subtasks={subtasks}
                onCreateTask={onCreateTask}
                onUpdateTask={onUpdateTask}
                onDeleteTask={onDeleteTask}
                onAssignTask={onAssignTask}
                onRunTask={onRunTask}
                onStopTask={onStopTask}
                onPauseTask={onPauseTask}
                onResumeTask={onResumeTask}
                onOpenTerminal={onOpenTerminal}
                onOpenMeetingMinutes={onOpenMeetingMinutes}
                onOpenDetails={openTask}
              />
            )}

            {view === "tech" && (
              <BusinessWorkspace
                key="tech"
                business="tech"
                sections={["work", "contacts"]}
                eyebrow="Small Business Tech"
                title="Tech Services"
                description="Service tickets and the clients behind them. Draft messages to these clients in Outreach."
              />
            )}
            {view === "events" && (
              <BusinessWorkspace
                key="events"
                business="rental"
                sections={["calendar", "work", "contacts"]}
                eyebrow="Primrose Events"
                title="Events and Rentals"
                description="Upcoming events by date, rental quotes and customers. Draft messages to customers in Outreach."
              />
            )}
            {view === "ventures" && <ListingsPanel business="ventures" />}
            {view === "ventures" && (
              <BusinessWorkspace
                key="ventures"
                business="ventures"
                sections={["contacts", "drafts"]}
                eyebrow="AI-run ventures"
                title="Ventures"
                description="Online products and services the agents run themselves: Etsy listings, game assets, custom dashboards. Customers and message drafts for those ventures live here."
              />
            )}
            {view === "outreach" && (
              <BusinessWorkspace
                key="outreach"
                sections={["drafts", "contacts"]}
                eyebrow="All businesses"
                title="Outreach"
                description="Email, social and SMS drafts for every business. Nothing is sent from here: mark a draft ready when it is good to go. Contacts marked do-not-contact can't receive ready drafts."
              />
            )}
            {view === "homelab" && <HomelabWorkspace agents={agents} />}
            {TEAM_VIEWS.includes(view) && <TeamTabs current={view} onChange={setView} />}
            {view === "model_director" && <ModelDirectorWorkspace />}
            {view === "vp_decisions" && <VpDecisions />}
            {view === "knowledge" && <KnowledgeTab />}

            {view === "agents" && (
              <AgentManager agents={agents} departments={departments} onAgentsChange={onAgentsChange} />
            )}

            {view === "skills" && <SkillsLibrary agents={agents} />}

            {view === "settings" && (
              <SettingsPanel
                settings={settings}
                cliStatus={cliStatus}
                onSave={(nextSettings) => {
                  void onSaveSettings(nextSettings);
                }}
                onRefreshCli={() => {
                  void onRefreshCli();
                }}
                oauthResult={oauthResult}
                onOauthResultClear={onOauthResultClear}
              />
            )}
          </div>
        </main>

        {phone && (
          <PhoneTabBar
            currentView={view}
            onChangeView={handleViewChange}
            onOpenMenu={() => setMobileNavOpen(true)}
            menuOpen={mobileNavOpen}
            needsYouCount={needsYouCount}
          />
        )}

        {children}
        <CommandPalette open={commandBarOpen} onClose={() => setCommandBarOpen(false)} commands={commands} />
        {openTaskRecord && (
          <TaskDrawer
            key={openTaskRecord.id}
            task={openTaskRecord}
            agents={agents}
            departments={departments}
            subtasks={openTaskSubtasks}
            approvals={openTaskApprovals}
            onClose={() => openTask(null)}
            onUpdateTask={onUpdateTask}
            onAssignTask={onAssignTask}
            onRunTask={onRunTask}
            onStopTask={onStopTask}
            onPauseTask={onPauseTask}
            onResumeTask={onResumeTask}
            onDeleteTask={onDeleteTask}
            onOpenTerminal={onOpenTerminal}
            onOpenMeetingMinutes={onOpenMeetingMinutes}
            onOpenReport={onOpenTaskReport}
            onDecideApproval={handleDecideApproval}
            onOpenHomelab={() => {
              openTask(null);
              setView("homelab");
            }}
          />
        )}
      </div>
    </I18nProvider>
  );
}
