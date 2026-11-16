import { useEffect, useState } from "react";
import { socialApi, type SocialAccount, type InstagramPost } from "../../api/business-social";
import type { BusinessKind } from "../../api/business";
import SettingsSection from "./SettingsSection";

const inputClass = "w-full rounded-lg border px-3 py-2 text-sm";
const inputStyle = {
  background: "var(--th-input-bg)",
  borderColor: "var(--th-input-border)",
  color: "var(--th-text-primary)",
};
const buttonClass = "rounded-lg border px-3 py-2 text-sm active:scale-[0.98] disabled:opacity-50";
const errors: Record<string, string> = {
  social_access_token_required: "Add an Instagram access token before testing this account.",
  social_authorization_failed:
    "Instagram rejected this token. Generate a current token with the required profile permission.",
  social_account_mismatch: "This token belongs to a different Instagram username. Check the account and token.",
  social_missing_profile_scope:
    "The token needs Instagram profile access. Check its permissions in Meta's developer dashboard.",
  social_account_exists: "This Instagram account is already saved for this business.",
  social_authorization_or_scope_failed:
    "Instagram could not authorize this account. Check the token and its profile permission.",
  social_rate_limited: "Instagram rate-limited this check. Wait before trying again.",
  social_account_not_verified: "Save a token and verify this Instagram account before loading posts.",
};
function errorText(cause: unknown) {
  const code = cause instanceof Error ? cause.message : String(cause);
  return errors[code] ?? "Could not complete this action. Check your Instagram account configuration and try again.";
}
function connectionLabel(account: SocialAccount) {
  return account.connection_status === "verified"
    ? "Profile verified"
    : account.has_access_token
      ? "Token saved · verify account"
      : "Not connected · profile only";
}

