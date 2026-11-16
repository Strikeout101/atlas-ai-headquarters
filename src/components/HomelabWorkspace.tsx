import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { getAgents } from "../api/organization-projects";
import type { Agent } from "../types";
import {
  createHomelabSshTarget,
  decideHomelabSshApproval,
  deleteHomelabSshTarget,
  getHomelabSshApprovals,
  getHomelabApprovalPolicy,
  setHomelabApprovalPolicy,
  getHomelabSshRuns,
  getHomelabSshTargets,
  probeHomelabSshTarget,
  runHomelabSshCommand,
  setHomelabSshGrants,
  testHomelabSshTarget,
  updateHomelabSshTarget,
  type HomelabSshApproval,
  type HomelabSshProbe,
  type HomelabSshRun,
  type HomelabSshTarget,
  type HomelabSshTargetInput,
} from "../api/homelab";

type Draft = Omit<HomelabSshTargetInput, "port"> & { port: string; credential: string; passphrase: string };
type RunResult = Awaited<ReturnType<typeof runHomelabSshCommand>>;

const EMPTY: Draft = {
  name: "",
  host: "",
  ssh_user: "",
  port: "22",
  enabled: true,
  auth_method: "private_key",
  credential: "",
  passphrase: "",
  host_fingerprint: null,
};
const inputClass =
  "w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20";
const secondaryButton =
  "rounded-lg border border-slate-600 px-3 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-700 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton =
  "rounded-lg bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";
const dangerButton =
  "rounded-lg border border-rose-700 px-3 py-2 text-sm text-rose-200 transition hover:bg-rose-950/50 active:scale-[0.98] disabled:opacity-50";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed. Try again.";
}

function dateText(value: number): string {
  return new Date(value).toLocaleString();
}

function draftFromTarget(target: HomelabSshTarget): Draft {
  return {
    name: target.name,
    host: target.host,
    ssh_user: target.ssh_user,
    port: String(target.port),
    enabled: target.enabled,
    auth_method: target.auth_method === "legacy_key_path" ? "private_key" : target.auth_method,
    credential: "",
    passphrase: "",
    host_fingerprint: target.host_fingerprint,
  };
}

