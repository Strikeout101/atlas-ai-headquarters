import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AUTH_REQUIRED_EVENT, checkAuthSession, type AuthRequiredDetail } from "../../api";
import { useI18n } from "../../i18n";
import LoginScreen from "./LoginScreen";

type GateState =
  | { phase: "checking"; appMounted: boolean }
  | { phase: "signed_in"; appMounted: true }
  | { phase: "login"; appMounted: boolean; passwordConfigured: boolean }
  | { phase: "unreachable"; appMounted: boolean };

/**
 * Shows the app only once this browser has a session. Browsers on the server machine or a trusted network are
 * signed in automatically; others see the login screen. If a session ends while the app is open, the login
 * screen covers the app instead of unmounting it, so in-progress work survives a re-login.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [state, setState] = useState<GateState>({ phase: "checking", appMounted: false });

  const check = useCallback(async () => {
    setState((prev) => ({ phase: "checking", appMounted: prev.appMounted }));
    try {
      const result = await checkAuthSession();
      setState((prev) =>
        result.status === "signed_in"
          ? { phase: "signed_in", appMounted: true }
          : { phase: "login", appMounted: prev.appMounted, passwordConfigured: result.passwordConfigured },
      );
    } catch {
      setState((prev) => ({ phase: "unreachable", appMounted: prev.appMounted }));
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    const onAuthRequired = (event: Event) => {
      const detail = (event as CustomEvent<AuthRequiredDetail>).detail;
      setState((prev) =>
        prev.phase === "login"
          ? prev
          : { phase: "login", appMounted: prev.appMounted, passwordConfigured: detail?.passwordConfigured === true },
      );
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
  }, []);

  const handleSignedIn = useCallback(() => setState({ phase: "signed_in", appMounted: true }), []);

  let blocking: ReactNode = null;
  if (state.phase === "login") {
    blocking = (
      <LoginScreen passwordConfigured={state.passwordConfigured} onSignedIn={handleSignedIn} onRecheck={check} />
    );
  } else if (state.phase === "unreachable") {
    blocking = (
      <div
        className="flex min-h-[100dvh] w-full flex-col items-center justify-center gap-4 px-4 text-center"
        style={{ background: "var(--th-bg-primary)", color: "var(--th-text-primary)" }}
      >
        <p className="max-w-sm text-sm" style={{ color: "var(--th-text-secondary)" }}>
          {t({
            ko: "ATLAS 서버에 연결할 수 없습니다.",
            en: "Couldn't reach the ATLAS server.",
            ja: "ATLAS サーバーに接続できません。",
            zh: "无法连接 ATLAS 服务器。",
          })}
        </p>
        <button
          type="button"
          onClick={() => void check()}
          className="ax-btn-primary min-h-[44px] rounded-lg px-5 text-sm"
        >
          {t({ ko: "다시 시도", en: "Try again", ja: "再試行", zh: "重试" })}
        </button>
      </div>
    );
  } else if (state.phase === "checking" && !state.appMounted) {
    blocking = (
      <div className="min-h-[100dvh] w-full" style={{ background: "var(--th-bg-primary)" }} aria-busy="true" />
    );
  }

  if (!state.appMounted) return <>{blocking}</>;
  return (
    <>
      {children}
      {blocking && (
        <div className="fixed inset-0 z-[1000] overflow-y-auto" role="dialog" aria-modal="true">
          {blocking}
        </div>
      )}
    </>
  );
}
