import { useMemo, type ReactNode } from "react";
import { ArrowRight, Loader2, Signpost, SquareTerminal } from "lucide-react";
import type { Agent, Task } from "../../types";
import { localeName, useI18n } from "../../i18n";
import type { DecisionInboxItem } from "../chat/decision-inbox";
import type { PendingApproval } from "../../api";
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

  const needsYouCount = approvals.length + decisionItems.length + inReview.length;
  const shownDecisions = decisionItems.slice(0, NEEDS_YOU_LIMIT);
  const shownReviews = inReview.slice(0, Math.max(0, NEEDS_YOU_LIMIT - shownDecisions.length));

  const agentFor = (task: Task): Agent | undefined =>
    task.assigned_agent ?? (task.assigned_agent_id ? agentById.get(task.assigned_agent_id) : undefined);
  const agentNameFor = (task: Task): string => {
    const agent = agentFor(task);
    if (agent) return localeName(language, agent);
    return task.agent_name ?? t({ ko: "미배정", en: "Unassigned", ja: "未割り当て", zh: "未分配" });
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
            {t({ ko: "오늘", en: "Today", ja: "今日", zh: "今日" })}
          </h2>
          <p className="mt-1 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
            {date}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {chip(
            t({
              ko: `${needsYouCount}건 대기`,
              en: `${needsYouCount} need you`,
              ja: `${needsYouCount} 件対応待ち`,
              zh: `${needsYouCount} 项待你处理`,
            }),
            needsYouCount > 0,
          )}
          {chip(
            t({
              ko: `${running.length}건 진행 중`,
              en: `${running.length} running`,
              ja: `${running.length} 件実行中`,
              zh: `${running.length} 项运行中`,
            }),
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Panel
          title={t({ ko: "확인이 필요한 항목", en: "Needs you", ja: "対応が必要", zh: "待你处理" })}
          meta={
            decisionInboxLoading ? <Loader2 size={14} className="animate-spin" aria-label="Loading" /> : needsYouCount
          }
        >
          {needsYouCount === 0 ? (
            <p className="px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "지금은 결정할 것이 없습니다.",
                en: "Nothing is waiting on you right now.",
                ja: "今は対応待ちの項目はありません。",
                zh: "目前没有需要你处理的事项。",
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
                        {t({ ko: "결정 요청", en: "Decision", ja: "意思決定", zh: "决策" })}
                      </span>
                      <span>{language === "ko" ? item.agentNameKo : item.agentName}</span>
                      {item.projectName && <span>· {item.projectName}</span>}
                      <span>· {timeAgo(item.createdAt, localeTag)}</span>
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "var(--th-text-primary)" }}>
                      {plainSnippet(item.requestContent)}
                    </p>
                  </div>
                  <button type="button" onClick={onOpenDecisionInbox} className={`${actionButtonClass} ax-btn-primary`}>
                    {t({ ko: "결정하기", en: "Decide", ja: "決定する", zh: "去决定" })}
                  </button>
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
                        {t({ ko: "검토 대기", en: "Ready for review", ja: "レビュー待ち", zh: "待审核" })}
                      </span>
                      <span>{agentNameFor(task)}</span>
                      <span>· {timeAgo(task.updated_at, localeTag)}</span>
                    </div>
                    <p className="mt-1 truncate text-[13px]" style={{ color: "var(--th-text-primary)" }}>
                      {task.title}
                    </p>
                  </div>
                  <button type="button" onClick={onOpenWork} className={actionButtonClass} style={quietButtonStyle}>
                    {t({ ko: "업무에서 열기", en: "Open in Work", ja: "業務で開く", zh: "在工作中打开" })}
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
                      {t({ ko: "모든 결정 보기", en: "All decisions", ja: "すべての意思決定", zh: "全部决策" })}
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
                      {t({ ko: "모든 검토 보기", en: "All reviews", ja: "すべてのレビュー", zh: "全部审核" })}
                      <ArrowRight size={13} />
                    </button>
                  )}
                </li>
              )}
            </ul>
          )}
        </Panel>

        <Panel title={t({ ko: "진행 중", en: "Running now", ja: "実行中", zh: "正在运行" })} meta={running.length}>
          {running.length === 0 ? (
            <p className="px-5 py-8 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "실행 중인 업무가 없습니다.",
                en: "No tasks are running.",
                ja: "実行中のタスクはありません。",
                zh: "没有正在运行的任务。",
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
                      <p className="truncate text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
                        {task.title}
                      </p>
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
                        ko: `${task.title} 로그 열기`,
                        en: `Open log for ${task.title}`,
                        ja: `${task.title} のログを開く`,
                        zh: `打开 ${task.title} 的日志`,
                      })}
                    >
                      <SquareTerminal size={14} strokeWidth={1.75} />
                      {t({ ko: "로그", en: "Log", ja: "ログ", zh: "日志" })}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>

      {children && (
        <div className="space-y-3">
          <h3 className="text-[13px] font-semibold" style={{ color: "var(--th-text-muted)" }}>
            {t({ ko: "회사 현황", en: "Company overview", ja: "会社の概況", zh: "公司概况" })}
          </h3>
          {children}
        </div>
      )}
    </div>
  );
}
