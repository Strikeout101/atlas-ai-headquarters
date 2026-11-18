import { useCallback, useEffect, useRef, useState } from "react";
import { disconnectOAuth, pollGitHubDevice, startGitHubDeviceFlow } from "../../api";
import { useI18n } from "../../i18n";

interface GitHubDeviceConnectProps {
  reason: "not_connected" | "missing_repo_scope";
  onConnected: () => void;
  onCancel: () => void;
}

export default function GitHubDeviceConnect({ reason, onConnected, onCancel }: GitHubDeviceConnectProps) {
  const { t } = useI18n();
  const [deviceUserCode, setDeviceUserCode] = useState<string | null>(null);
  const [deviceVerifyUrl, setDeviceVerifyUrl] = useState<string | null>(null);
  const [deviceStateId, setDeviceStateId] = useState<string | null>(null);
  const [deviceStatus, setDeviceStatus] = useState<"idle" | "waiting" | "complete" | "error">("idle");
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const startFlow = useCallback(async () => {
    setDeviceError(null);
    setDeviceStatus("idle");

    if (reason === "missing_repo_scope") {
      setDisconnecting(true);
      try {
        await disconnectOAuth("github-copilot");
      } catch {
        /* ok */
      }
      setDisconnecting(false);
    }

    try {
      const deviceCode = await startGitHubDeviceFlow();
      setDeviceUserCode(deviceCode.userCode);
      setDeviceVerifyUrl(deviceCode.verificationUri);
      setDeviceStateId(deviceCode.stateId);
      setDeviceStatus("waiting");

      window.open(deviceCode.verificationUri, "_blank");

      let intervalMs = (deviceCode.interval || 5) * 1000;
      let stopped = false;
      const poll = () => {
        if (stopped) return;
        pollTimer.current = setTimeout(async () => {
          if (stopped) return;
          try {
            const result = await pollGitHubDevice(deviceCode.stateId);
            if (result.status === "complete") {
              stopped = true;
              setDeviceStatus("complete");
              setTimeout(onConnected, 500);
              return;
            }
            if (result.status === "expired" || result.status === "denied") {
              stopped = true;
              setDeviceStatus("error");
              setDeviceError(result.status === "expired" ? "Code expired" : "Access denied");
              return;
            }
            if (result.status === "slow_down") {
              intervalMs += 5000;
            }
          } catch (pollError) {
            console.error("[GitHubImport] poll error:", pollError);
          }
          poll();
        }, intervalMs);
      };
      poll();
    } catch (err) {
      setDeviceStatus("error");
      setDeviceError(err instanceof Error ? err.message : String(err));
    }
  }, [reason, onConnected]);

  const description =
    reason === "not_connected"
      ? t({
          en: "Connect your GitHub account to import repositories.",
        })
      : t({
          en: "Current GitHub token lacks repo scope. Reconnect to access all repositories including private ones.",
        });

  return (
    <div className="space-y-4 p-6">
      <p className="text-sm text-slate-300">{description}</p>

      {deviceStatus === "idle" && (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={disconnecting}
            onClick={() => void startFlow()}
            className="rounded-lg ax-btn-primary px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {disconnecting
              ? t({ en: "Disconnecting..." })
              : reason === "not_connected"
                ? t({ en: "Connect GitHub" })
                : t({
                    en: "Reconnect GitHub (repo scope)",
                  })}
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300"
          >
            {t({ en: "Close" })}
          </button>
        </div>
      )}

      {deviceStatus === "waiting" && deviceUserCode && (
        <div className="space-y-3 rounded-xl border border-blue-500/30 bg-blue-900/20 p-4">
          <p className="text-xs text-slate-300">
            {t({
              en: "Enter this code on the GitHub verification page:",
            })}
          </p>
          <div className="flex items-center gap-3">
            <code className="rounded-lg bg-slate-800 px-4 py-2 text-lg font-bold tracking-widest text-white">
              {deviceUserCode}
            </code>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(deviceUserCode);
              }}
              className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-700"
            >
              {t({ en: "Copy" })}
            </button>
          </div>
          {deviceVerifyUrl && (
            <a
              href={deviceVerifyUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs text-blue-400 underline hover:text-blue-300"
            >
              {t({
                en: "Open GitHub verification page",
              })}
            </a>
          )}
          <p className="animate-pulse text-xs text-slate-400">{t({ en: "Waiting for authorization..." })}</p>
        </div>
      )}

      {deviceStatus === "complete" && (
        <div className="rounded-lg border border-green-500/20 bg-green-500/10 px-3 py-2 text-xs text-green-400">
          {t({
            en: "GitHub connected! Loading repositories...",
          })}
        </div>
      )}

      {deviceStatus === "error" && (
        <div className="space-y-2">
          <div className="rounded-lg border border-rose-500/60 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {deviceError}
          </div>
          <button
            type="button"
            onClick={() => {
              setDeviceStatus("idle");
              setDeviceError(null);
            }}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300"
          >
            {t({ en: "Try again" })}
          </button>
        </div>
      )}
    </div>
  );
}
