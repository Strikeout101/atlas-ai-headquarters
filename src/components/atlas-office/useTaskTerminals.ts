import { useEffect, useRef, useState } from "react";
import * as api from "../../api";
import { cleanTerminalLines } from "./screenArt";

const POLL_MS = 4000;
const LINES = 12;

/**
 * Latest terminal output for each task id, refreshed every few seconds while the ATLAS office is open. Used to
 * show what working agents are really doing on their desk monitors. Falls back to the task's log messages when
 * the task has no terminal output yet.
 */
export function useTaskTerminals(taskIds: string[]): ReadonlyMap<string, string[]> {
  const [terminals, setTerminals] = useState<ReadonlyMap<string, string[]>>(() => new Map());
  const key = [...new Set(taskIds)].sort().join(",");
  const ids = useRef<string[]>([]);
  ids.current = key ? key.split(",") : [];

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      // Nobody can see the monitors while the tab is hidden: wait for it to come back instead of fetching.
      if (document.hidden) {
        document.addEventListener("visibilitychange", poll, { once: true });
        return;
      }
      const current = ids.current;
      const results = await Promise.allSettled(
        current.map(async (id) => {
          const response = await api.getTerminal(id, LINES * 3, true, LINES);
          let lines = response.exists ? cleanTerminalLines(response.text ?? "", LINES) : [];
          if (lines.length === 0 && response.task_logs?.length) {
            lines = response.task_logs
              .slice(-LINES)
              .map((log) => cleanTerminalLines(log.message, 1)[0] ?? "")
              .filter(Boolean);
          }
          return [id, lines] as const;
        }),
      );
      if (cancelled) return;
      const next = new Map<string, string[]>();
      for (const result of results) if (result.status === "fulfilled") next.set(result.value[0], result.value[1]);
      setTerminals(next);
      timer = setTimeout(poll, POLL_MS);
    };
    if (ids.current.length > 0) void poll();
    else setTerminals(new Map());
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [key]);

  return terminals;
}
