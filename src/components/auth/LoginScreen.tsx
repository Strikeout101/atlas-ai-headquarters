import { useId, useState, type FormEvent } from "react";
import { loginWithPassword, type AuthInfo } from "../../api";
import { useI18n } from "../../i18n";

interface LoginScreenProps {
  passwordConfigured: boolean;
  onSignedIn: (auth: AuthInfo) => void;
  onRecheck: () => void;
}

export default function LoginScreen({ passwordConfigured, onSignedIn, onRecheck }: LoginScreenProps) {
  const { t } = useI18n();
  const inputId = useId();
  const errorId = useId();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await loginWithPassword(password);
    setSubmitting(false);
    if (result.ok) {
      setPassword("");
      onSignedIn(result.auth);
      return;
    }
    setPassword("");
    if (result.error === "invalid_credentials") {
      setError(
        t({
          en: "That password didn't work.",
        }),
      );
    } else if (result.error === "too_many_attempts") {
      const minutes = Math.max(1, Math.ceil((result.retryAfterSeconds ?? 900) / 60));
      setError(
        t({
          en: `Too many attempts. Try again in ${minutes} min.`,
        }),
      );
    } else if (result.error === "password_not_set") {
      onRecheck();
    } else {
      setError(
        t({
          en: "Couldn't reach ATLAS. Check the connection and try again.",
        }),
      );
    }
  }

  return (
    <div
      className="flex min-h-[100dvh] w-full items-center justify-center px-4 py-10"
      style={{ background: "var(--th-bg-primary)", color: "var(--th-text-primary)" }}
    >
      <main
        className="w-full max-w-[400px] rounded-2xl p-6 sm:p-8"
        style={{ background: "var(--th-card-bg)", border: "1px solid var(--th-card-border)" }}
      >
        <div className="mb-8 flex items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg text-[13px] font-semibold"
            style={{ background: "var(--ax-signal)", color: "var(--ax-signal-ink)" }}
            aria-hidden="true"
          >
            AT
          </div>
          <span className="text-[15px] font-semibold tracking-[-0.01em]">ATLAS</span>
        </div>

        {passwordConfigured ? (
          <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <h1 className="text-[20px] font-semibold tracking-[-0.015em]" style={{ color: "var(--th-text-heading)" }}>
                {t({ en: "Sign in" })}
              </h1>
              <p className="text-sm leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
                {t({
                  en: "This device isn't on a trusted network. Enter the ATLAS password to continue.",
                })}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor={inputId} className="text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>
                {t({ en: "Password" })}
              </label>
              <input
                id={inputId}
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className="min-h-[44px] w-full rounded-lg border px-3 text-sm transition-colors focus:outline-none focus:ring-2"
                style={{
                  background: "var(--th-input-bg)",
                  borderColor: error ? "var(--th-danger-border)" : "var(--th-input-border)",
                  color: "var(--th-text-primary)",
                }}
              />
              {error && (
                <p id={errorId} role="alert" className="text-sm" style={{ color: "var(--th-danger-border)" }}>
                  {error}
                </p>
              )}
            </div>

            <button
              type="submit"
              disabled={!password || submitting}
              className="ax-btn-primary min-h-[44px] w-full rounded-lg text-sm"
            >
              {submitting ? t({ en: "Checking…" }) : t({ en: "Sign in" })}
            </button>

            <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                en: "This browser stays signed in for 30 days.",
              })}
            </p>
          </form>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <h1 className="text-[20px] font-semibold tracking-[-0.015em]" style={{ color: "var(--th-text-heading)" }}>
                {t({
                  en: "Password sign-in isn't set up yet",
                })}
              </h1>
              <p className="text-sm leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
                {t({
                  en: "Open ATLAS on the server machine or from a trusted network, then set a password in Settings › Security. After that you can sign in here.",
                })}
              </p>
            </div>
            <button type="button" onClick={onRecheck} className="ax-btn-primary min-h-[44px] w-full rounded-lg text-sm">
              {t({ en: "Check again" })}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
