import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  getFinance,
  saveDeal,
  recordFinanceEntry,
  linkFinanceEntry,
  createSpendRequest,
  decideSpendRequest,
  type FinanceOverview,
  type Deal,
  type FinanceEntry,
  type RevenueOpportunity,
} from "../../api/finance";
import { BUSINESS_KINDS, BUSINESS_NAMES, type BusinessKind } from "../../api/business";
import { isApiRequestError } from "../../api/core";
import { useI18n } from "../../i18n";
import { formatMoney, moneyInput, parseMoney } from "./money";
import "./revenue.css";

const currencyOptions = ["USD", "CAD", "EUR", "GBP", "AUD", "JPY", "KWD"];
const stages = ["lead", "qualified", "proposal", "won", "paid", "lost"] as const;
const localDate = (value: number | null) =>
  value === null ? "" : new Date(value - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const timestamp = (value: FormDataEntryValue | null) => (value ? new Date(String(value)).getTime() : null);
const surface = { borderColor: "var(--th-border)", background: "var(--th-card-bg)" };
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col text-xs font-medium">
      <label htmlFor={id}>{label}</label>
      {isValidElement(children) ? cloneElement(children as ReactElement<{ id?: string }>, { id }) : children}
    </div>
  );
}
function OpportunitySelect({
  opportunities,
  defaultValue = "",
  name = "opportunity_id",
  id,
}: {
  opportunities: RevenueOpportunity[];
  defaultValue?: string;
  name?: string;
  id?: string;
}) {
  return (
    <select id={id} name={name} defaultValue={defaultValue}>
      <option value="">None</option>
      {opportunities.map((item) => (
        <option key={item.id} value={item.id}>
          {item.title}
        </option>
      ))}
    </select>
  );
}
type FormKind = "deal" | "entry" | "spend" | "link";

