import type { ReactNode } from "react";
import type { AutonomyOverview, BusinessGoal, Initiative } from "../../api/autonomy";
import { BUSINESS_NAMES } from "../../api/business";
import { useI18n } from "../../i18n";
import { formatMoney } from "../revenue/money";

const financialMetrics = new Set(["revenue", "verified_revenue", "profit", "verified_profit"]);
const readable = (value: string) => value.replaceAll("_", " ");

export default function GoalsOverview({
  data,
  busy,
  onEdit,
  milestones,
}: {
  data: AutonomyOverview;
  busy: boolean;
  onEdit: (goal: BusinessGoal) => void;
  milestones: (goal: BusinessGoal) => ReactNode;
}) {
  const { t, locale } = useI18n();
  const progressText = (goal: BusinessGoal, value: number) =>
    financialMetrics.has(goal.metric)
      ? new Intl.NumberFormat(locale, { style: "currency", currency: goal.currency || "USD" }).format(value)
      : new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const usd = (value: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);

  if (!data.goals.length)
    return (
      <p className="py-8 text-sm" style={{ color: "var(--th-text-muted)" }}>
        {t({ en: "No goals yet. Add one to give the team a target." })}
      </p>
    );

  return (
    <div className="space-y-6">
      {data.goals.map((goal) => {
        const initiatives = data.initiatives.filter((item) => item.goal_id === goal.id);
        const strategy = data.strategies?.find((item) => item.goal_id === goal.id);
        const progress = goal.progress;
        const percentage =
          progress === null || goal.target <= 0 ? null : Math.min(100, Math.max(0, (progress / goal.target) * 100));
        return (
          <section
            key={goal.id}
            className="rounded-xl border p-4 sm:p-5"
            style={{ borderColor: "var(--th-border)", background: "var(--th-card-bg)" }}
            aria-label={goal.title || readable(goal.metric)}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium" style={{ color: "var(--th-text-muted)" }}>
                  {BUSINESS_NAMES[goal.business]}
                </p>
                <h3 className="mt-1 break-words text-lg font-semibold">{goal.title || readable(goal.metric)}</h3>
                <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                  {readable(goal.metric)} · {new Date(goal.period_start).toLocaleDateString(locale)} –{" "}
                  {new Date(goal.period_end).toLocaleDateString(locale)}
                </p>
              </div>
              <button type="button" className="ax-btn-secondary" disabled={busy} onClick={() => onEdit(goal)}>
                {t({ en: "Edit goal" })}
              </button>
            </div>

            <div
              className="mt-5 grid gap-4 border-t pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)]"
              style={{ borderColor: "var(--th-border)" }}
            >
              <div className="min-w-0">
                <p className="text-xs font-medium" style={{ color: "var(--th-text-muted)" }}>
                  {t({ en: "Progress" })}
                </p>
                <p className="mt-1 text-base font-semibold tabular-nums">
                  {progress === null
                    ? t({ en: "Not measured yet" })
                    : `${progressText(goal, progress)} / ${progressText(goal, goal.target)}`}
                </p>
                {percentage !== null && (
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--th-border)" }}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${percentage}%`, background: "var(--ax-signal)" }}
                    />
                  </div>
                )}
                {goal.progress_scope === "business" && (
                  <p className="mt-2 text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {t({ en: "Measured across this business" })}
                  </p>
                )}
                {milestones(goal)}
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium" style={{ color: "var(--th-text-muted)" }}>
                  {t({ en: "Strategy" })}
                </p>
                {strategy ? (
                  <>
                    <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                      v{strategy.version ?? 1} · {readable(strategy.status ?? "approved")}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{strategy.summary}</p>
                  </>
                ) : (
                  <p className="mt-2 text-sm" style={{ color: "var(--th-text-muted)" }}>
                    {t({ en: "The team will research a strategy for this goal." })}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--th-border)" }}>
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="text-sm font-semibold">{t({ en: "Initiatives" })}</h4>
                <span className="text-xs tabular-nums" style={{ color: "var(--th-text-muted)" }}>
                  {initiatives.length} · {goal.initiative_slots ?? 3} {t({ en: "active slots" })}
                </span>
              </div>
              {initiatives.length ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {initiatives.map((item: Initiative) => (
                    <article
                      key={item.id}
                      className="min-w-0 rounded-lg border p-3"
                      style={{ borderColor: "var(--th-border)" }}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <h5 className="break-words text-sm font-semibold">{item.title}</h5>
                        <span
                          className="rounded-full border px-2 py-0.5 text-[11px]"
                          style={{ borderColor: "var(--th-border)" }}
                        >
                          {readable(item.status)}
                        </span>
                      </div>
                      <p className="mt-2 text-xs" style={{ color: "var(--th-text-secondary)" }}>
                        {t({ en: "Step" })}:{" "}
                        {item.playbook_stage ? readable(item.playbook_stage) : t({ en: "Waiting for a plan" })}
                      </p>
                      {item.status === "blocked" && (
                        <p className="mt-2 break-words text-xs" style={{ color: "var(--th-danger-border)" }}>
                          {item.blocked_reason || t({ en: "This initiative is blocked." })}
                        </p>
                      )}
                      <p className="mt-2 text-xs tabular-nums" style={{ color: "var(--th-text-secondary)" }}>
                        {t({ en: "Recorded USD spend" })}:{" "}
                        {item.spent_minor === undefined
                          ? t({ en: "Unavailable" })
                          : formatMoney(item.spent_minor, "USD", locale)}{" "}
                        / {usd(item.budget)} {t({ en: "budget" })}
                      </p>
                      <a
                        className="mt-3 inline-block text-xs font-medium underline underline-offset-2"
                        href={`/work?initiative=${encodeURIComponent(item.id)}`}
                      >
                        {t({ en: "View steps and reviews" })}
                      </a>
                    </article>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm" style={{ color: "var(--th-text-muted)" }}>
                  {t({ en: "No initiatives yet. The team will suggest ideas after the strategy is approved." })}
                </p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
