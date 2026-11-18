import { Plus } from "lucide-react";
import type { TFunction } from "./model";

interface SkillsHeaderProps {
  t: TFunction;
  skillsCount: number;
  search: string;
  onSearchChange: (value: string) => void;
  sortBy: "rank" | "name" | "installs";
  onSortByChange: (value: "rank" | "name" | "installs") => void;
  onOpenCustomSkillModal: () => void;
}

export default function SkillsHeader({
  t,
  skillsCount,
  search,
  onSearchChange,
  sortBy,
  onSortByChange,
  onOpenCustomSkillModal,
}: SkillsHeaderProps) {
  return (
    <div className="ax-panel p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-[20px] font-semibold tracking-[-0.015em]" style={{ color: "var(--th-text-heading)" }}>
            {t({
              en: "Agent Skills Library",
            })}
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            {t({
              en: "Skills your agents can learn, live from skills.sh",
            })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onOpenCustomSkillModal}
            className="custom-skill-add-btn header-action-btn header-action-btn-secondary !border-[var(--th-border)]"
            title={t({
              en: "Add custom skill",
            })}
          >
            <Plus size={15} strokeWidth={2} />
            {t({ en: "Add custom skill" })}
          </button>
          <div className="text-right">
            <div
              className="text-[26px] font-semibold leading-none tabular-nums tracking-[-0.02em]"
              style={{ color: "var(--th-text-heading)" }}
            >
              {skillsCount}
            </div>
            <div className="text-xs text-slate-500">{t({ en: "Registered skills" })}</div>
          </div>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex-1 relative">
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t({
              en: "Search skills... (name, repo, category)",
            })}
            className="w-full bg-slate-900/60 border border-slate-600/50 rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/25"
          />
          {search && (
            <button
              onClick={() => onSearchChange("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
            >
              &times;
            </button>
          )}
        </div>

        <select
          value={sortBy}
          onChange={(e) => onSortByChange(e.target.value as "rank" | "name" | "installs")}
          className="bg-slate-900/60 border border-slate-600/50 rounded-lg px-3 py-2.5 text-sm text-slate-300 focus:outline-none focus:border-blue-500/50"
        >
          <option value="rank">{t({ en: "By Rank" })}</option>
          <option value="installs">{t({ en: "By Installs" })}</option>
          <option value="name">{t({ en: "By Name" })}</option>
        </select>
      </div>
    </div>
  );
}
