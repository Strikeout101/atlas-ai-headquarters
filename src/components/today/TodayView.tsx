import { useMemo, type ReactNode } from "react";
import { ArrowRight, Loader2, Send, Signpost, SquareTerminal } from "lucide-react";
import type { Agent, Task } from "../../types";
import { localeName, useI18n } from "../../i18n";
import type { DecisionInboxItem } from "../chat/decision-inbox";
import type { PendingApproval } from "../../api";
import { BUSINESS_NAMES, type CommunicationDraft } from "../../api/business";
import AutonomyDigest from "../autonomy/AutonomyDigest";
import ApprovalRow from "./ApprovalRow";
import AgentAvatar from "../AgentAvatar";
import { timeAgo, useNow } from "../dashboard/model";

const NEEDS_YOU_LIMIT = 6;

interface TodayViewProps {
  agents: Agent[];
  tasks: Task[];
  decisionItems: DecisionInboxItem[];
  decisionInboxLoading: boolean;
  onOpenDecisionInbox: () => void;
  onOpenTerminal: (taskId: string) => void;
  onOpenWork: () => void;
  /** Opens the task drawer for one task. */
  onOpenTask?: (taskId: string) => void;
  /** Outreach drafts marked ready for review. */
  readyDrafts?: CommunicationDraft[];
  onOpenOutreach?: () => void;
  /** SSH commands that could change a host, and model upgrades, decided in place. */
  approvals?: PendingApproval[];
  onDecideApproval?: (item: PendingApproval, approve: boolean) => Promise<void>;
  onOpenHomelab?: () => void;
  /** The company overview (the previous dashboard) rendered below the attention queue. */
  children?: ReactNode;
}

