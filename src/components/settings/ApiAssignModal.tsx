import AgentAvatar, { buildSpriteMap } from "../AgentAvatar";
import type { Agent } from "../../types";
import type { ApiStateBundle, TFunction } from "./types";

interface ApiAssignModalProps {
  t: TFunction;
  localeTag: string;
  apiState: ApiStateBundle;
}

export default function ApiAssignModal({ t, localeTag, apiState }: ApiAssignModalProps) {
  const {
    apiAssignTarget,
    apiAssigning,
    apiAssignAgents,
    apiAssignDepts,
    apiProviders,
    contextWindowTokensInput,
    setContextWindowTokensInput,
    setApiAssignTarget,
    handleApiAssignToAgent,
  } = apiState;

  if (!apiAssignTarget) return null;

  const isOllama = apiProviders.some(
    (provider) => provider.id === apiAssignTarget.providerId && provider.type === "ollama",
  );
  const windowValue = contextWindowTokensInput === "" ? null : Number(contextWindowTokensInput);
  const validWindow = windowValue === null || (Number.isSafeInteger(windowValue) && windowValue > 0);

  const spriteMap = buildSpriteMap(apiAssignAgents);
  const localName = (nameEn: string, nameKo: string) => (localeTag === "ko" ? nameKo || nameEn : nameEn || nameKo);
  const ROLE_LABELS: Record<string, Record<string, string>> = {
    vp: { ko: "부사장", en: "VP", ja: "副社長", zh: "副总裁" },
    team_leader: { ko: "팀장", en: "Team Leader", ja: "チームリーダー", zh: "组长" },
    senior: { ko: "시니어", en: "Senior", ja: "シニア", zh: "高级" },
    junior: { ko: "주니어", en: "Junior", ja: "ジュニア", zh: "初级" },
    intern: { ko: "인턴", en: "Intern", ja: "インターン", zh: "实习生" },
  };

  const roleBadge = (role: string) => {
    const label = ROLE_LABELS[role];
    const text = label ? t(label as Record<"ko" | "en" | "ja" | "zh", string>) : role;
    const color =
      role === "team_leader"
        ? "text-amber-400 bg-amber-500/15"
        : role === "senior"
          ? "text-blue-400 bg-blue-500/15"
          : role === "junior"
            ? "text-emerald-400 bg-emerald-500/15"
            : "text-slate-400 bg-slate-500/15";
    return <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${color}`}>{text}</span>;
  };

  const deptIds = new Set(apiAssignDepts.map((dept) => dept.id));
  const departments = apiAssignDepts
    .map((dept) => ({ dept, agents: apiAssignAgents.filter((agent) => agent.department_id === dept.id) }))
    .filter((group) => group.agents.length > 0);
  const unassigned = apiAssignAgents.filter((agent) => !agent.department_id || !deptIds.has(agent.department_id));

  const renderAgentRow = (agent: Agent) => {
    const isAssigned =
      agent.cli_provider === "api" &&
      agent.api_provider_id === apiAssignTarget.providerId &&
      agent.api_model === apiAssignTarget.model &&
      (!isOllama || (agent.context_window_tokens ?? null) === windowValue);

    return (
      <button
        key={agent.id}
        disabled={apiAssigning || isAssigned || !validWindow}
        onClick={() => void handleApiAssignToAgent(agent.id)}
        className={`w-full text-left px-2 py-1.5 rounded-lg text-xs transition-colors flex items-center gap-2.5 ${
          isAssigned ? "bg-green-500/10 text-green-400 cursor-default" : "hover:bg-slate-700/60 text-slate-300"
        } disabled:opacity-60`}
      >
        <AgentAvatar agent={agent} spriteMap={spriteMap} size={28} rounded="xl" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium truncate">{localName(agent.name, agent.name_ko)}</span>
            {roleBadge(agent.role)}
          </div>
          <div className="text-[10px] text-slate-500 truncate mt-0.5">
            {agent.cli_provider === "api" && agent.api_model
              ? `API: ${agent.api_model}${agent.context_window_tokens ? ` · ${agent.context_window_tokens.toLocaleString()} tokens` : ""}`
              : agent.cli_provider}
          </div>
        </div>
        {isAssigned && <span className="text-green-400 flex-shrink-0">✓</span>}
      </button>
    );
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => setApiAssignTarget(null)}
    >
      <div
        className="w-96 max-h-[75vh] rounded-xl border border-slate-600 bg-slate-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-slate-700">
          <h4 className="text-sm font-semibold text-white">
            {t({
              ko: "에이전트에 모델 배정",
              en: "Assign Model to Agent",
              ja: "エージェントにモデル割当",
              zh: "分配模型给代理",
            })}
          </h4>
          <p className="text-[11px] text-slate-400 mt-0.5 font-mono truncate">{apiAssignTarget.model}</p>
          {isOllama && (
            <div className="mt-3">
              <label htmlFor="ollama-context-window" className="block text-[11px] text-slate-300 mb-1">
                {t({
                  ko: "컨텍스트 창 (토큰)",
                  en: "Context window (tokens)",
                  ja: "コンテキスト窓（トークン）",
                  zh: "上下文窗口（令牌）",
                })}
              </label>
              <input
                id="ollama-context-window"
                type="number"
                min="1"
                step="1"
                value={contextWindowTokensInput}
                onChange={(event) => setContextWindowTokensInput(event.target.value)}
                placeholder={t({ ko: "미설정", en: "Unknown", ja: "未設定", zh: "未设置" })}
                aria-invalid={!validWindow}
                className="w-full rounded border border-slate-600 bg-slate-700 px-2 py-1 text-xs text-slate-100 focus:outline-none focus:border-blue-500"
              />
              <p className="mt-1 text-[10px] text-slate-400">
                {t({
                  ko: "80%에서 자동으로 새 컨텍스트로 이어갑니다. 비워두면 한도 오류가 발생했을 때 복구합니다.",
                  en: "Roll over at 80%. Leave blank to recover only after a context error.",
                  ja: "80%で新しいコンテキストに切り替えます。空欄なら上限エラー時に復旧します。",
                  zh: "达到 80% 时切换到新上下文。留空则仅在超限错误后恢复。",
                })}
              </p>
              {!validWindow && (
                <p className="mt-1 text-[10px] text-rose-400">
                  {t({
                    ko: "양의 정수를 입력하세요.",
                    en: "Enter a positive whole number.",
                    ja: "正の整数を入力してください。",
                    zh: "请输入正整数。",
                  })}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="max-h-[55vh] overflow-y-auto p-2 space-y-3">
          {apiAssignAgents.length === 0 ? (
            <p className="text-xs text-slate-500 text-center py-4">
              {t({
                ko: "에이전트를 불러오는 중...",
                en: "Loading agents...",
                ja: "エージェント読み込み中...",
                zh: "正在加载代理...",
              })}
            </p>
          ) : (
            <>
              {departments.map(({ dept, agents }) => (
                <div key={dept.id}>
                  <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-slate-700/40">
                    <span className="text-sm">{dept.icon}</span>
                    <span className="text-[11px] font-semibold text-slate-300 tracking-wide">
                      {localName(dept.name, dept.name_ko)}
                    </span>
                    <span className="text-[10px] text-slate-600">({agents.length})</span>
                  </div>
                  {agents.map(renderAgentRow)}
                </div>
              ))}
              {unassigned.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-slate-700/40">
                    <span className="text-sm">📁</span>
                    <span className="text-[11px] font-semibold text-slate-500 tracking-wide">
                      {t({ ko: "미배정", en: "Unassigned", ja: "未配属", zh: "未分配" })}
                    </span>
                  </div>
                  {unassigned.map(renderAgentRow)}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-slate-700 flex justify-end">
          <button
            onClick={() => setApiAssignTarget(null)}
            className="text-xs px-3 py-1.5 bg-slate-600 hover:bg-slate-500 text-slate-300 rounded-lg transition-colors"
          >
            {t({ ko: "닫기", en: "Close", ja: "閉じる", zh: "关闭" })}
          </button>
        </div>
      </div>
    </div>
  );
}
