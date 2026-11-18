import type { OAuthConnectProvider } from "../../api";
import { OAUTH_INFO } from "./constants";
import { AntigravityLogo, GitHubCopilotLogo } from "./Logos";
import type { OAuthCommonProps } from "./types";

export default function OAuthConnectedProvidersSection({
  t,
  localeTag,
  form,
  setForm,
  persistSettings,
  oauthStatus,
  models,
  modelsLoading,
  refreshing,
  disconnecting,
  savingAccountId,
  accountDrafts,
  onConnect,
  onDisconnect,
  onRefreshToken,
  onUpdateAccountDraft,
  onActivateAccount,
  onSaveAccount,
  onToggleAccount,
  onDeleteAccount,
}: OAuthCommonProps) {
  const detectedProviders = Object.entries(oauthStatus.providers).filter(([, info]) =>
    Boolean(info.detected ?? info.connected),
  );
  if (detectedProviders.length === 0) return null;

  const logoMap: Record<string, ({ className }: { className?: string }) => React.ReactElement> = {
    "github-copilot": GitHubCopilotLogo,
    antigravity: AntigravityLogo,
  };

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-slate-500 mb-2">{t({ en: "Auth Status" })}</div>
      {detectedProviders.map(([provider, info]) => {
        const oauthInfo = OAUTH_INFO[provider];
        const LogoComp = logoMap[provider];
        const expiresAt = info.expires_at ? new Date(info.expires_at) : null;
        const isExpired = expiresAt ? expiresAt.getTime() < Date.now() : false;
        const isWebOAuth = info.source === "web-oauth";
        const isFileDetected = info.source === "file-detected";
        const isRunnable = Boolean(info.executionReady ?? info.connected);
        const accountList = info.accounts ?? [];

        return (
          <div key={provider} className="space-y-2 overflow-hidden rounded-lg bg-slate-700/30 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                {LogoComp ? <LogoComp className="w-5 h-5" /> : <span className="text-lg">🔑</span>}
                <span className="text-sm font-medium text-white">{oauthInfo?.label ?? provider}</span>
                {info.email && <span className="max-w-full break-all text-xs text-slate-400">{info.email}</span>}
                {isFileDetected && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-600/50 text-slate-400">
                    {t({ en: "CLI detected" })}
                  </span>
                )}
                {isWebOAuth && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
                    {t({ en: "Web OAuth" })}
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                {!isRunnable ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300">
                    {t({
                      en: "Detected (not runnable)",
                    })}
                  </span>
                ) : !isExpired ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">
                    {info.lastRefreshed ? t({ en: "Auto-refreshed" }) : t({ en: "Connected" })}
                  </span>
                ) : info.refreshFailed ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400">
                    {t({ en: "Refresh failed" })}
                  </span>
                ) : isExpired && !info.hasRefreshToken ? (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">
                    {t({
                      en: "Expired — re-auth needed",
                    })}
                  </span>
                ) : (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">
                    {t({ en: "Expired" })}
                  </span>
                )}

                {info.hasRefreshToken && isWebOAuth && (
                  <button
                    onClick={() => void onRefreshToken(provider as OAuthConnectProvider)}
                    disabled={refreshing === provider}
                    className="text-xs px-2.5 py-1 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 text-blue-400 border border-blue-500/30 transition-colors disabled:opacity-50"
                  >
                    {refreshing === provider ? t({ en: "Refreshing..." }) : t({ en: "Refresh" })}
                  </button>
                )}

                {isExpired && !info.hasRefreshToken && isWebOAuth && (
                  <button
                    onClick={() => onConnect(provider as OAuthConnectProvider)}
                    className="text-xs px-2.5 py-1 rounded-lg ax-btn-primary transition-colors"
                  >
                    {t({ en: "Reconnect" })}
                  </button>
                )}

                {isWebOAuth && (
                  <button
                    onClick={() => void onDisconnect(provider as OAuthConnectProvider)}
                    disabled={disconnecting === provider}
                    className="text-xs px-2.5 py-1 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 transition-colors disabled:opacity-50"
                  >
                    {disconnecting === provider ? t({ en: "Disconnecting..." }) : t({ en: "Disconnect" })}
                  </button>
                )}
              </div>
            </div>

            {info.requiresWebOAuth && (
              <div className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-2.5 py-1.5">
                {t({
                  en: "CLI-detected credentials are not used directly for ATLAS execution. Reconnect with Web OAuth.",
                })}
              </div>
            )}

            {(info.scope || expiresAt || info.created_at > 0) && (
              <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                {info.scope && (
                  <div className="col-span-2">
                    <span className="text-slate-500">{t({ en: "Scope" })}: </span>
                    <span className="break-all font-mono text-[10px] leading-relaxed text-slate-300">{info.scope}</span>
                  </div>
                )}
                {expiresAt && (
                  <div>
                    <span className="text-slate-500">{t({ en: "Expires" })}: </span>
                    <span className={isExpired ? "text-red-400" : "text-slate-300"}>
                      {expiresAt.toLocaleString(localeTag)}
                    </span>
                  </div>
                )}
                {info.created_at > 0 && (
                  <div>
                    <span className="text-slate-500">{t({ en: "Created" })}: </span>
                    <span className="text-slate-300">{new Date(info.created_at).toLocaleString(localeTag)}</span>
                  </div>
                )}
              </div>
            )}

            {(() => {
              const modelKey =
                provider === "github-copilot" ? "copilot" : provider === "antigravity" ? "antigravity" : null;
              if (!modelKey) return null;
              const modelList = models?.[modelKey];
              const currentModel = form.providerModelConfig?.[modelKey]?.model || "";

              return (
                <div className="flex min-w-0 flex-col items-stretch gap-1.5 pt-1 sm:flex-row sm:items-center sm:gap-2">
                  <span className="w-auto shrink-0 text-xs text-slate-400">{t({ en: "Model:" })}</span>
                  {modelsLoading ? (
                    <span className="text-xs text-slate-500 animate-pulse">{t({ en: "Loading..." })}</span>
                  ) : modelList && modelList.length > 0 ? (
                    <select
                      value={currentModel}
                      onChange={(e) => {
                        const newConfig = {
                          ...form.providerModelConfig,
                          [modelKey]: { model: e.target.value },
                        };
                        const newForm = { ...form, providerModelConfig: newConfig };
                        setForm(newForm);
                        persistSettings(newForm);
                      }}
                      className="w-full min-w-0 rounded border border-slate-600 bg-slate-700/50 px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none sm:flex-1"
                    >
                      {!currentModel && <option value="">{t({ en: "Select..." })}</option>}
                      {modelList.map((model, idx) => (
                        <option key={`${model}-${idx}`} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="flex flex-col gap-1">
                      <span className="text-xs text-slate-500">{t({ en: "No models" })}</span>
                      {provider === "github-copilot" && (
                        <span className="text-[11px] text-amber-400/80">
                          {t({
                            en: "Models require a GitHub Copilot subscription. You can ignore this if you only need repo import.",
                          })}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {accountList.length > 0 && (
              <div className="space-y-2 rounded-lg border border-slate-600/40 bg-slate-800/40 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <div className="text-[11px] font-semibold text-slate-400">{t({ en: "Account Pool" })}</div>
                  <div className="text-[10px] text-slate-500 text-right">
                    {t({
                      en: "Multiple active accounts supported · lower priority runs first",
                    })}
                  </div>
                </div>

                {accountList.map((account) => {
                  const modelKey =
                    provider === "github-copilot" ? "copilot" : provider === "antigravity" ? "antigravity" : null;
                  const modelList = modelKey ? (models?.[modelKey] ?? []) : [];
                  const draft = accountDrafts[account.id] ?? {
                    label: account.label ?? "",
                    modelOverride: account.modelOverride ?? "",
                    priority: String(account.priority ?? 100),
                  };
                  const hasCustomOverride = Boolean(draft.modelOverride) && !modelList.includes(draft.modelOverride);

                  return (
                    <div
                      key={account.id}
                      className="rounded border border-slate-700/70 bg-slate-900/30 p-2.5 space-y-2"
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            account.active ? "bg-green-500/20 text-green-300" : "bg-slate-700 text-slate-400"
                          }`}
                        >
                          {account.active ? t({ en: "Active" }) : t({ en: "Standby" })}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            account.executionReady ? "bg-blue-500/20 text-blue-300" : "bg-amber-500/20 text-amber-300"
                          }`}
                        >
                          {account.executionReady ? t({ en: "Runnable" }) : t({ en: "Not runnable" })}
                        </span>
                        {account.email && <span className="text-[11px] text-slate-300 break-all">{account.email}</span>}
                      </div>

                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                        <label className="space-y-1">
                          <span className="block text-[11.5px] font-medium text-slate-500">{t({ en: "Label" })}</span>
                          <input
                            value={draft.label}
                            onChange={(e) => onUpdateAccountDraft(account.id, { label: e.target.value })}
                            placeholder={t({
                              en: "Account alias",
                            })}
                            className="w-full rounded border border-slate-600 bg-slate-800/70 px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none"
                          />
                        </label>

                        <label className="space-y-1">
                          <span className="block text-[11.5px] font-medium text-slate-500">
                            {t({ en: "Model Override" })}
                          </span>
                          <select
                            value={draft.modelOverride}
                            onChange={(e) => onUpdateAccountDraft(account.id, { modelOverride: e.target.value })}
                            className="w-full rounded border border-slate-600 bg-slate-800/70 px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none"
                          >
                            <option value="">
                              {t({
                                en: "Use provider default",
                              })}
                            </option>
                            {hasCustomOverride && <option value={draft.modelOverride}>{draft.modelOverride}</option>}
                            {modelList.map((model, idx) => (
                              <option key={`${model}-${idx}`} value={model}>
                                {model}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="space-y-1">
                          <span className="block text-[11.5px] font-medium text-slate-500">
                            {t({ en: "Priority" })}
                          </span>
                          <input
                            type="number"
                            min={1}
                            step={1}
                            value={draft.priority}
                            onChange={(e) => onUpdateAccountDraft(account.id, { priority: e.target.value })}
                            placeholder="100"
                            className="w-full rounded border border-slate-600 bg-slate-800/70 px-2 py-1 text-xs text-white focus:border-blue-500 focus:outline-none"
                          />
                        </label>
                      </div>

                      <div className="flex flex-wrap gap-1.5">
                        <button
                          onClick={() =>
                            void onActivateAccount(provider as OAuthConnectProvider, account.id, account.active)
                          }
                          disabled={savingAccountId === account.id || account.status !== "active"}
                          className={`text-[11px] px-2 py-1 rounded disabled:opacity-50 ${
                            account.active
                              ? "bg-orange-600/20 hover:bg-orange-600/35 text-orange-200"
                              : "bg-blue-600/30 hover:bg-blue-600/45 text-blue-200"
                          }`}
                        >
                          {account.active ? t({ en: "Pool Off" }) : t({ en: "Pool On" })}
                        </button>

                        <button
                          onClick={() => void onSaveAccount(account.id)}
                          disabled={savingAccountId === account.id}
                          className="text-[11px] px-2 py-1 rounded bg-emerald-600/25 hover:bg-emerald-600/40 text-emerald-200 disabled:opacity-50"
                        >
                          {t({ en: "Save" })}
                        </button>

                        <button
                          onClick={() =>
                            void onToggleAccount(account.id, account.status === "active" ? "disabled" : "active")
                          }
                          disabled={savingAccountId === account.id}
                          className="text-[11px] px-2 py-1 rounded bg-amber-600/20 hover:bg-amber-600/35 text-amber-200 disabled:opacity-50"
                        >
                          {account.status === "active" ? t({ en: "Disable" }) : t({ en: "Enable" })}
                        </button>

                        <button
                          onClick={() => void onDeleteAccount(provider as OAuthConnectProvider, account.id)}
                          disabled={savingAccountId === account.id}
                          className="text-[11px] px-2 py-1 rounded bg-red-600/20 hover:bg-red-600/35 text-red-300 disabled:opacity-50"
                        >
                          {t({ en: "Delete" })}
                        </button>
                      </div>

                      {account.lastError && (
                        <div className="text-[10px] text-red-300 break-words">{account.lastError}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
