import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import { useI18n } from "../../i18n";

export type CommandGroup = "navigate" | "actions" | "agents" | "tasks";

export interface CommandItem {
  id: string;
  group: CommandGroup;
  label: string;
  /** Secondary text on the right, such as a status or department. */
  hint?: string;
  icon?: ReactNode;
  /** Extra words to match on. */
  keywords?: string;
  run: () => void;
}

const GROUP_ORDER: CommandGroup[] = ["navigate", "actions", "agents", "tasks"];
/** Agents and tasks only appear once the user types, so the empty list stays short. */
const SEARCH_ONLY_GROUPS = new Set<CommandGroup>(["agents", "tasks"]);
const MAX_PER_GROUP = 8;

function score(item: CommandItem, terms: string[]): number {
  if (terms.length === 0) return 1;
  const label = item.label.toLowerCase();
  const haystack = `${label} ${(item.hint ?? "").toLowerCase()} ${(item.keywords ?? "").toLowerCase()}`;
  if (!terms.every((term) => haystack.includes(term))) return 0;
  const first = terms[0];
  if (label.startsWith(first)) return 3;
  if (label.includes(first)) return 2;
  return 1;
}

export function filterCommands(items: CommandItem[], query: string): CommandItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out: CommandItem[] = [];
  for (const group of GROUP_ORDER) {
    if (terms.length === 0 && SEARCH_ONLY_GROUPS.has(group)) continue;
    const matches = items
      .filter((item) => item.group === group)
      .map((item) => ({ item, s: score(item, terms) }))
      .filter((entry) => entry.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, terms.length === 0 ? undefined : MAX_PER_GROUP)
      .map((entry) => entry.item);
    out.push(...matches);
  }
  return out;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: CommandItem[];
}

export default function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, [open]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const groupLabel: Record<CommandGroup, string> = {
    navigate: t({ ko: "이동", en: "Go to", ja: "移動", zh: "跳转" }),
    actions: t({ ko: "작업", en: "Actions", ja: "操作", zh: "操作" }),
    agents: t({ ko: "에이전트", en: "Agents", ja: "エージェント", zh: "代理" }),
    tasks: t({ ko: "업무", en: "Tasks", ja: "タスク", zh: "任务" }),
  };

  const runAt = (index: number) => {
    const item = results[index];
    if (!item) return;
    onClose();
    item.run();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runAt(active);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  const activeId = results[active] ? `${listId}-${active}` : undefined;
  let lastGroup: CommandGroup | null = null;

  return (
    <div
      className="fixed inset-0 z-[900] flex items-start justify-center bg-black/50 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t({ ko: "명령 모음", en: "Command bar", ja: "コマンドバー", zh: "命令栏" })}
        className="flex max-h-[70vh] w-full max-w-[600px] flex-col overflow-hidden rounded-xl"
        style={{
          background: "var(--th-bg-elevated)",
          border: "1px solid var(--th-border-strong)",
          boxShadow: "var(--ax-shadow-lift)",
          animation: "ax-rise 0.22s cubic-bezier(0.2, 0.8, 0.2, 1) both",
        }}
        onKeyDown={onKeyDown}
      >
        <div className="flex h-12 items-center gap-3 px-4" style={{ borderBottom: "1px solid var(--th-border)" }}>
          <Search size={16} strokeWidth={1.75} style={{ color: "var(--th-text-muted)" }} aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t({
              ko: "페이지, 작업, 에이전트, 업무 검색…",
              en: "Search pages, actions, agents and tasks…",
              ja: "ページ・操作・エージェント・タスクを検索…",
              zh: "搜索页面、操作、代理和任务…",
            })}
            className="h-full flex-1 bg-transparent text-[14px] focus:outline-none"
            style={{ color: "var(--th-text-primary)" }}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
          />
          <kbd
            className="rounded px-1.5 font-mono text-[10.5px]"
            style={{ border: "1px solid var(--th-border)", color: "var(--th-text-muted)" }}
          >
            Esc
          </kbd>
        </div>

        <ul ref={listRef} id={listId} role="listbox" className="flex-1 overflow-y-auto py-1.5">
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-[13px]" style={{ color: "var(--th-text-muted)" }}>
              {t({ ko: "일치하는 항목이 없습니다.", en: "Nothing matches.", ja: "一致なし。", zh: "没有匹配项。" })}
            </li>
          )}
          {results.map((item, index) => {
            const heading =
              item.group !== lastGroup ? (
                <li
                  key={`h-${item.group}`}
                  role="presentation"
                  className="px-4 pb-1 pt-2.5 text-[11px] font-medium"
                  style={{ color: "var(--th-text-muted)" }}
                >
                  {groupLabel[item.group]}
                </li>
              ) : null;
            lastGroup = item.group;
            const selected = index === active;
            return [
              heading,
              <li
                key={item.id}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={selected}
                className="mx-1.5 flex h-9 cursor-pointer items-center gap-3 rounded-md px-2.5 text-[13px]"
                style={{
                  background: selected ? "var(--th-bg-surface)" : "transparent",
                  color: selected ? "var(--th-text-heading)" : "var(--th-text-primary)",
                }}
                onMouseMove={() => setActive(index)}
                onClick={() => runAt(index)}
              >
                <span className="flex w-4 justify-center" style={{ color: "var(--th-text-muted)" }} aria-hidden>
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.hint && (
                  <span className="max-w-[40%] truncate text-[11.5px]" style={{ color: "var(--th-text-muted)" }}>
                    {item.hint}
                  </span>
                )}
                {selected && <CornerDownLeft size={13} style={{ color: "var(--th-text-muted)" }} aria-hidden />}
              </li>,
            ];
          })}
        </ul>
      </div>
    </div>
  );
}
