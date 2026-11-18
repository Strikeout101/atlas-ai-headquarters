import { CONNECTABLE_PROVIDERS } from "./constants";
import type { OAuthConnectCardProps } from "./types";

export default function OAuthConnectCards({
  t,
  oauthStatus,
  deviceCode,
  deviceStatus,
  deviceError,
  onConnect,
  onStartDeviceCodeFlow,
}: OAuthConnectCardProps) {
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold text-slate-500">
        {t({
          en: "Add OAuth Account",
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CONNECTABLE_PROVIDERS.map(({ id, label, Logo, description }) => {
          const providerInfo = oauthStatus.providers[id];
          const isConnected = Boolean(providerInfo?.executionReady ?? providerInfo?.connected);
          const isDetectedOnly = Boolean(providerInfo?.detected) && !isConnected;
          const storageOk = oauthStatus.storageReady;
          const isGitHub = id === "github-copilot";

          return (
            <div
              key={id}
              className={`flex flex-col items-center gap-2 p-4 rounded-xl border transition-all ${
                isConnected
                  ? "bg-green-500/5 border-green-500/30"
                  : isDetectedOnly
                    ? "bg-amber-500/5 border-amber-500/30"
                    : storageOk
                      ? "bg-slate-700/30 border-slate-600/50 hover:border-blue-400/50 hover:bg-slate-700/50"
                      : "bg-slate-800/30 border-slate-700/30 opacity-50"
              }`}
            >
              <Logo className="w-8 h-8" />
              <span className="text-sm font-medium text-white">{label}</span>
              <span className="text-[10px] text-slate-400 text-center leading-tight">{description}</span>

              {!storageOk ? (
                <span className="text-[10px] px-2 py-0.5 rounded bg-yellow-500/20 text-yellow-500">
                  {t({
                    en: "Encryption key required",
                  })}
                </span>
              ) : (
                <>
                  {isConnected ? (
                    <span className="text-[11px] px-2.5 py-1 rounded-lg bg-green-500/20 text-green-400 font-medium">
                      {t({ en: "Runnable" })}
                    </span>
                  ) : isDetectedOnly ? (
                    <span className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 font-medium">
                      {t({ en: "Detected" })}
                    </span>
                  ) : null}

                  {isGitHub ? (
                    deviceCode && deviceStatus === "polling" ? (
                      <div className="flex flex-col items-center gap-1.5">
                        <div className="text-xs text-slate-300 font-mono bg-slate-700/60 px-3 py-1.5 rounded-lg tracking-widest select-all">
                          {deviceCode.userCode}
                        </div>
                        <span className="text-[10px] text-blue-400 animate-pulse">
                          {t({
                            en: "Waiting for code...",
                          })}
                        </span>
                      </div>
                    ) : (
                      <button
                        onClick={() => void onStartDeviceCodeFlow()}
                        className="text-[11px] px-3 py-1 rounded-lg ax-btn-primary font-medium transition-colors"
                      >
                        {isConnected || isDetectedOnly ? t({ en: "Add Account" }) : t({ en: "Connect" })}
                      </button>
                    )
                  ) : (
                    <button
                      onClick={() => onConnect(id)}
                      className="text-[11px] px-3 py-1 rounded-lg ax-btn-primary font-medium transition-colors"
                    >
                      {isConnected || isDetectedOnly ? t({ en: "Add Account" }) : t({ en: "Connect" })}
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {deviceStatus === "complete" && (
        <div className="space-y-1.5">
          <div className="text-xs text-green-400 bg-green-500/10 border border-green-500/20 px-3 py-2 rounded-lg">
            {t({ en: "GitHub connected!" })}
          </div>
          <div className="text-[11px] text-slate-400 bg-slate-800/60 border border-slate-700/50 px-3 py-2 rounded-lg">
            {t({
              en: "With a Copilot subscription you can use AI models. Without it, GitHub repo import in Project Manager still works.",
            })}
          </div>
        </div>
      )}

      {deviceError && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 px-3 py-2 rounded-lg">
          {deviceError}
        </div>
      )}
    </div>
  );
}
