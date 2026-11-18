import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import {
  changeLoginPassword,
  getAuthInfo,
  isApiRequestError,
  logout,
  loginWithPassword,
  signOutEverywhere,
  type AuthInfo,
  type AuthMethod,
} from "../../api";
import type { TFunction } from "./types";
import SettingsSection from "./SettingsSection";

interface SecuritySettingsTabProps {
  t: TFunction;
}

const sectionStyle = { background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" };
const inputStyle = {
  background: "var(--th-input-bg)",
  borderColor: "var(--th-input-border)",
  color: "var(--th-text-primary)",
};
const inputClass =
  "min-h-[40px] w-full rounded-lg border px-3 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--th-focus-ring-shadow)]";
const secondaryButtonClass = "min-h-[40px] rounded-lg border px-4 text-sm transition-colors disabled:opacity-50";
const secondaryButtonStyle = { borderColor: "var(--th-input-border)", color: "var(--th-text-primary)" };

function methodLabel(t: TFunction, method: AuthMethod): string {
  switch (method) {
    case "local":
      return t({
        en: "On the server machine",
      });
    case "network":
      return t({
        en: "Automatically, on a trusted network",
      });
    case "password":
      return t({ en: "With the password" });
    default:
      return t({ en: "With the API token" });
  }
}

export default function SecuritySettingsTab({ t }: SecuritySettingsTabProps) {
  const ids = { current: useId(), next: useId(), confirm: useId(), message: useId() };
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [current, setCurrent] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInError, setSignInError] = useState(false);
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"password" | "revoke" | "logout" | "signin" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setAuth(await getAuthInfo());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!auth) {
    return (
      <section className="rounded-xl p-5 sm:p-6" style={sectionStyle}>
        <p className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
          {loadError
            ? t({
                en: "Couldn't load security settings.",
              })
            : t({ en: "Loading…" })}
        </p>
      </section>
    );
  }

  const needsCurrent = auth.password_configured && !auth.can_set_password_without_current;
  const tooShort = next.length > 0 && next.length < auth.password_min_length;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit =
    !busy && next.length >= auth.password_min_length && confirm === next && (!needsCurrent || current.length > 0);

  async function handlePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy("password");
    setMessage(null);
    try {
      setAuth(await changeLoginPassword(next, needsCurrent ? current : undefined));
      setCurrent("");
      setNext("");
      setConfirm("");
      setMessage({
        tone: "ok",
        text: t({
          en: "Password saved. Every other browser was signed out.",
        }),
      });
    } catch (error) {
      const code = isApiRequestError(error) ? error.code : null;
      setMessage({
        tone: "error",
        text:
          code === "invalid_current_password"
            ? t({
                en: "The current password is wrong.",
              })
            : code === "too_many_attempts"
              ? t({
                  en: "Too many attempts. Try again later.",
                })
              : t({
                  en: "Couldn't save the password.",
                }),
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleRevoke() {
    setBusy("revoke");
    setMessage(null);
    try {
      setAuth(await signOutEverywhere());
      setMessage({
        tone: "ok",
        text: t({
          en: "Signed out every other browser.",
        }),
      });
    } catch {
      setMessage({
        tone: "error",
        text: t({
          en: "Couldn't sign them out.",
        }),
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleLogout() {
    setBusy("logout");
    try {
      await logout();
    } finally {
      window.location.reload();
    }
  }

  const canSignOut = auth.method === "password" || auth.method === "token";

  return (
    <>
      <SettingsSection title={t({ en: "This browser" })} defaultOpen>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({ en: "Signed in" })}
            </span>
            <span className="text-sm">{methodLabel(t, auth.method)}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleRevoke}
              disabled={busy !== null}
              className={secondaryButtonClass}
              style={secondaryButtonStyle}
            >
              {t({
                en: "Sign out other browsers",
              })}
            </button>
            {canSignOut && (
              <button
                type="button"
                onClick={handleLogout}
                disabled={busy !== null}
                className={secondaryButtonClass}
                style={secondaryButtonStyle}
              >
                {t({ en: "Sign out" })}
              </button>
            )}
          </div>
        </div>
        {auth.method !== "password" && auth.password_configured && (
          <form
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy("signin");
              setSignInError(false);
              try {
                const result = await loginWithPassword(signInPassword);
                if (result.ok) {
                  setAuth(result.auth);
                  setSignInPassword("");
                } else setSignInError(true);
              } finally {
                setBusy(null);
              }
            }}
          >
            <label className="min-w-0 flex-1 text-sm">
              {t({
                en: "Sign in with your password to approve actions",
              })}
              <input
                type="password"
                autoComplete="current-password"
                value={signInPassword}
                onChange={(event) => setSignInPassword(event.target.value)}
                className={`${inputClass} mt-2`}
                style={inputStyle}
              />
            </label>
            <button
              type="submit"
              disabled={busy !== null || !signInPassword}
              className={secondaryButtonClass}
              style={secondaryButtonStyle}
            >
              {t({ en: "Sign in" })}
            </button>
            {signInError && (
              <p role="alert" className="w-full text-sm" style={{ color: "var(--th-danger-border)" }}>
                {t({
                  en: "Could not sign in. Check your password or try again later.",
                })}
              </p>
            )}
          </form>
        )}
      </SettingsSection>

      <SettingsSection title={t({ en: "Sign-in password" })}>
        <div className="flex flex-col gap-1">
          <p className="text-sm leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
            {auth.password_configured
              ? t({
                  en: "Devices outside your trusted networks sign in with this password. Changing it signs out every other browser.",
                })
              : t({
                  en: "No password yet. Set one so devices outside your trusted networks can sign in.",
                })}
          </p>
        </div>

        <form onSubmit={handlePassword} className="flex flex-col gap-4" noValidate>
          {needsCurrent && (
            <div className="flex flex-col gap-2">
              <label htmlFor={ids.current} className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {t({ en: "Current password" })}
              </label>
              <input
                id={ids.current}
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                className={inputClass}
                style={inputStyle}
              />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <label htmlFor={ids.next} className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {t({ en: "New password" })}
            </label>
            <input
              id={ids.next}
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              aria-invalid={tooShort || undefined}
              className={inputClass}
              style={inputStyle}
            />
            <span className="text-xs" style={{ color: tooShort ? "var(--th-danger-border)" : "var(--th-text-muted)" }}>
              {t({
                en: `At least ${auth.password_min_length} characters. A short phrase works well.`,
              })}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={ids.confirm} className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                en: "Confirm new password",
              })}
            </label>
            <input
              id={ids.confirm}
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={mismatch || undefined}
              className={inputClass}
              style={inputStyle}
            />
            {mismatch && (
              <span className="text-xs" style={{ color: "var(--th-danger-border)" }}>
                {t({
                  en: "The passwords don't match.",
                })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={!canSubmit} className="ax-btn-primary min-h-[40px] rounded-lg px-4 text-sm">
              {auth.password_configured ? t({ en: "Change password" }) : t({ en: "Set password" })}
            </button>
            {message && (
              <span
                id={ids.message}
                role="status"
                className="text-sm"
                style={{ color: message.tone === "ok" ? "var(--th-text-secondary)" : "var(--th-danger-border)" }}
              >
                {message.text}
              </span>
            )}
          </div>
        </form>
      </SettingsSection>

      <SettingsSection title={t({ en: "Trusted networks" })}>
        <div className="flex flex-col gap-1">
          <p className="text-sm leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              en: "Browsers on these networks sign in automatically. Edit TRUSTED_NETWORKS in the server's .env file and restart ATLAS to change them. Leave out guest and IoT VLANs.",
            })}
          </p>
        </div>
        {auth.trusted_networks.length > 0 ? (
          <ul className="flex flex-wrap gap-2">
            {auth.trusted_networks.map((network) => (
              <li
                key={network}
                className="rounded-md border px-2.5 py-1 text-[13px]"
                style={{ borderColor: "var(--th-card-border)", fontFamily: "var(--th-font-mono)" }}
              >
                {network}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm" style={{ color: "var(--th-text-muted)" }}>
            {t({
              en: "None configured. Only the server machine signs in automatically.",
            })}
          </p>
        )}
        {auth.allowed_hosts.length > 0 && (
          <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
            {t({
              en: "Allowed host names: ",
            })}
            <span style={{ fontFamily: "var(--th-font-mono)" }}>{auth.allowed_hosts.join(", ")}</span>
          </p>
        )}
      </SettingsSection>
    </>
  );
}
