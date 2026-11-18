import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FileBarChart,
  FileText,
  GitCompare,
  Pause,
  Play,
  RotateCcw,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from "lucide-react";
import * as api from "../../api";
import type { PendingApproval } from "../../api";
import type { Agent, Department, SubTask, Task, TaskStatus } from "../../types";
import { localeName, useI18n } from "../../i18n";
import AgentSelect from "../AgentSelect";
import AgentAvatar from "../AgentAvatar";
import DiffModal from "../taskboard/DiffModal";
import { getTaskTypeBadge, priorityLabel, STATUS_OPTIONS, taskStatusLabel } from "../taskboard/constants";
import ApprovalRow from "../today/ApprovalRow";
import { hasOpenEscapeLayer } from "../../hooks/useEscapeToClose";

const LOG_POLL_MS = 3000;
const ACTIVITY_LINES = 12;
const OUTPUT_LINES = 40;

export interface TaskDrawerProps {
  task: Task;
  agents: Agent[];
  departments: Department[];
  subtasks: SubTask[];
  approvals: PendingApproval[];
  onClose: () => void;
  onUpdateTask: (id: string, data: Partial<Task>) => void | Promise<void>;
  onAssignTask: (taskId: string, agentId: string) => void | Promise<void>;
  onRunTask: (id: string) => void | Promise<void>;
  onStopTask: (id: string) => void | Promise<void>;
  onPauseTask?: (id: string) => void | Promise<void>;
  onResumeTask?: (id: string) => void | Promise<void>;
  onDeleteTask: (id: string) => void | Promise<void>;
  onOpenTerminal: (taskId: string) => void;
  onOpenMeetingMinutes: (taskId: string) => void;
  onOpenReport?: (taskId: string) => void;
  onDecideApproval: (item: PendingApproval, approve: boolean) => Promise<void>;
  onOpenHomelab: () => void;
}

type ActivityLine = { id: number; kind: string; message: string; created_at: number };

function formatDateTime(ms: number | null | undefined, localeTag: string): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(localeTag, { dateStyle: "medium", timeStyle: "short" });
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="px-5 py-4" style={{ borderBottom: "1px solid var(--th-border)" }}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-[0.04em]" style={{ color: "var(--th-text-muted)" }}>
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * Everything about one task in one place: details, actions, approvals waiting on it, model route and a live
 * activity preview. The full log, meeting minutes, diff and report open in their existing windows.
 */
