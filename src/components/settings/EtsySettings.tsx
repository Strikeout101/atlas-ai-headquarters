import { useCallback, useEffect, useState } from "react";
import { getAutonomy, type Initiative } from "../../api/autonomy";
import { etsyApi, type EtsySettings as Settings, type EtsyShopListing, type EtsyShopState } from "../../api/etsy";

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
  etsy_listing_already_in_atlas: "That listing is already in ATLAS.",
  etsy_listing_removed: "That listing is no longer on Etsy.",
  etsy_listing_not_found: "Sync first: ATLAS has not read that listing yet.",
  invalid_history_days: "History must be between 1 and 1095 days.",
  invalid_initiative_id: "Pick an initiative of the Etsy business, or none.",
  owner_session_required: "Sign in with your password in Settings > Security to change Etsy settings.",
};
function describe(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  const key = message.split(":")[0];
  return ERROR_TEXT[key] ?? (message || "Etsy request failed.");
}
const when = (at: number | null) => (at ? new Date(at).toLocaleString() : "never");
const money = (minor: number | null, currency: string | null) =>
  minor === null ? "" : `${(minor / 100).toFixed(2)} ${currency ?? "USD"}`;

/**
 * The shop itself: what is missing, and the owner's part of an applied shop setup (Etsy's API cannot upload the
 * logo or banner or set the About story, so agents make them and the owner uploads them).
 */
