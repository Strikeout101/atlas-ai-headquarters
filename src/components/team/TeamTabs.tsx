import { BookOpen, Bot, Clapperboard, type LucideIcon } from "lucide-react";
import { useI18n } from "../../i18n";
import type { View } from "../../app/types";

const TABS: Array<{ view: View; icon: LucideIcon; label: { ko: string; en: string; ja: string; zh: string } }> = [
  { view: "agents", icon: Bot, label: { ko: "에이전트", en: "Agents", ja: "エージェント", zh: "代理" } },
  { view: "vp_decisions", icon: Bot, label: { ko: "VP 결정", en: "VP decisions", ja: "VPの決定", zh: "VP决策" } },
  { view: "skills", icon: BookOpen, label: { ko: "문서고", en: "Library", ja: "ライブラリ", zh: "文档库" } },
  {
    view: "model_director",
    icon: Clapperboard,
    label: { ko: "모델 디렉터", en: "Model Director", ja: "モデルディレクター", zh: "模型主管" },
  },
];

/** Tabs across the Team area: agents and departments, the skills library, and model routing. */
export default function TeamTabs({ current, onChange }: { current: View; onChange: (view: View) => void }) {
  const { t } = useI18n();
  return (
    <div
      role="tablist"
      aria-label={t({ ko: "팀", en: "Team", ja: "チーム", zh: "团队" })}
      className="ax-tabs mb-4 flex-wrap"
    >
      {TABS.map(({ view, icon: Icon, label }) => (
        <button
          key={view}
          type="button"
          role="tab"
          aria-selected={current === view}
          onClick={() => onChange(view)}
          className="ax-tab"
        >
          <Icon size={15} strokeWidth={1.75} />
          {t(label)}
        </button>
      ))}
    </div>
  );
}
