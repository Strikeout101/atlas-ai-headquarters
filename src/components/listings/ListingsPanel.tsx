import { useCallback, useEffect, useState, type FormEvent } from "react";
import { etsyApi } from "../../api/etsy";
import { isApiRequestError } from "../../api/core";
import {
  LISTING_PLATFORM_NAMES,
  listingsApi,
  type ListingPackage,
  type ListingsOverview,
  type ListingStatus,
} from "../../api/listings";
import type { BusinessKind } from "../../api/business";
import { formatMoney, moneyInput, parseMoney } from "../revenue/money";

const ERROR_TEXT: Record<string, string> = {
  owner_session_required: "Sign in with your password in Settings > Security to change listings.",
  listing_already_decided: "This package was already decided. The list has been refreshed.",
  listing_not_approved: "Only an approved package can be marked as published.",
  invalid_listing_url: "Enter the full https:// address of the live listing.",
  invalid_monthly_cap_minor: "Enter a monthly budget between 0 and 1,000.00.",
};
function describe(cause: unknown): string {
  const code = isApiRequestError(cause) ? cause.code : cause instanceof Error ? cause.message : "";
  return ERROR_TEXT[code ?? ""] ?? (cause instanceof Error ? cause.message : "That did not go through. Try again.");
}

const GROUPS: Array<{ status: ListingStatus; title: string; empty: string }> = [
  {
    status: "approved",
    title: "Ready to publish",
    empty: "Nothing is approved and waiting to be published.",
  },
  { status: "ready", title: "Waiting for approval", empty: "No packages are waiting for approval." },
  { status: "draft", title: "Being prepared", empty: "No drafts in progress." },
  { status: "published", title: "Published", empty: "Nothing has been published yet." },
];

const buttonClass =
  "rounded-lg border border-slate-500/30 px-3 py-1.5 text-sm transition hover:bg-slate-500/10 active:scale-[0.98] disabled:cursor-wait disabled:opacity-50";
const primaryClass =
  "rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-sky-500 active:scale-[0.98] disabled:cursor-wait disabled:opacity-50";
const inputClass = "w-full rounded-lg border px-3 py-2 text-sm";
const inputStyle = {
  background: "var(--th-input-bg)",
  borderColor: "var(--th-input-border)",
  color: "var(--th-text-primary)",
};

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <dt className="text-xs font-medium text-[var(--th-text-secondary)]">{label}</dt>
        <button
          type="button"
          className="text-xs text-sky-500 hover:underline"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : `Copy ${label.toLowerCase()}`}
        </button>
      </div>
      <dd className="mt-1 whitespace-pre-wrap break-words text-sm">{value}</dd>
    </div>
  );
}