export default function RevenueWorkspace() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<FinanceOverview | null>(null);
  const [business, setBusiness] = useState<BusinessKind | "">("");
  const [period, setPeriod] = useState<{ from?: number; to?: number }>({});
  const [tab, setTab] = useState("overview");
  const [formKind, setFormKind] = useState<FormKind | null>(null);
  const [editing, setEditing] = useState<Deal | FinanceEntry | null>(null);
  const [formBusiness, setFormBusiness] = useState<BusinessKind>("ventures");
  const [formCurrency, setFormCurrency] = useState("USD");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const failure = useCallback(
    (cause: unknown) => {
      if (isApiRequestError(cause)) {
        if (cause.code === "owner_session_required")
          return t({
            en: "Sign in with your password in Settings > Security to change financial records.",
          });
        if (cause.code?.includes("paid") || cause.code?.includes("receipt"))
          return t({
            en: "Link sufficient verified receipts in the same currency before marking a deal paid.",
          });
        if (cause.code) return cause.code.replaceAll("_", " ");
      }
      return cause instanceof Error ? cause.message : String(cause);
    },
    [t],
  );
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const value = await getFinance({ ...period, ...(business ? { business } : {}) });
        if (!signal?.aborted) {
          setData(value);
          setError(null);
        }
      } catch (cause) {
        if (!signal?.aborted) setError(failure(cause));
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [business, period, failure],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  async function mutate(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setFormKind(null);
      setEditing(null);
      setNotice(t({ en: "Saved." }));
      await refresh();
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  }
  function open(kind: FormKind, row: Deal | FinanceEntry | null = null) {
    setFormKind(kind);
    setEditing(row);
    setFormBusiness(row?.business ?? (business || "ventures"));
    setFormCurrency(row?.currency ?? "USD");
    setError(null);
    setNotice(null);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    try {
      if (formKind === "link" && editing)
        return await mutate(() =>
          linkFinanceEntry(editing.id, {
            deal_id: String(values.get("deal_id") || "") || null,
            opportunity_id: String(values.get("opportunity_id") || "") || null,
          }),
        );
      const amount = parseMoney(String(values.get("amount")), formCurrency);
      const base = {
        business: formBusiness,
        currency: formCurrency,
        opportunity_id: String(values.get("opportunity_id") || "") || null,
      };
      if (formKind === "deal")
        await mutate(() =>
          saveDeal(
            {
              ...base,
              title: String(values.get("title")),
              notes: String(values.get("notes")),
              stage: String(values.get("stage")),
              expected_amount_minor: amount,
              generated_at: timestamp(values.get("generated_at")),
              published_at: timestamp(values.get("published_at")),
              ordered_at: timestamp(values.get("ordered_at")),
            },
            editing?.id,
          ),
        );
      if (formKind === "entry")
        await mutate(() =>
          recordFinanceEntry({
            ...base,
            kind: String(values.get("kind")),
            amount_minor: amount,
            description: String(values.get("description")),
            occurred_at: timestamp(values.get("occurred_at")),
            deal_id: String(values.get("deal_id") || "") || null,
          }),
        );
      if (formKind === "spend")
        await mutate(() =>
          createSpendRequest({ ...base, amount_minor: amount, purpose: String(values.get("purpose")) }),
        );
    } catch (cause) {
      setError(failure(cause));
    }
  }
  const money = (amount: number, currency: string) => formatMoney(amount, currency, locale);
  const label = (kind: FormKind) =>
    ({
      deal: t({ en: "Deal" }),
      entry: t({ en: "Manual record" }),
      spend: t({ en: "Spending request" }),
      link: t({ en: "Link record" }),
    })[kind];
  const opportunities = data?.opportunities.filter((item) => item.business === formBusiness) ?? [];
  const compatibleDeals =
    data?.deals.filter((item) => item.business === formBusiness && item.currency === formCurrency) ?? [];
  const options = [...new Set([...currencyOptions, formCurrency])];
  return (
    <section className="revenue-workspace mx-auto w-full max-w-7xl space-y-6 pb-8" aria-label="Revenue">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">{t({ en: "Revenue" })}</h1>
          <p className="mt-1 max-w-3xl text-sm" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              en: "Verified net receipts, reported costs and sales progress, kept separate by currency. Recorded surplus does not establish complete accounting profit.",
            })}
          </p>
        </div>
        <button type="button" className="revenue-button" disabled={busy || loading} onClick={() => void refresh()}>
          {t({ en: "Refresh" })}
        </button>
      </header>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          const start = values.get("from");
          const end = values.get("to");
          setFormKind(null);
          setPeriod({
            ...(start ? { from: new Date(`${start}T00:00`).getTime() } : {}),
            ...(end ? { to: new Date(`${end}T23:59:59.999`).getTime() + 1 } : {}),
          });
        }}
      >
        <Field label={t({ en: "Business filter" })}>
          <select
            value={business}
            onChange={(event) => {
              setBusiness(event.target.value as BusinessKind | "");
              setFormKind(null);
            }}
          >
            <option value="">{t({ en: "All businesses" })}</option>
            {BUSINESS_KINDS.map((item) => (
              <option key={item} value={item}>
                {BUSINESS_NAMES[item]}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t({ en: "From" })}>
          <input name="from" type="date" />
        </Field>
        <Field label={t({ en: "To" })}>
          <input name="to" type="date" />
        </Field>
        <button type="submit" className="revenue-button">
          {t({ en: "Apply dates" })}
        </button>
      </form>
      <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
        {t({
          en: "Date filters apply to financial records and opportunity totals. Goals use their own periods.",
        })}
      </p>
      {error && (
        <p role="alert" className="break-words text-sm" style={{ color: "var(--th-danger-border)" }}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm">
          {t({
            en: "Loading financial records…",
          })}
        </p>
      )}
      {data && (
        <>
          <div
            role="tablist"
            aria-label="Revenue sections"
            className="flex flex-wrap gap-2 border-b pb-3"
            style={{ borderColor: "var(--th-border)" }}
          >
            {[
              ["overview", "Overview"],
              ["pipeline", "Pipeline"],
              ["ledger", "Records"],
              ["spending", "Spending requests"],
            ].map(([key, title]) => (
              <button
                type="button"
                key={key}
                className="revenue-button"
                role="tab"
                id={`revenue-tab-${key}`}
                aria-selected={tab === key}
                aria-controls="revenue-panel"
                onClick={() => {
                  setTab(key);
                  setFormKind(null);
                }}
              >
                {title}
              </button>
            ))}
          </div>
          <div role="tabpanel" id="revenue-panel" aria-labelledby={`revenue-tab-${tab}`} className="space-y-5">
            {tab === "overview" && (
              <>
                {!data.totals.length ? (
                  <p className="py-6 text-sm">
                    {t({
                      en: "No receipts or costs recorded yet. Connect read-only Square sync in Settings > Businesses.",
                    })}
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border" style={surface}>
                    <table className="w-full text-left text-sm">
                      <caption className="px-4 py-3 text-left text-xs" style={{ color: "var(--th-text-muted)" }}>
                        Each business and currency stands alone. Square receipts are net of recorded refunds. Surplus
                        subtracts verified costs only; unverified costs remain separate and total costs are incomplete.
                      </caption>
                      <thead>
                        <tr>
                          {[
                            "Business / currency",
                            "Verified net receipts",
                            "Verified costs",
                            "Recorded surplus",
                            "Unverified revenue",
                            "Unverified costs",
                          ].map((title) => (
                            <th key={title} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                              {title}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.totals.map((row) => (
                          <tr
                            key={`${row.business}:${row.currency}`}
                            className="border-t"
                            style={{ borderColor: "var(--th-border)" }}
                          >
                            <th scope="row" className="whitespace-nowrap px-4 py-3 font-medium">
                              {BUSINESS_NAMES[row.business]} · {row.currency}
                            </th>
                            {[
                              row.revenue_minor,
                              row.cost_minor,
                              row.surplus_minor,
                              row.unverified_revenue_minor,
                              row.unverified_cost_minor,
                            ].map((amount, index) => (
                              <td key={index} className="whitespace-nowrap px-4 py-3 tabular-nums">
                                {money(amount, row.currency)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <section aria-label="Revenue targets">
                  <h2 className="text-sm font-semibold">Revenue targets</h2>
                  {!data.goals.length ? (
                    <p className="py-3 text-sm" style={{ color: "var(--th-text-muted)" }}>
                      Set a verified revenue goal and its currency in Autonomy.
                    </p>
                  ) : (
                    <ol className="divide-y" style={{ borderColor: "var(--th-border)" }}>
                      {data.goals.map((goal) => (
                        <li key={goal.id} className="py-3">
                          <p className="text-sm">
                            {BUSINESS_NAMES[goal.business]} · {goal.currency || "Currency not set"} ·{" "}
                            {goal.metric.replaceAll("_", " ")}
                          </p>
                          <p className="mt-1 text-sm tabular-nums">
                            {goal.currency
                              ? goal.metric.includes("profit")
                                ? `${new Intl.NumberFormat(locale, { style: "currency", currency: goal.currency }).format(goal.target)} target · Profit not measured`
                                : `${money(goal.verified_revenue_minor, goal.currency)} verified net receipts / ${new Intl.NumberFormat(locale, { style: "currency", currency: goal.currency }).format(goal.target)} target`
                              : "No currency assigned; progress unavailable"}
                          </p>
                          <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                            {new Date(goal.period_start).toLocaleDateString(locale)} –{" "}
                            {new Date(goal.period_end).toLocaleDateString(locale)} ·{" "}
                            {goal.metric.includes("profit")
                              ? "Profit progress unavailable: costs are incomplete."
                              : "Verified receipts only; unverified revenue is excluded."}
                          </p>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
                <section aria-label="Opportunity results">
                  <h2 className="text-sm font-semibold">Opportunity results</h2>
                  {!data.opportunities.length ? (
                    <p className="py-3 text-sm" style={{ color: "var(--th-text-muted)" }}>
                      No opportunities yet. Add one in Autonomy.
                    </p>
                  ) : (
                    <ol className="divide-y" style={{ borderColor: "var(--th-border)" }}>
                      {data.opportunities.map((item) => (
                        <li key={item.id} className="py-3">
                          <p className="break-words text-sm font-medium">{item.title}</p>
                          <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                            {BUSINESS_NAMES[item.business]} · {item.status}
                          </p>
                          {!item.currencies.length ? (
                            <p className="mt-2 text-sm">No attributed receipts or costs.</p>
                          ) : (
                            item.currencies.map((row) => (
                              <p key={row.currency} className="mt-2 text-sm">
                                {row.currency} · {money(row.revenue_minor, row.currency)} verified net receipts ·{" "}
                                {money(row.cost_minor, row.currency)} verified costs ·{" "}
                                {money(row.surplus_minor, row.currency)} recorded surplus
                              </p>
                            ))
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </>
            )}
            {tab !== "overview" && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">
                  {tab === "pipeline"
                    ? "Sales pipeline"
                    : tab === "ledger"
                      ? "Receipts and cost records"
                      : "Owner spending decisions"}
                </h2>
                <button
                  type="button"
                  className="revenue-button"
                  onClick={() => open(tab === "pipeline" ? "deal" : tab === "ledger" ? "entry" : "spend")}
                >
                  {tab === "pipeline" ? "Add deal" : tab === "ledger" ? "Add manual record" : "Request spending"}
                </button>
              </div>
            )}
            {formKind && (
              <form
                key={`${formKind}:${editing?.id ?? "new"}`}
                onSubmit={submit}
                aria-label={label(formKind)}
                className="space-y-4 rounded-xl border p-4 sm:p-5"
                style={surface}
              >
                <h3 className="text-sm font-semibold">{label(formKind)}</h3>
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  {formKind !== "link" && (
                    <>
                      <Field label="Business">
                        <select
                          value={formBusiness}
                          onChange={(event) => setFormBusiness(event.target.value as BusinessKind)}
                        >
                          {BUSINESS_KINDS.map((item) => (
                            <option key={item} value={item}>
                              {BUSINESS_NAMES[item]}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Currency">
                        <select value={formCurrency} onChange={(event) => setFormCurrency(event.target.value)}>
                          {options.map((item) => (
                            <option key={item} value={item}>
                              {item}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label={formKind === "deal" ? "Expected amount" : "Amount"}>
                        <input
                          name="amount"
                          type="text"
                          inputMode="decimal"
                          required
                          defaultValue={
                            editing && "expected_amount_minor" in editing
                              ? moneyInput(editing.expected_amount_minor, editing.currency)
                              : "0"
                          }
                        />
                      </Field>
                    </>
                  )}
                  {formKind === "deal" && (
                    <>
                      <Field label="Deal title">
                        <input
                          name="title"
                          required
                          maxLength={200}
                          defaultValue={editing && "title" in editing ? editing.title : ""}
                        />
                      </Field>
                      <Field label="Stage">
                        <select name="stage" defaultValue={editing && "stage" in editing ? editing.stage : "lead"}>
                          {stages
                            .filter(
                              (stage) =>
                                stage !== "paid" || (editing && "stage" in editing && editing.stage === "paid"),
                            )
                            .map((stage) => (
                              <option key={stage} value={stage} disabled={stage === "paid"}>
                                {stage}
                              </option>
                            ))}
                        </select>
                      </Field>
                      <Field label="Notes">
                        <textarea
                          name="notes"
                          rows={3}
                          defaultValue={editing && "notes" in editing ? editing.notes : ""}
                        />
                      </Field>
                      {(
                        [
                          ["generated_at", "Product generated"],
                          ["published_at", "Listing published"],
                          ["ordered_at", "Order received"],
                        ] as const
                      ).map(([name, title]) => (
                        <Field key={name} label={title}>
                          <input
                            name={name}
                            type="datetime-local"
                            defaultValue={editing && "stage" in editing ? localDate(editing[name]) : ""}
                          />
                        </Field>
                      ))}
                    </>
                  )}
                  {formKind === "entry" && (
                    <>
                      <Field label="Record type">
                        <select name="kind">
                          <option value="expense">Reported expense</option>
                          <option value="revenue">Unverified revenue</option>
                        </select>
                      </Field>
                      <Field label="Description">
                        <textarea name="description" required rows={3} />
                      </Field>
                      <Field label="Occurred at">
                        <input type="datetime-local" name="occurred_at" required defaultValue={localDate(Date.now())} />
                      </Field>
                    </>
                  )}
                  {formKind === "spend" && (
                    <Field label="Spending purpose">
                      <textarea name="purpose" rows={3} required />
                    </Field>
                  )}
                  {(formKind === "entry" || formKind === "link") && (
                    <Field label="Linked deal">
                      <select
                        name="deal_id"
                        defaultValue={editing && "deal_id" in editing ? (editing.deal_id ?? "") : ""}
                      >
                        <option value="">None</option>
                        {compatibleDeals.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <Field label="Linked opportunity">
                    <OpportunitySelect opportunities={opportunities} defaultValue={editing?.opportunity_id ?? ""} />
                  </Field>
                </div>
                <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
                  {formKind === "entry"
                    ? "Manual records stay unverified. They cannot mark a deal paid or count toward verified revenue."
                    : formKind === "deal"
                      ? "Milestones are separate records. Only sufficient linked verified receipts in the same currency mark this deal paid."
                      : formKind === "spend"
                        ? "Owner approval records permission only. ATLAS does not make purchases or move money."
                        : "Linking records changes attribution, never payment verification."}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button type="submit" className="revenue-button" disabled={busy}>
                    Save
                  </button>
                  <button type="button" className="revenue-button" disabled={busy} onClick={() => setFormKind(null)}>
                    Cancel
                  </button>
                </div>
              </form>
            )}
            {tab === "pipeline" && (
              <>
                {!data.deals.length ? (
                  <p className="py-6 text-sm">No deals yet. Record a lead to start the pipeline.</p>
                ) : (
                  <ol className="divide-y" style={{ borderColor: "var(--th-border)" }}>
                    {data.deals.map((deal) => (
                      <li key={deal.id} className="flex min-w-0 flex-wrap items-start justify-between gap-3 py-4">
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium">{deal.title}</p>
                          <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                            {BUSINESS_NAMES[deal.business]} · {deal.stage} ·{" "}
                            {money(deal.expected_amount_minor, deal.currency)} expected
                          </p>
                          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                            {(
                              [
                                ["generated_at", "Product generated"],
                                ["published_at", "Listing published"],
                                ["ordered_at", "Order received"],
                              ] as const
                            ).map(([key, title]) => (
                              <div key={key}>
                                <dt style={{ color: "var(--th-text-muted)" }}>{title}</dt>
                                <dd>{deal[key] ? new Date(deal[key]).toLocaleString(locale) : "Not recorded"}</dd>
                              </div>
                            ))}
                            <div>
                              <dt style={{ color: "var(--th-text-muted)" }}>Verified paid</dt>
                              <dd>
                                {deal.stage === "paid" ? "Sufficient linked verified receipts" : "Not verified paid"}
                              </dd>
                            </div>
                            <div>
                              <dt style={{ color: "var(--th-text-muted)" }}>Accounting profit</dt>
                              <dd>Unavailable: costs incomplete</dd>
                            </div>
                          </dl>
                        </div>
                        <button type="button" className="revenue-button" onClick={() => open("deal", deal)}>
                          Edit deal
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
            {tab === "ledger" && (
              <>
                {!data.ledger.length ? (
                  <p className="py-6 text-sm">No financial records yet.</p>
                ) : (
                  <ol className="divide-y" style={{ borderColor: "var(--th-border)" }}>
                    {data.ledger.map((entry) => (
                      <li key={entry.id} className="flex min-w-0 flex-wrap items-start justify-between gap-3 py-4">
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium">{entry.description}</p>
                          <p className="mt-1 text-sm tabular-nums">
                            {money(entry.amount_minor, entry.currency)} · {entry.kind}
                          </p>
                          <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                            {entry.verified ? "Verified source record" : "Unverified manual record"} ·{" "}
                            {entry.source.replaceAll("_", " ")} · {new Date(entry.occurred_at).toLocaleString(locale)}
                          </p>
                          <p className="mt-1 break-words text-xs" style={{ color: "var(--th-text-muted)" }}>
                            Deal: {data.deals.find((item) => item.id === entry.deal_id)?.title ?? "Unassigned"} ·
                            Opportunity:{" "}
                            {data.opportunities.find((item) => item.id === entry.opportunity_id)?.title ?? "Unassigned"}
                          </p>
                        </div>
                        <button type="button" className="revenue-button" onClick={() => open("link", entry)}>
                          Link record
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
            {tab === "spending" && (
              <>
                <p className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
                  Spending always requires you. An approval does not initiate payment.
                </p>
                {!data.spend_requests.length ? (
                  <p className="py-6 text-sm">No spending requests.</p>
                ) : (
                  <ol className="divide-y" style={{ borderColor: "var(--th-border)" }}>
                    {data.spend_requests.map((item) => (
                      <li key={item.id} className="flex min-w-0 flex-wrap items-start justify-between gap-3 py-4">
                        <div className="min-w-0 flex-1">
                          <p className="break-words text-sm font-medium">{item.purpose}</p>
                          <p className="mt-1 text-sm">
                            {money(item.amount_minor, item.currency)} · {item.status}
                          </p>
                          <p className="mt-1 text-xs" style={{ color: "var(--th-text-muted)" }}>
                            {BUSINESS_NAMES[item.business]} · {item.decided_by || "Waiting for owner"}
                          </p>
                        </div>
                        {item.status === "pending" && (
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className="revenue-button"
                              disabled={busy}
                              onClick={() => void mutate(() => decideSpendRequest(item.id, false))}
                            >
                              Deny request
                            </button>
                            <button
                              type="button"
                              className="revenue-button"
                              disabled={busy}
                              onClick={() => void mutate(() => decideSpendRequest(item.id, true))}
                            >
                              Approve request
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
