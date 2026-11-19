import { useCallback, useEffect, useState } from "react";
import { etsyApi, type EtsySettings as Settings } from "../../api/etsy";

const field =
  "w-full rounded-lg border border-[var(--th-input-border)] bg-[var(--th-input-bg)] px-3 py-2 text-sm text-[var(--th-text-primary)]";
const button = "rounded-lg border border-[var(--th-border)] px-3 py-2 text-sm disabled:opacity-50";

const ERROR_TEXT: Record<string, string> = {
  etsy_credentials_required: "Enter the app's keystring and shared secret first.",
  etsy_redirect_required: "Enter the redirect address you registered for the Etsy app.",
  etsy_redirect_must_be_https: "Etsy only accepts an https redirect address.",
  etsy_state_mismatch: "That address is from a different connect attempt. Press Connect again.",
  etsy_connect_expired: "That connect attempt expired (15 minutes). Press Connect again.",
  etsy_code_missing: "That address has no approval code in it. Paste the full address from the browser bar.",
  etsy_paste_the_address: "Paste the full address from the browser bar after approving on Etsy.",
  etsy_not_connected: "Connect the Etsy shop first.",
  owner_session_required: "Sign in with your password in Settings > Security to change Etsy settings.",
};
function describe(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  const key = message.split(":")[0];
  return ERROR_TEXT[key] ?? (message || "Etsy request failed.");
}
const when = (at: number | null) => (at ? new Date(at).toLocaleString() : "never");

/**
 * Etsy for the Ventures shop. Etsy only allows an https redirect, and ATLAS runs on plain http, so connecting is:
 * Connect, approve on Etsy, then paste the address the browser lands on (it will not load) back here.
 */
export default function EtsySettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [keystring, setKeystring] = useState("");
  const [secret, setSecret] = useState("");
  const [redirect, setRedirect] = useState("");
  const [pasted, setPasted] = useState("");
  const [connectUrl, setConnectUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const apply = useCallback((value: Settings) => {
    setSettings(value);
    setKeystring(value.keystring);
    setRedirect(value.redirect_uri || "https://localhost/atlas-etsy");
  }, []);
  useEffect(() => {
    etsyApi
      .get()
      .then(apply)
      .catch((cause) => setError(describe(cause)));
  }, [apply]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!settings && !error) return null;
  return (
    <section aria-label="Etsy" className="min-w-0 space-y-4 rounded-xl border border-[var(--th-border)] p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Etsy (Ventures shop)</h3>
        <span className="text-xs text-[var(--th-text-secondary)]">
          {settings?.connected
            ? `Connected to ${settings.shop_name ?? `shop ${settings.shop_id}`} · last sync ${when(settings.last_sync_at)}`
            : "Not connected"}
        </span>
      </div>
      {error && (
        <p role="alert" className="break-words text-sm text-red-500">
          {error}
        </p>
      )}
      {message && <p className="text-sm text-emerald-600">{message}</p>}
      {settings?.last_sync_error && (
        <p className="break-words text-xs text-amber-600">Last sync problem: {settings.last_sync_error}</p>
      )}
      <form
        aria-label="Etsy app"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            apply(
              await etsyApi.save({
                keystring,
                redirect_uri: redirect,
                ...(secret ? { shared_secret: secret } : {}),
              }),
            );
            setSecret("");
            setMessage("Saved.");
          });
        }}
      >
        <label className="text-xs">
          App keystring
          <input
            className={field}
            value={keystring}
            onChange={(e) => setKeystring(e.target.value)}
            autoComplete="off"
          />
        </label>
        <label className="text-xs">
          Shared secret {settings?.shared_secret_set ? "(saved; leave blank to keep)" : ""}
          <input
            className={field}
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="text-xs sm:col-span-2">
          Redirect address registered in the Etsy app (https)
          <input className={field} value={redirect} onChange={(e) => setRedirect(e.target.value)} />
        </label>
        <div className="sm:col-span-2">
          <button type="submit" className={button} disabled={busy}>
            Save app details
          </button>
        </div>
      </form>
      <div className="space-y-2 rounded-lg bg-[var(--th-bg-surface)] p-3 text-sm">
        <p className="text-xs text-[var(--th-text-secondary)]">
          1. Press Connect and approve ATLAS on Etsy. 2. Etsy sends the browser to your redirect address, which will not
          load. 3. Copy that whole address from the browser bar and paste it below.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const url = await etsyApi.connect();
                setConnectUrl(url);
                window.open(url, "_blank", "noopener");
              })
            }
          >
            Connect
          </button>
          {connectUrl && (
            <a className="break-all text-xs underline" href={connectUrl} target="_blank" rel="noopener noreferrer">
              Open the Etsy approval page again
            </a>
          )}
        </div>
        <form
          aria-label="Finish connecting"
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              apply(await etsyApi.complete(pasted));
              setPasted("");
              setMessage("Etsy shop connected.");
            });
          }}
        >
          <input
            className={field}
            aria-label="Address after approving"
            placeholder="https://localhost/atlas-etsy?code=…&state=…"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
          <button type="submit" className={button} disabled={busy || !pasted.trim()}>
            Finish connecting
          </button>
        </form>
      </div>
      {settings?.connected && (
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.auto_publish}
              disabled={busy}
              onChange={(e) => void run(async () => apply(await etsyApi.save({ auto_publish: e.target.checked })))}
            />
            <span>
              Publish approved listings automatically
              <span className="block text-xs text-[var(--th-text-secondary)]">
                Off: approved listings become Etsy drafts and you press Publish. Etsy charges its listing fee on
                publishing.
              </span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.sync_enabled}
              disabled={busy}
              onChange={(e) => void run(async () => apply(await etsyApi.save({ sync_enabled: e.target.checked })))}
            />
            Read orders, fees and favorites every 30 minutes
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void run(async () => (apply(await etsyApi.test()), setMessage("Etsy answered.")))}
            >
              Test
            </button>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await etsyApi.sync();
                  apply(result.settings);
                  setMessage(
                    `Synced: ${result.counts.receipts} orders, ${result.counts.fees} fees, ${result.counts.refunds} refunds.`,
                  );
                })
              }
            >
              Sync now
            </button>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void run(async () => apply(await etsyApi.disconnect()))}
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
