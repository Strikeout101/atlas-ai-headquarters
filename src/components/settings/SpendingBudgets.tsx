import { useEffect, useState } from "react";
import { BUSINESS_SETTINGS_NAMES, type BusinessKind } from "../../api/business";
import { spendBudgetsApi, type SpendBudget, type SpendCategory } from "../../api/accounts";
import SettingsSection from "./SettingsSection";

const field =
  "w-full rounded-lg border border-[var(--th-input-border)] bg-[var(--th-input-bg)] px-3 py-2 text-sm text-[var(--th-text-primary)]";
const button = "rounded-lg border border-[var(--th-border)] px-3 py-2 text-sm disabled:opacity-50";

export const SPEND_CATEGORY_NAMES: Record<SpendCategory, string> = {
  ai_tools: "AI tools",
  ads: "Ads",
  hosting: "Hosting and domains",
  software: "Software and assets",
  supplies: "Supplies",
  other: "Other",
};

const dollars = (minor: number) => String(Math.round(minor / 100));

function BudgetRow({ budget, onSaved }: { budget: SpendBudget; onSaved: (item: SpendBudget, note: string) => void }) {
  const [monthly, setMonthly] = useState(dollars(budget.monthly_cap_minor));
  const [perItem, setPerItem] = useState(dollars(budget.per_item_cap_minor));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setMonthly(dollars(budget.monthly_cap_minor));
    setPerItem(dollars(budget.per_item_cap_minor));
  }, [budget]);
  const name = SPEND_CATEGORY_NAMES[budget.category];
  const changed = monthly !== dollars(budget.monthly_cap_minor) || perItem !== dollars(budget.per_item_cap_minor);
  return (
    <form
      aria-label={`${name} budget`}
      className="grid min-w-0 grid-cols-2 items-end gap-2 rounded-lg border p-3 sm:grid-cols-[minmax(0,1.2fr)_1fr_1fr_auto]"
      style={{ borderColor: "var(--th-border)" }}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          const item = await spendBudgetsApi.save({
            business: budget.business,
            category: budget.category,
            currency: budget.currency,
            monthly_cap_minor: Number(monthly || 0) * 100,
            per_item_cap_minor: Number(perItem || 0) * 100,
          });
          onSaved(item, `${name} budget saved.`);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "";
          setError(
            message === "owner_session_required"
              ? "Sign in with your password in Settings > Security first."
              : message.includes("per_item_cap_above_monthly_cap")
                ? "The per-item limit cannot be more than the monthly budget."
                : "Could not save this budget.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="col-span-2 min-w-0 sm:col-span-1">
        <p className="text-sm font-medium">{name}</p>
        <p className="text-xs text-[var(--th-text-secondary)]">
          Used {budget.currency} {dollars(budget.used_minor)} of {dollars(budget.monthly_cap_minor)} this month
        </p>
      </div>
      <label className="grid min-w-0 gap-1 text-xs">
        Monthly budget ({budget.currency})
        <input
          className={field}
          inputMode="numeric"
          value={monthly}
          onChange={(e) => setMonthly(e.target.value.replace(/[^\d]/g, ""))}
        />
      </label>
      <label className="grid min-w-0 gap-1 text-xs">
        Per item ({budget.currency})
        <input
          className={field}
          inputMode="numeric"
          value={perItem}
          onChange={(e) => setPerItem(e.target.value.replace(/[^\d]/g, ""))}
        />
      </label>
      <button type="submit" className={`${button} col-span-2 sm:col-span-1`} disabled={busy || !changed}>
        Save
      </button>
      {error && (
        <p role="alert" className="col-span-2 text-sm text-red-500 sm:col-span-4">
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * Owner spending budgets for agent spend requests. Within a budget, both VPs may approve a request; anything over
 * goes to the owner. Approving only records permission: ATLAS never moves money.
 */
export default function SpendingBudgets() {
  const [items, setItems] = useState<SpendBudget[] | null>(null);
  const [business, setBusiness] = useState<BusinessKind>("tech");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => {
    spendBudgetsApi
      .list()
      .then(setItems)
      .catch(() => setError("Could not load spending budgets."));
  }, []);
  const shown = items?.filter((item) => item.business === business) ?? [];
  const total = (items ?? []).filter((item) => item.monthly_cap_minor > 0).length;
  return (
    <SettingsSection
      title="Spending budgets"
      description={
        total
          ? `${total} budget${total === 1 ? "" : "s"} set · within a budget both VPs may approve`
          : "All $0 · every spend request comes to you"
      }
    >
      <p className="text-sm text-[var(--th-text-secondary)]">
        When an agent asks to spend money, both VPs may approve it if it fits the per-item limit and what is left of the
        month&apos;s budget for that business and category. Anything else comes to you. Approving only records
        permission: ATLAS never pays for anything itself. Listing fees have their own budget on the Listings page.
      </p>
      <label className="grid max-w-xs gap-1 text-sm">
        Business
        <select className={field} value={business} onChange={(e) => setBusiness(e.target.value as BusinessKind)}>
          {(Object.keys(BUSINESS_SETTINGS_NAMES) as BusinessKind[]).map((key) => (
            <option key={key} value={key}>
              {BUSINESS_SETTINGS_NAMES[key]}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="text-sm text-emerald-500">
          {saved}
        </p>
      )}
      {!items ? (
        <p className="text-sm text-[var(--th-text-secondary)]">Loading…</p>
      ) : (
        <div className="space-y-2">
          {shown.map((budget) => (
            <BudgetRow
              key={`${budget.business}:${budget.category}`}
              budget={budget}
              onSaved={(item, note) => {
                setSaved(note);
                setItems(
                  (current) =>
                    current?.map((entry) =>
                      entry.business === item.business && entry.category === item.category ? item : entry,
                    ) ?? null,
                );
              }}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
