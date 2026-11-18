import { useEffect, useState } from "react";
import { BUSINESS_SETTINGS_NAMES } from "../../api/business";
import { policiesApi, type BusinessPolicy, type GateLevel } from "../../api/accounts";
import SettingsSection from "./SettingsSection";

const field =
  "w-full rounded-lg border border-[var(--th-input-border)] bg-[var(--th-input-bg)] px-3 py-2 text-sm text-[var(--th-text-primary)]";

const GATE_LABELS: Record<GateLevel, string> = {
  none: "No approval (agents apply it)",
  vp: "Both VPs must agree",
  owner: "Me",
};

/**
 * Per-business approval settings. Raising automation for a business is a change here, not in code. Spending, paid
 * accounts, accepting terms and destructive SSH always need the owner and are not listed.
 */
export default function BusinessApprovals() {
  const [items, setItems] = useState<BusinessPolicy[] | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    policiesApi
      .list()
      .then(setItems)
      .catch(() => setError("Could not load approval settings."));
  }, []);
  const change = async (business: BusinessPolicy["business"], key: keyof BusinessPolicy, value: string) => {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const item = await policiesApi.update(business, { [key]: value } as never);
      setItems((current) => current?.map((entry) => (entry.business === business ? item : entry)) ?? null);
      setSaved(`${BUSINESS_SETTINGS_NAMES[business]} approvals saved.`);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message === "owner_session_required"
          ? "Sign in with your password in Settings > Security to change approvals."
          : "Could not save that change.",
      );
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
                  onChange={(e) => void change(policy.business, "customer_sends", e.target.value)}
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
                  onChange={(e) => void change(policy.business, "record_changes", e.target.value)}
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
                  onChange={(e) => void change(policy.business, "code_pushes", e.target.value)}
                >
                  {(Object.keys(GATE_LABELS) as GateLevel[]).map((level) => (
                    <option key={level} value={level}>
                      {level === "none" ? "No approval (push after review)" : GATE_LABELS[level]}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
