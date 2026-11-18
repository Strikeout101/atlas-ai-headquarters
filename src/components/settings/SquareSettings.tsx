import { useCallback, useEffect, useState } from "react";
import { BUSINESS_KINDS, BUSINESS_SETTINGS_NAMES } from "../../api/business";
import { squareAccountsApi, type SquareAccount } from "../../api/square";

const field =
  "w-full rounded-lg border border-[var(--th-input-border)] bg-[var(--th-input-bg)] px-3 py-2 text-sm text-[var(--th-text-primary)]";
const button = "rounded-lg border border-[var(--th-border)] px-3 py-2 text-sm disabled:opacity-50";

const ERROR_TEXT: Record<string, string> = {
  square_business_mapped_in_other_account:
    "That business is already connected to a location in another Square account. Disconnect it there first.",
  square_location_mapped_elsewhere: "That location is already assigned in another Square account.",
  square_connection_has_receipts:
    "This account has imported payments, so it is kept for the record. Turn off sync instead.",
  square_last_connection: "At least one Square account stays; clear its token instead.",
  owner_session_required: "Sign in with your password in Settings > Security to change Square settings.",
};
function describe(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  return ERROR_TEXT[message] ?? (message || "Square request failed.");
}

/** One Square account: its token, environment, history window, locations and which business each location is. */
function SquareAccountEditor({
  account,
  others,
  onChanged,
}: {
  account: SquareAccount;
  /** Businesses already connected in other accounts, which this one cannot take. */
  others: Set<string>;
  onChanged: () => Promise<void>;
}) {
  const [settings, setSettings] = useState(account);
  const [label, setLabel] = useState(account.label),
    [environment, setEnvironment] = useState<"production" | "sandbox">(account.environment),
    [token, setToken] = useState(""),
    [since, setSince] = useState(account.history_since.slice(0, 10)),
    [mapping, setMapping] = useState<Record<string, string>>(
      Object.fromEntries(account.mappings.map((m) => [m.business, m.location_id])),
    );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const apply = useCallback((value: SquareAccount) => {
    setSettings(value);
    setLabel(value.label);
    setEnvironment(value.environment);
    setSince(value.history_since.slice(0, 10));
    setMapping(Object.fromEntries(value.mappings.map((m) => [m.business, m.location_id])));
  }, []);
  const run = async (action: () => Promise<void>, refreshAll = false) => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await action();
      if (refreshAll) await onChanged();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label={settings.label}
      className="min-w-0 space-y-5 rounded-xl border border-[var(--th-border)] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">{settings.label}</h4>
        <span className="text-xs text-[var(--th-text-secondary)]">
          {settings.token_configured ? (settings.enabled ? "Syncing" : "Connected, sync off") : "No token yet"} ·{" "}
          {settings.receipts} payment records
        </span>
      </div>
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
      <fieldset disabled={busy} className="space-y-5">
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <label className="grid gap-2 text-sm md:col-span-2">
            Account name
            <input className={field} value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
          </label>
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
              placeholder={
                settings.token_configured ? "Saved; leave blank to keep" : "Paste the Production access token"
              }
            />
            <span className="text-xs text-[var(--th-text-secondary)]">
              From developer.squareup.com &gt; your app &gt; Credentials &gt; Production. ATLAS only reads locations and
              payments with it. The saved token is never shown.
            </span>
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={button}
            onClick={() =>
              void run(async () => {
                apply(
                  await squareAccountsApi.update(settings.id, {
                    label: label.trim(),
                    environment,
                    history_since: `${since}T00:00:00.000Z`,
                    ...(token.trim() ? { token: token.trim() } : {}),
                  }),
                );
                setToken("");
                setMessage("Square account saved. Test and map locations after changing credentials.");
              }, true)
            }
          >
            Save Square account
          </button>
          <button
            className={button}
            disabled={!settings.token_configured}
            onClick={() =>
              void run(async () => {
                apply(await squareAccountsApi.test(settings.id));
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
              if (window.confirm(`Remove the saved token for ${settings.label}? Historical receipts will stay.`))
                void run(async () => {
                  apply(await squareAccountsApi.update(settings.id, { clear_token: true }));
                  setToken("");
                  setMessage("Square token removed; receipt history preserved.");
                }, true);
            }}
          >
            Clear Square token
          </button>
          {settings.receipts === 0 && (
            <button
              className={button}
              onClick={() => {
                if (window.confirm(`Remove the Square account "${settings.label}"?`))
                  void run(async () => {
                    await squareAccountsApi.remove(settings.id);
                  }, true);
              }}
            >
              Remove account
            </button>
          )}
        </div>
        <div className="border-t border-[var(--th-border)] pt-4">
          <h5 className="text-sm font-semibold">Business locations</h5>
          <p className="mt-1 text-xs text-[var(--th-text-secondary)]">
            One location per business, in one Square account. Imported locations keep their business to preserve receipt
            history.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {BUSINESS_KINDS.map((business) => (
              <label key={business} className="grid gap-2 text-sm">
                {BUSINESS_SETTINGS_NAMES[business]}
                <select
                  className={field}
                  value={mapping[business] ?? ""}
                  disabled={others.has(business)}
                  onChange={(e) => setMapping({ ...mapping, [business]: e.target.value })}
                >
                  <option value="">{others.has(business) ? "Connected in another account" : "Not connected"}</option>
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
                  await squareAccountsApi.mappings(
                    settings.id,
                    BUSINESS_KINDS.filter((business) => mapping[business] && !others.has(business)).map((business) => ({
                      business,
                      location_id: mapping[business],
                    })),
                  ),
                );
                setMessage("Square location assignments saved.");
              }, true)
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
                void run(async () => apply(await squareAccountsApi.update(settings.id, { enabled: e.target.checked })))
              }
            />
            Sync payments automatically every 15 minutes
          </label>
          <button
            className={button}
            disabled={!settings.mappings.length || !settings.token_configured}
            onClick={() =>
              void run(async () => {
                const result = await squareAccountsApi.sync(settings.id);
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
          sandbox payments, and incomplete payments are unverified. {settings.fee_unknown} imported payment records have
          unknown or unsupported fees.
        </p>
      </fieldset>
    </section>
  );
}

function SquareAccounts() {
  const [accounts, setAccounts] = useState<SquareAccount[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setError("");
    try {
      setAccounts(await squareAccountsApi.list());
    } catch (cause) {
      setError(describe(cause) || "Could not load Square settings. Try again.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="space-y-5">
      <p className="max-w-prose text-sm text-[var(--th-text-secondary)]">
        Reads Square locations and payments, from one or more Square accounts (Primrose Events has its own). Create
        locations in Square yourself, then connect them here. No charges, refunds, transfers or purchases are possible.
      </p>
      {error && (
        <p role="alert" className="break-words text-sm text-red-500">
          {error}
        </p>
      )}
      {!accounts ? (
        <button className={button} onClick={() => void load()}>
          Reload Square settings
        </button>
      ) : (
        <>
          {accounts.map((account) => (
            <SquareAccountEditor
              key={`${account.id}-${account.label}-${account.mappings.length}-${account.token_configured}`}
              account={account}
              others={
                new Set(
                  accounts
                    .filter((other) => other.id !== account.id)
                    .flatMap((other) => other.mappings.map((m) => m.business)),
                )
              }
              onChanged={load}
            />
          ))}
          <button
            className={button}
            disabled={busy}
            onClick={async () => {
              const name = window.prompt("Name for the new Square account (for example: Primrose Events)");
              if (!name?.trim()) return;
              setBusy(true);
              setError("");
              try {
                await squareAccountsApi.create({ label: name.trim() });
                await load();
              } catch (cause) {
                setError(describe(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            Add another Square account
          </button>
        </>
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
        <span className="ml-2 text-xs font-normal text-[var(--th-text-secondary)]">Read-only revenue connections</span>
      </summary>
      <div className="border-t border-[var(--th-card-border)] px-5 py-5 sm:px-6">{loaded && <SquareAccounts />}</div>
    </details>
  );
}
