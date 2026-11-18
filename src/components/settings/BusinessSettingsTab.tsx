import SquareSettings from "./SquareSettings";
import { useEffect, useState } from "react";
import { BUSINESS_SETTINGS_NAMES, businessApi, type BusinessProfile } from "../../api/business";
import BusinessMailboxes from "./BusinessMailboxes";
import BusinessApprovals from "./BusinessApprovals";
import SpendingBudgets from "./SpendingBudgets";
import GitHubAccounts from "./GitHubAccounts";
import BusinessSocialAccounts from "./BusinessSocialAccounts";
import SettingsSection from "./SettingsSection";

const fields = [
  ["name", "Business name", 160],
  ["website", "Website", 500],
  ["email", "Public email address", 320],
  ["service_area", "Service area", 1000],
  ["hours", "Hours and availability", 1000],
  ["brand_voice", "Brand voice", 4000],
  ["social_profiles", "Social profile links or usernames", 2000],
  ["services", "Services and catalog notes", 8000],
  ["workflow_notes", "Workflow and owner preferences", 8000],
] as const;

function ProfileEditor({
  profile,
  onSaved,
}: {
  profile: BusinessProfile;
  onSaved: (profile: BusinessProfile) => void;
}) {
  const [form, setForm] = useState(profile);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-5 pt-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setSaving(true);
        setError("");
        setMessage("");
        try {
          const { business, updated_at: _updatedAt, ...input } = form;
          const item = await businessApi.profiles.update(business, input);
          setForm(item);
          onSaved(item);
          setMessage("Business profile saved.");
        } catch {
          setError("Could not save this profile. Your edits are still here; please try again.");
        } finally {
          setSaving(false);
        }
      }}
    >
      <h3 className="text-sm font-semibold">{BUSINESS_SETTINGS_NAMES[profile.business]}</h3>
      <fieldset disabled={saving} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {fields.map(([key, label, maxLength]) => (
          <div key={key} className={`flex flex-col gap-2 ${maxLength >= 2000 ? "md:col-span-2" : ""}`}>
            <label
              htmlFor={`${profile.business}-${key}`}
              className="text-xs"
              style={{ color: "var(--th-text-secondary)" }}
            >
              {label}
            </label>
            <textarea
              id={`${profile.business}-${key}`}
              rows={maxLength >= 2000 ? 3 : 1}
              maxLength={maxLength}
              value={form[key]}
              onChange={(event) => {
                setForm({ ...form, [key]: event.target.value });
                setMessage("");
              }}
              className="w-full rounded-lg border px-3 py-2 text-sm"
              style={{
                background: "var(--th-input-bg)",
                borderColor: "var(--th-input-border)",
                color: "var(--th-text-primary)",
              }}
            />
          </div>
        ))}
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <button
        disabled={saving}
        className="ax-btn-primary rounded-lg px-4 py-2 text-sm active:scale-[0.98] disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save business profile"}
      </button>
    </form>
  );
}

export default function BusinessSettingsTab() {
  const [profiles, setProfiles] = useState<BusinessProfile[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    businessApi.profiles.list().then(
      (items) => {
        if (active) setProfiles(items);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Business settings</h2>
        <p className="mt-2 text-sm" style={{ color: "var(--th-text-secondary)" }}>
          Profiles, mailboxes, and social accounts. Expand a group, then select the account you want to manage.
        </p>
      </div>
      <SettingsSection
        title="Business profiles"
        description={`${profiles?.length ?? 0} businesses · brand, services, and workflow preferences`}
      >
        <p className="mb-4 max-w-prose text-sm text-[var(--th-text-secondary)]">
          Agents use these profiles as reference. Keep credentials out of profile notes. A public email address does not
          connect a mailbox.
        </p>
        {error ? (
          <div role="alert">
            Could not load business profiles.{" "}
            <button type="button" className="underline" onClick={() => setAttempt(attempt + 1)}>
              Try again
            </button>
          </div>
        ) : profiles === null ? (
          <div
            aria-label="Loading business profiles"
            className="h-64 animate-pulse rounded-xl"
            style={{ background: "var(--th-card-bg)" }}
          />
        ) : profiles.length === 0 ? (
          <p>No business profiles are available. Reload after the server has initialized them.</p>
        ) : (
          <div className="grid min-w-0 grid-cols-1 items-start gap-6 xl:grid-cols-2">
            {profiles.map((profile) => (
              <details
                key={profile.business}
                className="min-w-0 rounded-lg border p-4"
                style={{ borderColor: "var(--th-border)" }}
              >
                <summary className="cursor-pointer text-sm font-medium">
                  {profile.name || BUSINESS_SETTINGS_NAMES[profile.business]}
                </summary>
                <ProfileEditor
                  profile={profile}
                  onSaved={(item) =>
                    setProfiles(
                      (current) => current?.map((entry) => (entry.business === item.business ? item : entry)) ?? [item],
                    )
                  }
                />
              </details>
            ))}
          </div>
        )}
      </SettingsSection>
      <BusinessApprovals />
      <SpendingBudgets />
      <BusinessMailboxes />
      <BusinessSocialAccounts />
      <GitHubAccounts />
      <SquareSettings />
    </div>
  );
}
