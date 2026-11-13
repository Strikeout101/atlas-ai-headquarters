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
          ko: "비밀번호가 맞지 않습니다.",
          en: "That password didn't work.",
          ja: "パスワードが違います。",
          zh: "密码不正确。",
        }),
      );
    } else if (result.error === "too_many_attempts") {
      const minutes = Math.max(1, Math.ceil((result.retryAfterSeconds ?? 900) / 60));
      setError(
        t({
          ko: `시도 횟수가 너무 많습니다. ${minutes}분 후 다시 시도하세요.`,
          en: `Too many attempts. Try again in ${minutes} min.`,
          ja: `試行回数が多すぎます。${minutes} 分後に再試行してください。`,
          zh: `尝试次数过多。请在 ${minutes} 分钟后重试。`,
        }),
      );
    } else if (result.error === "password_not_set") {
      onRecheck();
    } else {
      setError(
        t({
          ko: "ATLAS에 연결할 수 없습니다. 연결을 확인하고 다시 시도하세요.",
          en: "Couldn't reach ATLAS. Check the connection and try again.",
          ja: "ATLAS に接続できません。接続を確認して再試行してください。",
          zh: "无法连接 ATLAS。请检查连接后重试。",
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
                {t({ ko: "로그인", en: "Sign in", ja: "サインイン", zh: "登录" })}
              </h1>
              <p className="text-sm leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
                {t({
                  ko: "이 기기는 신뢰된 네트워크에 있지 않습니다. ATLAS 비밀번호를 입력하세요.",
                  en: "This device isn't on a trusted network. Enter the ATLAS password to continue.",
                  ja: "このデバイスは信頼済みネットワーク外です。ATLAS のパスワードを入力してください。",
                  zh: "此设备不在受信任网络中。请输入 ATLAS 密码以继续。",
                })}
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <label htmlFor={inputId} className="text-xs font-medium" style={{ color: "var(--th-text-secondary)" }}>
                {t({ ko: "비밀번호", en: "Password", ja: "パスワード", zh: "密码" })}
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
              {submitting
                ? t({ ko: "확인 중…", en: "Checking…", ja: "確認中…", zh: "验证中…" })
                : t({ ko: "로그인", en: "Sign in", ja: "サインイン", zh: "登录" })}
            </button>

            <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({
                ko: "로그인한 브라우저는 30일 동안 유지됩니다.",
                en: "This browser stays signed in for 30 days.",
                ja: "このブラウザは 30 日間サインインしたままになります。",
                zh: "此浏览器将保持登录 30 天。",
              })}
            </p>
          </form>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <h1 className="text-[20px] font-semibold tracking-[-0.015em]" style={{ color: "var(--th-text-heading)" }}>
                {t({
                  ko: "비밀번호 로그인이 설정되지 않았습니다",
                  en: "Password sign-in isn't set up yet",
                  ja: "パスワードサインインは未設定です",
                  zh: "尚未设置密码登录",
                })}
              </h1>
              <p className="text-sm leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
                {t({
                  ko: "서버 컴퓨터나 신뢰된 네트워크에서 ATLAS를 열고 설정 › 보안에서 비밀번호를 정하세요. 그 후 여기서 로그인할 수 있습니다.",
                  en: "Open ATLAS on the server machine or from a trusted network, then set a password in Settings › Security. After that you can sign in here.",
                  ja: "サーバーまたは信頼済みネットワークから ATLAS を開き、設定 › セキュリティでパスワードを設定してください。その後ここでサインインできます。",
                  zh: "请在服务器本机或受信任网络中打开 ATLAS，并在 设置 › 安全 中设置密码。之后即可在此登录。",
                })}
              </p>
            </div>
            <button type="button" onClick={onRecheck} className="ax-btn-primary min-h-[44px] w-full rounded-lg text-sm">
              {t({ ko: "다시 확인", en: "Check again", ja: "再確認", zh: "重新检查" })}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
