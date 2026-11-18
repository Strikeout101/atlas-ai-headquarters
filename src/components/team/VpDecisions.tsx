import { useCallback, useEffect, useState } from "react";
import { request } from "../../api/core";
import { useI18n } from "../../i18n";

interface Decision {
  event_id?: string;
  approval_kind: string;
  approval_id: string;
  status: string;
  outcome: string | null;
  reason: string;
  updated_at: number;
  reviews: Array<{ vp_agent_id: string; verdict: string; reason: string }>;
}

export default function VpDecisions() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<Decision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await request<{ items: Decision[] }>("/api/vp-decisions");
      if (signal?.aborted) return;
      setItems(result.items);
      setError(null);
    } catch (cause) {
      if (!signal?.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => void refresh(controller.signal), 30_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);
  return (
    <section className="mx-auto w-full max-w-7xl" aria-label={t({ en: "VP decisions" })}>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {t({ en: "VP decisions" })}
          </h1>
          <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              en: "Independent reviews, approvals, denials and waits. Disagreements and requests needing your judgment appear on Today.",
            })}
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} className="ax-btn-secondary shrink-0">
          {t({ en: "Refresh" })}
        </button>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm" style={{ color: "var(--ax-danger)" }}>
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">{t({ en: "Loading reviews…" })}</p>
      ) : !items.length ? (
        <p className="py-10 text-sm" style={{ color: "var(--th-text-muted)" }}>
          {t({
            en: "No VP reviews yet.",
          })}
        </p>
      ) : (
        <ol className="divide-y" style={{ borderColor: "var(--th-border)" }}>
          {items.map((item) => (
            <li key={item.event_id ?? `${item.approval_kind}:${item.approval_id}`} className="py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-medium" style={{ color: "var(--th-text-primary)" }}>
                  {item.approval_kind.replaceAll("_", " ")}{" "}
                  <span className="ml-2 text-xs font-normal" style={{ color: "var(--th-text-muted)" }}>
                    {item.outcome ?? item.status}
                  </span>
                </h2>
                <time
                  className="text-xs"
                  style={{ color: "var(--th-text-muted)" }}
                  dateTime={new Date(item.updated_at).toISOString()}
                >
                  {new Date(item.updated_at).toLocaleString(locale)}
                </time>
              </div>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm" style={{ color: "var(--th-text-secondary)" }}>
                {item.reason ||
                  t({
                    en: "Waiting for independent reviews.",
                  })}
              </p>
              <p className="mt-2 break-all font-mono text-[11px]" style={{ color: "var(--th-text-muted)" }}>
                {item.approval_id}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
