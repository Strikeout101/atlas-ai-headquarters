import { useEffect, useState, type FormEvent } from "react";
import { getTasks } from "../api/organization-projects";
import {
  decideModelUpgrade,
  getModelDirector,
  getTaskModelRoute,
  routeTaskModel,
  saveModelDirector,
  type ModelDirectorConfig,
  type ModelUpgradeRequest,
  type TaskModelRoute,
} from "../api/model-routing";
import type { Task } from "../types";

const PROVIDERS = ["claude", "codex", "gemini", "opencode", "kimi", "copilot", "antigravity", "api"] as const;
type Provider = (typeof PROVIDERS)[number];

const inputClass =
  "w-full rounded-lg border border-slate-500/40 bg-[var(--th-bg-surface)] px-3 py-2 text-sm text-[var(--th-text-primary)] outline-none focus:border-sky-500";
const buttonClass =
  "rounded-lg border border-slate-500/40 px-3 py-2 text-sm font-medium text-[var(--th-text-primary)] transition hover:bg-slate-500/10 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass =
  "rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-sky-500 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

function candidateText(config: ModelDirectorConfig): Record<string, string> {
  return Object.fromEntries(PROVIDERS.map((provider) => [provider, (config.candidates[provider] ?? []).join("\n")]));
}

function parseCandidates(values: Record<string, string>): Record<string, string[]> {
  return Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider,
      [
        ...new Set(
          (values[provider] ?? "")
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ],
    ]),
  );
}

function dateLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export default function ModelDirectorWorkspace() {
  const [config, setConfig] = useState<ModelDirectorConfig | null>(null);
  const [directorId, setDirectorId] = useState("");
  const [candidateDrafts, setCandidateDrafts] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskId, setTaskId] = useState("");
  const [taskRoute, setTaskRoute] = useState<TaskModelRoute | null>(null);
  const [taskCandidates, setTaskCandidates] = useState<string[]>([]);
  const [requests, setRequests] = useState<ModelUpgradeRequest[]>([]);
  const [decisionNote, setDecisionNote] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [routeLoading, setRouteLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([getModelDirector(), getTasks()])
      .then(([nextConfig, nextTasks]) => {
        if (!live) return;
        setConfig(nextConfig);
        setDirectorId(nextConfig.directorAgentId ?? "");
        setCandidateDrafts(candidateText(nextConfig));
        setTasks(nextTasks);
        setTaskId((current) => current || nextTasks.find((task) => task.assigned_agent_id)?.id || "");
      })
      .catch((cause) => {
        if (live) setError(cause instanceof Error ? cause.message : "Could not load model routing.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!taskId) {
      setTaskRoute(null);
      setTaskCandidates([]);
      setRequests([]);
      return;
    }
    let live = true;
    setRouteLoading(true);
    getTaskModelRoute(taskId)
      .then((detail) => {
        if (!live) return;
        setTaskRoute(detail.route);
        setTaskCandidates(detail.candidates);
        setRequests(detail.requests);
      })
      .catch((cause) => {
        if (live) setError(cause instanceof Error ? cause.message : "Could not load the task model route.");
      })
      .finally(() => {
        if (live) setRouteLoading(false);
      });
    return () => {
      live = false;
    };
  }, [taskId]);

  const refreshRoute = async (id: string) => {
    const detail = await getTaskModelRoute(id);
    setTaskRoute(detail.route);
    setTaskCandidates(detail.candidates);
    setRequests(detail.requests);
  };

  const saveConfig = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveModelDirector({
        directorAgentId: directorId || null,
        candidates: parseCandidates(candidateDrafts),
      });
      setConfig((current) => (current ? { ...current, ...saved, directors: current.directors } : saved));
      setNotice("Director settings saved.");
      if (taskId) await refreshRoute(taskId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save director settings.");
    } finally {
      setBusy(false);
    }
  };

  const routeSelectedTask = async () => {
    if (!taskId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await routeTaskModel(taskId, Boolean(taskRoute));
      await refreshRoute(taskId);
      setNotice("Model choice recorded for this task.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not route this task.");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (request: ModelUpgradeRequest, approve: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const note = decisionNote[request.id]?.trim() || (approve ? "Approved by owner" : "Denied by owner");
      await decideModelUpgrade(request.id, approve, note);
      await refreshRoute(request.task_id);
      setNotice(approve ? "Upgrade approved." : "Upgrade denied.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not decide this upgrade request.");
    } finally {
      setBusy(false);
    }
  };

  const selectedTask = tasks.find((task) => task.id === taskId);

  return (
    <div className="mx-auto max-w-7xl space-y-7 px-4 py-6 text-[var(--th-text-primary)] md:px-6">
      <header className="border-b border-slate-500/20 pb-5">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-500">Agent operations</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">Model director</h1>
        <p className="mt-2 max-w-[65ch] text-sm text-[var(--th-text-secondary)]">
          Choose a Claude or Codex director, set the models each worker may use, and review model upgrades as tasks run.
        </p>
      </header>

      {error && (
        <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-500"
        >
          {notice}
        </div>
      )}

      {loading ? (
        <div aria-label="Loading model director" className="grid gap-4 lg:grid-cols-2">
          <div className="h-80 animate-pulse rounded-xl bg-slate-500/10" />
          <div className="h-80 animate-pulse rounded-xl bg-slate-500/10" />
        </div>
      ) : !config ? (
        <div className="rounded-xl border border-dashed border-slate-500/30 p-8 text-sm text-[var(--th-text-secondary)]">
          Model director settings are unavailable. Reload the page to try again.
        </div>
      ) : (
        <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.9fr)]">
          <form onSubmit={(event) => void saveConfig(event)} className="space-y-5">
            <div className="border-b border-slate-500/20 pb-4">
              <h2 className="text-lg font-semibold">Director and model order</h2>
              <p className="mt-1 text-sm text-[var(--th-text-secondary)]">
                List model IDs one per line. The first is the fallback; put stronger options below it for upgrade
                requests.
              </p>
            </div>
            <label className="grid gap-2 text-xs font-medium text-[var(--th-text-secondary)]">
              Director
              <select value={directorId} onChange={(event) => setDirectorId(event.target.value)} className={inputClass}>
                <option value="">No director; use configured worker models</option>
                {config.directors.map((agent) => (
                  <option key={agent.id} value={agent.id} disabled={agent.status === "offline"}>
                    {agent.name} ({agent.cli_provider}){agent.status === "offline" ? " — offline" : ""}
                  </option>
                ))}
              </select>
              {config.directors.length === 0 && (
                <span>No Claude or Codex agent is available yet. Add one in Agents.</span>
              )}
            </label>
            <div className="grid gap-4 md:grid-cols-2">
              {PROVIDERS.map((provider: Provider) => (
                <label key={provider} className="grid gap-2 text-xs font-medium text-[var(--th-text-secondary)]">
                  <span className="capitalize">{provider} models</span>
                  <textarea
                    rows={3}
                    spellCheck={false}
                    value={candidateDrafts[provider] ?? ""}
                    onChange={(event) =>
                      setCandidateDrafts((current) => ({ ...current, [provider]: event.target.value }))
                    }
                    placeholder="One model ID per line"
                    className={`${inputClass} font-mono text-xs`}
                  />
                </label>
              ))}
            </div>
            <button type="submit" disabled={busy} className={primaryClass}>
              {busy ? "Saving…" : "Save director settings"}
            </button>
          </form>

          <section className="space-y-5" aria-label="Task model routing">
            <div className="border-b border-slate-500/20 pb-4">
              <h2 className="text-lg font-semibold">Task model</h2>
              <p className="mt-1 text-sm text-[var(--th-text-secondary)]">
                The selected worker keeps its provider. The director chooses among that provider’s configured models.
              </p>
            </div>
            {tasks.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-500/30 p-6 text-sm text-[var(--th-text-secondary)]">
                No tasks yet. Create and assign one on the Task Board.
              </div>
            ) : (
              <label className="grid gap-2 text-xs font-medium text-[var(--th-text-secondary)]">
                Task
                <select value={taskId} onChange={(event) => setTaskId(event.target.value)} className={inputClass}>
                  <option value="">Choose a task</option>
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title} — {task.agent_name || (task.assigned_agent_id ? "Assigned" : "Unassigned")}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {selectedTask && !selectedTask.assigned_agent_id && (
              <p className="text-sm text-amber-500">Assign a worker before choosing a model for this task.</p>
            )}
            {selectedTask?.assigned_agent_id && (
              <>
                {routeLoading ? (
                  <div className="h-36 animate-pulse rounded-xl bg-slate-500/10" aria-label="Loading task route" />
                ) : (
                  <div className="rounded-xl border border-slate-500/25 bg-[var(--th-bg-surface)] p-5">
                    {taskRoute ? (
                      <>
                        <p className="text-xs font-semibold uppercase tracking-wide text-sky-500">
                          {taskRoute.source} choice
                        </p>
                        <p className="mt-2 break-all font-mono text-lg">
                          {taskRoute.provider}/{taskRoute.model}
                        </p>
                        <p className="mt-2 text-sm text-[var(--th-text-secondary)]">
                          {taskRoute.reason || "No reason recorded."}
                        </p>
                        <p className="mt-3 text-xs text-[var(--th-text-secondary)]">
                          Updated {dateLabel(taskRoute.updated_at)}
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-[var(--th-text-secondary)]">
                        No model choice has been recorded for this task.
                      </p>
                    )}
                    <p className="mt-4 text-xs text-[var(--th-text-secondary)]">
                      Available:{" "}
                      {taskCandidates.length ? taskCandidates.join(" · ") : "No models configured for this worker"}
                    </p>
                  </div>
                )}
                <button
                  type="button"
                  disabled={busy || routeLoading || taskCandidates.length === 0}
                  onClick={() => void routeSelectedTask()}
                  className={buttonClass}
                >
                  {taskRoute ? "Choose again" : "Choose task model"}
                </button>
                <div className="space-y-3 border-t border-slate-500/20 pt-5">
                  <h3 className="text-base font-semibold">Upgrade requests</h3>
                  {requests.length === 0 && (
                    <p className="text-sm text-[var(--th-text-secondary)]">No upgrade requests for this task.</p>
                  )}
                  {requests.map((item) => (
                    <article key={item.id} className="rounded-xl border border-slate-500/25 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <p className="break-all font-mono text-sm">{item.requested_model}</p>
                        <span className="rounded-full border border-slate-500/30 px-2 py-0.5 text-xs capitalize">
                          {item.status}
                        </span>
                      </div>
                      <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--th-text-secondary)]">{item.reason}</p>
                      {item.decision_reason && (
                        <p className="mt-2 text-xs text-[var(--th-text-secondary)]">Decision: {item.decision_reason}</p>
                      )}
                      {item.status === "pending" && (
                        <div className="mt-4 space-y-3">
                          <label className="grid gap-1.5 text-xs text-[var(--th-text-secondary)]">
                            Decision note
                            <input
                              value={decisionNote[item.id] ?? ""}
                              onChange={(event) =>
                                setDecisionNote((current) => ({ ...current, [item.id]: event.target.value }))
                              }
                              maxLength={500}
                              className={inputClass}
                              placeholder="Optional reason"
                            />
                          </label>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void decide(item, true)}
                              className={primaryClass}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void decide(item, false)}
                              className={buttonClass}
                            >
                              Deny
                            </button>
                          </div>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
