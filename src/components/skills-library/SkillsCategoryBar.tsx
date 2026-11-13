import { CATEGORIES, categoryLabel, type TFunction } from "./model";

interface SkillsCategoryBarProps {
  t: TFunction;
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
  categoryCounts: Record<string, number>;
  filteredLength: number;
  search: string;
}

export default function SkillsCategoryBar({
  t,
  selectedCategory,
  onSelectCategory,
  categoryCounts,
  filteredLength,
  search,
}: SkillsCategoryBarProps) {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((category) => (
          <button
            key={category}
            onClick={() => onSelectCategory(category)}
            type="button"
            className="ax-chip"
            aria-pressed={selectedCategory === category}
          >
            {categoryLabel(category, t)}
            <span className="ax-chip-count">{categoryCounts[category] || 0}</span>
          </button>
        ))}
      </div>

      <div className="text-xs text-slate-500 px-1">
        {filteredLength}
        {t({ ko: "개 스킬 표시중", en: " skills shown", ja: "件のスキルを表示中", zh: " 个技能已显示" })}
        {search && `, "${search}" ${t({ ko: "검색 결과", en: "search results", ja: "検索結果", zh: "搜索结果" })}`}
      </div>
    </>
  );
}