export default function TaskDrawer({
  task,
  agents,
  departments,
  subtasks,
  approvals,
  onClose,
  onUpdateTask,
  onAssignTask,
  onRunTask,
  onStopTask,
  onPauseTask,
  onResumeTask,
  onDeleteTask,
  onOpenTerminal,
  onOpenMeetingMinutes,
  onOpenReport,
  onDecideApproval,
  onOpenHomelab,
}: TaskDrawerProps) {
  const { t, language, locale: localeTag } = useI18n();
  const [showDiff, setShowDiff] = useState(false);
  const [agentWarning, setAgentWarning] = useState(false);
  const [activity, setActivity] = useState<ActivityLine[]>([]);
  const [output, setOutput] = useState("");
  const [showOutput, setShowOutput] = useState(false);
  const [route, setRoute] = useState<api.TaskModelRoute | null>(null);
  const [upgradeHistory, setUpgradeHistory] = useState<api.ModelUpgradeRequest[]>([]);
  const panelRef = useRef<HTMLElement>(null);

  const assignedAgent = task.assigned_agent ?? agents.find((agent) => agent.id === task.assigned_agent_id);
  const department = departments.find((d) => d.id === task.department_id);
  const typeBadge = getTaskTypeBadge(task.task_type, t);
  const canRun = task.status === "planned" || task.status === "inbox";
  const canStop = task.status === "in_progress";
  const canPause = task.status === "in_progress" && !!onPauseTask;
  const canResume = (task.status === "pending" || task.status === "cancelled") && !!onResumeTask;
  const canDelete = task.status !== "in_progress";
  const hasLog = ["in_progress", "review", "done", "pending"].includes(task.status);
  const hasMinutes = ["planned", "collaborating", "in_progress", "review", "done", "pending"].includes(task.status);
  const hasReport = task.status === "done" || task.status === "review";

  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || showDiff || event.defaultPrevented || hasOpenEscapeLayer()) return;
      // Leave Escape to any dialog opened on top of the drawer.
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs.length > 1 || (dialogs.length === 1 && !panelRef.current?.contains(dialogs[0]))) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, showDiff]);

  useEffect(() => {
    let cancelled = false;
    api
      .getTaskModelRoute(task.id)
      .then((result) => {
        if (cancelled) return;
        setRoute(result.route);
        setUpgradeHistory(result.requests ?? []);
      })
      .catch(() => {
        if (!cancelled) setRoute(null);
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, task.status, task.assigned_agent_id]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.getTerminal(task.id, OUTPUT_LINES, true, ACTIVITY_LINES);
        if (cancelled || !res.ok) return;
        setActivity((res.task_logs ?? []).slice(-ACTIVITY_LINES));
        setOutput(res.exists ? (res.text ?? "") : "");
      } catch {
        // The preview is best effort; the full log window has its own error handling.
      }
    };
    void load();
    if (task.status !== "in_progress") return () => void (cancelled = true);
    const timer = window.setInterval(load, LOG_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [task.id, task.status]);

  const outputTail = useMemo(() => output.split("\n").slice(-OUTPUT_LINES).join("\n").trim(), [output]);

  const act = (icon: ReactNode, label: string, onClick: () => void, tone?: "go" | "warn" | "danger" | "info") => (
    <button type="button" onClick={onClick} className="ax-act" data-tone={tone} title={label}>
      {icon} {label}
    </button>
  );

  const field = (label: string, value: ReactNode) => (
    <div className="min-w-0">
      <dt className="text-[11.5px]" style={{ color: "var(--th-text-muted)" }}>
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-[13px]" style={{ color: "var(--th-text-primary)" }}>
        {value}
      </dd>
    </div>
  );

  return (
    <>
      <button
        type="button"
        className="fixed inset-0 z-[46] cursor-default bg-black/40"
        aria-label={t({ en: "Close" })}
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={task.title}
        className="fixed inset-y-0 right-0 z-[47] flex w-full max-w-[560px] flex-col outline-none"
        style={{
          background: "var(--th-bg-primary)",
          borderLeft: "1px solid var(--th-border)",
          boxShadow: "var(--ax-shadow-lift)",
          animation: "ax-rise 0.2s cubic-bezier(0.2, 0.8, 0.2, 1) both",
        }}
      >
        <header
          className="flex items-start gap-3 px-5 pb-3 pt-4"
          style={{ borderBottom: "1px solid var(--th-border)" }}
        >
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11.5px]">
              <span className={`rounded-full px-2 py-0.5 font-medium ${typeBadge.color}`}>{typeBadge.label}</span>
              {department && (
                <span
                  className="rounded-full px-2 py-0.5"
                  style={{ background: "var(--th-bg-surface)", color: "var(--th-text-secondary)" }}
                >
                  {department.icon} {localeName(language, department)}
                </span>
              )}
              <span style={{ color: "var(--th-text-muted)" }}>
                {t({ en: "Priority" })}: {priorityLabel(task.priority, t)}
              </span>
            </div>
            <h2 className="text-[17px] font-semibold leading-snug" style={{ color: "var(--th-text-heading)" }}>
              {task.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="theme-toggle-btn !h-8 !w-8 shrink-0"
            aria-label={t({ en: "Close" })}
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex flex-wrap gap-1.5 px-5 py-3" style={{ borderBottom: "1px solid var(--th-border)" }}>
          {canRun &&
            act(
              <Play size={12} strokeWidth={2.25} />,
              t({ en: "Run" }),
              () => {
                if (!task.assigned_agent_id) {
                  setAgentWarning(true);
                  window.setTimeout(() => setAgentWarning(false), 3000);
                  return;
                }
                void onRunTask(task.id);
              },
              "go",
            )}
          {canPause &&
            act(<Pause size={12} strokeWidth={2.25} />, t({ en: "Pause" }), () => void onPauseTask!(task.id), "warn")}
          {canStop &&
            act(
              <Square size={11} strokeWidth={2.25} />,
              t({ en: "Cancel" }),
              () => {
                const ok = window.confirm(
                  t({
                    en: `Stop "${task.title}"?\n\nWarning: stopping will roll back project changes.`,
                  }),
                );
                if (ok) void onStopTask(task.id);
              },
              "danger",
            )}
          {canResume &&
            act(<RotateCcw size={12} strokeWidth={2} />, t({ en: "Resume" }), () => void onResumeTask!(task.id), "go")}
          {hasLog &&
            act(<SquareTerminal size={13} strokeWidth={1.75} />, t({ en: "Full log" }), () => onOpenTerminal(task.id))}
          {hasMinutes &&
            act(<FileText size={13} strokeWidth={1.75} />, t({ en: "Minutes" }), () => onOpenMeetingMinutes(task.id))}
          {task.status === "review" &&
            act(
              <GitCompare size={12} strokeWidth={1.75} />,
              t({ en: "Diff · merge" }),
              () => setShowDiff(true),
              "info",
            )}
          {hasReport &&
            onOpenReport &&
            act(<FileBarChart size={13} strokeWidth={1.75} />, t({ en: "Report" }), () => onOpenReport(task.id))}
          {canDelete &&
            act(
              <Trash2 size={13} strokeWidth={1.75} />,
              t({ en: "Delete" }),
              () => {
                const ok = window.confirm(
                  t({
                    en: `Delete "${task.title}"?`,
                  }),
                );
                if (ok) {
                  void onDeleteTask(task.id);
                  onClose();
                }
              },
              "danger",
            )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {approvals.length > 0 && (
            <Section title={t({ en: "Waiting on you" })}>
              <ul className="-mx-5">
                {approvals.map((item) => (
                  <ApprovalRow
                    key={`${item.kind}:${item.id}`}
                    item={item}
                    onDecide={onDecideApproval}
                    onOpenHomelab={onOpenHomelab}
                  />
                ))}
              </ul>
            </Section>
          )}

          <Section title={t({ en: "Details" })}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block min-w-0">
                <span className="text-[11.5px]" style={{ color: "var(--th-text-muted)" }}>
                  {t({ en: "Status" })}
                </span>
                <select
                  value={task.status}
                  onChange={(event) => void onUpdateTask(task.id, { status: event.target.value as TaskStatus })}
                  className="mt-1 w-full rounded-lg px-2 py-1.5 text-[13px] outline-none"
                  style={{
                    background: "var(--th-input-bg)",
                    border: "1px solid var(--th-input-border)",
                    color: "var(--th-text-primary)",
                  }}
                >
                  {STATUS_OPTIONS.map((status) => (
                    <option key={status} value={status}>
                      {taskStatusLabel(status as TaskStatus, t)}
                    </option>
                  ))}
                </select>
              </label>
              <div className={`min-w-0 rounded-lg ${agentWarning ? "ring-2 ring-red-500" : ""}`}>
                <span className="text-[11.5px]" style={{ color: "var(--th-text-muted)" }}>
                  {t({ en: "Assigned to" })}
                </span>
                <div className="mt-1">
                  <AgentSelect
                    agents={agents}
                    departments={departments}
                    value={task.assigned_agent_id ?? ""}
                    onChange={(agentId) => {
                      setAgentWarning(false);
                      if (agentId) void onAssignTask(task.id, agentId);
                      else void onUpdateTask(task.id, { assigned_agent_id: null });
                    }}
                  />
                </div>
                {agentWarning && (
                  <p className="mt-1 text-[12px] font-medium text-red-400">
                    {t({
                      en: "Please assign an agent!",
                    })}
                  </p>
                )}
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {field(t({ en: "Created" }), formatDateTime(task.created_at, localeTag))}
              {field(t({ en: "Started" }), formatDateTime(task.started_at, localeTag))}
              {field(t({ en: "Completed" }), formatDateTime(task.completed_at, localeTag))}
            </dl>
            {task.project_path && (
              <p
                className="mt-3 truncate font-mono text-[12px]"
                style={{ color: "var(--th-text-secondary)" }}
                title={task.project_path}
              >
                {task.project_path}
              </p>
            )}
            {task.description && (
              <p
                className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed"
                style={{ color: "var(--th-text-primary)" }}
              >
                {task.description}
              </p>
            )}
          </Section>

          {subtasks.length > 0 && (
            <Section
              title={t({ en: "Subtasks" })}
              aside={
                <span className="text-[12px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                  {subtasks.filter((s) => s.status === "done").length}/{subtasks.length}
                </span>
              }
            >
              <ul className="space-y-1.5">
                {subtasks.map((subtask) => (
                  <li key={subtask.id} className="flex items-start gap-2 text-[13px]">
                    <span
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{
                        background:
                          subtask.status === "done"
                            ? "var(--ax-done)"
                            : subtask.status === "blocked"
                              ? "var(--ax-danger)"
                              : subtask.status === "in_progress"
                                ? "var(--ax-working)"
                                : "var(--ax-idle)",
                      }}
                      aria-hidden
                    />
                    <span
                      className={subtask.status === "done" ? "line-through" : ""}
                      style={{ color: subtask.status === "done" ? "var(--th-text-muted)" : "var(--th-text-primary)" }}
                    >
                      {subtask.title}
                      {subtask.status === "blocked" && subtask.blocked_reason && (
                        <span className="block text-[12px]" style={{ color: "var(--ax-danger)" }}>
                          {subtask.blocked_reason}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title={t({ en: "Model" })}>
            <div className="flex items-center gap-2.5">
              {assignedAgent && <AgentAvatar agent={assignedAgent} agents={agents} size={24} />}
              <p className="min-w-0 text-[13px]" style={{ color: "var(--th-text-primary)" }}>
                {route ? (
                  <>
                    <span className="font-mono">{route.model}</span>
                    {route.reasoning_level ? ` · ${route.reasoning_level}` : ""}
                    <span style={{ color: "var(--th-text-muted)" }}>
                      {" "}
                      · {route.provider} · {route.source}
                    </span>
                  </>
                ) : (
                  <span style={{ color: "var(--th-text-muted)" }}>{t({ en: "Default model" })}</span>
                )}
              </p>
            </div>
            {upgradeHistory.length > 0 && (
              <ul className="mt-2 space-y-1 text-[12px]" style={{ color: "var(--th-text-secondary)" }}>
                {upgradeHistory.slice(0, 5).map((req) => (
                  <li key={req.id}>
                    <span className="font-mono">
                      {req.requested_provider ? `${req.requested_provider}/` : ""}
                      {req.requested_model}
                    </span>{" "}
                    · {req.status}
                    {req.decision_reason ? ` — ${req.decision_reason}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section
            title={t({ en: "Recent activity" })}
            aside={
              task.status === "in_progress" ? (
                <span className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--th-text-muted)" }}>
                  <span className="ax-live" aria-hidden />
                  {t({ en: "Live" })}
                </span>
              ) : undefined
            }
          >
            {activity.length === 0 && !outputTail ? (
              <p className="text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                {t({
                  en: "Nothing logged yet.",
                })}
              </p>
            ) : (
              <>
                <ul className="space-y-1">
                  {activity.map((line) => (
                    <li key={line.id} className="flex gap-2 text-[12.5px] leading-relaxed">
                      <span className="shrink-0 tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                        {new Date(line.created_at).toLocaleTimeString(localeTag, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      <span className="min-w-0 break-words" style={{ color: "var(--th-text-primary)" }}>
                        {line.message}
                      </span>
                    </li>
                  ))}
                </ul>
                {outputTail && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() => setShowOutput((v) => !v)}
                      className="text-[12px] font-medium"
                      style={{ color: "var(--ax-signal)" }}
                    >
                      {showOutput
                        ? t({ en: "Hide output" })
                        : t({
                            en: "Show latest output",
                          })}
                    </button>
                    {showOutput && (
                      <pre
                        className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md p-2.5 font-mono text-[11.5px]"
                        style={{
                          background: "var(--th-bg-surface)",
                          border: "1px solid var(--th-border)",
                          color: "var(--th-text-secondary)",
                        }}
                      >
                        {outputTail}
                      </pre>
                    )}
                  </div>
                )}
              </>
            )}
          </Section>

          {task.result && (
            <Section title={t({ en: "Result" })}>
              <p
                className="max-h-64 overflow-auto whitespace-pre-wrap text-[13px] leading-relaxed"
                style={{ color: "var(--th-text-primary)" }}
              >
                {task.result}
              </p>
            </Section>
          )}
        </div>
      </aside>
      {showDiff && <DiffModal taskId={task.id} onClose={() => setShowDiff(false)} />}
    </>
  );
}
