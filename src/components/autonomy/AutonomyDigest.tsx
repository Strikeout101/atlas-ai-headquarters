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
      aria-label={t({ ko: "자리를 비운 동안", en: "While you were away", ja: "不在中の動き", zh: "您离开期间" })}
      className="rounded-xl border p-5"
      style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">
          {t({ ko: "자리를 비운 동안", en: "While you were away", ja: "不在中の動き", zh: "您离开期间" })}
        </h3>
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
            {t({ ko: "읽음으로 표시", en: "Mark read", ja: "既読にする", zh: "标为已读" })}
          </button>
        )}
      </div>
      {failed && (
        <p role="alert" className="mt-3 text-sm">
          {t({
            ko: "활동을 불러오지 못했습니다.",
            en: "Could not load autonomy activity.",
            ja: "活動を読み込めませんでした。",
            zh: "无法加载自主活动。",
          })}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            {t({ ko: "다시 시도", en: "Retry", ja: "再試行", zh: "重试" })}
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
                ko: "전체 활동은 자율 운영에서 확인하세요.",
                en: "See Autonomy for the full activity log.",
                ja: "全活動は自律運用で確認できます。",
                zh: "在自主运行中查看完整活动记录。",
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
