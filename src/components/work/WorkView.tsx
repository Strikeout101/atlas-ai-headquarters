import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import WorkBoard from "./WorkBoard";
import InitiativePanel from "./InitiativePanel";

type Mode = "goals" | "all";
const MODE_KEY = "atlas.work.mode";

function readMode(): Mode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "all" ? "all" : "goals";
  } catch {
    return "goals";
  }
}

function readInitiative(): string | null {
  try {
    return new URLSearchParams(window.location.search).get("initiative");
  } catch {
    return null;
  }
}

/**
 * The Work page (phase 7): the board by goal → initiative (default), or every task on the classic board, where new
 * tasks, filters and bulk tools live. An initiative's page opens over the board (`?initiative=<id>`).
 */
export default function WorkView({
  refreshKey,
  onOpenTask,
  allTasks,
}: {
  refreshKey: unknown;
  onOpenTask: (id: string) => void;
  allTasks: ReactNode;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>(readMode);
  const [initiativeId, setInitiativeId] = useState<string | null>(readInitiative);
  const choose = (next: Mode) => {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      /* remembered only when storage works */
    }
  };
  const setInitiativeParam = useCallback((id: string | null) => {
    setInitiativeId(id);
    try {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set("initiative", id);
      else url.searchParams.delete("initiative");
      window.history.replaceState(window.history.state, "", url);
    } catch {
      /* the panel still opens without the URL */
    }
  }, []);
  useEffect(() => {
    const onPop = () => setInitiativeId(readInitiative());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const tabs: Array<[Mode, string]> = [
    ["goals", t({ en: "By goal" })],
    ["all", t({ en: "All tasks" })],
  ];
  return (
    <div className="min-w-0">
      <div role="tablist" aria-label={t({ en: "Work views" })} className="ax-tabs mb-4">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={mode === key}
            className="ax-tab"
            onClick={() => choose(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "goals" ? (
        <WorkBoard refreshKey={refreshKey} onOpenTask={onOpenTask} onOpenInitiative={(id) => setInitiativeParam(id)} />
      ) : (
        allTasks
      )}
      {initiativeId ? (
        <InitiativePanel
          initiativeId={initiativeId}
          refreshKey={refreshKey}
          onClose={() => setInitiativeParam(null)}
          onOpenTask={onOpenTask}
        />
      ) : null}
    </div>
  );
}
