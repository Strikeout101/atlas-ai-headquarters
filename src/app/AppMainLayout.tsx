import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  Building,
  FileText,
  ListChecks,
  Megaphone,
  MessageSquare,
  Moon,
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
import type { DecisionInboxItem } from "../components/chat/decision-inbox";
import { NAV_ITEMS } from "./routes";
import { usePendingApprovals } from "./usePendingApprovals";
import { decidePendingApproval, type PendingApproval } from "../api";
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
  WorkflowPackKey,
} from "../types";
import type { UpdateStatus } from "../api";
import type { OAuthCallbackResult, RoomThemeMap, View } from "./types";
import AppHeaderBar from "./AppHeaderBar";
import {
  buildOfficePackStarterAgents,
  buildOfficePackPresentation,
  getOfficePackRoomThemes,
  listOfficePackOptions,
  normalizeOfficeWorkflowPack,
  resolveOfficePackSeedProvider,
} from "./office-workflow-pack";
import { resolvePackAgentViews, resolvePackDepartmentsForDisplay } from "./office-pack-display";
import { applyOfficePackToTaskInput, filterTasksByOfficePack, type TaskCreateInput } from "./task-workflow-pack";
import { DEFAULT_OFFICE_POSE } from "../components/atlas-office/layout";
import BusinessWorkspace from "../components/BusinessWorkspace";
import HomelabWorkspace from "../components/HomelabWorkspace";
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
    workflow_pack_key?: WorkflowPackKey;
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
  onAgentsChange: () => void;
  activeOfficeWorkflowPack: WorkflowPackKey;
  onChangeOfficeWorkflowPack: (packKey: WorkflowPackKey) => void;
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
  officePackBootstrappingLabel?: string | null;
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
  onAgentsChange,
  activeOfficeWorkflowPack,
  onChangeOfficeWorkflowPack,
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
  officePackBootstrappingLabel,
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
  const uiLanguage =
    labels.uiLanguage === "ko" || labels.uiLanguage === "ja" || labels.uiLanguage === "zh" ? labels.uiLanguage : "en";
  const officePackKey = normalizeOfficeWorkflowPack(activeOfficeWorkflowPack);
  const officePackOptions = useMemo(() => listOfficePackOptions(uiLanguage), [uiLanguage]);
  const officePackLabel =
    labels.uiLanguage === "ko"
      ? "오피스 팩"
      : labels.uiLanguage === "ja"
        ? "オフィスパック"
        : labels.uiLanguage === "zh"
          ? "办公室包"
          : "Office Pack";
  const officePackBootstrappingMessage = useMemo(() => {
    if (!officePackBootstrappingLabel) return null;
    if (uiLanguage === "ko") return `${officePackBootstrappingLabel} 오피스 팩 배치중...`;
    if (uiLanguage === "ja") return `${officePackBootstrappingLabel} オフィスパックを配置中...`;
    if (uiLanguage === "zh") return `${officePackBootstrappingLabel} 办公室包部署中...`;
    return `Deploying ${officePackBootstrappingLabel} office pack...`;
  }, [officePackBootstrappingLabel, uiLanguage]);
  const generatedOfficePresentation = useMemo(
    () =>
      buildOfficePackPresentation({
        packKey: officePackKey,
        locale: uiLanguage,
        departments,
        agents,
        customRoomThemes,
      }),
    [officePackKey, uiLanguage, departments, agents, customRoomThemes],
  );

  const activePackProfile =
    officePackKey === "development" ? null : (settings.officePackProfiles?.[officePackKey] ?? null);

  const seededPackAgents = useMemo(() => {
    if (officePackKey === "development") return [] as Agent[];
    if (activePackProfile?.agents?.length) return activePackProfile.agents;
    const drafts = buildOfficePackStarterAgents({
      packKey: officePackKey,
      departments: generatedOfficePresentation.departments,
      targetCount: 8,
      locale: uiLanguage,
    });
    const now = Date.now();
    return drafts.map((draft, index) => ({
      id: `${officePackKey}-seed-${index + 1}`,
      name: draft.name,
      name_ko: draft.name_ko,
      name_ja: draft.name_ja,
      name_zh: draft.name_zh,
      department_id: draft.department_id,
      role: draft.role,
      acts_as_planning_leader: draft.acts_as_planning_leader,
      cli_provider: resolveOfficePackSeedProvider({
        packKey: officePackKey,
        departmentId: draft.department_id,
        role: draft.role,
        seedIndex: index + 1,
        seedOrderInDepartment: draft.seed_order_in_department,
      }),
      avatar_emoji: draft.avatar_emoji,
      sprite_number: draft.sprite_number,
      personality: draft.personality,
      status: "idle" as const,
      current_task_id: null,
      stats_tasks_done: 0,
      stats_xp: 0,
      created_at: now,
    }));
  }, [activePackProfile?.agents, generatedOfficePresentation.departments, officePackKey, uiLanguage]);

  const packProfileDepartments =
    officePackKey === "development"
      ? null
      : (activePackProfile?.departments ?? generatedOfficePresentation.departments);
  const packProfileAgents = officePackKey === "development" ? null : (activePackProfile?.agents ?? seededPackAgents);

  const isHydratedOfficePack = useMemo(() => {
    if (officePackKey === "development") return false;
    const hydrated = settings.officePackHydratedPacks;
    if (!Array.isArray(hydrated)) return false;
    return hydrated.map((value) => String(value ?? "").trim()).includes(officePackKey);
  }, [officePackKey, settings.officePackHydratedPacks]);

  const displayDepartments = useMemo(
    () =>
      resolvePackDepartmentsForDisplay({
        packKey: officePackKey,
        globalDepartments: departments,
        packDepartments: packProfileDepartments,
        preferPackProfile: !isHydratedOfficePack,
      }),
    [departments, isHydratedOfficePack, officePackKey, packProfileDepartments],
  );

  const { scopedAgents: officeScopedAgents, mergedAgents: displayAgents } = useMemo(
    () =>
      resolvePackAgentViews({
        packKey: officePackKey,
        globalAgents: agents,
        packAgents: packProfileAgents,
      }),
    [agents, officePackKey, packProfileAgents],
  );

  const managerDepartments =
    officePackKey === "development"
      ? departments
      : isHydratedOfficePack
        ? displayDepartments
        : (activePackProfile?.departments ?? generatedOfficePresentation.departments);

  const managerAgents =
    officePackKey === "development"
      ? agents
      : isHydratedOfficePack
        ? officeScopedAgents
        : (activePackProfile?.agents ?? seededPackAgents);

  const officePresentation = useMemo(() => {
    if (officePackKey === "development") return generatedOfficePresentation;
    return {
      departments: displayDepartments,
      agents: officeScopedAgents,
      roomThemes: {
        ...customRoomThemes,
        ...getOfficePackRoomThemes(officePackKey),
      },
    };
  }, [customRoomThemes, displayDepartments, generatedOfficePresentation, officePackKey, officeScopedAgents]);

  const tasksForActivePack = useMemo(() => filterTasksByOfficePack(tasks, officePackKey), [tasks, officePackKey]);
  const handleCreateTaskForActivePack = useCallback(
    async (input: TaskCreateInput) => {
      await onCreateTask(applyOfficePackToTaskInput(input, officePackKey));
    },
    [onCreateTask, officePackKey],
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
  const refreshApprovals = pendingApprovals.refresh;
  useEffect(() => {
    if (view === "dashboard") void refreshApprovals();
  }, [view, refreshApprovals]);
  const handleDecideApproval = useCallback(
    async (item: PendingApproval, approve: boolean) => {
      await decidePendingApproval(item, approve);
      pendingApprovals.setItems((prev) => prev.filter((p) => !(p.kind === item.kind && p.id === item.id)));
      void refreshApprovals();
    },
    [pendingApprovals, refreshApprovals],
  );
  const needsYouCount = pendingApprovals.items.length + decisionInboxCount + reviewCount;
  const tr = useCallback(
    (text: { ko: string; en: string; ja: string; zh: string }) => pickLang(uiLanguage, text),
    [uiLanguage],
  );

  const commands = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = NAV_ITEMS.map(({ view: target, icon: Icon, label, keywords }) => ({
      id: `nav:${target}`,
      group: "navigate" as const,
      label: tr(label),
      icon: <Icon size={15} strokeWidth={1.75} />,
      keywords: `${keywords} ${label.en}`,
      run: () => handleViewChange(target),
    }));
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
    action(
      "room-manager",
      labels.roomManagerLabel,
      <Building size={15} strokeWidth={1.75} />,
      onOpenRoomManager,
      "office rooms themes",
    );
    action(
      "new-task",
      tr({ ko: "새 업무 만들기", en: "New task", ja: "新しいタスク", zh: "新建任务" }),
      <ListChecks size={15} strokeWidth={1.75} />,
      () => handleViewChange("tasks"),
      "create add task work",
    );
    action(
      "theme",
      theme === "dark"
        ? tr({ ko: "라이트 모드로 전환", en: "Switch to light mode", ja: "ライトモードに切替", zh: "切换到浅色模式" })
        : tr({ ko: "다크 모드로 전환", en: "Switch to dark mode", ja: "ダークモードに切替", zh: "切换到深色模式" }),
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
          label: tr({ ko: `${name}와 대화`, en: `Chat with ${name}`, ja: `${name} とチャット`, zh: `与 ${name} 聊天` }),
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
        keywords: `${task.agent_name ?? ""} ${task.status} log terminal`,
        run: () => onOpenTerminal(task.id),
      });
    }
    return items;
  }, [
    agents,
    handleViewChange,
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
    onOpenTerminal,
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
        <div className="hidden lg:flex lg:flex-shrink-0">
          <Sidebar
            currentView={view}
            onChangeView={handleViewChange}
            departments={officePresentation.departments}
            agents={officePresentation.agents}
            settings={settings}
            connected={connected}
            needsYouCount={needsYouCount}
            onOpenCommandBar={() => setCommandBarOpen(true)}
          />
        </div>

        {mobileNavOpen && (
          <button
            aria-label="Close navigation"
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={() => setMobileNavOpen(false)}
          />
        )}
        <div
          className={`fixed inset-y-0 left-0 z-50 transition-transform duration-200 lg:hidden ${
            mobileNavOpen ? "translate-x-0" : "-translate-x-full pointer-events-none"
          }`}
        >
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
            onOpenCommandBar={() => {
              setMobileNavOpen(false);
              setCommandBarOpen(true);
            }}
          />
        </div>

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
            officePackControl={
              view === "office" || view === "agents" || view === "tasks"
                ? {
                    label: officePackLabel,
                    value: officePackKey,
                    options: officePackOptions,
                    onChange: onChangeOfficeWorkflowPack,
                  }
                : null
            }
            onToggleTheme={toggleTheme}
            onToggleMobileHeaderMenu={() => setMobileHeaderMenuOpen(!mobileHeaderMenuOpen)}
            onCloseMobileHeaderMenu={() => setMobileHeaderMenuOpen(false)}
            onOpenCommandBar={() => setCommandBarOpen(true)}
            commandBarLabel={tr({ ko: "검색 및 이동", en: "Search and jump", ja: "検索・移動", zh: "搜索与跳转" })}
            moreLabel={tr({ ko: "더보기", en: "More", ja: "その他", zh: "更多" })}
          />

          {executiveDesktopOpen && view !== "office" && (
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

          {officePackBootstrappingMessage && (
            <div className="border-b border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 sm:px-4 lg:px-6">
              <div className="text-xs font-medium text-emerald-100">{officePackBootstrappingMessage}</div>
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

          <div className="p-3 sm:p-4 lg:p-6">
            {view === "office" && (
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

            {view === "tasks" && (
              <TaskBoard
                tasks={tasksForActivePack}
                agents={displayAgents}
                departments={displayDepartments}
                subtasks={subtasks}
                onCreateTask={handleCreateTaskForActivePack}
                onUpdateTask={onUpdateTask}
                onDeleteTask={onDeleteTask}
                onAssignTask={onAssignTask}
                onRunTask={onRunTask}
                onStopTask={onStopTask}
                onPauseTask={onPauseTask}
                onResumeTask={onResumeTask}
                onOpenTerminal={onOpenTerminal}
                onOpenMeetingMinutes={onOpenMeetingMinutes}
              />
            )}

            {view === "business" && <BusinessWorkspace />}
            {view === "homelab" && <HomelabWorkspace agents={agents} />}
            {view === "model_director" && <ModelDirectorWorkspace />}

            {view === "agents" && (
              <AgentManager
                agents={managerAgents}
                departments={managerDepartments}
                onAgentsChange={onAgentsChange}
                activeOfficeWorkflowPack={officePackKey}
                dbBackedOfficePack={isHydratedOfficePack}
                onSaveOfficePackProfile={async (packKey, profile) => {
                  if (packKey === "development") return;
                  await onSaveSettings({
                    ...settings,
                    officePackProfiles: {
                      ...(settings.officePackProfiles ?? {}),
                      [packKey]: profile,
                    },
                  });
                }}
              />
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

        {children}
        <CommandPalette open={commandBarOpen} onClose={() => setCommandBarOpen(false)} commands={commands} />
      </div>
    </I18nProvider>
  );
}
