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
    <section
      className="mx-auto w-full max-w-7xl"
      aria-label={t({ ko: "VP 결정", en: "VP decisions", ja: "VPの決定", zh: "VP决策" })}
    >
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold" style={{ color: "var(--th-text-heading)" }}>
            {t({ ko: "VP 결정", en: "VP decisions", ja: "VPの決定", zh: "VP决策" })}
          </h1>
          <p className="mt-1 max-w-2xl text-sm" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: "독립 검토, 승인, 거부 및 대기 기록입니다. 의견이 다르거나 소유자의 승인이 필요하면 오늘에 표시됩니다.",
              en: "Independent reviews, approvals, denials and waits. Disagreements and requests needing your judgment appear on Today.",
              ja: "独立レビュー、承認、拒否、待機の記録です。意見の相違やオーナー判断が必要な項目は今日に表示されます。",
              zh: "独立审核、批准、拒绝和等待记录。分歧和需要您判断的请求会显示在今日。",
            })}
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} className="ax-btn-secondary shrink-0">
          {t({ ko: "새로고침", en: "Refresh", ja: "更新", zh: "刷新" })}
        </button>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm" style={{ color: "var(--ax-danger)" }}>
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">{t({ ko: "불러오는 중…", en: "Loading reviews…", ja: "読み込み中…", zh: "正在加载审核…" })}</p>
      ) : !items.length ? (
        <p className="py-10 text-sm" style={{ color: "var(--th-text-muted)" }}>
          {t({
            ko: "아직 VP 검토가 없습니다.",
            en: "No VP reviews yet.",
            ja: "VPレビューはまだありません。",
            zh: "暂无VP审核。",
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
                    ko: "독립 검토를 기다리는 중입니다.",
                    en: "Waiting for independent reviews.",
                    ja: "独立レビューを待っています。",
                    zh: "正在等待独立审核。",
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
