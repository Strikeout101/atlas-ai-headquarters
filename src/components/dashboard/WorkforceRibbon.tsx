import { useMemo, useState, type CSSProperties } from "react";
import type { Agent, AgentStatus, Task } from "../../types";
import { localeName, type UiLanguage } from "../../i18n";
import AgentAvatar from "../AgentAvatar";
import { AGENT_STATUS_COLOR, AGENT_STATUS_ORDER, CountUp, agentStatusLabel, type TFunction } from "./model";

interface WorkforceRibbonProps {
  agents: Agent[];
  taskById: Map<string, Task>;
  language: UiLanguage;
  numberFormatter: Intl.NumberFormat;
  t: TFunction;
}

/**
 * One segment per agent, coloured by live status. Hovering or focusing a
 * segment fills the readout line underneath with who it is and what they hold.
 */
export function WorkforceRibbon({ agents, taskById, language, numberFormatter, t }: WorkforceRibbonProps) {
  const [focusId, setFocusId] = useState<string | null>(null);

  const ordered = useMemo(
    () =>
      [...agents].sort(
        (a, b) =>
          AGENT_STATUS_ORDER.indexOf(a.status) - AGENT_STATUS_ORDER.indexOf(b.status) ||
          (a.department_id ?? "").localeCompare(b.department_id ?? "") ||
          a.name.localeCompare(b.name),
      ),
    [agents],
  );

  const counts = useMemo(() => {
    const result: Record<AgentStatus, number> = { working: 0, break: 0, idle: 0, offline: 0 };
    for (const agent of agents) result[agent.status] = (result[agent.status] ?? 0) + 1;
    return result;
  }, [agents]);

  const focused = focusId ? agents.find((agent) => agent.id === focusId) : undefined;
  const focusedTask = focused?.current_task_id ? taskById.get(focused.current_task_id) : undefined;

  return (
    <div className="ax-panel px-5 pb-4 pt-5 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="flex items-baseline gap-3">
          <span className="text-[44px] font-semibold leading-none tabular-nums tracking-[-0.03em]">
            <CountUp value={counts.working} format={numberFormatter} />
          </span>
          <span className="text-[15px]" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: `/ ${agents.length}명 근무 중`,
              en: `of ${agents.length} agents working`,
              ja: `/ ${agents.length}名 稼働中`,
              zh: `/ ${agents.length} 名代理工作中`,
            })}
          </span>
        </div>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[12px]" style={{ color: "var(--th-text-secondary)" }}>
          {AGENT_STATUS_ORDER.map((status) => (
            <li key={status} className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: AGENT_STATUS_COLOR[status] }} />
              {agentStatusLabel(status, t)}
              <span className="tabular-nums" style={{ color: "var(--th-text-primary)" }}>
                {numberFormatter.format(counts[status])}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {ordered.length === 0 ? (
        <div
          className="mt-5 flex h-11 items-center justify-center rounded-md text-[13px]"
          style={{ border: "1px dashed var(--th-border-strong)", color: "var(--th-text-muted)" }}
        >
          {t({
            ko: "아직 에이전트가 없습니다. 에이전트 화면에서 추가하세요.",
            en: "No agents yet. Add one from the Agents screen.",
            ja: "エージェントがまだいません。エージェント画面から追加してください。",
            zh: "还没有代理。请在代理页面添加。",
          })}
        </div>
      ) : (
        <ol
          className="ax-ribbon mt-5"
          aria-label={t({ ko: "에이전트 상태", en: "Agent status", ja: "エージェント状態", zh: "代理状态" })}
          onMouseLeave={() => setFocusId(null)}
        >
          {ordered.map((agent, index) => (
            <li
              key={agent.id}
              tabIndex={0}
              className="ax-ribbon-seg"
              data-status={agent.status}
              data-active={focusId === agent.id || undefined}
              style={
                {
                  "--seg": AGENT_STATUS_COLOR[agent.status],
                  animationDelay: `${index * 18}ms`,
                } as CSSProperties
              }
              aria-label={`${localeName(language, agent)}, ${agentStatusLabel(agent.status, t)}`}
              onMouseEnter={() => setFocusId(agent.id)}
              onClick={() => setFocusId(agent.id)}
              onFocus={() => setFocusId(agent.id)}
              onBlur={() => setFocusId(null)}
            >
              <span className="ax-seg-face">
                <AgentAvatar agent={agent} agents={agents} size={26} />
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className="mt-3 h-5 truncate text-[12.5px]" style={{ color: "var(--th-text-muted)" }} aria-live="polite">
        {focused ? (
          <>
            <span style={{ color: "var(--th-text-primary)" }}>{localeName(language, focused)}</span>
            {focused.department ? `, ${localeName(language, focused.department)}` : ""}
            {": "}
            {focusedTask ? focusedTask.title : agentStatusLabel(focused.status, t)}
          </>
        ) : (
          t({
            ko: "막대를 선택하면 에이전트 정보를 볼 수 있습니다.",
            en: "Select a segment to see who it is and what they're on.",
            ja: "セグメントを選ぶと担当者と作業内容が表示されます。",
            zh: "选择色块，查看代理及其当前任务。",
          })
        )}
      </p>
    </div>
  );
}
