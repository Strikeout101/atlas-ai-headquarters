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
        {t({ en: " skills shown" })}
        {search && `, "${search}" ${t({ en: "search results" })}`}
      </div>
    </>
  );
}