export default function HomelabWorkspace({ agents: providedAgents }: { agents?: Agent[] }) {
  const [agents, setAgents] = useState<Agent[]>(providedAgents ?? []);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [targets, setTargets] = useState<HomelabSshTarget[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState<HomelabSshProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [trustChecked, setTrustChecked] = useState(false);
  const [testing, setTesting] = useState(false);
  const [grantDraft, setGrantDraft] = useState<string[]>([]);
  const [savingGrants, setSavingGrants] = useState(false);
  const [savingAccess, setSavingAccess] = useState(false);
  const [approvals, setApprovals] = useState<HomelabSshApproval[]>([]);
  const [approvalsError, setApprovalsError] = useState<string | null>(null);
  const [loadingApprovals, setLoadingApprovals] = useState(false);
  const [autoApproveReadOnly, setAutoApproveReadOnly] = useState<boolean | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [command, setCommand] = useState("");
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState<RunResult | null>(null);
  const [runs, setRuns] = useState<HomelabSshRun[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);

  const selected = useMemo(() => targets.find((target) => target.id === selectedId) ?? null, [targets, selectedId]);
  const selectedApprovals = useMemo(
    () => approvals.filter((approval) => approval.target_id === selectedId),
    [approvals, selectedId],
  );

  const refreshTargets = useCallback(async (preferredId?: string) => {
    const result = await getHomelabSshTargets();
    setTargets(result.targets);
    setSelectedId((current) => {
      const choice = preferredId ?? current;
      return result.targets.some((target) => target.id === choice) ? choice : (result.targets[0]?.id ?? null);
    });
  }, []);

  const refreshApprovals = useCallback(async () => {
    setLoadingApprovals(true);
    setApprovalsError(null);
    try {
      const result = await getHomelabSshApprovals();
      setApprovals(result.approvals);
    } catch (cause) {
      setApprovalsError(errorText(cause));
    } finally {
      setLoadingApprovals(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    getHomelabSshTargets()
      .then((result) => {
        if (!active) return;
        setTargets(result.targets);
        setSelectedId(result.targets[0]?.id ?? null);
      })
      .catch((cause) => {
        if (active) setError(errorText(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (providedAgents) {
      setAgents(providedAgents);
      return;
    }
    let active = true;
    getAgents({ includeSeed: true })
      .then((result) => {
        if (active) setAgents(result);
      })
      .catch((cause) => {
        if (active) setAgentsError(errorText(cause));
      });
    return () => {
      active = false;
    };
  }, [providedAgents]);

  useEffect(() => {
    void refreshApprovals();
  }, [refreshApprovals]);

  useEffect(() => {
    getHomelabApprovalPolicy()
      .then((policy) => setAutoApproveReadOnly(policy.auto_approve_read_only))
      .catch(() => setAutoApproveReadOnly(null));
  }, []);

  async function changeApprovalPolicy(next: boolean) {
    setSavingPolicy(true);
    setError(null);
    try {
      const policy = await setHomelabApprovalPolicy(next);
      setAutoApproveReadOnly(policy.auto_approve_read_only);
      setNotice(
        policy.auto_approve_read_only
          ? "Read-only checks now run without asking. Anything that could change a host still needs your approval."
          : "Every agent SSH command now needs your approval.",
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSavingPolicy(false);
    }
  }
  useEffect(() => {
    setGrantDraft(selected?.agent_ids ?? []);
    setOutput(null);
    setProbe(null);
    setTrustChecked(false);
  }, [selected]);

  useEffect(() => {
    if (!selectedId) {
      setRuns([]);
      return;
    }
    let active = true;
    setLoadingRuns(true);
    setRunsError(null);
    getHomelabSshRuns(selectedId)
      .then((result) => {
        if (active) setRuns(result.runs);
      })
      .catch((cause) => {
        if (active) setRunsError(errorText(cause));
      })
      .finally(() => {
        if (active) setLoadingRuns(false);
      });
    return () => {
      active = false;
    };
  }, [selectedId, historyVersion]);

  function openCreate() {
    setEditingId(null);
    setDraft({ ...EMPTY });
    setEditorOpen(true);
    setError(null);
  }

  function openEdit(target: HomelabSshTarget) {
    setEditingId(target.id);
    setDraft(draftFromTarget(target));
    setEditorOpen(true);
    setError(null);
  }

  async function saveTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    const input: HomelabSshTargetInput = {
      name: draft.name.trim(),
      host: draft.host.trim(),
      ssh_user: draft.ssh_user.trim(),
      port: Number(draft.port),
      enabled: draft.enabled,
      auth_method: draft.auth_method,
      ...(draft.credential ? { credential: draft.credential } : {}),
      ...(draft.passphrase ? { passphrase: draft.passphrase } : {}),
      host_fingerprint: draft.host_fingerprint?.trim() || null,
    };
    try {
      const result = editingId ? await updateHomelabSshTarget(editingId, input) : await createHomelabSshTarget(input);
      setDraft({ ...EMPTY });
      setEditorOpen(false);
      await refreshTargets(result.target.id);
      setNotice(editingId ? "Host updated." : "Host added. Probe its fingerprint before using SSH.");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  }

  async function removeTarget(target: HomelabSshTarget) {
    if (!window.confirm(`Delete ${target.name} and its saved SSH credential and grants?`)) return;
    setError(null);
    try {
      await deleteHomelabSshTarget(target.id);
      await refreshTargets();
      setNotice("Host removed.");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function probeHost() {
    if (!selected) return;
    setProbing(true);
    setProbe(null);
    setTrustChecked(false);
    setError(null);
    try {
      setProbe(await probeHomelabSshTarget(selected.id));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setProbing(false);
    }
  }

  async function trustFingerprint() {
    if (!selected || !probe || !trustChecked) return;
    setError(null);
    try {
      await updateHomelabSshTarget(selected.id, { host_fingerprint: probe.fingerprint });
      await refreshTargets(selected.id);
      setProbe(null);
      setTrustChecked(false);
      setNotice("Fingerprint pinned. Test the SSH connection before running agent commands.");
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  async function testConnection() {
    if (!selected) return;
    setTesting(true);
    setError(null);
    try {
      const result = await testHomelabSshTarget(selected.id);
      setNotice(result.ok ? "SSH connection succeeded." : `SSH test failed: ${result.error_code ?? result.status}.`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setTesting(false);
    }
  }

  async function changeHostAccess(restricted: boolean) {
    if (!selected) return;
    setSavingAccess(true);
    setError(null);
    try {
      const { target } = await updateHomelabSshTarget(selected.id, { restrict_agents: restricted });
      setTargets((current) => current.map((host) => (host.id === target.id ? target : host)));
      setNotice(
        restricted
          ? "Only selected agents can access this host. Command approvals still apply."
          : "All agents can access this host. Command approvals still apply.",
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSavingAccess(false);
    }
  }

  async function saveGrants() {
    if (!selected) return;
    setSavingGrants(true);
    setError(null);
    try {
      await setHomelabSshGrants(selected.id, grantDraft);
      await refreshTargets(selected.id);
      setNotice(
        autoApproveReadOnly === false
          ? "Agent grants saved. Every agent command still needs owner approval."
          : "Agent grants saved. Commands that could change the host still need owner approval.",
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSavingGrants(false);
    }
  }

  async function decideApproval(approval: HomelabSshApproval, approve: boolean) {
    if (
      approve &&
      !window.confirm(`Approve this exact SSH command on ${selected?.name ?? "the host"}?\n\n${approval.command}`)
    )
      return;
    setDecidingId(approval.id);
    setError(null);
    try {
      await decideHomelabSshApproval(approval.id, approve);
      await refreshApprovals();
      setNotice(approve ? "Command approved for this request." : "Command denied.");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setDecidingId(null);
    }
  }

  async function runCommand() {
    if (!selected || !command.trim()) return;
    setRunning(true);
    setOutput(null);
    setError(null);
    try {
      setOutput(await runHomelabSshCommand(selected.id, command.trim()));
      setHistoryVersion((value) => value + 1);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="mx-auto max-w-7xl space-y-6 pb-12 text-slate-100" aria-label="SSH host manager">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-700 pb-5">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-400">ATLAS Settings</p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight">SSH Host Manager</h2>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            Store host credentials, verify fingerprints, restrict sensitive hosts, and approve commands that need
            review.
          </p>
        </div>
        <button type="button" className={primaryButton} onClick={openCreate}>
          Add host
        </button>
      </header>

      {error && (
        <p role="alert" className="rounded-lg border border-rose-500/50 bg-rose-950/40 px-4 py-3 text-sm text-rose-100">
          {error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-100"
        >
          {notice}
        </p>
      )}

      {editorOpen && (
        <form
          onSubmit={(event) => void saveTarget(event)}
          className="space-y-4 rounded-xl border border-slate-700 bg-slate-900 p-5"
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-lg font-semibold">{editingId ? "Edit host" : "New host"}</h3>
            <button
              type="button"
              className={secondaryButton}
              onClick={() => {
                setEditorOpen(false);
                setDraft({ ...EMPTY });
              }}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="block text-slate-300">Display name</span>
              <input
                className={inputClass}
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                required
                maxLength={100}
                placeholder="Main homelab"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="block text-slate-300">Host or IP</span>
              <input
                className={inputClass}
                value={draft.host}
                onChange={(event) => setDraft({ ...draft, host: event.target.value })}
                required
                autoComplete="off"
                placeholder="lab.example.local"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="block text-slate-300">SSH user</span>
              <input
                className={inputClass}
                value={draft.ssh_user}
                onChange={(event) => setDraft({ ...draft, ssh_user: event.target.value })}
                required
                autoComplete="off"
                placeholder="operator"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="block text-slate-300">Port</span>
              <input
                className={inputClass}
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(event) => setDraft({ ...draft, port: event.target.value })}
                required
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="block text-slate-300">Authentication</span>
              <select
                className={inputClass}
                value={draft.auth_method}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    auth_method: event.target.value as Draft["auth_method"],
                    credential: "",
                    passphrase: "",
                  })
                }
              >
                <option value="private_key">Private key</option>
                <option value="password">Password</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span className="block text-slate-300">Host fingerprint</span>
              <input
                className={inputClass}
                value={draft.host_fingerprint ?? ""}
                onChange={(event) => setDraft({ ...draft, host_fingerprint: event.target.value })}
                placeholder="SHA256:..."
                autoComplete="off"
              />
              <span className="block text-xs text-slate-500">Verify against a trusted source before saving.</span>
            </label>
          </div>
          <label className="block space-y-1 text-sm">
            <span className="block text-slate-300">
              {draft.auth_method === "password" ? "SSH password" : "Paste private key"}
              {editingId ? " (leave blank to keep saved credential)" : ""}
            </span>
            {draft.auth_method === "password" ? (
              <input
                className={inputClass}
                type="password"
                value={draft.credential}
                onChange={(event) => setDraft({ ...draft, credential: event.target.value })}
                required={!editingId || selected?.auth_method !== draft.auth_method}
                autoComplete="new-password"
              />
            ) : (
              <textarea
                className={`${inputClass} min-h-32 font-mono`}
                value={draft.credential}
                onChange={(event) => setDraft({ ...draft, credential: event.target.value })}
                required={!editingId || selected?.auth_method !== draft.auth_method}
                spellCheck={false}
                autoComplete="off"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              />
            )}
          </label>
          {draft.auth_method === "private_key" && (
            <label className="block space-y-1 text-sm">
              <span className="block text-slate-300">Key passphrase (optional)</span>
              <input
                className={inputClass}
                type="password"
                value={draft.passphrase}
                onChange={(event) => setDraft({ ...draft, passphrase: event.target.value })}
                autoComplete="new-password"
              />
              <span className="block text-xs text-slate-500">
                Leave blank when editing to keep the saved passphrase.
              </span>
            </label>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
              />
              Enabled
            </label>
            <button type="submit" className={primaryButton} disabled={saving}>
              {saving ? "Saving..." : "Save host"}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <p role="status" className="rounded-xl border border-slate-700 bg-slate-900 p-8 text-sm text-slate-400">
          Loading hosts...
        </p>
      ) : targets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-600 bg-slate-900/60 p-8">
          <h3 className="text-lg font-semibold">No SSH hosts configured</h3>
          <p className="mt-2 text-sm text-slate-400">
            Add a host and verify its fingerprint to start managing your homelab.
          </p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[230px_minmax(0,1fr)]">
          <aside className="space-y-2" aria-label="SSH hosts">
            {targets.map((target) => (
              <button
                type="button"
                key={target.id}
                onClick={() => setSelectedId(target.id)}
                aria-pressed={selectedId === target.id}
                className={`w-full rounded-lg border px-3 py-3 text-left transition ${selectedId === target.id ? "border-cyan-400 bg-cyan-950/30" : "border-slate-700 bg-slate-900 hover:border-slate-500"}`}
              >
                <span className="block truncate font-semibold">{target.name}</span>
                <span className="mt-1 block truncate font-mono text-xs text-slate-400">
                  {target.ssh_user}@{target.host}:{target.port}
                </span>
                <span className="mt-1 block text-xs text-slate-500">
                  {target.host_fingerprint ? "Fingerprint pinned" : "Fingerprint needed"}
                </span>
              </button>
            ))}
          </aside>
          {selected && (
            <div className="min-w-0 space-y-6">
              <section className="rounded-xl border border-slate-700 bg-slate-900 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-xl font-semibold">{selected.name}</h3>
                    <p className="mt-1 font-mono text-sm text-slate-400">
                      {selected.ssh_user}@{selected.host}:{selected.port}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className={secondaryButton} onClick={() => openEdit(selected)}>
                      Edit
                    </button>
                    <button type="button" className={dangerButton} onClick={() => void removeTarget(selected)}>
                      Delete
                    </button>
                  </div>
                </div>
                <dl className="mt-4 grid gap-3 border-t border-slate-700 pt-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-slate-500">Authentication</dt>
                    <dd className="mt-1 text-slate-200">
                      {selected.auth_method === "legacy_key_path"
                        ? "Legacy key path; paste a credential to migrate"
                        : selected.auth_method === "private_key"
                          ? "Private key"
                          : "Password"}{" "}
                      · {selected.has_credential ? "Credential saved" : "Credential needed"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Host fingerprint</dt>
                    <dd className="mt-1 break-all font-mono text-xs text-slate-200">
                      {selected.host_fingerprint ?? "Unpinned"}
                    </dd>
                  </div>
                </dl>
              </section>

              <section className="rounded-xl border border-slate-700 bg-slate-900 p-5">
                <h3 className="text-lg font-semibold">Host identity and connection</h3>
                <p className="mt-1 text-sm text-slate-400">
                  Probe only observes the host key. Compare it with a fingerprint obtained through a trusted channel
                  before pinning.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" className={secondaryButton} onClick={() => void probeHost()} disabled={probing}>
                    {probing ? "Probing..." : "Probe fingerprint"}
                  </button>
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() => void testConnection()}
                    disabled={testing || !selected.enabled || !selected.host_fingerprint || !selected.has_credential}
                  >
                    {testing ? "Testing..." : "Test SSH connection"}
                  </button>
                </div>
                {probe && (
                  <div className="mt-4 space-y-3 rounded-lg border border-amber-600/50 bg-amber-950/20 p-4">
                    <p className="text-sm text-amber-100">
                      Observed fingerprint: <strong className="break-all font-mono">{probe.fingerprint}</strong>
                    </p>
                    <p className="text-xs text-slate-400">
                      {probe.matches_pin
                        ? "Matches the saved fingerprint."
                        : "Does not match the saved fingerprint or no fingerprint is pinned."}
                    </p>
                    <label className="flex items-start gap-2 text-sm text-slate-200">
                      <input
                        type="checkbox"
                        checked={trustChecked}
                        onChange={(event) => setTrustChecked(event.target.checked)}
                      />
                      <span>I verified this fingerprint through a trusted source and trust this host.</span>
                    </label>
                    <button
                      type="button"
                      className={primaryButton}
                      onClick={() => void trustFingerprint()}
                      disabled={!trustChecked}
                    >
                      Pin this fingerprint
                    </button>
                  </div>
                )}
                {!selected.host_fingerprint && (
                  <p className="mt-3 text-sm text-amber-300">SSH testing and commands require a pinned fingerprint.</p>
                )}
              </section>

              <section className="rounded-xl border border-slate-700 bg-slate-900 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">Agent access</h3>
                    <p className="mt-1 text-sm text-slate-400">
                      {selected.restrict_agents
                        ? "Only selected agents can request SSH on this host. "
                        : "All agents can request SSH on this host. "}
                      {autoApproveReadOnly === false
                        ? "Every command needs a separate owner approval."
                        : "Read-only checks run on their own; anything that could change the host needs your approval."}
                    </p>
                  </div>
                  {selected.restrict_agents && (
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => void saveGrants()}
                      disabled={savingGrants || savingAccess || agentsError !== null}
                    >
                      {savingGrants ? "Saving..." : "Save selected agents"}
                    </button>
                  )}
                </div>
                <label className="mt-4 flex items-start gap-2 text-sm text-slate-200">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.restrict_agents}
                    disabled={savingAccess || savingGrants}
                    onChange={(event) => void changeHostAccess(event.target.checked)}
                  />
                  <span>
                    Restrict to selected agents
                    <span className="block text-xs text-slate-400">
                      Use for sensitive hosts such as infrastructure nodes. Off allows all current and future agents.
                      Saved selections are kept when this is turned off. Changes save immediately.
                    </span>
                  </span>
                </label>
                {selected.restrict_agents && agentsError && (
                  <p role="alert" className="mt-3 text-sm text-rose-300">
                    {agentsError}
                  </p>
                )}
                {!selected.restrict_agents ? (
                  <p className="mt-4 text-sm text-slate-400">Host access: all agents.</p>
                ) : agents.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-400">
                    No agents available. No agents can access a restricted host without a saved selection.
                  </p>
                ) : (
                  <div className="mt-4 grid max-h-48 gap-2 overflow-y-auto border-t border-slate-700 pt-4 sm:grid-cols-2">
                    {[...agents]
                      .sort((a, b) => a.name.localeCompare(b.name))
                      .map((agent) => (
                        <label
                          key={agent.id}
                          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-200 hover:bg-slate-800"
                        >
                          <input
                            type="checkbox"
                            checked={grantDraft.includes(agent.id)}
                            disabled={savingGrants || savingAccess}
                            onChange={() =>
                              setGrantDraft((current) =>
                                current.includes(agent.id)
                                  ? current.filter((id) => id !== agent.id)
                                  : [...current, agent.id],
                              )
                            }
                          />
                          <span className="truncate">{agent.name}</span>
                        </label>
                      ))}
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-slate-700 bg-slate-900 p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">Agent command approvals</h3>
                    <p className="mt-1 text-sm text-slate-400">Review the exact command and target before deciding.</p>
                    <label className="mt-3 flex items-start gap-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={autoApproveReadOnly !== false}
                        disabled={autoApproveReadOnly === null || savingPolicy}
                        onChange={(event) => void changeApprovalPolicy(event.target.checked)}
                      />
                      <span>
                        Let read-only checks run without asking
                        <span className="block text-xs text-slate-400">
                          Status, logs, disk and network lookups such as systemctl status, journalctl, df, docker ps.
                          Anything that could change a host, chain commands, write files or read secrets still waits for
                          you.
                        </span>
                      </span>
                    </label>
                  </div>
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() => void refreshApprovals()}
                    disabled={loadingApprovals}
                  >
                    Refresh
                  </button>
                </div>
                {approvalsError ? (
                  <p role="alert" className="mt-4 text-sm text-rose-300">
                    {approvalsError}
                  </p>
                ) : loadingApprovals ? (
                  <p role="status" className="mt-4 text-sm text-slate-400">
                    Loading approvals...
                  </p>
                ) : selectedApprovals.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-400">No requests for this host.</p>
                ) : (
                  <ul className="mt-4 space-y-3">
                    {selectedApprovals.map((approval) => (
                      <li key={approval.id} className="rounded-lg border border-slate-700 bg-slate-950 p-3">
                        <div className="flex flex-wrap justify-between gap-2 text-xs text-slate-400">
                          <span>
                            {agents.find((agent) => agent.id === approval.agent_id)?.name ?? approval.agent_id} ·{" "}
                            {dateText(approval.created_at)}
                          </span>
                          <span className={approval.status === "pending" ? "text-amber-300" : "text-slate-400"}>
                            {approval.status}
                            {approval.decided_by === "auto_read_only" ? " · auto (read-only)" : ""}
                          </span>
                        </div>
                        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-slate-200">
                          {approval.command}
                        </pre>
                        {approval.status === "pending" && (
                          <div className="mt-3 flex gap-2">
                            <button
                              type="button"
                              className={primaryButton}
                              onClick={() => void decideApproval(approval, true)}
                              disabled={decidingId === approval.id}
                            >
                              Approve command
                            </button>
                            <button
                              type="button"
                              className={dangerButton}
                              onClick={() => void decideApproval(approval, false)}
                              disabled={decidingId === approval.id}
                            >
                              Deny
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-xl border border-slate-700 bg-slate-900 p-5">
                <h3 className="text-lg font-semibold">Owner command console</h3>
                <p className="mt-1 text-sm text-slate-400">
                  Commands entered here run under your direct control. Agent requests use the approval queue above.
                </p>
                <label className="mt-4 block space-y-2 text-sm text-slate-300">
                  <span>Remote command</span>
                  <textarea
                    className={`${inputClass} min-h-24 font-mono`}
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    maxLength={8000}
                    spellCheck={false}
                    placeholder="hostname && uptime"
                  />
                </label>
                <button
                  type="button"
                  className={`${primaryButton} mt-3`}
                  onClick={() => void runCommand()}
                  disabled={
                    running ||
                    !selected.enabled ||
                    !selected.host_fingerprint ||
                    !selected.has_credential ||
                    !command.trim()
                  }
                >
                  {running ? "Running..." : "Run command"}
                </button>
                {output && (
                  <div className="mt-4 border-t border-slate-700 pt-4">
                    <p className={`text-sm ${output.ok ? "text-emerald-300" : "text-rose-300"}`}>
                      {output.status}
                      {output.exit_code !== null ? ` (exit ${output.exit_code})` : ""}
                    </p>
                    {output.stdout && (
                      <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-200">
                        {output.stdout}
                      </pre>
                    )}
                    {output.stderr && (
                      <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-rose-200">
                        {output.stderr}
                      </pre>
                    )}
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-slate-700 bg-slate-900 p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold">Run audit</h3>
                    <p className="mt-1 text-sm text-slate-400">
                      Command and output hashes are retained; command text and output are not stored here.
                    </p>
                  </div>
                  <button
                    type="button"
                    className={secondaryButton}
                    onClick={() => setHistoryVersion((value) => value + 1)}
                    disabled={loadingRuns}
                  >
                    Refresh
                  </button>
                </div>
                {loadingRuns ? (
                  <p role="status" className="mt-4 text-sm text-slate-400">
                    Loading audit...
                  </p>
                ) : runsError ? (
                  <p role="alert" className="mt-4 text-sm text-rose-300">
                    {runsError}
                  </p>
                ) : runs.length === 0 ? (
                  <p className="mt-4 text-sm text-slate-400">No SSH runs for this host.</p>
                ) : (
                  <div className="mt-4 overflow-x-auto">
                    <table className="min-w-full text-left text-sm">
                      <thead className="border-b border-slate-700 text-xs uppercase text-slate-500">
                        <tr>
                          <th className="py-2 pr-4">Time</th>
                          <th className="py-2 pr-4">Status</th>
                          <th className="py-2 pr-4">Actor</th>
                          <th className="py-2">Command hash</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {runs.map((run) => (
                          <tr key={run.id}>
                            <td className="whitespace-nowrap py-2 pr-4 text-slate-300">{dateText(run.started_at)}</td>
                            <td className="py-2 pr-4">{run.status}</td>
                            <td className="py-2 pr-4 text-slate-400">
                              {agents.find((agent) => agent.id === run.agent_id)?.name ??
                                (run.agent_id ? "Unknown agent" : "Owner")}
                            </td>
                            <td className="py-2 font-mono text-xs text-slate-500" title={run.command_sha256}>
                              {run.command_sha256.slice(0, 12)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
