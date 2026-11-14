import { useCallback, useEffect, useRef, useState } from "react";
import { getPendingApprovals, type PendingApproval } from "../api";

const REFRESH_MS = 30_000;

/** Keeps the list of SSH and model-upgrade approvals current while the page is visible. */
export function usePendingApprovals(enabled: boolean) {
  const [items, setItems] = useState<PendingApproval[]>([]);
  const [loaded, setLoaded] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setItems(await getPendingApprovals());
      setLoaded(true);
    } catch {
      // Keep the last known list; the next refresh will try again.
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    tick();
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, refresh]);

  return { items, loaded, refresh, setItems };
}