function PackageCard({
  item,
  busy,
  etsyConnected,
  onDecide,
  onPublished,
  onWithdraw,
  onEtsyDraft,
  onEtsyPublish,
}: {
  item: ListingPackage;
  busy: boolean;
  etsyConnected: boolean;
  onDecide: (approve: boolean) => void;
  onPublished: (url: string) => void;
  onWithdraw: () => void;
  onEtsyDraft: () => void;
  onEtsyPublish: () => void;
}) {
  const [url, setUrl] = useState("");
  const platform = LISTING_PLATFORM_NAMES[item.platform];
  const price = formatMoney(item.price_minor, item.currency, "en-US");
  const fee = item.fee_minor > 0 ? formatMoney(item.fee_minor, item.fee_currency, "en-US") : "free";
  return (
    <li className="rounded-xl border border-slate-500/25 p-4" aria-label={item.title}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="break-words text-sm font-semibold">{item.title}</h4>
          <p className="mt-0.5 text-xs text-[var(--th-text-secondary)]">
            {platform} · {price} · listing fee {fee}
            {item.status === "ready" &&
              ` · ${item.approver === "vp" ? "the VPs can approve this" : "needs your approval"}`}
            {item.decided_by && ` · decided by ${item.decided_by.startsWith("vp:") ? "the VPs" : "you"}`}
            {item.revision_of && " · change to a live listing"}
            {item.etsy_adopted ? " · brought in from your Etsy shop" : ""}
            {item.status === "published" &&
              !item.revision_of &&
              item.etsy_state &&
              ` · on Etsy: ${item.etsy_state.replace("_", " ")}`}
          </p>
        </div>
        {item.status === "published" && item.listing_url && (
          <a href={item.listing_url} target="_blank" rel="noreferrer" className="text-sm text-sky-500 hover:underline">
            Open listing
          </a>
        )}
      </div>

      {(item.status === "approved" || item.status === "ready") && (
        <dl className="mt-3 grid grid-cols-1 gap-3">
          <CopyField label="Title" value={item.title} />
          <CopyField label="Description" value={item.description} />
          <CopyField label="Tags" value={item.tags.join(", ")} />
          <CopyField label="Files to upload" value={item.files.join("\n")} />
          <CopyField label="Mockup images" value={item.mockups.join("\n")} />
          <CopyField label="Agent notes" value={item.notes} />
          {item.platform === "etsy" && item.taxonomy_id ? (
            <CopyField label="Etsy category id" value={String(item.taxonomy_id)} />
          ) : null}
        </dl>
      )}

      {item.status === "approved" && item.platform === "etsy" && etsyConnected && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[var(--th-bg-surface)] p-3">
          <p className="text-xs text-[var(--th-text-secondary)]">
            {item.revision_of
              ? `Approved change to live Etsy listing ${item.etsy_listing_id}. ATLAS applies it on the next sync; no listing fee.`
              : item.etsy_listing_id
                ? `Etsy draft created (listing ${item.etsy_listing_id}). Publishing makes it public and Etsy charges its fee.`
                : "Not on Etsy yet. Create the draft (private), check it on Etsy, then publish."}
          </p>
          <div className="flex flex-wrap gap-2">
            {item.revision_of ? (
              <button type="button" className={primaryClass} disabled={busy} onClick={onEtsyDraft}>
                Apply to Etsy now
              </button>
            ) : (
              <>
                {!item.etsy_listing_id && (
                  <button type="button" className={buttonClass} disabled={busy} onClick={onEtsyDraft}>
                    Create Etsy draft
                  </button>
                )}
                <button type="button" className={primaryClass} disabled={busy} onClick={onEtsyPublish}>
                  Publish on Etsy
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {item.status === "ready" && (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button type="button" className={buttonClass} disabled={busy} onClick={() => onDecide(false)}>
            Reject
          </button>
          <button type="button" className={primaryClass} disabled={busy} onClick={() => onDecide(true)}>
            {item.revision_of ? "Approve change" : "Approve for publishing"}
          </button>
        </div>
      )}

      {item.status === "approved" && (
        <form
          className="mt-4 flex flex-col gap-2 border-t border-slate-500/20 pt-3 sm:flex-row sm:items-end"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onPublished(url.trim());
          }}
        >
          <div className="min-w-0 flex-1">
            <label htmlFor={`listing-url-${item.id}`} className="text-xs">
              {item.revision_of
                ? "After you make this change on Etsy yourself, paste the listing address"
                : `After you publish it on ${platform}, paste the listing address`}
            </label>
            <input
              id={`listing-url-${item.id}`}
              type="url"
              required
              placeholder="https://"
              value={url}
              maxLength={500}
              className={`${inputClass} mt-1`}
              style={inputStyle}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
          <button type="button" className={buttonClass} disabled={busy} onClick={onWithdraw}>
            Withdraw
          </button>
          <button type="submit" className={primaryClass} disabled={busy}>
            Mark published
          </button>
        </form>
      )}
    </li>
  );
}

/** Storefront listing packages for one business: what agents prepared, what is approved, what is live. */
export default function ListingsPanel({ business }: { business: BusinessKind }) {
  const [data, setData] = useState<ListingsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [budgetText, setBudgetText] = useState("");
  const [etsyConnected, setEtsyConnected] = useState(false);
  useEffect(() => {
    etsyApi
      .get()
      .then((settings) => setEtsyConnected(settings.connected))
      .catch(() => setEtsyConnected(false));
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await listingsApi.list(business);
      setData(next);
      setBudgetText(moneyInput(next.budget.monthly_cap_minor, next.budget.currency));
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setLoading(false);
    }
  }, [business]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      await load();
      setBusy(false);
    }
  };

  const budget = data?.budget;
  const hidden = data?.items.filter((item) => item.status === "rejected" || item.status === "withdrawn").length ?? 0;

  return (
    <section className="mx-auto mb-8 w-full max-w-7xl" aria-label="Listings">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold tracking-tight">Listings</h2>
          <p className="mt-1 max-w-[65ch] text-sm text-[var(--th-text-secondary)]">
            Agents prepare complete listing packages for Etsy and itch.io.{" "}
            {etsyConnected
              ? "Approved Etsy packages become Etsy drafts here and you publish them (or turn on auto-publish in Settings). For other platforms, publish by hand and record the address."
              : "Once a package is approved, publish it yourself and record its address. Connect Etsy in Settings > Businesses to draft and publish from here."}
          </p>
        </div>
        {budget && (
          <form
            className="flex flex-wrap items-end gap-2"
            aria-label="Listing fee budget"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              void run(async () => {
                await listingsApi.setBudget(parseMoney(budgetText, budget.currency));
              });
            }}
          >
            <div>
              <label htmlFor="listing-fee-budget" className="text-xs">
                {`Monthly listing fee budget (${budget.currency})`}
              </label>
              <input
                id="listing-fee-budget"
                inputMode="decimal"
                value={budgetText}
                className={`${inputClass} mt-1 w-40`}
                style={inputStyle}
                aria-describedby="listing-fee-budget-help"
                onChange={(event) => setBudgetText(event.target.value)}
              />
            </div>
            <button type="submit" className={buttonClass} disabled={busy}>
              Save budget
            </button>
            <p id="listing-fee-budget-help" className="basis-full text-xs text-[var(--th-text-secondary)]">
              {budget.monthly_cap_minor === 0
                ? "No budget set: every listing that costs a fee needs your approval."
                : `${formatMoney(budget.used_minor, budget.currency, "en-US")} of ${formatMoney(budget.monthly_cap_minor, budget.currency, "en-US")} used in ${budget.month}. Inside it the VPs can approve; past it, listings come to you.`}
            </p>
          </form>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm" style={{ color: "var(--ax-danger)" }}>
          {error}
        </p>
      )}
      {loading && <p className="mt-4 text-sm text-[var(--th-text-secondary)]">Loading listings…</p>}

      {data && (
        <div className="mt-5 grid grid-cols-1 gap-6 xl:grid-cols-2">
          {GROUPS.map((group) => {
            const items = data.items.filter((item) => item.status === group.status);
            return (
              <section key={group.status} aria-label={group.title} className="min-w-0">
                <h3 className="text-sm font-semibold">
                  {group.title} <span className="font-normal text-[var(--th-text-secondary)]">({items.length})</span>
                </h3>
                {items.length === 0 ? (
                  <p className="mt-2 text-sm text-[var(--th-text-secondary)]">{group.empty}</p>
                ) : (
                  <ul className="mt-2 space-y-3">
                    {items.map((item) => (
                      <PackageCard
                        key={item.id}
                        item={item}
                        busy={busy}
                        etsyConnected={etsyConnected}
                        onEtsyDraft={() => void run(() => etsyApi.pushDraft(item.id))}
                        onEtsyPublish={() => {
                          if (
                            window.confirm(
                              `Publish "${item.title}" on Etsy now? It becomes public and Etsy charges its listing fee.`,
                            )
                          )
                            void run(() => etsyApi.publish(item.id));
                        }}
                        onDecide={(approve) => void run(() => listingsApi.decide(item.id, approve))}
                        onPublished={(url) => void run(() => listingsApi.markPublished(item.id, url))}
                        onWithdraw={() => {
                          if (window.confirm(`Withdraw "${item.title}"? It will not be published.`))
                            void run(() => listingsApi.withdraw(item.id));
                        }}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
      {hidden > 0 && (
        <p className="mt-4 text-xs text-[var(--th-text-secondary)]">{`${hidden} rejected or withdrawn package${hidden === 1 ? "" : "s"} not shown.`}</p>
      )}
    </section>
  );
}