function plainSnippet(content: string, max = 160): string {
  const flat = content
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatElapsed(fromMs: number, nowMs: number): string {
  const totalMinutes = Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, "0")}m` : `${minutes}m`;
}

function Panel({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section
      className="ax-panel overflow-hidden rounded-xl"
      style={{ border: "1px solid var(--th-border)", background: "var(--th-card-bg)" }}
    >
      <div
        className="flex h-12 items-center justify-between gap-3 px-5"
        style={{ borderBottom: "1px solid var(--th-border)" }}
      >
        <h3 className="text-[13px] font-semibold" style={{ color: "var(--th-text-heading)" }}>
          {title}
        </h3>
        {meta ? (
          <div className="text-[12px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
            {meta}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The landing page: what is waiting on the owner and what is running right now, with the company overview below.
 * SSH and model-upgrade approvals are decided here; decisions open the existing decision inbox, so every option it
 * offers stays available.
 */
export default function TodayView({
  agents,
  tasks,
  decisionItems,
  decisionInboxLoading,
  onOpenDecisionInbox,
  onOpenTerminal,
  onOpenWork,
  onOpenTask,
  readyDrafts = [],
  onOpenOutreach,
  approvals = [],
  onDecideApproval,
  onOpenHomelab,
  children,
}: TodayViewProps) {
  const { t, language, locale: localeTag } = useI18n();
  const { date } = useNow(localeTag);
  const nowMs = Date.now();
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);

  const running = useMemo(
    () =>
      tasks
        .filter((task) => task.status === "in_progress")
        .sort((a, b) => (a.started_at ?? a.updated_at) - (b.started_at ?? b.updated_at)),
    [tasks],
  );
  const inReview = useMemo(
    () => tasks.filter((task) => task.status === "review").sort((a, b) => b.updated_at - a.updated_at),
    [tasks],
  );

  const needsYouCount = approvals.length + decisionItems.length + inReview.length + readyDrafts.length;
  const shownDecisions = decisionItems.slice(0, NEEDS_YOU_LIMIT);
  const shownReviews = inReview.slice(0, Math.max(0, NEEDS_YOU_LIMIT - shownDecisions.length));

  const agentFor = (task: Task): Agent | undefined =>
    task.assigned_agent ?? (task.assigned_agent_id ? agentById.get(task.assigned_agent_id) : undefined);
  const agentNameFor = (task: Task): string => {
    const agent = agentFor(task);
    if (agent) return localeName(language, agent);
    return task.agent_name ?? t({ en: "Unassigned" });
  };

  const chip = (text: string, accent?: boolean) => (
    <span
      className="inline-flex h-7 items-center rounded-full px-3 text-[12px] font-medium tabular-nums"
      style={{
        border: `1px solid ${accent ? "var(--ax-signal)" : "var(--th-border)"}`,
        color: accent ? "var(--th-text-heading)" : "var(--th-text-secondary)",
        background: "var(--th-bg-surface)",
      }}
    >
      {text}
    </span>
  );

  const actionButtonClass =
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition hover:opacity-90 active:scale-[0.98]";
  const quietButtonStyle = {
    border: "1px solid var(--th-border)",
    background: "var(--th-bg-surface)",
    color: "var(--th-text-primary)",
  };

  return (
    <div className="mx-auto w-full max-w-[1280px] space-y-6 pb-8">
      <header className="flex flex-wrap items-end justify-between gap-4 pt-1">
        <div>
          <h2
            className="text-[26px] font-semibold leading-tight tracking-[-0.02em]"
            style={{ color: "var(--th-text-heading)" }}
          >
            {t({ en: "Today" })}
          </h2>
          <p className="mt-1 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
            {date}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {chip(
            t({
              en: `${needsYouCount} need you`,
            }),
            needsYouCount > 0,
          )}
          {chip(
            t({
              en: `${running.length} running`,
            }),
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Panel
          title={t({ en: "Needs you" })}
          meta={
            decisionInboxLoading ? <Loader2 size={14} className="animate-spin" aria-label="Loading" /> : needsYouCount
          }
        >
          {needsYouCount === 0 ? (
            <p className="px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              {t({
                en: "Nothing is waiting on you right now.",
              })}
            </p>
          ) : (
            <ul>
              {onDecideApproval &&
                approvals.map((item) => (
                  <ApprovalRow
                    key={`${item.kind}:${item.id}`}
                    item={item}
                    onDecide={onDecideApproval}
                    onOpenHomelab={onOpenHomelab ?? onOpenWork}
                  />
                ))}
              {shownDecisions.map((item) => (
                <li
                  key={item.id}
                  className="flex items-start gap-3 px-5 py-3.5"
                  style={{ borderBottom: "1px solid var(--th-border)" }}
                >
                  <Signpost
                    size={15}
                    strokeWidth={1.75}
                    className="mt-0.5 shrink-0"
                    style={{ color: "var(--ax-signal)" }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className="flex flex-wrap items-baseline gap-x-2 text-[12px]"
                      style={{ color: "var(--th-text-muted)" }}
                    >
                      <span className="font-medium" style={{ color: "var(--th-text-secondary)" }}>
                        {t({ en: "Decision" })}
                      </span>
                      <span>{item.agentName}</span>
                      {item.projectName && <span>· {item.projectName}</span>}
                      <span>· {timeAgo(item.createdAt, localeTag)}</span>
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--th-text-primary)" }}>
                      {plainSnippet(item.requestContent)}
                    </p>
                  </div>
                  <button type="button" onClick={onOpenDecisionInbox} className={`${actionButtonClass} ax-btn-primary`}>
                    {t({ en: "Decide" })}
                  </button>
                </li>
              ))}
              {readyDrafts.slice(0, NEEDS_YOU_LIMIT).map((draft) => (
                <li
                  key={`draft:${draft.id}`}
                  className="flex items-start gap-3 px-5 py-3.5"
                  style={{ borderBottom: "1px solid var(--th-border)" }}
                >
                  <Send
                    size={15}
                    strokeWidth={1.75}
                    className="mt-0.5 shrink-0"
                    style={{ color: "var(--ax-signal)" }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className="flex flex-wrap items-baseline gap-x-2 text-[12px]"
                      style={{ color: "var(--th-text-muted)" }}
                    >
                      <span className="font-medium" style={{ color: "var(--th-text-secondary)" }}>
                        {t({ en: "Draft ready" })}
                      </span>
                      <span>
                        {BUSINESS_NAMES[draft.business]} · {draft.channel}
                      </span>
                      <span>· {timeAgo(draft.updated_at, localeTag)}</span>
                    </div>
                    <p className="mt-1 truncate text-[13px]" style={{ color: "var(--th-text-primary)" }}>
                      {draft.subject || plainSnippet(draft.body, 90)}
                    </p>
                  </div>
                  {onOpenOutreach && (
                    <button
                      type="button"
                      onClick={onOpenOutreach}
                      className={actionButtonClass}
                      style={quietButtonStyle}
                    >
                      {t({
                        en: "Open in Outreach",
                      })}
                    </button>
                  )}
                </li>
              ))}
              {shownReviews.map((task) => (
                <li
                  key={task.id}
                  className="flex items-start gap-3 px-5 py-3.5"
                  style={{ borderBottom: "1px solid var(--th-border)" }}
                >
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                    style={{ background: "var(--ax-signal)" }}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className="flex flex-wrap items-baseline gap-x-2 text-[12px]"
                      style={{ color: "var(--th-text-muted)" }}
                    >
                      <span className="font-medium" style={{ color: "var(--th-text-secondary)" }}>
                        {t({ en: "Ready for review" })}
                      </span>
                      <span>{agentNameFor(task)}</span>
                      <span>· {timeAgo(task.updated_at, localeTag)}</span>
                    </div>
                    <p className="mt-1 truncate text-[13px]" style={{ color: "var(--th-text-primary)" }}>
                      {task.title}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => (onOpenTask ? onOpenTask(task.id) : onOpenWork())}
                    className={actionButtonClass}
                    style={quietButtonStyle}
                  >
                    {onOpenTask ? t({ en: "Review" }) : t({ en: "Open in Work" })}
                  </button>
                </li>
              ))}
              {needsYouCount > shownDecisions.length + shownReviews.length && (
                <li className="flex justify-end gap-2 px-5 py-2.5">
                  {decisionItems.length > shownDecisions.length && (
                    <button
                      type="button"
                      onClick={onOpenDecisionInbox}
                      className="inline-flex items-center gap-1 text-[12px] font-medium"
                      style={{ color: "var(--ax-signal)" }}
                    >
                      {t({ en: "All decisions" })}
                      <ArrowRight size={13} />
                    </button>
                  )}
                  {inReview.length > shownReviews.length && (
                    <button
                      type="button"
                      onClick={onOpenWork}
                      className="inline-flex items-center gap-1 text-[12px] font-medium"
                      style={{ color: "var(--ax-signal)" }}
                    >
                      {t({ en: "All reviews" })}
                      <ArrowRight size={13} />
                    </button>
                  )}
                </li>
              )}
            </ul>
          )}
        </Panel>

        <Panel title={t({ en: "Running now" })} meta={running.length}>
          {running.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              {t({
                en: "No tasks are running.",
              })}
            </p>
          ) : (
            <ul>
              {running.map((task) => {
                const agent = agentFor(task);
                return (
                  <li
                    key={task.id}
                    className="flex items-center gap-3 px-5 py-3"
                    style={{ borderBottom: "1px solid var(--th-border)" }}
                  >
                    {agent ? (
                      <AgentAvatar agent={agent} agents={agents} size={28} />
                    ) : (
                      <span
                        className="h-7 w-7 shrink-0 rounded-full"
                        style={{ background: "var(--th-bg-surface)" }}
                        aria-hidden
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      {onOpenTask ? (
                        <button
                          type="button"
                          onClick={() => onOpenTask(task.id)}
                          className="block max-w-full truncate text-left text-[13px] font-medium hover:underline"
                          style={{ color: "var(--th-text-primary)" }}
                        >
                          {task.title}
                        </button>
                      ) : (
                        <p className="truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
                          {task.title}
                        </p>
                      )}
                      <p className="truncate text-[12px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                        {agentNameFor(task)}
                        {task.started_at ? ` · ${formatElapsed(task.started_at, nowMs)}` : ""}
                        {task.subtask_total ? ` · ${task.subtask_done ?? 0}/${task.subtask_total}` : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenTerminal(task.id)}
                      className={actionButtonClass}
                      style={quietButtonStyle}
                      aria-label={t({
                        en: `Open log for ${task.title}`,
                      })}
                    >
                      <SquareTerminal size={14} strokeWidth={1.75} />
                      {t({ en: "Log" })}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      <AutonomyDigest />
      {children && (
        <div className="space-y-3">
          <h3 className="text-[13px] font-semibold" style={{ color: "var(--th-text-muted)" }}>
            {t({ en: "Company overview" })}
          </h3>
          {children}
        </div>
      )}
    </div>
  );
}
