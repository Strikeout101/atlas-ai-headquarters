import { ChevronRight, Plus } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { Agent, Task, TaskStatus } from "../../types";
import { localeName, type UiLanguage } from "../../i18n";
import AgentAvatar from "../AgentAvatar";
import { CountUp, TASK_STATUS_COLOR, taskStatusLabel, timeAgo, type TFunction } from "./model";

function PanelHeader({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
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
  );
}

/* ─── Pipeline ─── */

export interface PipelineStage {
  status: TaskStatus;
  count: number;
}

export function TaskPipeline({
  stages,
  aside,
  numberFormatter,
  t,
}: {
  stages: PipelineStage[];
  aside: ReactNode;
  numberFormatter: Intl.NumberFormat;
  t: TFunction;
}) {
  const max = Math.max(1, ...stages.map((stage) => stage.count));
  return (
    <div className="ax-panel">
      <PanelHeader title={t({ en: "Task flow" })} meta={aside} />
      <ol className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {stages.map((stage, index) => (
          <li
            key={stage.status}
            className="ax-stage relative px-5 py-4 last:col-span-2 sm:last:col-span-1"
            data-busy={stage.count > 0 || undefined}
            style={{ "--stage": TASK_STATUS_COLOR[stage.status] } as CSSProperties}
          >
            <div className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--th-text-secondary)" }}>
              <span className="h-2 w-2 rounded-full" style={{ background: TASK_STATUS_COLOR[stage.status] }} />
              {taskStatusLabel(stage.status, t)}
            </div>
            <div
              className="mt-2 text-[28px] font-semibold leading-none tabular-nums tracking-[-0.02em]"
              style={{ color: stage.count > 0 ? "var(--th-text-heading)" : "var(--th-text-muted)" }}
            >
              <CountUp value={stage.count} format={numberFormatter} />
            </div>
            <div className="mt-3 h-[3px] overflow-hidden rounded-full" style={{ background: "var(--th-border)" }}>
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${(stage.count / max) * 100}%`, background: TASK_STATUS_COLOR[stage.status] }}
              />
            </div>
            {index < stages.length - 1 && (
              <ChevronRight
                size={14}
                strokeWidth={1.75}
                className="ax-stage-arrow absolute right-[-7px] top-1/2 hidden -translate-y-1/2 lg:block"
                style={{ color: "var(--th-text-muted)", background: "var(--th-panel-bg)" }}
                aria-hidden
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ─── Recent activity ─── */

export function RecentActivity({
  tasks,
  agentMap,
  agents,
  language,
  localeTag,
  onCreateTask,
  t,
}: {
  tasks: Task[];
  agentMap: Map<string, Agent>;
  agents: Agent[];
  language: UiLanguage;
  localeTag: string;
  onCreateTask: () => void;
  t: TFunction;
}) {
  return (
    <div className="ax-panel self-start">
      <PanelHeader title={t({ en: "Recent activity" })} />
      {tasks.length === 0 ? (
        <div className="flex flex-col items-start gap-3 px-5 py-8">
          <p className="max-w-[46ch] text-[13.5px] leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              en: "No tasks yet. Create one and an agent will pick it up.",
            })}
          </p>
          <button type="button" onClick={onCreateTask} className="header-action-btn header-action-btn-primary">
            <Plus size={15} strokeWidth={2} />
            {t({ en: "New task" })}
          </button>
        </div>
      ) : (
        <ul>
          {tasks.map((task) => {
            const agent = task.assigned_agent_id ? agentMap.get(task.assigned_agent_id) : undefined;
            return (
              <li
                key={task.id}
                className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_9rem_6.5rem_4.5rem]"
                style={{ borderTop: "1px solid var(--th-border)" }}
              >
                <div className="min-w-0 truncate text-[13.5px]" style={{ color: "var(--th-text-primary)" }}>
                  {task.title}
                </div>
                <div className="hidden min-w-0 items-center gap-2 sm:flex">
                  {agent ? (
                    <>
                      <AgentAvatar agent={agent} agents={agents} size={20} />
                      <span className="truncate text-[12.5px]" style={{ color: "var(--th-text-secondary)" }}>
                        {localeName(language, agent)}
                      </span>
                    </>
                  ) : (
                    <span className="text-[12.5px]" style={{ color: "var(--th-text-muted)" }}>
                      {t({ en: "Unassigned" })}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--th-text-secondary)" }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: TASK_STATUS_COLOR[task.status] }} />
                  {taskStatusLabel(task.status, t)}
                </div>
                <div
                  className="col-span-2 text-[12px] tabular-nums sm:col-span-1 sm:text-right"
                  style={{ color: "var(--th-text-muted)" }}
                >
                  {timeAgo(task.updated_at, localeTag)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ─── Departments ─── */

export interface DepartmentLoad {
  id: string;
  name: string;
  done: number;
  total: number;
  staffed: number;
  working: number;
}

export function DepartmentTable({
  departments,
  numberFormatter,
  t,
}: {
  departments: DepartmentLoad[];
  numberFormatter: Intl.NumberFormat;
  t: TFunction;
}) {
  return (
    <div className="ax-panel">
      <PanelHeader title={t({ en: "Departments" })} meta={t({ en: "done / total" })} />
      {departments.length === 0 ? (
        <p className="px-5 py-6 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
          {t({
            en: "No departments set up yet.",
          })}
        </p>
      ) : (
        <ul className="py-1.5">
          {departments.map((dept) => {
            const pct = dept.total > 0 ? (dept.done / dept.total) * 100 : 0;
            return (
              <li key={dept.id} className="px-5 py-2">
                <div className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate" style={{ color: "var(--th-text-primary)" }}>
                      {dept.name}
                    </span>
                    {dept.working > 0 && (
                      <span className="shrink-0 text-[11.5px]" style={{ color: "var(--ax-working)" }}>
                        {t({
                          en: `${dept.working} working`,
                        })}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 tabular-nums" style={{ color: "var(--th-text-secondary)" }}>
                    {numberFormatter.format(dept.done)}
                    <span style={{ color: "var(--th-text-muted)" }}> / {numberFormatter.format(dept.total)}</span>
                  </span>
                </div>
                <div className="mt-1.5 h-[3px] overflow-hidden rounded-full" style={{ background: "var(--th-border)" }}>
                  <div
                    className="h-full rounded-full transition-[width] duration-500"
                    style={{ width: `${pct}%`, background: "var(--ax-done)" }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ─── Top contributors ─── */

export interface Contributor {
  id: string;
  name: string;
  department: string;
  tasksDone: number;
  xp: number;
}

export function TopContributors({
  contributors,
  agentMap,
  agents,
  numberFormatter,
  t,
}: {
  contributors: Contributor[];
  agentMap: Map<string, Agent>;
  agents: Agent[];
  numberFormatter: Intl.NumberFormat;
  t: TFunction;
}) {
  const hasWork = contributors.some((c) => c.tasksDone > 0 || c.xp > 0);
  return (
    <div className="ax-panel">
      <PanelHeader title={t({ en: "Top contributors" })} meta={t({ en: "tasks done" })} />
      {!hasWork ? (
        <p className="px-5 py-6 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
          {t({
            en: "Rankings appear once agents finish their first tasks.",
          })}
        </p>
      ) : (
        <ol className="py-1.5">
          {contributors.map((c, index) => (
            <li key={c.id} className="flex items-center gap-3 px-5 py-2">
              <span className="w-4 text-right text-[12px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                {index + 1}
              </span>
              <AgentAvatar agent={agentMap.get(c.id)} agents={agents} size={26} />
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-[13px]" style={{ color: "var(--th-text-primary)" }}>
                  {c.name}
                </div>
                <div className="truncate text-[11.5px]" style={{ color: "var(--th-text-muted)" }}>
                  {c.department || t({ en: "Unassigned" })}
                </div>
              </div>
              <div className="text-right leading-tight">
                <div className="text-[13px] font-medium tabular-nums">{numberFormatter.format(c.tasksDone)}</div>
                <div className="text-[11px] tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                  {numberFormatter.format(c.xp)} xp
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
