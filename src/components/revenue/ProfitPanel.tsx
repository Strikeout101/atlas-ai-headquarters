import { useState, type FormEvent } from "react";
import { BUSINESS_KINDS, BUSINESS_NAMES, type BusinessKind } from "../../api/business";
import {
  deleteRecurringCost,
  saveRecurringCost,
  setCostsComplete,
  type ProfitOverview,
  type RecurringCost,
} from "../../api/finance";
import { formatMoney } from "./money";

const CATEGORY_NAMES: Record<RecurringCost["category"], string> = {
  ai_tools: "AI tools",
  software: "Software",
  hosting: "Hosting",
  ads: "Ads",
  other: "Other",
};

/**
 * Profit: verified revenue, minus every recorded cost, minus monthly costs spread over the period (shared ones split
 * across the businesses). Profit goals are only measured once the owner says the monthly costs are complete.
 */
export default function ProfitPanel({
  profit,
  locale,
  busy,
  onChanged,
  onError,
}: {
  profit: ProfitOverview;
  locale: string;
  busy: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const money = (minor: number, currency: string) => formatMoney(minor, currency, locale);
  const run = async (work: () => Promise<unknown>) => {
    try {
      await work();
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Request failed.");
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const amount = Math.round(Number(values.get("amount")) * 100);
    void run(async () => {
      await saveRecurringCost({
        label: String(values.get("label")),
        business: String(values.get("business")) || null,
        category: String(values.get("category")),
        amount_minor: amount,
        currency: "USD",
      });
      setAdding(false);
    });
  };
  return (
    <section aria-label="Profit" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Profit</h2>
        <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
          {new Date(profit.from).toLocaleDateString(locale)} – {new Date(profit.to).toLocaleDateString(locale)}
        </span>
      </div>
      {!profit.lines.length ? (
        <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
          Nothing to show yet: no revenue, costs or monthly costs in this period.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border" style={{ borderColor: "var(--th-border)" }}>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                <th className="px-3 py-2 font-medium">Business</th>
                <th className="px-3 py-2 font-medium">Verified revenue</th>
                <th className="px-3 py-2 font-medium">Recorded costs</th>
                <th className="px-3 py-2 font-medium">Monthly costs</th>
                <th className="px-3 py-2 font-medium">{profit.costs_complete ? "Profit" : "Profit (estimate)"}</th>
              </tr>
            </thead>
            <tbody>
              {profit.lines.map((line) => (
                <tr
                  key={`${line.business}:${line.currency}`}
                  className="border-t"
                  style={{ borderColor: "var(--th-border)" }}
                >
                  <td className="px-3 py-2">{BUSINESS_NAMES[line.business as BusinessKind] ?? line.business}</td>
                  <td className="px-3 py-2 tabular-nums">{money(line.revenue_minor, line.currency)}</td>
                  <td className="px-3 py-2 tabular-nums">{money(line.expense_minor, line.currency)}</td>
                  <td className="px-3 py-2 tabular-nums">{money(line.recurring_minor, line.currency)}</td>
                  <td
                    className={`px-3 py-2 font-medium tabular-nums ${line.profit_minor < 0 ? "text-red-500" : "text-emerald-600"}`}
                  >
                    {money(line.profit_minor, line.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="rounded-xl border p-3" style={{ borderColor: "var(--th-border)" }}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Monthly costs</h3>
          <button type="button" className="revenue-button" disabled={busy} onClick={() => setAdding((value) => !value)}>
            {adding ? "Cancel" : "Add a monthly cost"}
          </button>
        </div>
        {adding && (
          <form aria-label="Add a monthly cost" className="mt-3 grid gap-2 sm:grid-cols-5" onSubmit={submit}>
            <input
              name="label"
              required
              maxLength={120}
              placeholder="Claude subscription"
              aria-label="Name"
              className="sm:col-span-2"
            />
            <select name="business" aria-label="Business" defaultValue="">
              <option value="">Shared</option>
              {BUSINESS_KINDS.map((key) => (
                <option key={key} value={key}>
                  {BUSINESS_NAMES[key]}
                </option>
              ))}
            </select>
            <select name="category" aria-label="Category" defaultValue="ai_tools">
              {Object.entries(CATEGORY_NAMES).map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
            <input name="amount" required inputMode="decimal" placeholder="USD a month" aria-label="USD a month" />
            <button type="submit" className="revenue-button sm:col-span-5" disabled={busy}>
              Save
            </button>
          </form>
        )}
        {!profit.recurring_costs.length ? (
          <p className="mt-2 text-sm" style={{ color: "var(--th-text-muted)" }}>
            None yet. Add your AI subscriptions and other monthly costs so profit is real.
          </p>
        ) : (
          <ul className="mt-2 divide-y" style={{ borderColor: "var(--th-border)" }} aria-label="Monthly costs">
            {profit.recurring_costs.map((cost) => (
              <li key={cost.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 break-words">
                  {cost.label} · {cost.business ? BUSINESS_NAMES[cost.business] : "Shared"} ·{" "}
                  {CATEGORY_NAMES[cost.category] ?? cost.category}
                  {!cost.active && " · paused"}
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">{money(cost.amount_minor, cost.currency)} / month</span>
                  <button
                    type="button"
                    className="revenue-button"
                    disabled={busy}
                    onClick={() => void run(() => saveRecurringCost({ active: !cost.active }, cost.id))}
                  >
                    {cost.active ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    className="revenue-button"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Remove "${cost.label}"?`)) void run(() => deleteRecurringCost(cost.id));
                    }}
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={profit.costs_complete}
            disabled={busy}
            onChange={(event) => void run(() => setCostsComplete(event.target.checked))}
          />
          <span>
            My monthly costs are complete
            <span className="block text-xs" style={{ color: "var(--th-text-muted)" }}>
              Profit goals are only measured after you confirm this, so a missing cost can never make a goal look met.
            </span>
          </span>
        </label>
      </div>
    </section>
  );
}
