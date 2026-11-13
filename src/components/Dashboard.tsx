import { useMemo } from "react";
import { Plus } from "lucide-react";
import type { Agent, CompanyStats, Department, Task } from "../types";
import { localeName, useI18n } from "../i18n";
import { WorkforceRibbon } from "./dashboard/WorkforceRibbon";
import {
  DepartmentTable,
  RecentActivity,
  TaskPipeline,
  TopContributors,
  type Contributor,
  type DepartmentLoad,
  type PipelineStage,
} from "./dashboard/Sections";
import { useNow } from "./dashboard/model";

interface DashboardProps {
  stats: CompanyStats | null;
  agents: Agent[];
  tasks: Task[];
  departments?: Department[];
  companyName: string;
  onPrimaryCtaClick: () => void;
}

export default function Dashboard({
  stats,
  agents,
  tasks,
  departments: departmentList = [],
  companyName,
  onPrimaryCtaClick,
}: DashboardProps) {
  const { t, language, locale: localeTag } = useI18n();
  const { date, time } = useNow(localeTag);
  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(localeTag), [localeTag]);

  const countTasks = (status: Task["status"]) => tasks.filter((task) => task.status === status).length;
  const stages: PipelineStage[] = [
    { status: "inbox", count: stats?.tasks?.inbox ?? countTasks("inbox") },
    {
      status: "planned",
      count:
        (stats?.tasks?.planned ?? countTasks("planned")) + (stats?.tasks?.collaborating ?? countTasks("collaborating")),
    },
    { status: "in_progress", count: stats?.tasks?.in_progress ?? countTasks("in_progress") },
    { status: "review", count: stats?.tasks?.review ?? countTasks("review") },
    { status: "done", count: stats?.tasks?.done ?? countTasks("done") },
  ];
  const inProgress = stages[2].count;
  const inReview = stages[3].count;
  const onHold = countTasks("pending");
  const cancelled = stats?.tasks?.cancelled ?? countTasks("cancelled");
  const totalTasks = stats?.tasks?.total ?? tasks.length;
  const completionRate =
    stats?.tasks?.completion_rate ?? (totalTasks > 0 ? Math.round((stages[4].count / totalTasks) * 100) : 0);

  const summary = (() => {
    if (inProgress === 0 && inReview === 0) {
      return t({
        ko: "진행 중인 작업이 없습니다.",
        en: "Nothing in progress right now.",
        ja: "進行中のタスクはありません。",
        zh: "目前没有进行中的任务。",
      });
    }
    return t({
      ko: `진행 중 ${inProgress}건, 검토 대기 ${inReview}건.`,
      en: `${inProgress} ${inProgress === 1 ? "task" : "tasks"} in progress, ${inReview} waiting for review.`,
      ja: `進行中 ${inProgress} 件、レビュー待ち ${inReview} 件。`,
      zh: `进行中 ${inProgress} 项，待审核 ${inReview} 项。`,
    });
  })();

  const departments = useMemo<DepartmentLoad[]>(() => {
    const map = new Map<string, DepartmentLoad>();
    const named = new Map(departmentList.map((dept) => [dept.id, localeName(language, dept)]));
    const ensure = (id: string, fallback: string) => {
      if (!map.has(id)) map.set(id, { id, name: named.get(id) ?? fallback, done: 0, total: 0, staffed: 0, working: 0 });
      return map.get(id)!;
    };
    for (const dept of departmentList) ensure(dept.id, dept.name);
    for (const agent of agents) {
      if (!agent.department_id) continue;
      const entry = ensure(
        agent.department_id,
        agent.department ? localeName(language, agent.department) : agent.department_id,
      );
      entry.staffed += 1;
      if (agent.status === "working") entry.working += 1;
    }
    if (stats?.tasks_by_department?.length) {
      for (const dept of stats.tasks_by_department) {
        const entry = ensure(dept.id, dept.name);
        entry.done = dept.done_tasks;
        entry.total = dept.total_tasks;
      }
    } else {
      for (const task of tasks) {
        if (!task.department_id) continue;
        const entry = map.get(task.department_id);
        if (!entry) continue;
        entry.total += 1;
        if (task.status === "done") entry.done += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.working - a.working || b.total - a.total || a.name.localeCompare(b.name));
  }, [stats, agents, tasks, departmentList, language]);

  const contributors = useMemo<Contributor[]>(() => {
    const source =
      stats?.top_agents && stats.top_agents.length > 0
        ? stats.top_agents.map((top) => ({
            id: top.id,
            fallback: top.name,
            tasksDone: top.stats_tasks_done,
            xp: top.stats_xp,
          }))
        : agents.map((agent) => ({
            id: agent.id,
            fallback: agent.name,
            tasksDone: agent.stats_tasks_done,
            xp: agent.stats_xp,
          }));
    return source
      .sort((a, b) => b.tasksDone - a.tasksDone || b.xp - a.xp)
      .slice(0, 5)
      .map((entry) => {
        const agent = agentMap.get(entry.id);
        return {
          id: entry.id,
          name: agent ? localeName(language, agent) : entry.fallback,
          department: agent?.department ? localeName(language, agent.department) : "",
          tasksDone: entry.tasksDone,
          xp: entry.xp,
        };
      });
  }, [stats, agents, agentMap, language]);

  const recentTasks = useMemo(() => [...tasks].sort((a, b) => b.updated_at - a.updated_at).slice(0, 8), [tasks]);

  const pipelineAside = (
    <span>
      {t({
        ko: `완료율 ${completionRate}%`,
        en: `${completionRate}% complete`,
        ja: `完了率 ${completionRate}%`,
        zh: `完成率 ${completionRate}%`,
      })}
      {onHold > 0 &&
        t({ ko: `, 보류 ${onHold}`, en: `, ${onHold} on hold`, ja: `、保留 ${onHold}`, zh: `，待处理 ${onHold}` })}
      {cancelled > 0 &&
        t({
          ko: `, 취소 ${cancelled}`,
          en: `, ${cancelled} cancelled`,
          ja: `、キャンセル ${cancelled}`,
          zh: `，已取消 ${cancelled}`,
        })}
    </span>
  );

  return (
    <section
      className="ax-dashboard mx-auto w-full max-w-[1280px] space-y-4 pb-8"
      style={{ color: "var(--th-text-primary)" }}
    >
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-2 pt-1">
        <div className="min-w-0">
          <h2
            className="truncate text-[26px] font-semibold leading-tight tracking-[-0.02em]"
            style={{ color: "var(--th-text-heading)" }}
          >
            {companyName}
          </h2>
          <p className="mt-1 flex items-center gap-2 text-[14px]" style={{ color: "var(--th-text-secondary)" }}>
            {agents.some((agent) => agent.status === "working") && <span className="ax-live" aria-hidden />}
            {summary}
          </p>
        </div>
        <div className="flex items-center gap-5">
          <div className="leading-tight sm:text-right">
            <div className="font-mono text-[20px] font-medium tabular-nums" style={{ color: "var(--th-text-heading)" }}>
              {time}
            </div>
            <div className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              {date}
            </div>
          </div>
          <button
            type="button"
            onClick={onPrimaryCtaClick}
            className="header-action-btn header-action-btn-primary !h-9 !px-4"
          >
            <Plus size={16} strokeWidth={2} />
            {t({ ko: "새 작업", en: "New task", ja: "新しいタスク", zh: "新建任务" })}
          </button>
        </div>
      </header>

      <WorkforceRibbon
        agents={agents}
        taskById={taskById}
        language={language}
        numberFormatter={numberFormatter}
        t={t}
      />

      <TaskPipeline stages={stages} aside={pipelineAside} numberFormatter={numberFormatter} t={t} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <RecentActivity
          tasks={recentTasks}
          agentMap={agentMap}
          agents={agents}
          language={language}
          localeTag={localeTag}
          onCreateTask={onPrimaryCtaClick}
          t={t}
        />
        <div className="space-y-4">
          <DepartmentTable departments={departments} numberFormatter={numberFormatter} t={t} />
          <TopContributors
            contributors={contributors}
            agentMap={agentMap}
            agents={agents}
            numberFormatter={numberFormatter}
            t={t}
          />
        </div>
      </div>
    </section>
  );
}
