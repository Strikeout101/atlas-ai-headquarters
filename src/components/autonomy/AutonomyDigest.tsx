import { useCallback, useEffect, useState } from "react";
import { getAutonomyDigest, type AutonomyDigest as Digest } from "../../api/autonomy";
import { useI18n } from "../../i18n";

const STORAGE_KEY = "atlas.autonomyDigest.acknowledgedAt";
function readAcknowledged(): number {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    return Number.isFinite(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** A fetch never acknowledges events. Only the owner's Mark read action advances the cursor. */
export default function AutonomyDigest() {
  const { t, locale } = useI18n();
  const [after, setAfter] = useState(readAcknowledged);
  const [digest, setDigest] = useState<Digest | null>(null);
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const value = await getAutonomyDigest(after);
        if (!signal?.aborted) {
          setDigest(value);
          setFailed(false);
        }
      } catch {
        if (!signal?.aborted) setFailed(true);
      }
    },
    [after],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(controller.signal), 60000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);
  if (!digest?.events.length && !failed) return null;
  return (
    <section
      aria-label={t({ en: "While you were away" })}
      className="rounded-xl border p-5"
      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">{t({ en: "While you were away" })}</h3>
        {!!digest?.events.length && (
          <button
            type="button"
            className="ax-btn-secondary"
            onClick={() => {
              const newest = digest.through ?? Math.max(after, ...digest.events.map((event) => event.created_at));
              try {
                localStorage.setItem(STORAGE_KEY, String(newest));
              } catch {
                /* Keep the acknowledgment for this tab. */
              }
              setAfter(newest);
              setDigest({ events: [], counts: {} });
            }}
          >
            {t({ en: "Mark read" })}
          </button>
        )}
      </div>
      {failed && (
        <p role="alert" className="mt-3 text-sm">
          {t({
            en: "Could not load autonomy activity.",
          })}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            {t({ en: "Retry" })}
          </button>
        </p>
      )}
      {!!digest?.events.length && (
        <>
          <p className="mt-2 break-words text-xs" style={{ color: "var(--th-text-muted)" }}>
            {Object.entries(digest.counts)
              .map(([kind, count]) => `${kind.replaceAll("_", " ")}: ${count}`)
              .join(" · ")}
          </p>
          <ol className="mt-3 divide-y" style={{ borderColor: "var(--th-border)" }}>
            {digest.events.slice(0, 6).map((event) => (
              <li key={event.id} className="py-2 text-sm">
                <p className="break-words">{event.message}</p>
                <time
                  className="text-xs"
                  style={{ color: "var(--th-text-muted)" }}
                  dateTime={new Date(event.created_at).toISOString()}
                >
                  {new Date(event.created_at).toLocaleString(locale)}
                </time>
              </li>
            ))}
          </ol>
          {digest.events.length > 6 && (
            <p className="mt-2 text-xs">
              {t({
                en: "See Autonomy for the full activity log.",
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
