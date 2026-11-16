import { useCallback, useEffect, useState } from "react";
import { BUSINESS_SETTINGS_NAMES } from "../../api/business";
import {
  getSquareSettings,
  updateSquareSettings,
  updateSquareMappings,
  testSquare,
  syncSquare,
  type SquareConnection,
} from "../../api/square";

const field =
  "w-full rounded-lg border border-[var(--th-input-border)] bg-[var(--th-input-bg)] px-3 py-2 text-sm text-[var(--th-text-primary)]";
const button = "rounded-lg border border-[var(--th-border)] px-3 py-2 text-sm disabled:opacity-50";
function SquareEditor() {
  const [settings, setSettings] = useState<SquareConnection | null>(null),
    [environment, setEnvironment] = useState<"production" | "sandbox">("production");
  const [token, setToken] = useState(""),
    [since, setSince] = useState(""),
    [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const apply = useCallback((value: SquareConnection) => {
    setSettings(value);
    setEnvironment(value.environment);
    setSince(value.history_since.slice(0, 10));
    setMapping(Object.fromEntries(value.mappings.map((m) => [m.business, m.location_id])));
  }, []);
  const load = useCallback(async () => {
    setError("");
    try {
      apply((await getSquareSettings()).connection);
    } catch {
      setError("Could not load Square settings. Try again.");
    }
  }, [apply]);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Square request failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <p className="max-w-prose text-sm text-[var(--th-text-secondary)]">
        Reads Square locations and payments. Create the Ventures location in Square yourself, then connect it here. No
        charges, refunds, transfers, account creation, or purchases are available.
      </p>
      {error && (
        <p role="alert" className="break-words text-sm text-red-500">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm text-emerald-500">
          {message}
        </p>
      )}
      {!settings ? (
        <button className={button} onClick={() => void load()}>
          Reload Square settings
        </button>
      ) : (
        <fieldset disabled={busy} className="space-y-5">
          <div className="grid min-w-0 gap-4 md:grid-cols-2">
            <label className="grid gap-2 text-sm">
              Square environment
              <select
                className={field}
                value={environment}
                onChange={(e) => setEnvironment(e.target.value as "production" | "sandbox")}
              >
                <option value="production">Production</option>
                <option value="sandbox">Sandbox (never verified revenue)</option>
              </select>
            </label>
            <label className="grid gap-2 text-sm">
              Payment history since
              <input type="date" className={field} value={since} onChange={(e) => setSince(e.target.value)} />
            </label>
            <label className="grid gap-2 text-sm md:col-span-2">
              Square access token
              <input
                type="password"
                aria-label="Square access token"
                autoComplete="new-password"
                className={field}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={settings.token_configured ? "Saved; leave blank to keep" : "Enter a read-only token"}
              />
              <span className="text-xs text-[var(--th-text-secondary)]">
                Use PAYMENTS_READ and MERCHANT_PROFILE_READ access. The saved token is never shown.
              </span>
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              onClick={() =>
                void run(async () => {
                  const result = await updateSquareSettings({
                    environment,
                    history_since: `${since}T00:00:00.000Z`,
                    ...(token.trim() ? { token: token.trim() } : {}),
                  });
                  setToken("");
                  apply(result.connection);
                  setMessage("Square connection saved. Test and map locations after changing credentials.");
                })
              }
            >
              Save Square connection
            </button>
            <button
              className={button}
              disabled={!settings.token_configured}
              onClick={() =>
                void run(async () => {
                  apply((await testSquare()).connection);
                  setMessage("Square locations loaded.");
                })
              }
            >
              Test and load locations
            </button>
            <button
              className={button}
              disabled={!settings.token_configured}
              onClick={() => {
                if (window.confirm("Remove the saved Square token? Historical receipts will stay."))
                  void run(async () => {
                    apply((await updateSquareSettings({ clear_token: true })).connection);
                    setToken("");
                    setMessage("Square token removed; receipt history preserved.");
                  });
              }}
            >
              Clear Square token
            </button>
          </div>
          <div className="border-t border-[var(--th-border)] pt-4">
            <h4 className="text-sm font-semibold">Business locations</h4>
            <p className="mt-1 text-xs text-[var(--th-text-secondary)]">
              One location per business. Imported locations retain their business assignment to preserve receipt
              history.
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {(["tech", "rental", "ventures"] as const).map((business) => (
                <label key={business} className="grid gap-2 text-sm">
                  {BUSINESS_SETTINGS_NAMES[business]}
                  <select
                    className={field}
                    value={mapping[business] ?? ""}
                    onChange={(e) => setMapping({ ...mapping, [business]: e.target.value })}
                  >
                    <option value="">Not connected</option>
                    {settings.locations.map((location) => (
                      <option key={location.id} value={location.id}>
                        {location.name} · {location.currency}
                        {location.status !== "ACTIVE" ? " (inactive)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <button
              className={`${button} mt-4`}
              disabled={!settings.locations.length}
              onClick={() =>
                void run(async () => {
                  apply(
                    (
                      await updateSquareMappings(
                        (["tech", "rental", "ventures"] as const)
                          .filter((business) => mapping[business])
                          .map((business) => ({ business, location_id: mapping[business] })),
                      )
                    ).connection,
                  );
                  setMessage("Square location assignments saved.");
                })
              }
            >
              Save Square locations
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--th-border)] pt-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) =>
                  void run(async () => apply((await updateSquareSettings({ enabled: e.target.checked })).connection))
                }
              />
              Sync payments automatically every 15 minutes
            </label>
            <button
              className={button}
              disabled={!settings.mappings.length || !settings.token_configured}
              onClick={() =>
                void run(async () => {
                  const result = await syncSquare();
                  apply(result.settings);
                  setMessage(`Square sync completed: ${result.imported} payment records read.`);
                })
              }
            >
              Sync Square payments now
            </button>
          </div>
          <p className="text-xs text-[var(--th-text-secondary)]">
            Coverage begins {settings.history_since.slice(0, 10)}. Last complete sync:{" "}
            {settings.last_sync_at ? new Date(settings.last_sync_at).toLocaleString() : "never"}.{" "}
            {settings.last_sync_error ? `Last sync issue: ${settings.last_sync_error}. ` : ""}Cash, external records,
            sandbox payments, and incomplete payments are unverified. Costs can be incomplete; {settings.fee_unknown}{" "}
            imported payment records have unknown or unsupported fees.
          </p>
        </fieldset>
      )}
    </div>
  );
}
export default function SquareSettings() {
  const [loaded, setLoaded] = useState(false);
  return (
    <details
      className="min-w-0 rounded-xl border border-[var(--th-card-border)] bg-[var(--th-card-bg)]"
      onToggle={(event) => {
        if (event.currentTarget.open) setLoaded(true);
      }}
    >
      <summary className="cursor-pointer px-5 py-4 text-sm font-semibold sm:px-6">
        Square payments{" "}
        <span className="ml-2 text-xs font-normal text-[var(--th-text-secondary)]">Read-only revenue connection</span>
      </summary>
      <div className="border-t border-[var(--th-card-border)] px-5 py-5 sm:px-6">{loaded && <SquareEditor />}</div>
    </details>
  );
}
