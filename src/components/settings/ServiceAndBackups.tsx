import { useCallback, useEffect, useState } from "react";
import { systemApi, type BackupOverview, type ServiceOverview } from "../../api/system";
import SettingsSection from "./SettingsSection";

const field =
  "w-full rounded-lg border border-[var(--th-input-border)] bg-[var(--th-input-bg)] px-3 py-2 text-sm text-[var(--th-text-primary)]";
const button = "rounded-lg border border-[var(--th-border)] px-3 py-2 text-sm disabled:opacity-50";
const muted = "text-xs text-[var(--th-text-secondary)]";

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString() : "—");
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");
const size = (bytes: number | null | undefined) =>
  bytes ? (bytes > 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`) : "—";

/** An error whose message is already written for the owner (a folder check, a failed backup check). */
class PlainError extends Error {}

function errorText(cause: unknown, fallback: string) {
  if (cause instanceof PlainError) return cause.message;
  const message = cause instanceof Error ? cause.message : "";
  if (message.includes("owner_session_required")) return "Sign in with your password in Settings > Security first.";
  if (message.includes("service_not_running"))
    return "ATLAS is not running as a service, so there is nothing to update.";
  return fallback;
}

function ServicePanel() {
  const [data, setData] = useState<ServiceOverview | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      systemApi
        .service()
        .then(setData)
        .catch((cause) => setError(errorText(cause, "Could not read the service status."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (action: "update" | "restart") => {
    setBusy(true);
    setError("");
    try {
      await systemApi.serviceAction(action);
      setNote(
        action === "update"
          ? "Update requested. ATLAS builds the latest commit, switches over and checks it; this page reconnects in a few minutes. If the new version is not healthy it rolls back on its own."
          : "Restart requested. This page reconnects in a few seconds.",
      );
    } catch (cause) {
      setError(errorText(cause, "Could not send the request."));
    } finally {
      setBusy(false);
    }
  };
  const state = data?.state;
  const description = !data
    ? "Loading…"
    : data.managed
      ? `Running ${short(state?.current_sha)}${data.commits_behind ? ` · update available (${data.commits_behind} commit${data.commits_behind === 1 ? "" : "s"})` : " · up to date"}`
      : "Not running as a service";
  return (
    <SettingsSection title="Service" description={description}>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      {note && (
        <p role="status" className="text-sm text-emerald-500">
          {note}
        </p>
      )}
      {data && !data.managed && (
        <div className="space-y-2 text-sm">
          <p>
            ATLAS is running in development mode, so saved code changes restart it straight away. To run a stable build
            that starts at login and restarts after a crash, run this once in PowerShell from the ATLAS folder:
          </p>
          <code className="block overflow-x-auto rounded-lg bg-black/20 px-3 py-2 text-xs">
            .\scripts\atlas-service\atlas-service.ps1 install
          </code>
        </div>
      )}
      {data?.managed && (
        <>
          <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className={muted}>Running version</dt>
              <dd className="break-words">
                {short(state?.current_sha)} · built {when(state?.built_at)}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className={muted}>Latest commit</dt>
              <dd className="break-words">
                {short(data.repo_head)} {data.repo_head_subject ? `· ${data.repo_head_subject}` : ""}
              </dd>
            </div>
            <div>
              <dt className={muted}>Started</dt>
              <dd>{when(state?.started_at)}</dd>
            </div>
            <div>
              <dt className={muted}>Restarts after a crash or hang</dt>
              <dd>{state?.restarts ?? 0}</dd>
            </div>
            {state?.last_update && (
              <div className="min-w-0 sm:col-span-2">
                <dt className={muted}>Last update ({when(state.last_update.at)})</dt>
                <dd className={`break-words ${state.last_update.ok ? "" : "text-red-500"}`}>
                  {state.last_update.detail}
                </dd>
              </div>
            )}
          </dl>
          <p className={muted}>
            Only committed code runs here; edits in progress never reach it. Update builds the latest commit, switches
            over, and rolls back by itself if the new version does not start.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={button}
              disabled={busy || !data.commits_behind || Boolean(data.pending_request)}
              onClick={() => void act("update")}
            >
              Update to latest commit
            </button>
            <button
              type="button"
              className={button}
              disabled={busy || Boolean(data.pending_request)}
              onClick={() => void act("restart")}
            >
              Restart
            </button>
            <button type="button" className={button} disabled={busy} onClick={() => void load()}>
              Refresh
            </button>
          </div>
        </>
      )}
    </SettingsSection>
  );
}

function BackupsPanel() {
  const [data, setData] = useState<BackupOverview | null>(null);
  const [folder, setFolder] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      systemApi
        .backups()
        .then((next) => {
          setData(next);
          setFolder(next.settings.copy_dir ?? "");
        })
        .catch((cause) => setError(errorText(cause, "Could not read backups."))),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const wrap = async (work: () => Promise<string>) => {
    setBusy(true);
    setError("");
    setNote("");
    try {
      setNote(await work());
    } catch (cause) {
      setError(errorText(cause, "That did not work."));
    } finally {
      setBusy(false);
    }
  };
  const last = data?.last_good;
  const description = !data
    ? "Loading…"
    : last
      ? `Last good backup ${when(last.started_at)}${data.settings.copy_dir ? ` · copied ${last.copy_status === "ok" ? "off this PC" : "— copy failed"}` : ""}`
      : "No backup yet";
  return (
    <SettingsSection title="Backups" description={description}>
      {error && (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      )}
      {note && (
        <p role="status" className="text-sm text-emerald-500">
          {note}
        </p>
      )}
      {data && (
        <>
          <p className="text-sm">
            Every day ATLAS copies its database, then opens the copy and checks it can be restored (integrity check and
            matching row counts). The last {data.settings.keep_days} days are kept in{" "}
            <span className="break-all font-mono text-xs">{data.folder}</span>; the newest three are never deleted.
          </p>
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="grid gap-1 text-sm">
              Daily backups
              <select
                className={field}
                value={data.settings.enabled ? "on" : "off"}
                onChange={(e) =>
                  void wrap(async () => {
                    const settings = await systemApi.saveBackupSettings({ enabled: e.target.value === "on" });
                    setData({ ...data, settings });
                    return settings.enabled ? "Daily backups are on." : "Daily backups are off.";
                  })
                }
              >
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Time of day
              <select
                className={field}
                value={data.settings.hour}
                onChange={(e) =>
                  void wrap(async () => {
                    const settings = await systemApi.saveBackupSettings({ hour: Number(e.target.value) });
                    setData({ ...data, settings });
                    return "Backup time saved.";
                  })
                }
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>
                    {new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: "numeric" })}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Keep (days)
              <select
                className={field}
                value={data.settings.keep_days}
                onChange={(e) =>
                  void wrap(async () => {
                    const settings = await systemApi.saveBackupSettings({ keep_days: Number(e.target.value) });
                    setData({ ...data, settings });
                    return "Retention saved.";
                  })
                }
              >
                {[7, 14, 30, 60, 90, 180, 365].map((days) => (
                  <option key={days} value={days}>
                    {days}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <form
            aria-label="Copy backups off this PC"
            className="grid min-w-0 gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void wrap(async () => {
                if (folder.trim()) {
                  const probe = await systemApi.testFolder(folder.trim());
                  if (!probe.ok) throw new PlainError(probe.error ?? "ATLAS cannot use that folder.");
                }
                const settings = await systemApi.saveBackupSettings({ copy_dir: folder.trim() || null });
                setData({ ...data, settings });
                return settings.copy_dir
                  ? "Folder works. Each good backup is copied there too."
                  : "Backups are kept on this PC only.";
              }).catch(() => {});
            }}
          >
            <label className="grid gap-1 text-sm">
              Copy backups off this PC (optional)
              <input
                className={field}
                placeholder="\\nas\backups\atlas, D:\ATLAS backups or a OneDrive folder"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              />
              <span className={muted}>
                A folder on a NAS share, an external drive or a synced cloud folder. ATLAS checks it can write there
                before saving. Leave empty to keep backups on this PC only.
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={button} disabled={busy}>
                Test and save folder
              </button>
              <button
                type="button"
                className={button}
                disabled={busy}
                onClick={() =>
                  void wrap(async () => {
                    const result = await systemApi.runBackup();
                    await load();
                    if (!result.ok) throw new PlainError(`The backup failed its check: ${result.run.check_detail}`);
                    return `Backup saved and checked (${size(result.run.size_bytes)}${
                      result.run.copy_status === "ok"
                        ? ", copied off this PC"
                        : result.run.copy_status === "failed"
                          ? "; the copy off this PC failed"
                          : ""
                    }).`;
                  })
                }
              >
                Back up now
              </button>
            </div>
          </form>
          {data.runs.length > 0 && (
            <div className="min-w-0">
              <h4 className="mb-1 text-sm font-medium">Recent backups</h4>
              <ul className="divide-y divide-[var(--th-border)] text-sm" aria-label="Recent backups">
                {data.runs.slice(0, 5).map((run) => (
                  <li key={run.id} className="flex min-w-0 flex-col gap-0.5 py-2 sm:flex-row sm:justify-between">
                    <span>
                      {when(run.started_at)} · {run.trigger} · {size(run.size_bytes)}
                    </span>
                    <span
                      className={`min-w-0 break-words ${run.status === "ok" ? "text-emerald-500" : "text-red-500"}`}
                    >
                      {run.status === "ok" ? "checked OK" : run.check_detail}
                      {run.copy_status === "failed" ? ` · copy failed: ${run.copy_detail}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className={muted}>
            Next backup: {when(data.next_run_at)}. To restore one, see docs/operations.md (scripts\atlas-service\
            restore-backup.ps1).
          </p>
        </>
      )}
    </SettingsSection>
  );
}

/** Settings > General: the ATLAS service and automatic database backups (owner only). */
export default function ServiceAndBackups() {
  return (
    <div className="space-y-4">
      <ServicePanel />
      <BackupsPanel />
    </div>
  );
}
