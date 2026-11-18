import { useEffect, useState } from "react";
import { BUSINESS_SETTINGS_NAMES } from "../../api/business";
import {
  policiesApi,
  trustOffersApi,
  type BusinessPolicy,
  type GateLevel,
  type RampKind,
  type TrustOffer,
} from "../../api/accounts";
import SettingsSection from "./SettingsSection";

const field =
  "w-full rounded-lg border border-[var(--th-input-border)] bg-[var(--th-input-bg)] px-3 py-2 text-sm text-[var(--th-text-primary)]";

const button = "rounded-lg border border-[var(--th-border)] px-3 py-1.5 text-sm disabled:opacity-50";

const GATE_LABELS: Record<GateLevel, string> = {
  none: "No approval (agents apply it)",
  vp: "Both VPs must agree",
  owner: "Me",
};

const RAMP_NAMES: Record<RampKind, string> = {
  customer_sends: "emails, posts and listings customers see",
  record_changes: "agent changes to records",
  code_pushes: "code pushes",
};

type Editable = Omit<BusinessPolicy, "business" | "updated_at">;

/** A whole-number setting that saves when the field loses focus or Enter is pressed. */
function NumberSetting({
  label,
  hint,
  value,
  onSave,
  prefix,
}: {
  label: string;
  hint: string;
  value: number;
  onSave: (value: number) => void;
  prefix?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number(draft);
    if (!Number.isInteger(next) || next < 0) return setDraft(String(value));
    if (next !== value) onSave(next);
  };
  return (
    <label className="grid gap-1 text-sm">
      {label}
      <span className="flex items-center gap-2">
        {prefix && <span className="text-[var(--th-text-secondary)]">{prefix}</span>}
        <input
          aria-label={label}
          className={field}
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
        />
      </span>
      <span className="text-xs text-[var(--th-text-secondary)]">{hint}</span>
    </label>
  );
}

/**
 * Per-business approval settings. Raising automation for a business is a change here, not in code. Spending, paid
 * accounts, accepting terms and destructive SSH always need the owner and are not listed.
 */
