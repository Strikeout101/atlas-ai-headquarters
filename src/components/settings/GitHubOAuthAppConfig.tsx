import { useEffect, useState } from "react";
import * as api from "../../api";
import type { TFunction } from "./types";

export default function GitHubOAuthAppConfig({ t }: { t: TFunction }) {
  const [ghClientId, setGhClientId] = useState("");
  const [ghClientIdSaved, setGhClientIdSaved] = useState(false);
  const [ghClientIdLoaded, setGhClientIdLoaded] = useState(false);

  useEffect(() => {
    api
      .getSettingsRaw()
      .then((settings) => {
        const val = settings?.github_oauth_client_id;
        if (val) setGhClientId(String(val).replace(/^"|"$/g, ""));
        setGhClientIdLoaded(true);
      })
      .catch(() => setGhClientIdLoaded(true));
  }, []);

  const saveClientId = () => {
    const val = ghClientId.trim();
    api
      .saveSettingsPatch({ github_oauth_client_id: val || null })
      .then(() => {
        setGhClientIdSaved(true);
        setTimeout(() => setGhClientIdSaved(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div className="space-y-2 rounded-xl border border-slate-700/50 bg-slate-800/40 p-4">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold text-slate-400">
          {t({
            en: "GitHub OAuth App (Private repo access)",
          })}
        </h4>
        {ghClientIdSaved && <span className="text-[10px] text-green-400">{t({ en: "Saved" })}</span>}
      </div>
      <p className="text-[11px] text-slate-500 leading-relaxed">
        {t({
          en: "Default GitHub uses Copilot OAuth which limits private repo access. Register your own OAuth App for full access.",
        })}
      </p>
      <details className="text-[11px] text-slate-500">
        <summary className="cursor-pointer text-blue-400 hover:text-blue-300">
          {t({
            en: "How to create OAuth App",
          })}
        </summary>
        <ol className="mt-2 ml-4 list-decimal space-y-1 text-slate-400">
          <li>GitHub → Settings → Developer settings → OAuth Apps → New OAuth App</li>
          <li>
            {t({
              en: "Application name: any name (e.g. My ATLAS)",
            })}
          </li>
          <li>Homepage URL: http://localhost:8800</li>
          <li>Callback URL: http://localhost:8800/oauth/callback</li>
          <li>
            {t({
              en: "☑ Check 'Enable Device Flow'",
            })}
          </li>
          <li>
            {t({
              en: "Register → Paste Client ID below",
            })}
          </li>
        </ol>
      </details>
      {ghClientIdLoaded && (
        <div className="flex gap-2 items-center">
          <input
            type="text"
            placeholder="Iv23li..."
            value={ghClientId}
            onChange={(e) => setGhClientId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveClientId();
            }}
            className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white outline-none focus:border-blue-500 font-mono"
          />
          <button
            onClick={saveClientId}
            className="shrink-0 rounded-lg ax-btn-primary px-3 py-1.5 text-[11px] font-medium"
          >
            {t({ en: "Save" })}
          </button>
        </div>
      )}
      {ghClientId.trim() && (
        <p className="text-[10px] text-amber-400">
          {t({
            en: "After saving, reconnect your GitHub account using the 'Connect' or 'Add Account' button above.",
          })}
        </p>
      )}
    </div>
  );
}
