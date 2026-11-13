import type { Agent, Department } from "../../types";
import { localeName } from "../../i18n";
import AgentCard from "./AgentCard";
import { Search } from "lucide-react";
import type { Translator } from "./types";

interface AgentsTabProps {
  tr: Translator;
  locale: string;
  isKo: boolean;
  agents: Agent[];
  departments: Department[];
  deptTab: string;
  setDeptTab: (deptId: string) => void;
  search: string;
  setSearch: (next: string) => void;
  sortedAgents: Agent[];
  spriteMap: Map<string, number>;
  confirmDeleteId: string | null;
  setConfirmDeleteId: (id: string | null) => void;
  onEditAgent: (agent: Agent) => void;
  onEditDepartment: (department: Department) => void;
  onDeleteAgent: (agentId: string) => void;
  saving: boolean;
  randomIconSprites: {
    total: [number, number];
  };
}

export default function AgentsTab({
  tr,
  locale,
  isKo,
  agents,
  departments,
  deptTab,
  setDeptTab,
  search,
  setSearch,
  sortedAgents,
  spriteMap,
  confirmDeleteId,
  setConfirmDeleteId,
  onEditAgent,
  onEditDepartment,
  onDeleteAgent,
  saving,
}: AgentsTabProps) {
  const workingCount = agents.filter((agent) => agent.status === "working").length;
  const deptCounts = new Map<string, { total: number; working: number }>();
  for (const agent of agents) {
    const key = agent.department_id || "__none";
    const count = deptCounts.get(key) ?? { total: 0, working: 0 };
    count.total += 1;
    if (agent.status === "working") count.working += 1;
    deptCounts.set(key, count);
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
        {[
          { label: tr("전체 인원", "Agents"), value: agents.length, live: false },
          { label: tr("근무 중", "Working now"), value: workingCount, live: workingCount > 0 },
          { label: tr("부서", "Departments"), value: departments.length, live: false },
        ].map((summary) => (
          <div key={summary.label} className="flex items-baseline gap-2">
            <span
              className="text-[26px] font-semibold leading-none tabular-nums tracking-[-0.02em]"
              style={{ color: "var(--th-text-heading)" }}
            >
              {summary.value}
            </span>
            <span className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--th-text-secondary)" }}>
              {summary.live && <span className="ax-live" aria-hidden />}
              {summary.label}
            </span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setDeptTab("all")} className="ax-chip" aria-pressed={deptTab === "all"}>
          {tr("전체", "All")}
          <span className="ax-chip-count">{agents.length}</span>
        </button>
        {departments.map((department) => {
          const count = deptCounts.get(department.id);
          return (
            <button
              key={department.id}
              type="button"
              onClick={() => setDeptTab(department.id)}
              onDoubleClick={(e) => {
                e.preventDefault();
                onEditDepartment(department);
              }}
              title={tr("더블클릭: 부서 편집", "Double-click to edit department")}
              className="ax-chip"
              aria-pressed={deptTab === department.id}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: department.color || "var(--ax-idle)" }} />
              {localeName(locale, department)}
              <span className="ax-chip-count">{count?.total ?? 0}</span>
              {(count?.working ?? 0) > 0 && <span className="ax-live !h-1.5 !w-1.5" aria-hidden />}
            </button>
          );
        })}
        <div className="relative ml-auto">
          <Search
            size={14}
            strokeWidth={1.75}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2"
            style={{ color: "var(--th-text-muted)" }}
          />
          <input
            type="text"
            placeholder={tr("검색", "Search agents")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-44 rounded-[7px] pl-8 pr-3 text-[13px] outline-none"
            style={{
              background: "var(--th-input-bg)",
              border: "1px solid var(--th-input-border)",
              color: "var(--th-text-primary)",
            }}
          />
        </div>
      </div>

      {sortedAgents.length === 0 ? (
        <div className="text-center py-16" style={{ color: "var(--th-text-muted)" }}>
          {tr("검색 결과 없음", "No agents match this search.")}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {sortedAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              spriteMap={spriteMap}
              isKo={isKo}
              locale={locale}
              tr={tr}
              departments={departments}
              onEdit={() => onEditAgent(agent)}
              confirmDeleteId={confirmDeleteId}
              onDeleteClick={() => setConfirmDeleteId(agent.id)}
              onDeleteConfirm={() => onDeleteAgent(agent.id)}
              onDeleteCancel={() => setConfirmDeleteId(null)}
              saving={saving}
            />
          ))}
        </div>
      )}
    </>
  );
}
