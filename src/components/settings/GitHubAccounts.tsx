import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BUSINESS_KINDS, BUSINESS_SETTINGS_NAMES, type BusinessKind } from "../../api/business";
import { githubAccountsApi, type GitHubAccount } from "../../api/accounts";
import SettingsSection from "./SettingsSection";

const field =
  "w-full rounded-lg border border-[var(--th-input-border)] bg-[var(--th-input-bg)] px-3 py-2 text-sm text-[var(--th-text-primary)]";
const button = "rounded-lg border border-[var(--th-border)] px-3 py-2 text-sm disabled:opacity-50";

const ERROR_TEXT: Record<string, string> = {
  invalid_github_token: "That doesn't look like a GitHub token. Paste the whole fine-grained token.",
  github_account_label_exists: "Another GitHub account already has that name.",
  github_token_rejected: "GitHub rejected the token. It may be expired or revoked.",
  github_unreachable: "Could not reach GitHub. Check the internet connection and try again.",
  owner_session_required: "Sign in with your password in Settings > Security to change GitHub accounts.",
};
const describe = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  return ERROR_TEXT[message] ?? (message || "That did not go through.");
};
const ownerName = (business: BusinessKind | null) => (business ? BUSINESS_SETTINGS_NAMES[business] : "Personal");

/**
 * GitHub accounts for repositories, one per business or personal, each with its own fine-grained token. Separate from
 * the GitHub sign-in used for Copilot models. Reviewed work is pushed with the project's account, never the PC's login.
 */
export default function GitHubAccounts() {
  const [items, setItems] = useState<GitHubAccount[] | null>(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ label: string; business: BusinessKind | "personal"; token: string }>({
    label: "",
    business: "personal",
    token: "",
  });
  const load = useCallback(async () => {
    try {
      setItems(await githubAccountsApi.list());
    } catch (cause) {
      setError(describe(cause));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const done = await work();
      if (done) setMessage(done);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      await load();
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      title="GitHub accounts"
      description={`${items?.length ?? 0} repo accounts · one per business or personal`}
    >
      <p className="mb-4 max-w-prose text-sm text-[var(--th-text-secondary)]">
        Create a fine-grained personal access token on github.com for each account (Settings &gt; Developer settings
        &gt; Fine-grained tokens), limited to that account's repositories with Contents and Pull requests set to read
        and write. Projects push with their business's account, or the personal one; agents never get these tokens.
      </p>
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-500">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mb-3 text-sm text-emerald-500">
          {message}
        </p>
      )}
      {items && items.length === 0 && (
        <p className="mb-4 text-sm text-[var(--th-text-secondary)]">
          No GitHub accounts yet. Reviewed work stays on this PC until one is added.
        </p>
      )}
      {items && items.length > 0 && (
        <ul className="mb-5 grid grid-cols-1 gap-3 xl:grid-cols-2">
          {items.map((account) => (
            <li
              key={account.id}
              aria-label={account.label}
              className="rounded-lg border p-4"
              style={{ borderColor: "var(--th-border)" }}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-semibold">{account.label}</span>
                <span className="text-xs text-[var(--th-text-secondary)]">
                  {ownerName(account.business)}
                  {account.is_default ? " · default" : ""}
                </span>
              </div>
              <p className="mt-1 text-xs text-[var(--th-text-secondary)]">
                {account.last_test_at
                  ? account.last_test_ok
                    ? `Signed in as ${account.login ?? "?"}`
                    : `Last test failed: ${ERROR_TEXT[account.last_error ?? ""] ?? account.last_error}`
                  : "Not tested yet"}
              </p>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                {!account.is_default && (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await githubAccountsApi.update(account.id, { is_default: true });
                        return `${account.label} is now the default for ${ownerName(account.business)}.`;
                      })
                    }
                  >
                    Make default
                  </button>
                )}
                <button
                  className={button}
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove the GitHub account "${account.label}"? Projects using it fall back to their business default.`,
                      )
                    )
                      void run(async () => {
                        await githubAccountsApi.remove(account.id);
                        return `${account.label} removed.`;
                      });
                  }}
                >
                  Remove
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await githubAccountsApi.test(account.id);
                      if (!result.connected) throw new Error(result.error ?? "github_test_failed");
                      return `${account.label} works: signed in as ${result.login}.`;
                    })
                  }
                >
                  Test
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        aria-label="Add GitHub account"
        className="grid min-w-0 gap-3 md:grid-cols-3"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          void run(async () => {
            const created = await githubAccountsApi.create(draft);
            setDraft({ label: "", business: "personal", token: "" });
            const test = await githubAccountsApi.test(created.id);
            return test.connected
              ? `${created.label} added and signed in as ${test.login}.`
              : `${created.label} added, but the test failed: ${ERROR_TEXT[test.error ?? ""] ?? test.error}`;
          });
        }}
      >
        <label className="grid gap-1 text-sm">
          Account name
          <input
            required
            className={field}
            maxLength={80}
            value={draft.label}
            placeholder="Primrose GitHub"
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />
        </label>
        <label className="grid gap-1 text-sm">
          Used for
          <select
            className={field}
            value={draft.business}
            onChange={(e) => setDraft({ ...draft, business: e.target.value as BusinessKind | "personal" })}
          >
            <option value="personal">Personal (anything without its own account)</option>
            {BUSINESS_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {BUSINESS_SETTINGS_NAMES[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          Fine-grained token
          <input
            required
            type="password"
            autoComplete="new-password"
            className={field}
            value={draft.token}
            onChange={(e) => setDraft({ ...draft, token: e.target.value })}
          />
        </label>
        <div className="md:col-span-3">
          <button type="submit" className={button} disabled={busy}>
            Add and test account
          </button>
        </div>
      </form>
    </SettingsSection>
  );
}
