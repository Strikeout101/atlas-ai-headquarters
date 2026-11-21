import { useEffect, useState } from "react";
import { webSearchApi, type WebSearchProvider, type WebSearchSettings as Settings } from "../../api/web-search";

const field =
  "w-full rounded-lg border border-[var(--th-input-border)] bg-[var(--th-input-bg)] px-3 py-2 text-sm text-[var(--th-text-primary)]";
const button = "rounded-lg border border-[var(--th-border)] px-3 py-2 text-sm disabled:opacity-50";

const PROVIDERS: Array<{ value: WebSearchProvider; label: string; note: string }> = [
  {
    value: "none",
    label: "No key (DuckDuckGo, limited)",
    note: "Works for a few searches, then refuses for a while. Fine for testing, not for real research.",
  },
  {
    value: "serper",
    label: "Serper (Google results)",
    note: "Google results with related questions. serper.dev: 2,500 free searches, then paid.",
  },
  { value: "brave", label: "Brave Search API", note: "Brave's own index. api-dashboard.search.brave.com." },
  { value: "tavily", label: "Tavily", note: "A search service built for AI agents. tavily.com." },
];

function describe(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  if (message.startsWith("web_search_key_rejected"))
    return "The search service refused the key. Check it and save again.";
  if (message === "owner_session_required") return "Sign in with your password in Settings > Security first.";
  return message || "Web search request failed.";
}

/**
 * The search service agents use for web.search (ideas, strategies, best sellers, trends). Search engines refuse
 * unkeyed automated searches after a few queries, so real research needs a key; the monthly cap prevents surprise bills.
 */
export default function WebSearchSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [provider, setProvider] = useState<WebSearchProvider>("none");
  const [apiKey, setApiKey] = useState("");
  const [cap, setCap] = useState("1000");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const apply = (value: Settings) => {
    setSettings(value);
    setProvider(value.provider);
    setCap(String(value.monthly_cap));
  };
  useEffect(() => {
    webSearchApi
      .get()
      .then(apply)
      .catch((cause) => setError(describe(cause)));
  }, []);
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
  const choice = PROVIDERS.find((item) => item.value === provider) ?? PROVIDERS[0];
  return (
    <section
      aria-label="Web search"
      className="min-w-0 space-y-3 rounded-xl border border-[var(--th-border)] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Web search for agents</h3>
        {settings && (
          <span className="text-xs text-[var(--th-text-secondary)]">
            {settings.used_this_month} of {settings.monthly_cap} searches this month
          </span>
        )}
      </div>
      <p className="text-xs text-[var(--th-text-secondary)]">
        Agents search the web for ideas, strategies, best sellers and trends. Search engines refuse unkeyed automated
        searches after a few queries, so real research needs a search service with a key.
      </p>
      {error && (
        <p role="alert" className="break-words text-sm text-red-500">
          {error}
        </p>
      )}
      {message && <p className="text-sm text-emerald-600">{message}</p>}
      {settings?.last_error && (
        <p className="break-words text-xs text-amber-600">Last problem: {settings.last_error}</p>
      )}
      <form
        aria-label="Search service"
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            apply(
              await webSearchApi.save({
                provider,
                monthly_cap: Math.max(1, Math.floor(Number(cap) || 1)),
                ...(apiKey ? { api_key: apiKey } : {}),
              }),
            );
            setApiKey("");
            setMessage("Saved.");
          });
        }}
      >
        <label className="text-xs">
          Search service
          <select className={field} value={provider} onChange={(e) => setProvider(e.target.value as WebSearchProvider)}>
            {PROVIDERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[var(--th-text-secondary)]">{choice.note}</span>
        </label>
        <label className="text-xs">
          Monthly search cap
          <input
            className={field}
            type="number"
            min={1}
            max={100000}
            value={cap}
            onChange={(e) => setCap(e.target.value)}
          />
        </label>
        {provider !== "none" && (
          <label className="text-xs sm:col-span-2">
            API key {settings?.api_key_set && settings.provider === provider ? "(saved; leave blank to keep)" : ""}
            <input
              className={field}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
            />
          </label>
        )}
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <button type="submit" className={button} disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className={button}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await webSearchApi.test();
                apply(result.settings);
                setMessage(`${result.source} answered with ${result.results} results.`);
              })
            }
          >
            Test a search
          </button>
        </div>
      </form>
    </section>
  );
}
