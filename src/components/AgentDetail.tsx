import { Wrench, Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { OAuthStatus } from "../api";
import * as api from "../api";
import { localeName, useI18n } from "../i18n";
import type { Agent, CliModelInfo, Department, ReasoningLevelOption, SubAgent, SubTask, Task } from "../types";
import AgentAvatar from "./AgentAvatar";
import AgentDetailTabContent from "./agent-detail/AgentDetailTabContent";
import { CLI_LABELS, oauthAccountLabel, roleLabel, STATUS_CONFIG, statusLabel } from "./agent-detail/constants";
import { useEscapeToClose } from "../hooks/useEscapeToClose";

interface AgentDetailProps {
  agent: Agent;
  agents: Agent[];
  department: Department | undefined;
  departments: Department[];
  tasks: Task[];
  subAgents: SubAgent[];
  subtasks: SubTask[];
  onClose: () => void;
  onChat: (agent: Agent) => void;
  onAssignTask: (agentId: string) => void;
  onOpenTerminal?: (taskId: string) => void;
  onAgentUpdated?: () => void;
}

const CLI_MODEL_OVERRIDE_PROVIDERS: Agent["cli_provider"][] = ["claude", "codex", "gemini", "opencode", "kimi"];
const CODEX_REASONING_FALLBACK_OPTIONS: ReasoningLevelOption[] = [
  { effort: "low", description: "Faster, lower depth" },
  { effort: "medium", description: "Balanced default" },
  { effort: "high", description: "Higher reasoning depth" },
  { effort: "xhigh", description: "Maximum reasoning depth" },
];

export default function AgentDetail({
  agent,
  agents,
  department,
  departments,
  tasks,
  subAgents,
  subtasks,
  onClose,
  onChat,
  onAssignTask,
  onOpenTerminal,
  onAgentUpdated,
}: AgentDetailProps) {
  useEscapeToClose(onClose);
  const { t, language } = useI18n();
  const [tab, setTab] = useState<"info" | "tasks" | "alba">("info");
  const [editingCli, setEditingCli] = useState(false);
  const [selectedCli, setSelectedCli] = useState(agent.cli_provider);
  const [selectedOAuthAccountId, setSelectedOAuthAccountId] = useState(agent.oauth_account_id ?? "");
  const [selectedApiProviderId, setSelectedApiProviderId] = useState(agent.api_provider_id ?? "");
  const [selectedApiModel, setSelectedApiModel] = useState(agent.api_model ?? "");
  const [selectedCliModel, setSelectedCliModel] = useState(agent.cli_model ?? "");
  const [selectedCliReasoningLevel, setSelectedCliReasoningLevel] = useState(agent.cli_reasoning_level ?? "");
  const [savingCli, setSavingCli] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus | null>(null);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [cliModels, setCliModels] = useState<Record<string, CliModelInfo[]>>({});
  const [cliModelsLoading, setCliModelsLoading] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [savingPlanningLead, setSavingPlanningLead] = useState(false);
  const [actsAsPlanningLead, setActsAsPlanningLead] = useState(Number(agent.acts_as_planning_leader ?? 0) === 1);

  const agentTasks = tasks.filter((task) => task.assigned_agent_id === agent.id);
  const subtasksByTask = useMemo(() => {
    const grouped: Record<string, SubTask[]> = {};
    for (const subtask of subtasks) {
      if (!grouped[subtask.task_id]) grouped[subtask.task_id] = [];
      grouped[subtask.task_id].push(subtask);
    }
    return grouped;
  }, [subtasks]);
  const agentSubAgents = subAgents.filter((subAgent) => subAgent.parentAgentId === agent.id);
  const statusCfg = STATUS_CONFIG[agent.status] ?? STATUS_CONFIG.idle;
  const oauthProviderKey =
    selectedCli === "copilot" ? "github-copilot" : selectedCli === "antigravity" ? "antigravity" : null;
  const activeOAuthAccounts = useMemo(() => {
    if (!oauthProviderKey || !oauthStatus) return [];
    return (oauthStatus.providers[oauthProviderKey]?.accounts ?? []).filter(
      (account) => account.active && account.status === "active",
    );
  }, [oauthProviderKey, oauthStatus]);
  const requiresOAuthAccount = selectedCli === "copilot" || selectedCli === "antigravity";
  const requiresApiProvider = selectedCli === "api";
  const supportsCliModelOverride = CLI_MODEL_OVERRIDE_PROVIDERS.includes(selectedCli);
  const selectedCliModelOptions = useMemo(() => cliModels[selectedCli] ?? [], [cliModels, selectedCli]);
  const selectedCliModelMeta = useMemo(
    () => selectedCliModelOptions.find((model) => model.slug === selectedCliModel),
    [selectedCliModelOptions, selectedCliModel],
  );
  const codexReasoningOptions = useMemo(() => {
    if (selectedCli !== "codex") return [];
    if (selectedCliModelMeta?.reasoningLevels && selectedCliModelMeta.reasoningLevels.length > 0) {
      return selectedCliModelMeta.reasoningLevels;
    }
    return CODEX_REASONING_FALLBACK_OPTIONS;
  }, [selectedCli, selectedCliModelMeta]);
  const canSaveCli = requiresApiProvider ? false : !requiresOAuthAccount || Boolean(selectedOAuthAccountId);
  const getReasoningDescription = useCallback(
    (effort: string, fallback?: string) => {
      switch (effort) {
        case "low":
          return t({ en: "Faster, lower depth" });
        case "medium":
          return t({ en: "Balanced default" });
        case "high":
          return t({ en: "Higher reasoning depth" });
        case "xhigh":
          return t({
            en: "Maximum reasoning depth",
          });
        default:
          return fallback || "";
      }
    },
    [t],
  );

  const xpLevel = Math.floor(agent.stats_xp / 100) + 1;
  const xpProgress = agent.stats_xp % 100;

  useEffect(() => {
    setSelectedCli(agent.cli_provider);
    setSelectedOAuthAccountId(agent.oauth_account_id ?? "");
    setSelectedApiProviderId(agent.api_provider_id ?? "");
    setSelectedApiModel(agent.api_model ?? "");
    setSelectedCliModel(agent.cli_model ?? "");
    setSelectedCliReasoningLevel(agent.cli_reasoning_level ?? "");
    setActsAsPlanningLead(Number(agent.acts_as_planning_leader ?? 0) === 1);
  }, [
    agent.id,
    agent.cli_provider,
    agent.oauth_account_id,
    agent.api_provider_id,
    agent.api_model,
    agent.cli_model,
    agent.cli_reasoning_level,
    agent.acts_as_planning_leader,
  ]);

  useEffect(() => {
    if (!editingCli || !requiresOAuthAccount) return;
    setOauthLoading(true);
    api
      .getOAuthStatus()
      .then(setOauthStatus)
      .catch((err) => console.error("Failed to load OAuth status:", err))
      .finally(() => setOauthLoading(false));
  }, [editingCli, requiresOAuthAccount]);

  useEffect(() => {
    if (!editingCli || !supportsCliModelOverride || Object.keys(cliModels).length > 0) return;
    let cancelled = false;
    setCliModelsLoading(true);
    api
      .getCliModels()
      .then((models) => {
        if (cancelled) return;
        setCliModels(models);
      })
      .catch((err) => console.error("Failed to load CLI models:", err))
      .finally(() => {
        if (!cancelled) setCliModelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editingCli, supportsCliModelOverride, cliModels]);

  useEffect(() => {
    if (!requiresOAuthAccount) {
      if (selectedOAuthAccountId) setSelectedOAuthAccountId("");
      return;
    }
    if (activeOAuthAccounts.length === 0) return;
    if (!selectedOAuthAccountId || !activeOAuthAccounts.some((account) => account.id === selectedOAuthAccountId)) {
      setSelectedOAuthAccountId(activeOAuthAccounts[0].id);
    }
  }, [requiresOAuthAccount, activeOAuthAccounts, selectedOAuthAccountId]);

  useEffect(() => {
    if (!supportsCliModelOverride && selectedCliModel) {
      setSelectedCliModel("");
    }
  }, [supportsCliModelOverride, selectedCliModel]);

  useEffect(() => {
    if (selectedCli !== "codex" && selectedCliReasoningLevel) {
      setSelectedCliReasoningLevel("");
      return;
    }
    if (selectedCli === "codex" && selectedCliReasoningLevel) {
      const isValid = codexReasoningOptions.some((level) => level.effort === selectedCliReasoningLevel);
      if (!isValid) setSelectedCliReasoningLevel("");
    }
  }, [selectedCli, selectedCliReasoningLevel, codexReasoningOptions]);

  const handleSaveCli = useCallback(async () => {
    setSavingCli(true);
    try {
      await api.updateAgent(agent.id, {
        cli_provider: selectedCli,
        oauth_account_id: requiresOAuthAccount ? selectedOAuthAccountId || null : null,
        api_provider_id: requiresApiProvider ? selectedApiProviderId || null : null,
        api_model: requiresApiProvider ? selectedApiModel || null : null,
        cli_model: supportsCliModelOverride ? selectedCliModel || null : null,
        cli_reasoning_level: selectedCli === "codex" ? selectedCliReasoningLevel || null : null,
      });
      onAgentUpdated?.();
      setEditingCli(false);
    } catch (error) {
      console.error("Failed to update CLI:", error);
    } finally {
      setSavingCli(false);
    }
  }, [
    agent.id,
    selectedCli,
    requiresOAuthAccount,
    selectedOAuthAccountId,
    requiresApiProvider,
    selectedApiProviderId,
    selectedApiModel,
    supportsCliModelOverride,
    selectedCliModel,
    selectedCliReasoningLevel,
    onAgentUpdated,
  ]);

  const handleCancelCliEdit = useCallback(() => {
    setEditingCli(false);
    setSelectedCli(agent.cli_provider);
    setSelectedOAuthAccountId(agent.oauth_account_id ?? "");
    setSelectedApiProviderId(agent.api_provider_id ?? "");
    setSelectedApiModel(agent.api_model ?? "");
    setSelectedCliModel(agent.cli_model ?? "");
    setSelectedCliReasoningLevel(agent.cli_reasoning_level ?? "");
  }, [
    agent.cli_provider,
    agent.oauth_account_id,
    agent.api_provider_id,
    agent.api_model,
    agent.cli_model,
    agent.cli_reasoning_level,
  ]);

  const handlePlanningLeadToggle = useCallback(
    async (nextChecked: boolean) => {
      if (agent.role !== "team_leader" || savingPlanningLead) return;
      const previous = actsAsPlanningLead;
      setActsAsPlanningLead(nextChecked);
      setSavingPlanningLead(true);

      try {
        await api.updateAgent(agent.id, {
          acts_as_planning_leader: nextChecked ? 1 : 0,
        });
        onAgentUpdated?.();
      } catch (error) {
        if (
          nextChecked &&
          api.isApiRequestError(error) &&
          error.status === 409 &&
          error.code === "planning_leader_exists"
        ) {
          const details = (error.details ?? {}) as {
            existing_leader?: { name?: string | null; name_ko?: string | null };
          };
          const existingLeaderName = String(details.existing_leader?.name || t({ en: "current leader" })).trim();
          const confirmed = window.confirm(
            t({
              en: `${existingLeaderName} is already the planning lead. Change leader?`,
            }),
          );
          if (confirmed) {
            try {
              await api.updateAgent(agent.id, {
                acts_as_planning_leader: 1,
                force_planning_leader_override: true,
              });
              onAgentUpdated?.();
              return;
            } catch (overrideError) {
              console.error("Failed to override planning lead:", overrideError);
            }
          }
        } else {
          console.error("Failed to update planning lead:", error);
        }
        setActsAsPlanningLead(previous);
      } finally {
        setSavingPlanningLead(false);
      }
    },
    [agent.id, agent.role, actsAsPlanningLead, onAgentUpdated, savingPlanningLead, t],
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[calc(100vw-1.5rem)] max-w-[480px] max-h-[85vh] overflow-hidden rounded-2xl border border-slate-700 bg-slate-800 shadow-2xl">
        <div
          className="relative px-6 py-5 border-b border-slate-700"
          style={{
            background: department ? `linear-gradient(135deg, ${department.color}22, transparent)` : undefined,
          }}
        >
          <button
            onClick={onClose}
            className="absolute top-3 right-3 w-8 h-8 rounded-full bg-slate-700/50 hover:bg-slate-600 flex items-center justify-center text-slate-400 hover:text-white transition-colors"
          >
            ✕
          </button>

          <div className="flex items-center gap-4">
            <div className="relative">
              <AgentAvatar
                agent={agent}
                agents={agents}
                size={64}
                rounded="2xl"
                className={agent.status === "working" ? "animate-agent-work" : ""}
              />
              <div
                className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-slate-800 ${
                  agent.status === "working"
                    ? "bg-blue-500"
                    : agent.status === "idle"
                      ? "bg-green-500"
                      : agent.status === "break"
                        ? "bg-yellow-500"
                        : "bg-slate-500"
                }`}
              />
            </div>

            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-white">{localeName(language, agent)}</h2>
                <span className={`text-xs px-1.5 py-0.5 rounded ${statusCfg.bg} ${statusCfg.color}`}>
                  {statusLabel(statusCfg.label, t)}
                </span>
              </div>
              <div className="text-sm text-slate-400 mt-0.5">
                {department?.icon} {department ? localeName(language, department) : ""} · {roleLabel(agent.role, t)}
              </div>
              {agent.role === "team_leader" && (
                <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    checked={actsAsPlanningLead}
                    disabled={savingPlanningLead}
                    onChange={(event) => {
                      void handlePlanningLeadToggle(event.target.checked);
                    }}
                    className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500/50 disabled:opacity-60"
                  />
                  <span>
                    {t({
                      en: "Lead (Planning lead)",
                    })}
                  </span>
                  {savingPlanningLead && <span className="text-[10px] text-slate-400">{t({ en: "Saving..." })}</span>}
                </label>
              )}
              <div className="text-xs text-slate-500 mt-0.5">
                {editingCli ? (
                  selectedCli === "codex" ? (
                    <div className="space-y-1">
                      <div className="flex w-full min-w-0 items-center gap-1 pb-0.5">
                        <Wrench size={12} strokeWidth={1.75} className="shrink-0" />
                        <select
                          value={selectedCli}
                          onChange={(event) => {
                            setSelectedCli(event.target.value as Agent["cli_provider"]);
                            setSelectedCliModel("");
                            setSelectedCliReasoningLevel("");
                          }}
                          className="w-[94px] shrink-0 bg-slate-700 text-slate-200 text-xs rounded px-1 py-0.5 border border-slate-600 focus:outline-none focus:border-blue-500"
                        >
                          {Object.entries(CLI_LABELS).map(([key, label]) => (
                            <option key={key} value={key}>
                              {label}
                            </option>
                          ))}
                        </select>
                        {cliModelsLoading ? (
                          <span className="text-[10px] text-slate-400">
                            {t({
                              en: "Loading models...",
                            })}
                          </span>
                        ) : selectedCliModelOptions.length > 0 ? (
                          <>
                            <select
                              value={selectedCliModel}
                              onChange={(event) => {
                                const nextModel = event.target.value;
                                setSelectedCliModel(nextModel);
                                const nextMeta = selectedCliModelOptions.find((model) => model.slug === nextModel);
                                setSelectedCliReasoningLevel(nextMeta?.defaultReasoningLevel || "");
                              }}
                              className="w-0 min-w-0 flex-1 bg-slate-700 text-slate-200 text-xs rounded px-1 py-0.5 border border-slate-600 focus:outline-none focus:border-blue-500"
                            >
                              <option value="">
                                {t({
                                  en: "Default (Settings model)",
                                })}
                              </option>
                              {selectedCliModelOptions.map((model) => (
                                <option key={model.slug} value={model.slug}>
                                  {model.displayName || model.slug}
                                </option>
                              ))}
                            </select>
                            {codexReasoningOptions.length > 0 && (
                              <select
                                value={selectedCliReasoningLevel}
                                onChange={(event) => setSelectedCliReasoningLevel(event.target.value)}
                                className="w-0 min-w-0 flex-1 bg-slate-700 text-slate-200 text-xs rounded px-1 py-0.5 border border-slate-600 focus:outline-none focus:border-blue-500"
                              >
                                <option value="">
                                  {t({
                                    en: "Default (Settings reasoning)",
                                  })}
                                </option>
                                {codexReasoningOptions.map((level) => (
                                  <option key={level.effort} value={level.effort}>
                                    {level.effort}
                                    {getReasoningDescription(level.effort, level.description)
                                      ? ` (${getReasoningDescription(level.effort, level.description)})`
                                      : ""}
                                  </option>
                                ))}
                              </select>
                            )}
                          </>
                        ) : (
                          <span className="text-[10px] text-slate-400">
                            {t({
                              en: "No model list available",
                            })}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="text-[10px] text-slate-400">
                          {t({
                            en: "Sub-agent model follows Settings",
                          })}
                        </span>
                        <button
                          disabled={savingCli || !canSaveCli}
                          onClick={() => {
                            void handleSaveCli();
                          }}
                          className="text-[10px] px-1.5 py-0.5 ax-btn-primary rounded transition-colors disabled:opacity-50"
                        >
                          {savingCli ? "..." : t({ en: "Save" })}
                        </button>
                        <button
                          onClick={handleCancelCliEdit}
                          className="text-[10px] px-1.5 py-0.5 bg-slate-600 hover:bg-slate-500 text-slate-300 rounded transition-colors"
                        >
                          {t({ en: "Cancel" })}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1">
                      <Wrench size={12} strokeWidth={1.75} />
                      <select
                        value={selectedCli}
                        onChange={(event) => {
                          setSelectedCli(event.target.value as Agent["cli_provider"]);
                          setSelectedCliModel("");
                          setSelectedCliReasoningLevel("");
                        }}
                        className="bg-slate-700 text-slate-200 text-xs rounded px-1.5 py-0.5 border border-slate-600 focus:outline-none focus:border-blue-500"
                      >
                        {Object.entries(CLI_LABELS).map(([key, label]) => (
                          <option key={key} value={key}>
                            {label}
                          </option>
                        ))}
                      </select>
                      {requiresOAuthAccount &&
                        (oauthLoading ? (
                          <span className="text-[10px] text-slate-400">
                            {t({
                              en: "Loading accounts...",
                            })}
                          </span>
                        ) : activeOAuthAccounts.length > 0 ? (
                          <select
                            value={selectedOAuthAccountId}
                            onChange={(event) => setSelectedOAuthAccountId(event.target.value)}
                            className="bg-slate-700 text-slate-200 text-xs rounded px-1.5 py-0.5 border border-slate-600 focus:outline-none focus:border-blue-500 max-w-[170px]"
                          >
                            {activeOAuthAccounts.map((account) => (
                              <option key={account.id} value={account.id}>
                                {oauthAccountLabel(account)}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-[10px] text-amber-300">
                            {t({
                              en: "No active OAuth account",
                            })}
                          </span>
                        ))}
                      {requiresApiProvider && (
                        <span className="text-[10px] text-amber-300">
                          {t({
                            en: "Assign models in Settings > API",
                          })}
                        </span>
                      )}
                      {supportsCliModelOverride &&
                        (cliModelsLoading ? (
                          <span className="text-[10px] text-slate-400">
                            {t({
                              en: "Loading models...",
                            })}
                          </span>
                        ) : selectedCliModelOptions.length > 0 ? (
                          <>
                            <select
                              value={selectedCliModel}
                              onChange={(event) => {
                                const nextModel = event.target.value;
                                setSelectedCliModel(nextModel);
                              }}
                              className="bg-slate-700 text-slate-200 text-xs rounded px-1.5 py-0.5 border border-slate-600 focus:outline-none focus:border-blue-500 max-w-[210px]"
                            >
                              <option value="">
                                {t({
                                  en: "Default (Settings model)",
                                })}
                              </option>
                              {selectedCliModelOptions.map((model) => (
                                <option key={model.slug} value={model.slug}>
                                  {model.displayName || model.slug}
                                </option>
                              ))}
                            </select>
                            <span className="text-[10px] text-slate-400">
                              {t({
                                en: "Sub-agent model follows Settings",
                              })}
                            </span>
                          </>
                        ) : (
                          <span className="text-[10px] text-slate-400">
                            {t({
                              en: "No model list available",
                            })}
                          </span>
                        ))}
                      <button
                        disabled={savingCli || !canSaveCli}
                        onClick={() => {
                          void handleSaveCli();
                        }}
                        className="text-[10px] px-1.5 py-0.5 ax-btn-primary rounded transition-colors disabled:opacity-50"
                      >
                        {savingCli ? "..." : t({ en: "Save" })}
                      </button>
                      <button
                        onClick={handleCancelCliEdit}
                        className="text-[10px] px-1.5 py-0.5 bg-slate-600 hover:bg-slate-500 text-slate-300 rounded transition-colors"
                      >
                        {t({ en: "Cancel" })}
                      </button>
                    </div>
                  )
                ) : (
                  <button
                    onClick={() => setEditingCli(true)}
                    className="flex items-center gap-1 hover:text-slate-300 transition-colors"
                    title={t({
                      en: "Click to change CLI",
                    })}
                  >
                    🔧{" "}
                    {agent.cli_provider === "api" && agent.api_model
                      ? `API: ${agent.api_model}`
                      : agent.cli_model &&
                          CLI_MODEL_OVERRIDE_PROVIDERS.includes(agent.cli_provider) &&
                          agent.cli_provider !== "api"
                        ? `${CLI_LABELS[agent.cli_provider] ?? agent.cli_provider} · ${agent.cli_model}${agent.cli_provider === "codex" && agent.cli_reasoning_level ? ` (${agent.cli_reasoning_level})` : ""}`
                        : agent.cli_provider === "codex" && agent.cli_reasoning_level
                          ? `${CLI_LABELS[agent.cli_provider] ?? agent.cli_provider} · (${agent.cli_reasoning_level})`
                          : (CLI_LABELS[agent.cli_provider] ?? agent.cli_provider)}
                    <Pencil size={10} strokeWidth={1.75} className="ml-0.5 inline text-slate-500" />
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-yellow-400 font-bold">Lv.{xpLevel}</span>
            <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-yellow-500 to-amber-400 rounded-full transition-all"
                style={{ width: `${xpProgress}%` }}
              />
            </div>
            <span className="text-[10px] text-slate-500">{agent.stats_xp} XP</span>
          </div>
        </div>

        <div className="flex border-b border-slate-700">
          {[
            { key: "info", label: t({ en: "Info" }) },
            {
              key: "tasks",
              label: `${t({ en: "Tasks" })} (${agentTasks.length})`,
            },
            {
              key: "alba",
              label: `${t({ en: "Sub-agents" })} (${agentSubAgents.length})`,
            },
          ].map((tabItem) => (
            <button
              key={tabItem.key}
              onClick={() => setTab(tabItem.key as typeof tab)}
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                tab === tabItem.key ? "text-blue-400 border-b-2 border-blue-400" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {tabItem.label}
            </button>
          ))}
        </div>

        <div className="p-4 overflow-y-auto max-h-[40vh]">
          <AgentDetailTabContent
            tab={tab}
            t={t}
            language={language}
            agent={agent}
            departments={departments}
            agentTasks={agentTasks}
            agentSubAgents={agentSubAgents}
            subtasksByTask={subtasksByTask}
            expandedTaskId={expandedTaskId}
            setExpandedTaskId={setExpandedTaskId}
            onChat={onChat}
            onAssignTask={onAssignTask}
            onOpenTerminal={onOpenTerminal}
          />
        </div>
      </div>
    </div>
  );
}
