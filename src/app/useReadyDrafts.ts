import { useCallback, useEffect, useState } from "react";
import { businessApi, type CommunicationDraft } from "../api/business";

const REFRESH_MS = 60_000;

/** Outreach drafts marked ready for the owner's review, across both businesses. */
export function useReadyDrafts(enabled: boolean) {
  const [items, setItems] = useState<CommunicationDraft[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [tech, rental] = await Promise.all([businessApi.drafts.list("tech"), businessApi.drafts.list("rental")]);
      setItems(
        [...tech, ...rental].filter((draft) => draft.status === "ready").sort((a, b) => b.updated_at - a.updated_at),
      );
    } catch {
      // Keep the last known list; Today still works without it.
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

  return { items, refresh };
}