function ShopSetup() {
  const [state, setState] = useState<EtsyShopState | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    etsyApi
      .shop()
      .then(setState)
      .catch((cause) => setError(describe(cause)));
  }, []);
  useEffect(load, [load]);
  if (!state && !error) return null;
  const waiting = (state?.changes ?? []).filter(
    (change) =>
      change.status === "applied" && !change.owner_done_at && (change.logo_path || change.banner_path || change.about),
  );
  return (
    <div className="space-y-2 rounded-lg bg-[var(--th-bg-surface)] p-3 text-sm" aria-label="Shop setup">
      <p className="font-medium">Shop setup</p>
      {error && <p className="text-xs text-red-500">{error}</p>}
      {state && !state.can_change && (
        <p className="text-xs text-amber-600">
          Reconnect Etsy (Connect, approve, paste the address) so approved shop changes can be applied: ATLAS now also
          asks to edit the shop.
        </p>
      )}
      {state?.profile && (
        <p className="text-xs text-[var(--th-text-secondary)]">
          {state.gaps.length
            ? `Missing: ${state.gaps.join("; ")}.`
            : "Logo, banner, title, announcement and sections are set."}{" "}
          Agents make the shop setup and propose it for approval.
        </p>
      )}
      {waiting.map((change) => (
        <div key={change.id} className="space-y-1 border-t border-[var(--th-border)] pt-2 text-xs">
          <p>Your part: upload on Etsy (Shop Manager &gt; your shop &gt; Edit shop), then tick it off.</p>
          {change.logo_path && <p className="break-all">Logo: project folder / {change.logo_path}</p>}
          {change.banner_path && <p className="break-all">Banner: project folder / {change.banner_path}</p>}
          {change.about && (
            <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">About story: {change.about}</p>
          )}
          <button
            type="button"
            className={button}
            onClick={() =>
              void etsyApi
                .shopOwnerDone(change.id)
                .then(load)
                .catch((cause) => setError(describe(cause)))
            }
          >
            Uploaded on Etsy
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Every listing in the shop as last synced, including ones ATLAS did not create. The owner can bring one into
 * ATLAS (optionally tied to an initiative) so its sales count there and agents can propose revisions of it.
 */
function ShopListings({ business, count }: { business: Settings["business"]; count: number }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<EtsyShopListing[] | null>(null);
  const [initiatives, setInitiatives] = useState<Initiative[]>([]);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const [listings, autonomy] = await Promise.all([etsyApi.shopListings(), getAutonomy().catch(() => null)]);
    setItems(listings);
    setInitiatives(
      (autonomy?.initiatives ?? []).filter((item) => item.business === business && item.status !== "stopped"),
    );
  }, [business]);
  useEffect(() => {
    if (open) load().catch((cause) => setError(describe(cause)));
  }, [open, load]);
  return (
    <div className="space-y-2">
      <button type="button" className={button} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide" : "Show"} shop listings ({count})
      </button>
      {error && (
        <p role="alert" className="break-words text-sm text-red-500">
          {error}
        </p>
      )}
      {open && items && items.length === 0 && (
        <p className="text-xs text-[var(--th-text-secondary)]">No listings read yet. Press Sync now.</p>
      )}
      {open && items && items.length > 0 && (
        <ul aria-label="Shop listings" className="divide-y divide-[var(--th-border)] text-sm">
          {items.map((item) => (
            <li key={item.listing_id} className="flex min-w-0 flex-col gap-2 py-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                {item.url ? (
                  <a className="break-words underline" href={item.url} target="_blank" rel="noopener noreferrer">
                    {item.title || `Listing ${item.listing_id}`}
                  </a>
                ) : (
                  <span className="break-words">{item.title || `Listing ${item.listing_id}`}</span>
                )}
                <span className="block text-xs text-[var(--th-text-secondary)]">
                  {item.state.replace("_", " ")}
                  {item.price_minor !== null ? ` · ${money(item.price_minor, item.currency)}` : ""}
                  {item.num_favorers !== null ? ` · ${item.num_favorers} favorites` : ""}
                  {typeof item.views === "number" ? ` · ${item.views} views` : ""}
                </span>
              </div>
              {item.package_id ? (
                <span className="text-xs text-[var(--th-text-secondary)]">
                  {item.adopted ? "Brought into ATLAS" : "Made by ATLAS"}
                </span>
              ) : item.state !== "removed" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label={`Initiative for ${item.title}`}
                    className={`${field} sm:w-48`}
                    value={choice[item.listing_id] ?? ""}
                    onChange={(e) => setChoice({ ...choice, [item.listing_id]: e.target.value })}
                  >
                    <option value="">No initiative</option>
                    {initiatives.map((initiative) => (
                      <option key={initiative.id} value={initiative.id}>
                        {initiative.title}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={button}
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setBusy(item.listing_id);
                      setError("");
                      etsyApi
                        .adopt(item.listing_id, choice[item.listing_id] || null)
                        .then(load)
                        .catch((cause) => setError(describe(cause)))
                        .finally(() => setBusy(""));
                    }}
                  >
                    Bring into ATLAS
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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
  const [historyDays, setHistoryDays] = useState(365);
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
      {settings?.connected && typeof settings.rate_remaining_today === "number" && (
        <p className={`text-xs ${settings.quota_low ? "text-amber-600" : "text-[var(--th-text-secondary)]"}`}>
          Etsy requests left today: {settings.rate_remaining_today}
          {settings.rate_limit_per_day ? ` of ${settings.rate_limit_per_day}` : ""}
          {settings.quota_low ? " · background sync paused until it refills" : ""}
        </p>
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
            Read orders, fees, favorites and shop listings every 30 minutes
          </label>
          <p className="text-xs text-[var(--th-text-secondary)]">
            Approved revisions are applied to live listings, and listings of stopped initiatives are taken down (never
            ones you brought in).
          </p>
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
                    `Synced: ${result.counts.receipts} orders, ${result.counts.fees} fees, ${result.counts.refunds} refunds, ${result.counts.shop_listings} shop listings (${result.counts.changed_on_etsy} changed on Etsy).`,
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
          <form
            aria-label="Re-read history"
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await etsyApi.sync(historyDays);
                apply(result.settings);
                setMessage(
                  `Read ${historyDays} days of history: ${result.counts.receipts} orders, ${result.counts.fees} fees, ${result.counts.refunds} refunds. Records already in Revenue were not added twice.`,
                );
              });
            }}
          >
            <label className="text-xs">
              Re-read history (days, up to 1095)
              <input
                className={`${field} w-32`}
                type="number"
                min={1}
                max={1095}
                value={historyDays}
                onChange={(e) => setHistoryDays(Math.max(1, Math.min(1095, Math.floor(Number(e.target.value) || 1))))}
              />
            </label>
            <button type="submit" className={button} disabled={busy}>
              Re-read history
            </button>
          </form>
          <ShopSetup />
          <ShopListings business={settings.business} count={settings.shop_listings ?? 0} />
        </div>
      )}
    </section>
  );
}
