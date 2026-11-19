import { useCallback, useEffect, useState } from "react";
import { studioApi, type StudioSettings as Settings } from "../../api/studio";

const field =
  "w-full rounded-lg border border-[var(--th-input-border)] bg-[var(--th-input-bg)] px-3 py-2 text-sm text-[var(--th-text-primary)]";
const button = "rounded-lg border border-[var(--th-border)] px-3 py-2 text-sm disabled:opacity-50";
const dollars = (minor: number) => (minor / 100).toFixed(2);
const toMinor = (value: string) => Math.round((Number(value) || 0) * 100);

function describe(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  if (message === "studio_provider_incomplete") return "Enter the service address and model before turning it on.";
  if (message === "owner_session_required") return "Sign in with your password in Settings > Security first.";
  return message || "Studio request failed.";
}

/**
 * The image studio. The free mockup renderer always works when Chrome or Edge is installed. AI image generation stays
 * off until the owner sets a service (paid, or a model on the homelab) and a monthly cap.
 */
export default function StudioSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [form, setForm] = useState({
    base_url: "",
    model: "",
    image_size: "1024x1024",
    cost: "0",
    cap: "0",
    chrome_path: "",
    license_note: "",
  });
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const apply = useCallback((value: Settings) => {
    setSettings(value);
    setForm({
      base_url: value.base_url,
      model: value.model,
      image_size: value.image_size,
      cost: dollars(value.cost_per_image_minor),
      cap: dollars(value.monthly_cap_minor),
      chrome_path: value.chrome_path,
      license_note: value.license_note,
    });
  }, []);
  useEffect(() => {
    studioApi
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
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));
  return (
    <section
      aria-label="Image studio"
      className="min-w-0 space-y-4 rounded-xl border border-[var(--th-border)] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Image studio</h3>
        {settings && (
          <span className="text-xs text-[var(--th-text-secondary)]">
            AI images {settings.enabled ? "on" : "off"} · ${dollars(settings.spent_this_month_minor)} of $
            {dollars(settings.monthly_cap_minor)} this month
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="break-words text-sm text-red-500">
          {error}
        </p>
      )}
      {message && <p className="text-sm text-emerald-600">{message}</p>}
      <p className="text-xs text-[var(--th-text-secondary)]">
        Free mockups (covers, page grids, printables, tablet frames):{" "}
        {settings?.renderer_browser
          ? `ready, using ${settings.renderer_browser}`
          : "no Chrome or Edge found; set its path below"}
        .
      </p>
      <form
        aria-label="Image studio settings"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            apply(
              await studioApi.save({
                provider: form.base_url ? "openai_compatible" : "none",
                base_url: form.base_url,
                model: form.model,
                image_size: form.image_size,
                cost_per_image_minor: toMinor(form.cost),
                monthly_cap_minor: toMinor(form.cap),
                chrome_path: form.chrome_path,
                license_note: form.license_note,
                ...(apiKey ? { api_key: apiKey } : {}),
              }),
            );
            setApiKey("");
            setMessage("Saved.");
          });
        }}
      >
        <label className="text-xs sm:col-span-2">
          Image service address (OpenAI-compatible, for example https://api.openai.com/v1 or your homelab)
          <input className={field} value={form.base_url} onChange={set("base_url")} placeholder="https://…/v1" />
        </label>
        <label className="text-xs">
          Model
          <input className={field} value={form.model} onChange={set("model")} />
        </label>
        <label className="text-xs">
          API key {settings?.api_key_set ? "(saved; leave blank to keep)" : "(blank for none)"}
          <input
            className={field}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="text-xs">
          Cost per image (USD)
          <input className={field} inputMode="decimal" value={form.cost} onChange={set("cost")} />
        </label>
        <label className="text-xs">
          Monthly cap (USD)
          <input className={field} inputMode="decimal" value={form.cap} onChange={set("cap")} />
        </label>
        <label className="text-xs">
          Image size
          <input className={field} value={form.image_size} onChange={set("image_size")} />
        </label>
        <label className="text-xs">
          Chrome or Edge path (only if not found)
          <input className={field} value={form.chrome_path} onChange={set("chrome_path")} />
        </label>
        <label className="text-xs sm:col-span-2">
          License note saved with generated images
          <input
            className={field}
            value={form.license_note}
            onChange={set("license_note")}
            placeholder="Check the provider's terms before selling."
          />
        </label>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button type="submit" className={button} disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className={button}
            disabled={busy || !settings?.base_url}
            onClick={() =>
              void run(async () => {
                const models = await studioApi.test();
                setMessage(`The service answered (${models.length} models).`);
              })
            }
          >
            Test service
          </button>
          <button
            type="button"
            className={button}
            disabled={busy || !settings?.base_url}
            onClick={() => void run(async () => apply(await studioApi.save({ enabled: !settings?.enabled })))}
          >
            {settings?.enabled ? "Turn AI images off" : "Turn AI images on"}
          </button>
        </div>
      </form>
    </section>
  );
}
