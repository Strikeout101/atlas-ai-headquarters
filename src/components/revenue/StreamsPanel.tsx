import { useEffect, useState } from "react";
import { getStream, type StreamOverview } from "../../api/autonomy";
import { BUSINESS_KINDS, BUSINESS_NAMES, type BusinessKind } from "../../api/business";
import { formatMoney } from "./money";

const STAGES = ["idea", "researching", "approved", "building", "launched", "stopped"] as const;
const pretty = (value: string) => value.replaceAll("_", " ");
const usd = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);

/**
 * One income stream on one page: goals against verified results, every idea with its money and stage, what the
 * engine has queued or is running next, listings, schedules and this month's profit.
 */
export default function StreamsPanel({
  locale,
  initialBusiness = "ventures",
}: {
  locale: string;
  initialBusiness?: BusinessKind;
}) {
  const [business, setBusiness] = useState<BusinessKind>(initialBusiness);
  const [data, setData] = useState<StreamOverview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setData(null);
    getStream(business)
      .then((value) => {
        if (live) {
          setData(value);
          setError("");
        }
      })
      .catch((cause) => live && setError(cause instanceof Error ? cause.message : "Could not load the stream."));
    return () => {
      live = false;
    };
  }, [business]);
  return (
    <section aria-label="Income stream" className="space-y-5">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Choose a stream">
        {BUSINESS_KINDS.map((key) => (
          <button
            key={key}
            type="button"
            className="revenue-button"
            aria-pressed={business === key}
            onClick={() => setBusiness(key)}
          >
            {BUSINESS_NAMES[key]}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      {!data && !error && <p className="text-sm">Loading…</p>}
      {data && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <section aria-label="Goals" className="space-y-2">
              <h3 className="text-sm font-semibold">Goals</h3>
              {!data.goals.length && (
                <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
                  No goal yet. Set one in Autonomy.
                </p>
              )}
              {data.goals.map((goal) => (
                <div key={goal.id} className="rounded-lg border p-3" style={{ borderColor: "var(--th-border)" }}>
                  <p className="text-sm">
                    {pretty(goal.metric)}:{" "}
                    <span className="font-medium tabular-nums">
                      {goal.progress === null ? "not measured yet" : `${goal.progress} / ${goal.target}`}
                    </span>
                  </p>
                  <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                    {new Date(goal.period_start).toLocaleDateString(locale)} –{" "}
                    {new Date(goal.period_end).toLocaleDateString(locale)}
                  </p>
                  {goal.milestones.length > 0 && (
                    <ul className="mt-2 space-y-1 text-xs" aria-label={`Milestones for ${goal.metric}`}>
                      {goal.milestones.map((m) => (
                        <li key={m.id}>
                          {m.status === "done" ? "✓" : "○"} {m.title}
                          {m.kind === "progress" && m.target !== null ? ` (at ${m.target})` : ""}
                          {m.done_by ? ` · ${m.done_by === "verified" ? "verified" : "confirmed by you"}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </section>
            <section aria-label="This month" className="space-y-2">
              <h3 className="text-sm font-semibold">This month</h3>
              {!data.month.lines.length ? (
                <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
                  No money recorded this month.
                </p>
              ) : (
                data.month.lines.map((line) => (
                  <p key={line.currency} className="text-sm tabular-nums">
                    {formatMoney(line.revenue_minor, line.currency, locale)} verified revenue ·{" "}
                    {formatMoney(line.expense_minor + line.recurring_minor, line.currency, locale)} costs ·{" "}
                    <span className={line.profit_minor < 0 ? "text-red-500" : "text-emerald-600"}>
                      {formatMoney(line.profit_minor, line.currency, locale)}{" "}
                      {data.month.costs_complete ? "profit" : "profit (estimate)"}
                    </span>
                  </p>
                ))
              )}
              <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                Pipeline: {STAGES.map((stage) => `${data.pipeline[stage] ?? 0} ${stage}`).join(" · ")}
              </p>
              <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                Listings:{" "}
                {Object.keys(data.listings).length
                  ? Object.entries(data.listings)
                      .map(([status, n]) => `${n} ${status}`)
                      .join(" · ")
                  : "none yet"}
              </p>
            </section>
          </div>

          <section aria-label="Next" className="space-y-2">
            <h3 className="text-sm font-semibold">What the engine does next</h3>
            {!data.next.length ? (
              <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
                Nothing queued. Work appears here when the planner, a schedule or a playbook step queues it.
              </p>
            ) : (
              <ol className="divide-y text-sm" style={{ borderColor: "var(--th-border)" }}>
                {data.next.map((item) => (
                  <li key={item.id} className="flex flex-wrap justify-between gap-2 py-2">
                    <span className="min-w-0 break-words">
                      {item.title ?? "Work item"}
                      {item.playbook_step ? ` · step ${item.playbook_step}` : ""}
                    </span>
                    <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                      {item.status === "pending"
                        ? "waiting for approval"
                        : item.status === "planned"
                          ? "approved, waiting to start"
                          : `running${item.task_status ? ` (${item.task_status})` : ""}`}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {data.schedules.length > 0 && (
              <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                Schedules:{" "}
                {data.schedules
                  .map(
                    (s) =>
                      `${s.title} (${s.enabled ? `next ${new Date(s.next_run_at).toLocaleString(locale)}` : "off"})`,
                  )
                  .join(" · ")}
              </p>
            )}
          </section>

          <section aria-label="Products and ideas" className="space-y-2">
            <h3 className="text-sm font-semibold">Products and ideas</h3>
            {!data.opportunities.length ? (
              <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
                No ideas yet. A research schedule or the planner adds them.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-xl border" style={{ borderColor: "var(--th-border)" }}>
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                      <th className="px-3 py-2 font-medium">Idea</th>
                      <th className="px-3 py-2 font-medium">Stage</th>
                      <th className="px-3 py-2 font-medium">Spent</th>
                      <th className="px-3 py-2 font-medium">Earned</th>
                      <th className="px-3 py-2 font-medium">Testing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.opportunities.map((o) => {
                      const active = o.results.variants.filter((v) => v.active);
                      return (
                        <tr key={o.id} className="border-t align-top" style={{ borderColor: "var(--th-border)" }}>
                          <td className="px-3 py-2">
                            <span className="break-words">{o.title}</span>
                            {o.results.stop_reason && (
                              <span className="block text-xs text-amber-600">Stopped: {o.results.stop_reason}</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {o.status}
                            {o.results.playbook_stage ? ` · ${pretty(o.results.playbook_stage)}` : ""}
                            {o.results.days_live !== null ? ` · ${o.results.days_live} days live` : ""}
                          </td>
                          <td className="px-3 py-2 tabular-nums">
                            {usd(o.results.spent_usd, locale)}
                            {o.results.budget_usd ? ` of ${usd(o.results.budget_usd, locale)}` : ""}
                          </td>
                          <td className="px-3 py-2 tabular-nums">{usd(o.results.earned_usd, locale)}</td>
                          <td className="px-3 py-2 text-xs">
                            {active.length ? active.map((v) => `${v.variable}: ${v.value}`).join("; ") : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {data.recent.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm font-semibold">Recent activity</summary>
              <ol className="mt-2 space-y-1 text-xs">
                {data.recent.map((event, index) => (
                  <li key={index}>
                    {new Date(event.created_at).toLocaleString(locale)} · {event.message}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </section>
  );
}
