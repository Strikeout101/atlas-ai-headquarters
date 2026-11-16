import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import {
  changeLoginPassword,
  getAuthInfo,
  isApiRequestError,
  logout,
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
        ko: "서버 컴퓨터에서 접속",
        en: "On the server machine",
        ja: "サーバー本体から",
        zh: "在服务器本机上",
      });
    case "network":
      return t({
        ko: "신뢰된 네트워크에서 자동 로그인",
        en: "Automatically, on a trusted network",
        ja: "信頼済みネットワークで自動",
        zh: "受信任网络自动登录",
      });
    case "password":
      return t({ ko: "비밀번호로 로그인", en: "With the password", ja: "パスワードで", zh: "使用密码" });
    default:
      return t({ ko: "API 토큰으로 로그인", en: "With the API token", ja: "API トークンで", zh: "使用 API 令牌" });
  }
}

export default function SecuritySettingsTab({ t }: SecuritySettingsTabProps) {
  const ids = { current: useId(), next: useId(), confirm: useId(), message: useId() };
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"password" | "revoke" | "logout" | null>(null);
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
                ko: "보안 설정을 불러오지 못했습니다.",
                en: "Couldn't load security settings.",
                ja: "セキュリティ設定を読み込めませんでした。",
                zh: "无法加载安全设置。",
              })
            : t({ ko: "불러오는 중…", en: "Loading…", ja: "読み込み中…", zh: "加载中…" })}
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
          ko: "비밀번호를 저장했습니다. 다른 브라우저는 모두 로그아웃되었습니다.",
          en: "Password saved. Every other browser was signed out.",
          ja: "パスワードを保存しました。他のブラウザはすべてサインアウトされました。",
          zh: "密码已保存。其他所有浏览器已退出登录。",
        }),
      });
    } catch (error) {
      const code = isApiRequestError(error) ? error.code : null;
      setMessage({
        tone: "error",
        text:
          code === "invalid_current_password"
            ? t({
                ko: "현재 비밀번호가 맞지 않습니다.",
                en: "The current password is wrong.",
                ja: "現在のパスワードが違います。",
                zh: "当前密码不正确。",
              })
            : code === "too_many_attempts"
              ? t({
                  ko: "시도 횟수가 너무 많습니다. 잠시 후 다시 시도하세요.",
                  en: "Too many attempts. Try again later.",
                  ja: "試行回数が多すぎます。後で再試行してください。",
                  zh: "尝试次数过多，请稍后再试。",
                })
              : t({
                  ko: "비밀번호를 저장하지 못했습니다.",
                  en: "Couldn't save the password.",
                  ja: "パスワードを保存できませんでした。",
                  zh: "无法保存密码。",
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
          ko: "다른 브라우저를 모두 로그아웃했습니다.",
          en: "Signed out every other browser.",
          ja: "他のブラウザをすべてサインアウトしました。",
          zh: "已退出所有其他浏览器。",
        }),
      });
    } catch {
      setMessage({
        tone: "error",
        text: t({
          ko: "로그아웃하지 못했습니다.",
          en: "Couldn't sign them out.",
          ja: "サインアウトできませんでした。",
          zh: "无法退出登录。",
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
      <SettingsSection
        title={t({ ko: "이 브라우저", en: "This browser", ja: "このブラウザ", zh: "此浏览器" })}
        defaultOpen
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs" style={{ color: "var(--th-text-muted)" }}>
              {t({ ko: "로그인 방식", en: "Signed in", ja: "サインイン方法", zh: "登录方式" })}
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
                ko: "다른 브라우저 모두 로그아웃",
                en: "Sign out other browsers",
                ja: "他のブラウザをサインアウト",
                zh: "退出其他浏览器",
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
                {t({ ko: "로그아웃", en: "Sign out", ja: "サインアウト", zh: "退出登录" })}
              </button>
            )}
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t({ ko: "로그인 비밀번호", en: "Sign-in password", ja: "サインインパスワード", zh: "登录密码" })}
      >
        <div className="flex flex-col gap-1">
          <p className="text-sm leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
            {auth.password_configured
              ? t({
                  ko: "신뢰된 네트워크 밖의 기기는 이 비밀번호로 로그인합니다. 변경하면 다른 브라우저는 모두 로그아웃됩니다.",
                  en: "Devices outside your trusted networks sign in with this password. Changing it signs out every other browser.",
                  ja: "信頼済みネットワーク外のデバイスはこのパスワードでサインインします。変更すると他のブラウザはすべてサインアウトされます。",
                  zh: "受信任网络之外的设备使用此密码登录。更改后其他所有浏览器将退出登录。",
                })
              : t({
                  ko: "아직 비밀번호가 없습니다. 설정하면 신뢰된 네트워크 밖의 기기도 로그인할 수 있습니다.",
                  en: "No password yet. Set one so devices outside your trusted networks can sign in.",
                  ja: "パスワードは未設定です。設定すると信頼済みネットワーク外のデバイスもサインインできます。",
                  zh: "尚未设置密码。设置后，受信任网络之外的设备也可以登录。",
                })}
          </p>
        </div>

        <form onSubmit={handlePassword} className="flex flex-col gap-4" noValidate>
          {needsCurrent && (
            <div className="flex flex-col gap-2">
              <label htmlFor={ids.current} className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
                {t({ ko: "현재 비밀번호", en: "Current password", ja: "現在のパスワード", zh: "当前密码" })}
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
              {t({ ko: "새 비밀번호", en: "New password", ja: "新しいパスワード", zh: "新密码" })}
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
                ko: `${auth.password_min_length}자 이상. 긴 문장형 비밀번호가 좋습니다.`,
                en: `At least ${auth.password_min_length} characters. A short phrase works well.`,
                ja: `${auth.password_min_length} 文字以上。短いフレーズがおすすめです。`,
                zh: `至少 ${auth.password_min_length} 个字符，建议使用短语。`,
              })}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor={ids.confirm} className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
              {t({
                ko: "새 비밀번호 확인",
                en: "Confirm new password",
                ja: "新しいパスワード（確認）",
                zh: "确认新密码",
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
                  ko: "비밀번호가 일치하지 않습니다.",
                  en: "The passwords don't match.",
                  ja: "パスワードが一致しません。",
                  zh: "两次输入的密码不一致。",
                })}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={!canSubmit} className="ax-btn-primary min-h-[40px] rounded-lg px-4 text-sm">
              {auth.password_configured
                ? t({ ko: "비밀번호 변경", en: "Change password", ja: "パスワードを変更", zh: "更改密码" })
                : t({ ko: "비밀번호 설정", en: "Set password", ja: "パスワードを設定", zh: "设置密码" })}
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

      <SettingsSection
        title={t({ ko: "신뢰된 네트워크", en: "Trusted networks", ja: "信頼済みネットワーク", zh: "受信任网络" })}
      >
        <div className="flex flex-col gap-1">
          <p className="text-sm leading-relaxed" style={{ color: "var(--th-text-secondary)" }}>
            {t({
              ko: "이 네트워크의 브라우저는 자동으로 로그인합니다. 서버의 .env 파일에서 TRUSTED_NETWORKS를 수정하고 ATLAS를 재시작하세요. 게스트나 IoT VLAN은 넣지 마세요.",
              en: "Browsers on these networks sign in automatically. Edit TRUSTED_NETWORKS in the server's .env file and restart ATLAS to change them. Leave out guest and IoT VLANs.",
              ja: "これらのネットワーク上のブラウザは自動でサインインします。変更するにはサーバーの .env で TRUSTED_NETWORKS を編集し、ATLAS を再起動してください。ゲストや IoT の VLAN は含めないでください。",
              zh: "这些网络中的浏览器会自动登录。如需更改，请编辑服务器 .env 中的 TRUSTED_NETWORKS 并重启 ATLAS。不要加入访客或 IoT VLAN。",
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
              ko: "설정된 네트워크가 없습니다. 서버 컴퓨터만 자동 로그인됩니다.",
              en: "None configured. Only the server machine signs in automatically.",
              ja: "未設定です。自動サインインはサーバー本体のみです。",
              zh: "未配置。仅服务器本机自动登录。",
            })}
          </p>
        )}
        {auth.allowed_hosts.length > 0 && (
          <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
            {t({
              ko: "허용된 호스트 이름: ",
              en: "Allowed host names: ",
              ja: "許可されたホスト名: ",
              zh: "允许的主机名：",
            })}
            <span style={{ fontFamily: "var(--th-font-mono)" }}>{auth.allowed_hosts.join(", ")}</span>
          </p>
        )}
      </SettingsSection>
    </>
  );
}