function SocialEditor({
  account,
  business,
  onSaved,
  onCancel,
}: {
  account?: SocialAccount;
  business: BusinessKind;
  onSaved: (item: SocialAccount) => void;
  onCancel?: () => void;
}) {
  const [username, setUsername] = useState(account?.username ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const prefix = `social-${account?.id ?? `new-${business}`}`;
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        setMessage("");
        try {
          const input = { username, ...(token ? { access_token: token } : {}) };
          const item = account ? await socialApi.update(account.id, input) : await socialApi.create(business, input);
          setToken("");
          setUsername(item.username);
          onSaved(item);
          setMessage("Instagram account saved. No content has been posted.");
        } catch (cause) {
          setError(errorText(cause));
        } finally {
          setBusy(false);
        }
      }}
    >
      <fieldset disabled={busy} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label className="text-xs" htmlFor={`${prefix}-username`}>
            Instagram username
          </label>
          <input
            id={`${prefix}-username`}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            maxLength={31}
            placeholder="primroseevents_"
            className={inputClass}
            style={inputStyle}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-xs" htmlFor={`${prefix}-token`}>
            Access token (optional)
          </label>
          <input
            id={`${prefix}-token`}
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            maxLength={16384}
            className={inputClass}
            style={inputStyle}
            aria-describedby={`${prefix}-help`}
          />
          <p id={`${prefix}-help`} className="text-xs text-[var(--th-text-secondary)]">
            {account?.has_access_token
              ? "A token is stored. Leave blank to keep it; saved tokens are never shown."
              : "You can save the profile now and connect API access later. Enter tokens here, never in chat or profile notes."}
          </p>
        </div>
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
      <div className="flex flex-wrap gap-3">
        <button disabled={busy} className={`${buttonClass} ax-btn-primary`}>
          {busy ? "Saving…" : account ? "Save Instagram account" : "Add Instagram account"}
        </button>
        {onCancel && (
          <button type="button" disabled={busy} className={buttonClass} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export default function BusinessSocialAccounts() {
  const [items, setItems] = useState<SocialAccount[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState<BusinessKind | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [posts, setPosts] = useState<Record<string, InstagramPost[]>>({});
  useEffect(() => {
    let active = true;
    setError("");
    socialApi.list().then(
      (next) => {
        if (active) setItems(next);
      },
      () => {
        if (active) setError("Could not load social accounts.");
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  const update = (item: SocialAccount) =>
    setItems((current) => [...(current ?? []).filter((entry) => entry.id !== item.id), item]);
  return (
    <SettingsSection
      title="Social accounts"
      description={`${items?.length ?? 0} Instagram profiles · you control posting`}
    >
      <div className="max-w-prose space-y-2 text-sm text-[var(--th-text-secondary)]">
        <p>
          Save Instagram profiles for agent planning and drafts. Connected accounts can load recent post links, types,
          and dates. This connection does not expose captions or analytics, publish content, send messages, or read your
          inbox.
        </p>
        <p>
          API access requires an Instagram Business or Creator account and a Meta developer app token with{" "}
          <code>instagram_business_basic</code>. Personal profiles can be saved for planning without connecting.
        </p>
        <a
          href="https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/"
          target="_blank"
          rel="noreferrer"
          className="inline-block underline"
        >
          Instagram connection setup guide
        </a>
      </div>
      {error && (
        <p role="alert" className="text-sm">
          {error}{" "}
          <button type="button" className="underline" onClick={() => setAttempt(attempt + 1)}>
            Reload accounts
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {items === null && !error ? (
        <div
          aria-label="Loading social accounts"
          className="h-24 animate-pulse rounded-lg"
          style={{ background: "var(--th-input-bg)" }}
        />
      ) : (
        items && (
          <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-2">
            {(["tech", "rental"] as const).map((business) => (
              <section
                key={business}
                className="min-w-0 space-y-3"
                aria-label={business === "tech" ? "Tech social accounts" : "Rental social accounts"}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">
                    {business === "tech" ? "Tech services" : "Events and rentals"}
                  </h3>
                  <button type="button" className={buttonClass} onClick={() => setAdding(business)}>
                    Add Instagram
                  </button>
                </div>
                {items.filter((item) => item.business === business).length === 0 && adding !== business && (
                  <p className="text-sm text-[var(--th-text-secondary)]">No Instagram accounts added.</p>
                )}
                {items
                  .filter((item) => item.business === business)
                  .map((item) => (
                    <details
                      key={item.id}
                      className="min-w-0 rounded-lg border p-3"
                      style={{ borderColor: "var(--th-border)" }}
                    >
                      <summary className="cursor-pointer break-all text-sm font-medium">
                        @{item.username}
                        <span className="mt-1 block text-xs font-normal text-[var(--th-text-secondary)]">
                          {connectionLabel(item)}
                        </span>
                      </summary>
                      <p className="mt-3 text-xs">
                        <a href={item.profile_url} target="_blank" rel="noreferrer" className="underline">
                          Open Instagram profile
                        </a>
                      </p>
                      <SocialEditor
                        account={item}
                        business={business}
                        onSaved={(updated) => {
                          update(updated);
                          setPosts((current) => {
                            const next = { ...current };
                            delete next[updated.id];
                            return next;
                          });
                        }}
                      />
                      <div className="mt-3 flex flex-wrap gap-3">
                        <button
                          type="button"
                          disabled={busy !== null || item.connection_status !== "verified"}
                          className={buttonClass}
                          onClick={async () => {
                            setBusy(item.id);
                            setError("");
                            setNotice("");
                            try {
                              const result = await socialApi.media(item.id);
                              if (result.ok) setPosts((current) => ({ ...current, [item.id]: result.items }));
                              else setError(errorText(new Error(result.error)));
                            } catch (cause) {
                              setError(errorText(cause));
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          Load recent posts
                        </button>
                        <button
                          type="button"
                          disabled={busy !== null || !item.has_access_token}
                          className={buttonClass}
                          onClick={async () => {
                            setBusy(item.id);
                            setError("");
                            setNotice("");
                            try {
                              const result = await socialApi.test(item.id);
                              update(result.item);
                              if (result.ok) setNotice(`Verified @${result.item.username}. Posting remains manual.`);
                              else setError(errorText(new Error(result.error)));
                            } catch (cause) {
                              setError(errorText(cause));
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          {busy === item.id ? "Working…" : "Verify saved connection"}
                        </button>
                        {item.has_access_token && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            className={buttonClass}
                            onClick={async () => {
                              setBusy(item.id);
                              setError("");
                              setNotice("");
                              try {
                                update(await socialApi.disconnect(item.id));
                                setPosts((current) => {
                                  const next = { ...current };
                                  delete next[item.id];
                                  return next;
                                });
                                setNotice("Connection removed. The profile is still available for planning.");
                              } catch (cause) {
                                setError(errorText(cause));
                              } finally {
                                setBusy(null);
                              }
                            }}
                          >
                            Disconnect API access
                          </button>
                        )}
                      </div>
                      {posts[item.id] && (
                        <div className="mt-4 space-y-3 border-t pt-3" style={{ borderColor: "var(--th-border)" }}>
                          <h4 className="text-sm font-medium">Recent Instagram posts</h4>
                          {posts[item.id].length === 0 ? (
                            <p className="text-sm text-[var(--th-text-secondary)]">
                              No recent posts returned by Instagram.
                            </p>
                          ) : (
                            posts[item.id].map((post) => (
                              <article key={post.id} className="space-y-2 text-sm">
                                <p className="whitespace-pre-wrap break-words">
                                  {post.caption ||
                                    "Caption unavailable through this connection. Open the post on Instagram to view it."}
                                </p>
                                <p className="text-xs text-[var(--th-text-secondary)]">
                                  {post.media_type}
                                  {post.timestamp ? ` · ${new Date(post.timestamp).toLocaleDateString()}` : ""}
                                </p>
                                {post.permalink && (
                                  <a
                                    href={post.permalink}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-xs underline"
                                  >
                                    View on Instagram
                                  </a>
                                )}
                              </article>
                            ))
                          )}
                        </div>
                      )}
                    </details>
                  ))}
                {adding === business && (
                  <div className="rounded-lg border p-4" style={{ borderColor: "var(--th-input-border)" }}>
                    <h4 className="text-sm font-semibold">New Instagram profile</h4>
                    <SocialEditor
                      business={business}
                      onSaved={(item) => {
                        update(item);
                        setAdding(null);
                      }}
                      onCancel={() => setAdding(null)}
                    />
                  </div>
                )}
              </section>
            ))}
          </div>
        )
      )}
    </SettingsSection>
  );
}
