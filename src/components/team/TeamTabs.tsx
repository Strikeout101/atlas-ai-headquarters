import { BookOpen, Bot, Brain, Clapperboard, type LucideIcon } from "lucide-react";
import { useI18n } from "../../i18n";
import type { View } from "../../app/types";

const TABS: Array<{ view: View; icon: LucideIcon; label: { en: string } }> = [
  { view: "agents", icon: Bot, label: { en: "Agents" } },
  { view: "vp_decisions", icon: Bot, label: { en: "VP decisions" } },
  { view: "knowledge", icon: Brain, label: { en: "Knowledge" } },
  { view: "skills", icon: BookOpen, label: { en: "Library" } },
  {
    view: "model_director",
    icon: Clapperboard,
    label: { en: "Model Director" },
  },
];

/** Tabs across the Team area: agents and departments, the skills library, and model routing. */
export default function TeamTabs({ current, onChange }: { current: View; onChange: (view: View) => void }) {
  const { t } = useI18n();
  return (
    <div role="tablist" aria-label={t({ en: "Team" })} className="ax-tabs mb-4 flex-wrap">
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