export default function BusinessApprovals() {
  const [items, setItems] = useState<BusinessPolicy[] | null>(null);
  const [offers, setOffers] = useState<TrustOffer[]>([]);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    policiesApi
      .list()
      .then(setItems)
      .catch(() => setError("Could not load approval settings."));
    trustOffersApi
      .list()
      .then(setOffers)
      .catch(() => setOffers([]));
  }, []);
  const failed = (cause: unknown) =>
    setError(
      cause instanceof Error && cause.message === "owner_session_required"
        ? "Sign in with your password in Settings > Security to change approvals."
        : "Could not save that change.",
    );
  const change = async <K extends keyof Editable>(business: BusinessPolicy["business"], key: K, value: Editable[K]) => {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const item = await policiesApi.update(business, { [key]: value } as Partial<Editable>);
      setItems((current) => current?.map((entry) => (entry.business === business ? item : entry)) ?? null);
      setSaved(`${BUSINESS_SETTINGS_NAMES[business]} approvals saved.`);
      setOffers(await trustOffersApi.list().catch(() => offers));
    } catch (cause) {
      failed(cause);
    } finally {
      setBusy(false);
    }
  };
  const answer = async (offer: TrustOffer, accept: boolean) => {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const result = await trustOffersApi.answer(offer.business, offer.kind, accept);
      setOffers(result.items);
      setItems(
        (current) => current?.map((entry) => (entry.business === offer.business ? result.policy : entry)) ?? null,
      );
      setSaved(
        accept
          ? `Both VPs now approve ${RAMP_NAMES[offer.kind]} for ${BUSINESS_SETTINGS_NAMES[offer.business]}.`
          : "Offer hidden for now.",
      );
    } catch (cause) {
      failed(cause);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      title="Approvals"
      description="Who approves what, per business. Spending money, paid accounts, accepting terms and destructive SSH always need you whatever is set here."
    >
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
      {offers.length > 0 && (
        <ul aria-label="Suggested changes" className="space-y-2">
          {offers.map((offer) => (
            <li
              key={`${offer.business}:${offer.kind}`}
              aria-label={`${BUSINESS_SETTINGS_NAMES[offer.business]} ${RAMP_NAMES[offer.kind]}`}
              className="flex min-w-0 flex-col gap-3 rounded-lg border p-3 text-sm sm:flex-row sm:items-center sm:justify-between"
              style={{ borderColor: "var(--th-border)" }}
            >
              <p className="min-w-0">
                <strong>{BUSINESS_SETTINGS_NAMES[offer.business]}:</strong> you approved {offer.streak}{" "}
                {RAMP_NAMES[offer.kind]} in a row without turning one down ({offer.approved} approved, {offer.denied}{" "}
                denied in total). Let both VPs approve these from now on?
              </p>
              <span className="flex shrink-0 gap-2">
                <button type="button" disabled={busy} className={button} onClick={() => void answer(offer, true)}>
                  Let VPs approve
                </button>
                <button type="button" disabled={busy} className={button} onClick={() => void answer(offer, false)}>
                  Not now
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {!items ? (
        <p className="text-sm text-[var(--th-text-secondary)]">Loading…</p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-3">
          {items.map((policy) => (
            <fieldset
              key={policy.business}
              disabled={busy}
              aria-label={`${BUSINESS_SETTINGS_NAMES[policy.business]} approvals`}
              className="min-w-0 space-y-3 rounded-lg border p-4"
              style={{ borderColor: "var(--th-border)" }}
            >
              <legend className="px-1 text-sm font-semibold">{BUSINESS_SETTINGS_NAMES[policy.business]}</legend>
              <label className="grid gap-1 text-sm">
                Emails, posts and listings customers see
                <select
                  className={field}
                  value={policy.customer_sends}
                  onChange={(e) =>
                    void change(policy.business, "customer_sends", e.target.value as BusinessPolicy["customer_sends"])
                  }
                >
                  <option value="owner">Me</option>
                  <option value="vp">Both VPs must agree</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Agent changes to contacts, tickets, quotes and deals
                <select
                  className={field}
                  value={policy.record_changes}
                  onChange={(e) => void change(policy.business, "record_changes", e.target.value as GateLevel)}
                >
                  {(Object.keys(GATE_LABELS) as GateLevel[]).map((level) => (
                    <option key={level} value={level}>
                      {GATE_LABELS[level]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Pushing reviewed code to GitHub
                <select
                  className={field}
                  value={policy.code_pushes}
                  onChange={(e) => void change(policy.business, "code_pushes", e.target.value as GateLevel)}
                >
                  {(Object.keys(GATE_LABELS) as GateLevel[]).map((level) => (
                    <option key={level} value={level}>
                      {level === "none" ? "No approval (push after review)" : GATE_LABELS[level]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                Important clients
                <select
                  className={field}
                  value={policy.tier_to_owner}
                  onChange={(e) =>
                    void change(policy.business, "tier_to_owner", e.target.value as BusinessPolicy["tier_to_owner"])
                  }
                >
                  <option value="important">Important and VIP clients come to me</option>
                  <option value="vip">Only VIP clients come to me</option>
                  <option value="off">Client tier does not matter</option>
                </select>
              </label>
              <NumberSetting
                label="Deals and quotes this big come to me"
                hint={`Whole ${policy.amount_currency}. Anything at or above this, or in another currency, needs you. 0 = no limit.`}
                prefix={policy.amount_currency}
                value={Math.round(policy.owner_amount_minor / 100)}
                onSave={(value) => void change(policy.business, "owner_amount_minor", value * 100)}
              />
              <NumberSetting
                label="Suggest handing work to the VPs after"
                hint="Approvals by you in a row with none turned down. You always decide; 0 = never suggest."
                value={policy.trust_ramp_after}
                onSave={(value) => void change(policy.business, "trust_ramp_after", value)}
              />
            </fieldset>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
